// Tauri shell — spawns the Python/PyInstaller backend, negotiates port,
// exposes the port to the frontend via a Tauri command.
//
// ┌─────────────────────────────────────────────────────────────────┐
// │  Dev mode  (npm run tauri dev)                                  │
// │    Spawns: python3 -m app.main                                 │
// │    Backend dir resolved relative to CARGO_MANIFEST_DIR          │
// │                                                                  │
// │  Release mode  (npm run tauri build)                            │
// │    Spawns: <Resources>/backend/mediasort-backend[.exe]          │
// │    PyInstaller-frozen executable bundled inside the .app/.exe   │
// │    ffmpeg resolved from <Resources>/ffmpeg/ and prepended to    │
// │    PATH — no system-wide Python or ffmpeg required.             │
// └─────────────────────────────────────────────────────────────────┘

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::fmt;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicI32, AtomicU32, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use native_dialog::{DialogBuilder, MessageLevel};
use rand::{distr::Alphanumeric, RngExt};
use serde::Serialize;
use tauri::{Manager, State};

mod backend_state;
mod lifecycle;
mod owned_backend;
#[cfg(windows)]
mod windows_icon;
use backend_state::BackendStartup;
use owned_backend::OwnedBackend;

// ── Launcher log ──────────────────────────────────────────────────────────────
//
// Every line carries a UTC timestamp with milliseconds, the level, this run's ID
// and the milliseconds since launch (see lifecycle.rs). The file rotates at 2 MB
// and keeps five backups, so the launcher never uses more than about 12 MB.
//
// Log location (mirrors the Python backend's log dir):
//   macOS:   ~/Library/Logs/MediaSorter/mediasort.log
//   Windows: %LOCALAPPDATA%\MediaSorter\Logs\mediasort.log
//   Linux:   ${XDG_STATE_HOME:-~/.local/state}/MediaSorter/log/mediasort.log

fn log_dir() -> PathBuf {
    if let Some(explicit) = std::env::var_os("MEDIASORT_LOG_DIR") {
        return PathBuf::from(explicit);
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        PathBuf::from(home).join("Library/Logs/MediaSorter")
    }
    #[cfg(target_os = "windows")]
    {
        // Prefer LocalAppData — logs are ephemeral and must not roam to domain servers.
        let base = std::env::var("LOCALAPPDATA")
            .or_else(|_| std::env::var("APPDATA"))
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| "C:\\".to_string());
        PathBuf::from(base).join("MediaSorter").join("Logs")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let xdg = std::env::var("XDG_STATE_HOME").unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
            format!("{}/.local/state", home)
        });
        PathBuf::from(xdg).join("MediaSorter/log")
    }
}

/// Open the rotating log and return its path for the startup banner.
fn init_logger() -> Result<PathBuf, StartupError> {
    let dir = log_dir();
    let path = dir.join("mediasort.log");
    lifecycle::init(&dir).map_err(|error| {
        StartupError::new(
            StartupStage::Path,
            "MediaSorter could not open its launcher log.",
            format!("log_dir={} error={}", dir.display(), error),
            path.clone(),
        )
    })
}

fn write_log(level: &str, msg: &str) {
    lifecycle::write(level, msg);
}

macro_rules! log_info {
    ($($arg:tt)*) => {{
        let msg = format!($($arg)*);
        println!("[mediasort] INFO: {}", msg);
        write_log("INFO", &msg);
    }};
}

macro_rules! log_warn {
    ($($arg:tt)*) => {{
        let msg = format!($($arg)*);
        eprintln!("[mediasort] WARN: {}", msg);
        write_log("WARN", &msg);
    }};
}

macro_rules! log_error {
    ($($arg:tt)*) => {{
        let msg = format!($($arg)*);
        eprintln!("[mediasort] ERROR: {}", msg);
        write_log("ERROR", &msg);
    }};
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartupStage {
    Path,
    Port,
    Spawn,
    Readiness,
}

impl fmt::Display for StartupStage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let label = match self {
            Self::Path => "path",
            Self::Port => "port",
            Self::Spawn => "spawn",
            Self::Readiness => "readiness",
        };
        formatter.write_str(label)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StartupError {
    stage: StartupStage,
    summary: String,
    detail: String,
    log_path: PathBuf,
}

impl StartupError {
    fn new(
        stage: StartupStage,
        summary: impl Into<String>,
        detail: impl Into<String>,
        log_path: PathBuf,
    ) -> Self {
        Self {
            stage,
            summary: summary.into(),
            detail: detail.into(),
            log_path,
        }
    }

    fn dialog_text(&self) -> String {
        format!(
            "{}\n\nChoose Yes to Reveal Log or No to Quit.\n\nLog file:\n{}",
            self.summary,
            self.log_path.display()
        )
    }
}

impl fmt::Display for StartupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} startup failure: {} ({})",
            self.stage, self.summary, self.detail
        )
    }
}

