// Tauri shell — spawns the Python/PyInstaller backend, negotiates port,
// exposes the port to the frontend via a Tauri command.
//
// ┌─────────────────────────────────────────────────────────────────┐
// │  Dev mode  (npm run tauri dev)                                  │
// │    Spawns: python3 -m uvicorn app.main:app …                   │
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
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use native_dialog::{DialogBuilder, MessageLevel};
use rand::{distributions::Alphanumeric, Rng};
use serde::Serialize;
use tauri::{Manager, State};

// ── File logger ───────────────────────────────────────────────────────────────
//
// A minimal rotating file logger — no external crates needed.
// Each entry is one line:  [YYYY-MM-DD HH:MM:SS] [LEVEL] message
//
// Rotation: when the log exceeds 2 MB the current file is renamed to
// mediasort.1.log and a fresh mediasort.log is started. Only one backup is
// kept so the total footprint stays under ~4 MB.
//
// Log location (mirrors the Python backend's log dir):
//   macOS:   ~/Library/Logs/MediaSorter/mediasort.log
//   Windows: %LOCALAPPDATA%\MediaSorter\Logs\mediasort.log
//   Linux:   ${XDG_STATE_HOME:-~/.local/state}/MediaSorter/log/mediasort.log

static LOG_FILE: OnceLock<Mutex<Option<File>>> = OnceLock::new();

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

/// Open (or rotate) the log file and register it in LOG_FILE.
/// Returns the path so the startup banner can report where logs live.
fn init_logger() -> Result<PathBuf, StartupError> {
    let dir = log_dir();
    let path = dir.join("mediasort.log");
    std::fs::create_dir_all(&dir).map_err(|error| {
        StartupError::new(
            StartupStage::Path,
            "MediaSorter could not create its log directory.",
            format!("create_dir_all({}): {}", dir.display(), error),
            path.clone(),
        )
    })?;

    // Rotate when the file exceeds 2 MB.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 2 * 1024 * 1024 {
            let backup = dir.join("mediasort.1.log");
            let _ = std::fs::remove_file(&backup);
            let _ = std::fs::rename(&path, &backup);
        }
    }

    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| {
            StartupError::new(
                StartupStage::Path,
                "MediaSorter could not open its launcher log.",
                format!("open({}): {}", path.display(), error),
                path.clone(),
            )
        })?;

    LOG_FILE.get_or_init(|| Mutex::new(Some(file)));
    Ok(path)
}

fn write_log(level: &str, msg: &str) {
    let ts = current_timestamp();
    let line = format!("[{}] [{}] {}\n", ts, level, msg);
    if let Some(lock) = LOG_FILE.get() {
        if let Ok(mut guard) = lock.lock() {
            if let Some(file) = guard.as_mut() {
                let _ = file.write_all(line.as_bytes());
                let _ = file.flush();
            }
        }
    }
}

/// ISO-8601 timestamp without an external crate.
fn current_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let (y, mo, day, h, mi, s) = unix_secs_to_datetime(d.as_secs());
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, mo, day, h, mi, s)
}