impl std::error::Error for StartupError {}

fn reveal_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg("-R").arg(path).spawn();

    #[cfg(target_os = "windows")]
    let result = Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .spawn();

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result = {
        let dir = path
            .parent()
            .map(|parent| parent.to_path_buf())
            .unwrap_or_else(|| path.to_path_buf());
        Command::new("xdg-open").arg(dir).spawn()
    };

    result.map(|_| ()).map_err(|error| error.to_string())
}

fn show_fatal_startup_dialog(error: &StartupError) {
    log_error!(
        "fatal_startup stage={} detail={} log_path={}",
        error.stage,
        error.detail,
        error.log_path.display()
    );
    if std::env::var("MEDIASORT_STARTUP_SMOKE_NONINTERACTIVE").as_deref() == Ok("1") {
        log_error!("native_dialog_recovery_reached action=Quit");
        return;
    }
    let reveal = match DialogBuilder::message()
        .set_level(MessageLevel::Error)
        .set_title("MediaSorter could not start")
        .set_text(error.dialog_text())
        .confirm()
        .show()
    {
        Ok(choice) => choice,
        Err(dialog_error) => {
            log_error!("native_dialog_failed title=startup error={}", dialog_error);
            false
        }
    };
    if reveal {
        if let Err(reveal_error) = reveal_in_file_manager(&error.log_path) {
            log_error!(
                "Reveal Log failed for {}: {}",
                error.log_path.display(),
                reveal_error
            );
            if let Err(dialog_error) = DialogBuilder::message()
                .set_level(MessageLevel::Error)
                .set_title("Could not reveal the log")
                .set_text(format!(
                    "Open this path manually:\n\n{}",
                    error.log_path.display()
                ))
                .alert()
                .show()
            {
                log_error!("native_dialog_failed title=reveal error={}", dialog_error);
            }
        }
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

struct BackendState {
    startup: Arc<BackendStartup>,
    exit_code: Arc<AtomicI32>,
}

#[derive(Debug, Clone, Serialize)]
struct ApiSession {
    port: u16,
    capability: String,
}

#[tauri::command]
async fn get_api_session(state: State<'_, BackendState>) -> Result<ApiSession, String> {
    let startup = Arc::clone(&state.startup);
    // Readiness includes blocking process and HTTP probes. Never block Tauri's
    // IPC/event loop or hold a synchronous mutex across an await.
    tauri::async_runtime::spawn_blocking(move || startup.session())
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.summary)
}

#[tauri::command]
fn frontend_mounted() {
    log_info!("packaged_webview_frontend_mounted");
    // The first moment the user can see MediaSorter: a later launch that finds
    // this missing knows the window never appeared.
    lifecycle::stage("ui_mounted", "");
    lifecycle::mark_window_shown();
}

/// Frontend diagnostics (uncaught errors, failed requests) for the launcher log.
///
/// Bounded per run and per message, so a misbehaving page cannot flood the log.
#[tauri::command]
fn frontend_log(level: String, message: String) {
    const LIMIT_PER_RUN: u32 = 500;
    const MAX_CHARS: usize = 2000;
    static COUNT: AtomicU32 = AtomicU32::new(0);
    let seen = COUNT.fetch_add(1, Ordering::Relaxed);
    if seen == LIMIT_PER_RUN {
        log_warn!("frontend log limit of {LIMIT_PER_RUN} lines reached; dropping further lines");
    }
    if seen >= LIMIT_PER_RUN {
        return;
    }
    let level = match level.as_str() {
        "error" => "ERROR",
        "warn" => "WARN",
        _ => "INFO",
    };
    let text: String = message.chars().take(MAX_CHARS).collect();
    write_log(level, &format!("frontend {text}"));
}

#[tauri::command]
fn frontend_failure(app: tauri::AppHandle) {
    log_error!("packaged_webview_readiness_or_media_rendering_failed");
    if std::env::var("MEDIASORT_WEBVIEW_SMOKE").as_deref() == Ok("1") {
        app.state::<BackendState>()
            .exit_code
            .store(1, Ordering::Release);
        kill_backend(app.state::<BackendState>().inner());
        app.exit(1);
    }
}

/// React calls this after mounting, backend readiness and Blob image rendering.
///
/// Release CI sets `MEDIASORT_WEBVIEW_SMOKE=1`; a successful invocation proves
/// the packaged shell loaded its bundled frontend (not merely that the native
/// process started), records durable evidence, and exits cleanly. Normal
/// launches only record the ready marker and continue.
#[tauri::command]
fn frontend_ready(app: tauri::AppHandle) {
    log_info!("packaged_webview_media_ready");
    log_info!("packaged_webview_frontend_ready");
    lifecycle::stage("ui_ready", "");
    if std::env::var("MEDIASORT_WEBVIEW_SMOKE").as_deref() == Ok("1") {
        // app.exit() does not consistently deliver the normal exit callbacks
        // before Windows tears down the WebView. Reap the packaged backend
        // explicitly so release verification can remove its extracted payload.
        kill_backend(app.state::<BackendState>().inner());
        app.exit(0);
    }
}

/// Reveal a file in the OS file manager (Finder / Explorer / file browser),
/// selecting it where the platform supports it. Best-effort: the spawn is
/// non-blocking and any failure is logged rather than surfaced.
#[tauri::command]
fn reveal_path(path: String) {
    if let Err(e) = reveal_in_file_manager(std::path::Path::new(&path)) {
        log_error!("reveal_path failed for {}: {}", path, e);
    }
}

// ── Port negotiation ─────────────────────────────────────────────────────────

fn backend_is_ready(port: u16, capability: &str) -> bool {
    health_check(port, capability).is_ok()
}

/// One readiness probe; the error says why, for the log.
fn health_check(port: u16, capability: &str) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}/api/health", port);
    match ureq::get(&url)
        .header("X-MediaSorter-Capability", capability)
        .config()
        .timeout_global(Some(Duration::from_secs(2)))
        .build()
        .call()
    {
        Ok(response) if response.status().as_u16() == 200 => Ok(()),
        Ok(response) => Err(format!("http_status={}", response.status().as_u16())),
        Err(error) => Err(format!("error={error}")),
    }
}

/// The whole launch, all spawn attempts included, must finish within this.
const STARTUP_BUDGET: Duration = Duration::from_secs(210);

/// Write the engine's last output lines to the log, with the secret removed.
fn log_backend_output(startup: &BackendStartup, capability: &str, reason: &str) {
    const MAX_LINES: usize = 60;
    let Some(tail) = startup.output_tail(capability) else {
        return;
    };
    let lines: Vec<&str> = tail
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.is_empty() {
        log_warn!("backend_output reason={reason} lines=0");
        return;
    }
    let shown = &lines[lines.len().saturating_sub(MAX_LINES)..];
    log_warn!(
        "backend_output reason={reason} lines={} showing_last={}",
        lines.len(),
        shown.len()
    );
    for line in shown {
        write_log("WARN", &format!("backend| {line}"));
    }
}

/// Ask the OS for a free loopback port by binding to port 0, then release it so
/// the backend can claim it. Between the release and the child's own bind there
/// is a race window; `acquire_backend` retries to close it.
fn find_available_port(log_path: &std::path::Path) -> Result<u16, StartupError> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
        StartupError::new(
            StartupStage::Port,
            "MediaSorter could not reserve a local backend port.",
            format!("TcpListener::bind(127.0.0.1:0): {}", error),
            log_path.to_path_buf(),
        )
    })?;

    listener
        .local_addr()
        .map_err(|error| {
            StartupError::new(
                StartupStage::Port,
                "MediaSorter could not inspect its reserved backend port.",
                format!("TcpListener::local_addr: {}", error),
                log_path.to_path_buf(),
            )
        })
        .map(|address| address.port())
}

/// Try to acquire a working port, retrying if another process beats us between
/// the bind probe and the backend's bind. The startup state owns the child.
fn acquire_backend(
    max_tries: u32,
    log_path: &std::path::Path,
    capability: &str,
    startup: &BackendStartup,
) -> Result<u16, StartupError> {
    let mut attempted_ports = Vec::new();
    let mut failures = Vec::new();
    let deadline = Instant::now() + STARTUP_BUDGET;
    for attempt in 1..=max_tries {
        if startup.is_closed() {
            return startup.session().map(|session| session.port);
        }
        if Instant::now() >= deadline {
            failures.push(format!(
                "startup budget of {}s exhausted",
                STARTUP_BUDGET.as_secs()
            ));
            break;
        }
        let port = find_available_port(log_path)?;
        attempted_ports.push(port);

        lifecycle::stage(
            "backend_spawn",
            &format!("port={port} attempt={attempt}/{max_tries}"),
        );
        let child_id = match startup.spawn(|| {
            let mut child = spawn_backend(port, capability, log_path)?;
            child.set_session(port, capability);
            Ok(child)
        }) {
            Ok(id) => id,
            Err(error) => {
                log_warn!(
                    "backend_spawn_failed attempt={attempt} detail={}",
                    error.detail
                );
                failures.push(error.detail);
                startup.wait_or_closed(Duration::from_millis(100));
                continue;
            }
        };
        log_info!("backend_spawned pid={child_id} port={port}");

        // Quick liveness probe — if the backend can't bind, it dies fast.
        startup.wait_or_closed(Duration::from_millis(500));
        match startup.probe() {
            Ok(Some(status)) => {
                log_warn!("backend_exited_immediately port={port} status={status}");
                log_backend_output(startup, capability, "exited_immediately");
                failures.push(format!("port {} exited immediately with {}", port, status));
                startup.stop_process();
                startup.wait_or_closed(Duration::from_millis(100));
                continue;
            }
            Err(error) => {
                failures.push(format!("port {} liveness check failed: {}", port, error));
                startup.stop_process();
                continue;
            }
            Ok(None) => {}
        }

        if let Err(error) =
            wait_for_backend(port, capability, 30, startup, child_id, log_path, deadline)
        {
            log_warn!(
                "backend_not_ready attempt={attempt} detail={}",
                error.detail
            );
            log_backend_output(startup, capability, "not_ready");
            failures.push(error.detail);
            startup.stop_process();
            continue;
        }

        return Ok(port);
    }

    Err(StartupError::new(
        StartupStage::Readiness,
        format!(
            "The MediaSorter backend failed to start after {} attempts.",
            max_tries
        ),
        format!(
            "attempted_ports=[{}]; failures=[{}]",
            attempted_ports
                .iter()
                .map(|port| port.to_string())
                .collect::<Vec<_>>()
                .join(","),
            failures.join(" | ")
        ),
        log_path.to_path_buf(),
    ))
}