fn unix_secs_to_datetime(total_secs: u64) -> (u32, u32, u32, u32, u32, u32) {
    let hour = ((total_secs % 86400) / 3600) as u32;
    let min = ((total_secs % 3600) / 60) as u32;
    let sec = (total_secs % 60) as u32;
    let mut days = (total_secs / 86400) as u32;

    let mut year = 1970u32;
    loop {
        let y_days = if is_leap_year(year) { 366 } else { 365 };
        if days < y_days {
            break;
        }
        days -= y_days;
        year += 1;
    }

    let month_days: [u32; 12] = [
        31,
        if is_leap_year(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1u32;
    for &md in &month_days {
        if days < md {
            break;
        }
        days -= md;
        month += 1;
    }

    (year, month, days + 1, hour, min, sec)
}

fn is_leap_year(year: u32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

macro_rules! log_info {
    ($($arg:tt)*) => {{
        let msg = format!($($arg)*);
        println!("[mediasort] INFO: {}", msg);
        write_log("INFO", &msg);
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
    let reveal = DialogBuilder::message()
        .set_level(MessageLevel::Error)
        .set_title("MediaSorter could not start")
        .set_text(error.dialog_text())
        .confirm()
        .show()
        .unwrap_or(false);
    if reveal {
        if let Err(reveal_error) = reveal_in_file_manager(&error.log_path) {
            log_error!(
                "Reveal Log failed for {}: {}",
                error.log_path.display(),
                reveal_error
            );
            let _ = DialogBuilder::message()
                .set_level(MessageLevel::Error)
                .set_title("Could not reveal the log")
                .set_text(format!(
                    "Open this path manually:\n\n{}",
                    error.log_path.display()
                ))
                .alert()
                .show();
        }
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

struct BackendState {
    process: Arc<Mutex<Option<Child>>>,
    api_port: u16,
    api_capability: String,
}

#[derive(Serialize)]
struct ApiSession {
    port: u16,
    capability: String,
}

#[tauri::command]
fn get_api_session(state: State<BackendState>) -> ApiSession {
    ApiSession {
        port: state.api_port,
        capability: state.api_capability.clone(),
    }
}

/// The React root calls this after it has mounted inside the WebView.
///
/// Release CI sets `MEDIASORT_WEBVIEW_SMOKE=1`; a successful invocation proves
/// the packaged shell loaded its bundled frontend (not merely that the native
/// process started), records durable evidence, and exits cleanly. Normal
/// launches only record the ready marker and continue.
#[tauri::command]
fn frontend_ready(app: tauri::AppHandle) {
    log_info!("packaged_webview_frontend_ready");
    if std::env::var("MEDIASORT_WEBVIEW_SMOKE").as_deref() == Ok("1") {
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
    let url = format!("http://127.0.0.1:{}/api/health", port);
    ureq::get(&url)
        .set("X-MediaSorter-Capability", capability)
        .call()
        .map(|r| r.status() == 200)
        .unwrap_or(false)
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
/// the bind probe and the backend's bind. Returns (port, child).
fn acquire_backend(
    max_tries: u32,
    log_path: &std::path::Path,
    capability: &str,
) -> Result<(u16, Child), StartupError> {
    let mut attempted_ports = Vec::new();
    let mut failures = Vec::new();
    for attempt in 1..=max_tries {
        let port = find_available_port(log_path)?;
        attempted_ports.push(port);

        log_info!(
            "Spawning backend on port {} (attempt {}/{})",
            port,
            attempt,
            max_tries
        );
        let mut child = match spawn_backend(port, capability, log_path) {
            Ok(child) => child,
            Err(error) => {
                failures.push(error.detail);
                thread::sleep(Duration::from_millis(100));
                continue;
            }
        };

        // Quick liveness probe — if the backend can't bind, it dies fast.
        thread::sleep(Duration::from_millis(500));
        match child.try_wait() {
            Ok(Some(status)) => {
                failures.push(format!("port {} exited immediately with {}", port, status));
                let _ = child.wait();
                thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(error) => {
                failures.push(format!("port {} liveness check failed: {}", port, error));
                let _ = child.kill();
                let _ = child.wait();
                continue;
            }
            Ok(None) => {}
        }

        if let Err(error) = wait_for_backend(port, capability, 30, &mut child, log_path) {
            failures.push(error.detail);
            let _ = child.kill();
            let _ = child.wait();
            continue;
        }

        return Ok((port, child));
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

fn wait_for_backend(
    port: u16,
    capability: &str,
    max_attempts: u32,
    child: &mut Child,
    log_path: &std::path::Path,
) -> Result<(), StartupError> {
    let url = format!("http://127.0.0.1:{}/api/health", port);
    for attempt in 1..=max_attempts {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(StartupError::new(
                    StartupStage::Readiness,
                    "The MediaSorter backend exited before it became ready.",
                    format!(
                        "port={} attempt={}/{} status={}",
                        port, attempt, max_attempts, status
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
        if let Ok(response) = ureq::get(&url)
            .set("X-MediaSorter-Capability", capability)
            .call()
        {
            if response.status() == 200 {
                log_info!("Backend ready on port {}", port);
                return Ok(());
            }
        }
        if attempt == 1 || attempt % 5 == 0 {
            log_info!(
                "Waiting for backend to be ready… (attempt {}/{})",
                attempt,
                max_attempts
            );
        }
        if attempt < max_attempts {
            let delay_ms = (200u64 * attempt as u64).min(2000);
            thread::sleep(Duration::from_millis(delay_ms));
        }
    }
    Err(StartupError::new(
        StartupStage::Readiness,
        "The MediaSorter backend did not become ready in time.",
        format!(
            "health_url={} attempts={} child_id={}",
            url,
            max_attempts,
            child.id()
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
) -> Result<Child, StartupError> {
    command.spawn().map_err(|error| {
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
) -> Result<Child, StartupError> {
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
            .args([
                "-m",
                "uvicorn",
                "app.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
            ])
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

fn launch(log_path: &std::path::Path) -> Result<(), StartupError> {
    log_info!(
        "=== MediaSorter starting (pid={}) — logs: {} ===",
        std::process::id(),
        log_path.display()
    );

    if std::env::var("MEDIASORT_STARTUP_SMOKE_FAIL").as_deref() == Ok("1") {
        return Err(StartupError::new(
            StartupStage::Spawn,
            "Controlled packaged-startup failure reached the native recovery path.",
            "MEDIASORT_STARTUP_SMOKE_FAIL=1",
            log_path.to_path_buf(),
        ));
    }

    let api_capability = std::env::var("MEDIASORT_API_CAPABILITY").unwrap_or_else(|_| {
        rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(48)
            .map(char::from)
            .collect()
    });
    let (api_port, backend_child) =
        if cfg!(debug_assertions) && backend_is_ready(8000, &api_capability) {
            log_info!("Found existing backend on port 8000 (hot-reload mode)");
            (8000, None)
        } else {
            // Retry up to 5 times in case another process grabs a port between
            // our probe and the backend's bind (TOCTOU window).
            let (port, child) = acquire_backend(5, log_path, &api_capability)?;
            (port, Some(child))
        };

    log_info!("Starting Tauri window (backend port {})", api_port);

    let process = Arc::new(Mutex::new(backend_child));
    let process_on_build_error = Arc::clone(&process);
    let app = tauri::Builder::default()
        .manage(BackendState {
            process,
            api_port,
            api_capability,
        })
        .setup(|_app| Ok(()))
        .on_window_event(|global_window_event| {
            if let tauri::WindowEvent::Destroyed = global_window_event.event() {
                kill_backend(global_window_event.window().state::<BackendState>().inner());
            }
        })
        .invoke_handler(tauri::generate_handler![
            frontend_ready,
            get_api_session,
            reveal_path
        ])
        .build(tauri::generate_context!())
        .map_err(|error| {
            kill_process(&process_on_build_error);
            StartupError::new(
                StartupStage::Readiness,
                "MediaSorter could not create its desktop window.",
                error.to_string(),
                log_path.to_path_buf(),
            )
        })?;

    app.run(|app_handle, event| {
        // On macOS Cmd-Q (and other clean-exit paths) WindowEvent::Destroyed
        // may not fire before the process exits. RunEvent::Exit fires
        // reliably so we kill the backend there too.
        if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
            kill_backend(app_handle.state::<BackendState>().inner());
        }
    });
    Ok(())
}

fn main() {
    let fallback_log_path = log_dir().join("mediasort.log");
    let log_path = match init_logger() {
        Ok(path) => path,
        Err(error) => {
            show_fatal_startup_dialog(&error);
            std::process::exit(1);
        }
    };
    if let Err(error) = launch(&log_path) {
        show_fatal_startup_dialog(&error);
        if error.log_path != fallback_log_path {
            log_error!("fallback_log_path={}", fallback_log_path.display());
        }
        std::process::exit(1);
    }
}

fn kill_process(process: &Arc<Mutex<Option<Child>>>) {
    if let Ok(mut guard) = process.lock() {
        if let Some(mut child) = guard.take() {
            log_info!("Shutting down backend process");
            graceful_kill(&mut child);
            log_info!("Backend process stopped");
        }
    }
}

fn kill_backend(state: &BackendState) {
    kill_process(&state.process);
}

/// Stop the backend cleanly: SIGTERM so uvicorn can run the FastAPI lifespan
/// shutdown (cancel tasks, flush logs), then force-kill after a grace window.
#[cfg(unix)]
fn graceful_kill(child: &mut Child) {
    let _ = Command::new("kill")
        .arg("-TERM")
        .arg(child.id().to_string())
        .status();

    for _ in 0..30 {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(_) => break,
        }
    }

    let _ = child.kill();
    let _ = child.wait();
}

/// On non-Unix platforms there's no portable graceful signal, so terminate
/// directly and reap.
#[cfg(not(unix))]
fn graceful_kill(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
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
        let mut child = Command::new("sh")
            .args(["-c", "exit 7"])
            .spawn()
            .expect("spawn fixture");
        let fixture_status = child.wait().expect("wait for fixture");
        assert_eq!(fixture_status.code(), Some(7));
        let error = wait_for_backend(
            9,
            "test-capability",
            1,
            &mut child,
            std::path::Path::new("/tmp/mediasort.log"),
        )
        .expect_err("child exit should fail readiness");
        assert_eq!(error.stage, StartupStage::Readiness);
        assert!(error.detail.contains("status"));
    }

    #[cfg(unix)]
    #[test]
    fn process_guard_reaps_a_running_child() {
        let child = Command::new("sh")
            .args(["-c", "sleep 30"])
            .spawn()
            .expect("spawn fixture");
        let process = Arc::new(Mutex::new(Some(child)));
        kill_process(&process);
        assert!(process.lock().expect("process mutex").is_none());
    }

    #[test]
    fn windows_release_subsystem_guard_remains_in_source() {
        let source = include_str!("main.rs");
        assert!(source.contains("windows_subsystem = \"windows\""));
    }
}