#[allow(clippy::too_many_arguments)]
fn wait_for_backend(
    port: u16,
    capability: &str,
    max_attempts: u32,
    startup: &BackendStartup,
    child_id: u32,
    log_path: &std::path::Path,
    deadline: Instant,
) -> Result<(), StartupError> {
    let started = Instant::now();
    let mut last_reason = String::from("no probe completed");
    for attempt in 1..=max_attempts {
        match startup.probe() {
            Ok(Some(status)) => {
                return Err(StartupError::new(
                    StartupStage::Readiness,
                    "The MediaSorter backend exited before it became ready.",
                    format!(
                        "port={} attempt={}/{} status={} elapsed_ms={}",
                        port,
                        attempt,
                        max_attempts,
                        status,
                        started.elapsed().as_millis()
                    ),
                    log_path.to_path_buf(),
                ));
            }
            Err(error) => {
                return Err(StartupError::new(
                    StartupStage::Readiness,
                    "MediaSorter could not inspect the backend process.",
                    format!("port={} try_wait: {}", port, error),
                    log_path.to_path_buf(),
                ));
            }
            Ok(None) => {}
        }
        match health_check(port, capability) {
            Ok(()) if !startup.is_closed() => {
                lifecycle::stage(
                    "backend_ready",
                    &format!(
                        "port={port} attempts={attempt} wait_ms={}",
                        started.elapsed().as_millis()
                    ),
                );
                return Ok(());
            }
            Ok(()) => last_reason = "closing".into(),
            Err(reason) => last_reason = reason,
        }
        if attempt == 1 || attempt % 5 == 0 {
            log_info!(
                "backend_waiting attempt={attempt}/{max_attempts} elapsed_ms={} last={last_reason}",
                started.elapsed().as_millis()
            );
        }
        if Instant::now() >= deadline {
            break;
        }
        if attempt < max_attempts {
            let delay_ms = (200u64 * attempt as u64).min(2000);
            startup.wait_or_closed(Duration::from_millis(delay_ms));
        }
    }
    Err(StartupError::new(
        StartupStage::Readiness,
        "The MediaSorter backend did not become ready in time.",
        format!(
            "port={} child_id={} elapsed_ms={} last={}",
            port,
            child_id,
            started.elapsed().as_millis(),
            last_reason
        ),
        log_path.to_path_buf(),
    ))
}

// ── Path resolution ───────────────────────────────────────────────────────────

/// Returns the backend directory:
/// - Dev: `<repo>/backend` (relative to CARGO_MANIFEST_DIR)
/// - Release: `<AppBundle>/Resources/backend` (PyInstaller output)
fn require_backend_directory(
    candidate: PathBuf,
    log_path: &std::path::Path,
) -> Result<PathBuf, StartupError> {
    if !candidate.is_dir() {
        return Err(StartupError::new(
            StartupStage::Path,
            "The MediaSorter backend directory is missing.",
            format!("not a directory: {}", candidate.display()),
            log_path.to_path_buf(),
        ));
    }
    Ok(candidate)
}

fn resolve_backend_dir(log_path: &std::path::Path) -> Result<PathBuf, StartupError> {
    #[cfg(debug_assertions)]
    {
        let manifest = std::env!("CARGO_MANIFEST_DIR");
        let candidate = PathBuf::from(manifest).join("../../backend");
        let resolved = candidate.canonicalize().map_err(|error| {
            StartupError::new(
                StartupStage::Path,
                "MediaSorter could not locate its development backend.",
                format!("canonicalize({}): {}", candidate.display(), error),
                log_path.to_path_buf(),
            )
        })?;
        require_backend_directory(resolved, log_path)
    }

    #[cfg(not(debug_assertions))]
    {
        let exe = std::env::current_exe().map_err(|error| {
            StartupError::new(
                StartupStage::Path,
                "MediaSorter could not locate its executable.",
                error.to_string(),
                log_path.to_path_buf(),
            )
        })?;
        let app_dir = exe.parent().ok_or_else(|| {
            StartupError::new(
                StartupStage::Path,
                "MediaSorter could not locate its application directory.",
                format!("executable has no parent: {}", exe.display()),
                log_path.to_path_buf(),
            )
        })?;
        #[cfg(target_os = "macos")]
        let candidate = app_dir.join("../Resources/resources/backend");
        #[cfg(target_os = "windows")]
        let candidate = app_dir.join("resources/backend");
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let candidate = app_dir.join("resources/backend");

        require_backend_directory(candidate, log_path)
    }
}

/// Returns the bundled ffmpeg directory in release builds.
/// In dev mode returns `None` so the system ffmpeg on PATH is used instead.
fn resolve_ffmpeg_dir() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        None
    }
    #[cfg(not(debug_assertions))]
    {
        let exe = std::env::current_exe().ok()?;
        let app_dir = exe.parent()?;
        #[cfg(target_os = "macos")]
        return Some(app_dir.join("../Resources/resources/ffmpeg"));
        #[cfg(target_os = "windows")]
        return Some(app_dir.join("resources/ffmpeg"));
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        return Some(app_dir.join("resources/ffmpeg"));
    }
}

/// Prepend the bundled ffmpeg directory to PATH (release) or leave it unchanged (dev).
fn build_path_with_ffmpeg() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    match resolve_ffmpeg_dir() {
        Some(dir) => {
            let sep = if cfg!(target_os = "windows") {
                ";"
            } else {
                ":"
            };
            format!("{}{}{}", dir.display(), sep, current)
        }
        None => current,
    }
}

// ── Backend launcher ──────────────────────────────────────────────────────────

fn spawn_with_startup_error(
    command: &mut Command,
    summary: &str,
    detail: String,
    log_path: &std::path::Path,
) -> Result<OwnedBackend, StartupError> {
    OwnedBackend::spawn(command).map_err(|error| {
        StartupError::new(
            StartupStage::Spawn,
            summary,
            format!("{} error={}", detail, error),
            log_path.to_path_buf(),
        )
    })
}

fn spawn_backend(
    port: u16,
    capability: &str,
    log_path: &std::path::Path,
) -> Result<OwnedBackend, StartupError> {
    let path_env = build_path_with_ffmpeg();
    let log_dir = log_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));

    #[cfg(debug_assertions)]
    {
        let backend_dir = resolve_backend_dir(log_path)?;
        let python = if cfg!(target_os = "windows") {
            "python.exe"
        } else {
            "python3"
        };

        let mut command = Command::new(python);
        command
            .args(["-m", "app.main"])
            .env("MEDIASORT_PORT", port.to_string())
            .env("MEDIASORT_LOG_LEVEL", "info")
            .env("MEDIASORT_LOG_DIR", log_dir)
            .env("MEDIASORT_API_CAPABILITY", capability)
            .env("PATH", &path_env)
            .current_dir(&backend_dir);
        spawn_with_startup_error(
            &mut command,
            "MediaSorter could not start its development backend.",
            format!(
                "command={} cwd={} port={}",
                python,
                backend_dir.display(),
                port
            ),
            log_path,
        )
    }

    #[cfg(not(debug_assertions))]
    {
        let backend_dir = resolve_backend_dir(log_path)?;
        let exe_name = if cfg!(target_os = "windows") {
            "mediasort-backend.exe"
        } else {
            "mediasort-backend"
        };
        let exe_path = backend_dir.join(exe_name);

        log_info!("backend_dir: {}", backend_dir.display());
        log_info!(
            "exe_path: {} (exists={})",
            exe_path.display(),
            exe_path.exists()
        );
        log_info!("PATH: {}", path_env);

        let mut command = Command::new(&exe_path);
        command
            .env("MEDIASORT_PORT", port.to_string())
            .env("MEDIASORT_LOG_LEVEL", "info")
            .env("MEDIASORT_LOG_DIR", log_dir)
            .env("MEDIASORT_API_CAPABILITY", capability)
            .env("PATH", &path_env);
        spawn_with_startup_error(
            &mut command,
            "MediaSorter could not start its packaged backend.",
            format!("executable={} port={}", exe_path.display(), port),
            log_path,
        )
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

fn launch(log_path: &std::path::Path) -> Result<i32, StartupError> {
    log_info!(
        "=== MediaSorter starting (pid={}) — logs: {} ===",
        std::process::id(),
        log_path.display()
    );

    // Create the window before backend initialization so the bundled splash
    // and React startup screen can paint while Python imports its services.
    lifecycle::stage("window_build", "");
    let startup = Arc::new(BackendStartup::default());
    let startup_on_build_error = Arc::clone(&startup);
    let exit_code = Arc::new(AtomicI32::new(0));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(BackendState {
            startup: Arc::clone(&startup),
            exit_code: Arc::clone(&exit_code),
        })
        .setup(|_app| Ok(()))
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { .. } => {
                lifecycle::stage("close_requested", &format!("window={}", window.label()));
            }
            tauri::WindowEvent::Destroyed => {
                lifecycle::stage("window_destroyed", &format!("window={}", window.label()));
                kill_backend(window.state::<BackendState>().inner());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            frontend_ready,
            frontend_mounted,
            frontend_failure,
            frontend_log,
            get_api_session,
            reveal_path
        ])
        .build(tauri::generate_context!())
        .map_err(|error| {
            startup_on_build_error.close();
            StartupError::new(
                StartupStage::Readiness,
                "MediaSorter could not create its desktop window.",
                error.to_string(),
                log_path.to_path_buf(),
            )
        })?;

    let backend_log_path = log_path.to_path_buf();
    let runtime_code = app.run_return(move |app_handle, event| {
        if let tauri::RunEvent::Ready = event {
            lifecycle::stage("window_created", "");
            #[cfg(windows)]
            if let Some(window) = app_handle.get_webview_window("main") {
                if let Err(error) = windows_icon::apply(&window) {
                    write_log(
                        "WARN",
                        &format!("Could not set the high-resolution Windows taskbar icon: {error}"),
                    );
                }
            }
            // Tauri creates configured windows during Ready, after build().
            // Start the worker only after that desktop initialization finishes.
            start_backend_in_background(
                app_handle.clone(),
                backend_log_path.clone(),
                Arc::clone(&startup),
            );
        }
        // On macOS Cmd-Q (and other clean-exit paths) WindowEvent::Destroyed
        // may not fire before the process exits. RunEvent::Exit fires
        // reliably so we kill the backend there too.
        if let tauri::RunEvent::ExitRequested { code, .. } = &event {
            lifecycle::stage("exit_requested", &format!("code={code:?}"));
        }
        if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
            kill_backend(app_handle.state::<BackendState>().inner());
        }
    });
    Ok(exit_code.load(Ordering::Acquire).max(runtime_code))
}

fn start_backend_in_background(
    app_handle: tauri::AppHandle,
    backend_log_path: PathBuf,
    startup: Arc<BackendStartup>,
) {
    let capability = std::env::var("MEDIASORT_API_CAPABILITY").unwrap_or_else(|_| {
        rand::rng()
            .sample_iter(&Alphanumeric)
            .take(48)
            .map(char::from)
            .collect()
    });
    let worker_startup = Arc::clone(&startup);
    let worker_path = backend_log_path.clone();
    let spawned = thread::Builder::new()
        .name("backend-startup".into())
        .spawn(move || {
            let result = run_startup_worker(&worker_path, || {
                start_backend(&worker_path, &worker_startup, &capability)
            });
            worker_startup.finish(result.clone());
            match result {
                Ok(_) => monitor_backend(app_handle, worker_startup, worker_path, capability),
                Err(error) => {
                    log_error!("stage=startup_failed {}", error);
                    report_fatal(&app_handle, &worker_startup, error);
                }
            }
        });
    if let Err(error) = spawned {
        let failure = StartupError::new(
            StartupStage::Spawn,
            "MediaSorter could not start its startup worker.",
            format!("thread spawn: {error}"),
            backend_log_path,
        );
        log_error!("stage=startup_failed {}", failure);
        startup.finish(Err(failure));
    }
}

/// Run the startup and turn a panic into a startup failure, so the UI waiting
/// for a session always receives a terminal answer.
fn run_startup_worker(
    log_path: &std::path::Path,
    start: impl FnOnce() -> Result<ApiSession, StartupError>,
) -> Result<ApiSession, StartupError> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(start)).unwrap_or_else(|_| {
        Err(StartupError::new(
            StartupStage::Readiness,
            "MediaSorter stopped starting because of an internal error.",
            "startup worker panicked; the panic line above names its location",
            log_path.to_path_buf(),
        ))
    })
}

/// Watch the engine after it became ready and report an exit nobody asked for.
fn monitor_backend(
    app_handle: tauri::AppHandle,
    startup: Arc<BackendStartup>,
    log_path: PathBuf,
    capability: String,
) {
    let spawned = thread::Builder::new()
        .name("backend-monitor".into())
        .spawn(move || loop {
            if startup.wait_or_closed(Duration::from_secs(1)) {
                return;
            }
            match startup.probe() {
                Ok(None) => continue,
                Ok(Some(status)) => {
                    log_error!("stage=backend_exited_unexpectedly status={status}");
                    log_backend_output(&startup, &capability, "unexpected_exit");
                    let error = StartupError::new(
                        StartupStage::Readiness,
                        "The MediaSorter engine stopped unexpectedly. Interrupted work is \
                         checked the next time MediaSorter starts.",
                        format!("backend exit status={status}"),
                        log_path.clone(),
                    );
                    report_fatal(&app_handle, &startup, error);
                    return;
                }
                // Closed or no longer inspectable: shutdown owns the outcome.
                Err(_) => return,
            }
        });
    if let Err(error) = spawned {
        log_warn!("backend_monitor_unavailable error={error}");
    }
}

/// Show the recovery dialog on the desktop thread, or fall back if that fails.
fn report_fatal(app_handle: &tauri::AppHandle, startup: &Arc<BackendStartup>, error: StartupError) {
    if startup.is_closed() {
        return;
    }
    // Recovery UI must run on the desktop thread, especially on macOS.
    // Closing the startup window suppresses stale dialogs.
    let recovery_app = app_handle.clone();
    let dialog_error = error.clone();
    let dispatched = app_handle.run_on_main_thread(move || {
        if !recovery_app.state::<BackendState>().startup.is_closed() {
            recovery_app
                .state::<BackendState>()
                .exit_code
                .store(1, Ordering::Release);
            show_fatal_startup_dialog(&dialog_error);
            kill_backend(recovery_app.state::<BackendState>().inner());
            recovery_app.exit(1);
        }
    });
    if let Err(dispatch_error) = dispatched {
        // The event loop is gone or refused the task. Report from this thread;
        // the dialog may not appear on every platform, but the log is written.
        log_error!("recovery_dispatch_failed error={dispatch_error}");
        startup.close();
        show_fatal_startup_dialog(&error);
        lifecycle::stage("exit_after_failed_dispatch", "code=1");
        std::process::exit(1);
    }
}

/// Explain why this launch stops because another instance owns MediaSorter.
fn explain_other_instance(other: lifecycle::OtherInstance, log_path: &std::path::Path) -> i32 {
    use lifecycle::OtherInstance;
    let (level, title, text, code) = match &other {
        OtherInstance::Running(marker) => {
            log_info!(
                "second_instance other_run={} other_pid={} state=running",
                marker.run_id,
                marker.pid
            );
            (
                MessageLevel::Info,
                "MediaSorter is already open",
                "MediaSorter is already open. Switch to its window to continue.".to_string(),
                0,
            )
        }
        OtherInstance::Starting(marker) => {
            log_info!(
                "second_instance other_run={} other_pid={} state=starting",
                marker.run_id,
                marker.pid
            );
            (
                MessageLevel::Info,
                "MediaSorter is starting",
                "MediaSorter is still starting. Its window should appear in a moment.".to_string(),
                0,
            )
        }
        OtherInstance::Stuck(marker) => {
            log_warn!(
                "second_instance other_run={} other_pid={} state=stuck_without_window \
                 started={} last_stage={}",
                marker.run_id,
                marker.pid,
                lifecycle::timestamp(
                    std::time::UNIX_EPOCH + Duration::from_millis(marker.started_unix_ms as u64)
                ),
                marker.stage
            );
            (
                MessageLevel::Warning,
                "MediaSorter did not finish starting",
                format!(
                    "Another MediaSorter process (process ID {}) started earlier but never \
                     showed its window. Security software can hold an app while it starts.\n\n\
                     End that process in Task Manager (Windows) or Activity Monitor (macOS), \
                     then open MediaSorter again.\n\nLog file:\n{}",
                    marker.pid,
                    log_path.display()
                ),
                2,
            )
        }
        OtherInstance::Unknown => {
            log_info!("second_instance other=unknown");
            (
                MessageLevel::Info,
                "MediaSorter is already running",
                "MediaSorter is already running. Switch to its window to continue.".to_string(),
                0,
            )
        }
    };
    if std::env::var("MEDIASORT_STARTUP_SMOKE_NONINTERACTIVE").as_deref() != Ok("1") {
        if let Err(dialog_error) = DialogBuilder::message()
            .set_level(level)
            .set_title(title)
            .set_text(text)
            .alert()
            .show()
        {
            log_error!(
                "native_dialog_failed title=second_instance error={}",
                dialog_error
            );
        }
    }
    code
}

fn main() {
    lifecycle::install_panic_hook();
    let fallback_log_path = log_dir().join("mediasort.log");
    let log_path = match init_logger() {
        Ok(path) => path,
        Err(error) => {
            show_fatal_startup_dialog(&error);
            std::process::exit(1);
        }
    };
    let dir = log_dir();
    // Only the owner of the instance lock may touch the run marker; a second
    // launch reads the running instance's marker to explain itself.
    if let Err(other) = lifecycle::acquire_instance(&dir) {
        std::process::exit(explain_other_instance(other, &log_path));
    }
    lifecycle::report_previous_run(&dir);
    lifecycle::stage(
        "logger_ready",
        &format!(
            "pid={} version={} os={} arch={}",
            std::process::id(),
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH
        ),
    );
    match launch(&log_path) {
        Ok(code) => {
            lifecycle::mark_clean_exit(code);
            if code != 0 {
                std::process::exit(code);
            }
        }
        Err(error) => {
            show_fatal_startup_dialog(&error);
            if error.log_path != fallback_log_path {
                log_error!("fallback_log_path={}", fallback_log_path.display());
            }
            lifecycle::mark_clean_exit(1);
            std::process::exit(1);
        }
    }
}

fn kill_backend(state: &BackendState) {
    state.startup.close();
}

fn start_backend(
    log_path: &std::path::Path,
    startup: &BackendStartup,
    capability: &str,
) -> Result<ApiSession, StartupError> {
    if std::env::var("MEDIASORT_STARTUP_SMOKE_FAIL").as_deref() == Ok("1") {
        return Err(StartupError::new(
            StartupStage::Spawn,
            "Controlled packaged-startup failure reached the native recovery path.",
            "MEDIASORT_STARTUP_SMOKE_FAIL=1",
            log_path.to_path_buf(),
        ));
    }
    let port = if cfg!(debug_assertions) && backend_is_ready(8000, capability) {
        log_info!("Found existing backend on port 8000 (hot-reload mode)");
        8000
    } else {
        acquire_backend(5, log_path, capability, startup)?
    };
    Ok(ApiSession {
        port,
        capability: capability.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_error_separates_safe_dialog_text_from_diagnostics() {
        let error = StartupError::new(
            StartupStage::Spawn,
            "The packaged backend is unavailable.",
            "secret command detail",
            PathBuf::from("/tmp/MediaSorter/mediasort.log"),
        );
        let text = error.dialog_text();
        assert!(text.contains("Reveal Log"));
        assert!(text.contains("Quit"));
        assert!(text.contains("/tmp/MediaSorter/mediasort.log"));
        assert!(!text.contains("secret command detail"));
        assert!(error.to_string().contains("secret command detail"));
    }

    #[test]
    fn os_assigned_port_is_loopback_and_nonzero() {
        match find_available_port(std::path::Path::new("/tmp/mediasort.log")) {
            Ok(port) => assert_ne!(port, 0),
            Err(error) => {
                // Sandboxed test runners may deny socket creation. That path
                // must remain a typed, actionable port failure.
                assert_eq!(error.stage, StartupStage::Port);
                assert!(error.detail.contains("TcpListener::bind"));
            }
        }
    }

    #[test]
    fn missing_process_is_a_typed_spawn_failure() {
        let log = std::path::Path::new("/tmp/mediasort.log");
        let mut command = Command::new("__mediasorter_missing_test_executable__");
        let error = spawn_with_startup_error(
            &mut command,
            "Could not start the test backend.",
            "controlled missing executable".to_string(),
            log,
        )
        .expect_err("the controlled executable must not exist");

        assert_eq!(error.stage, StartupStage::Spawn);
        assert!(error.detail.contains("controlled missing executable"));
        assert_eq!(error.log_path, log);
    }

    #[test]
    fn development_backend_path_is_a_directory() {
        let path = resolve_backend_dir(std::path::Path::new("/tmp/mediasort.log"))
            .expect("development backend path");
        assert!(path.is_dir());
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("backend")
        );
    }

    #[test]
    fn missing_backend_directory_is_a_typed_path_failure() {
        let log = std::path::Path::new("/tmp/mediasort.log");
        let missing = PathBuf::from("/__mediasorter_missing_backend_directory__");
        let error = require_backend_directory(missing.clone(), log)
            .expect_err("the controlled backend directory must not exist");

        assert_eq!(error.stage, StartupStage::Path);
        assert!(error.detail.contains(&missing.display().to_string()));
        assert_eq!(error.log_path, log);
    }

    #[cfg(unix)]
    #[test]
    fn readiness_failure_reports_early_child_exit() {
        let startup = BackendStartup::default();
        let id = startup
            .spawn(|| {
                let mut command = Command::new("sh");
                command.args(["-c", "exit 7"]);
                let mut child = OwnedBackend::spawn(&mut command).expect("spawn fixture");
                child.wait().expect("wait fixture");
                Ok(child)
            })
            .expect("child");
        let error = wait_for_backend(
            9,
            "fixture",
            1,
            &startup,
            id,
            std::path::Path::new("/tmp/mediasort.log"),
            Instant::now() + Duration::from_secs(5),
        )
        .expect_err("child exit should fail readiness");
        assert_eq!(error.stage, StartupStage::Readiness);
        assert!(error.detail.contains("status"));
        startup.close();
    }

    #[test]
    fn a_panicking_startup_still_reports_a_terminal_failure() {
        let log = std::path::Path::new("/tmp/mediasort.log");
        let error = run_startup_worker(log, || panic!("controlled startup panic"))
            .expect_err("a panic must become a startup failure");
        assert_eq!(error.stage, StartupStage::Readiness);
        assert!(error.summary.contains("internal error"));
        assert_eq!(error.log_path, log);
    }

    #[test]
    fn windows_release_subsystem_guard_remains_in_source() {
        let source = include_str!("main.rs");
        assert!(source.contains("windows_subsystem = \"windows\""));
    }
}
