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

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

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
//   Windows: %APPDATA%\MediaSorter\logs\mediasort.log
//   Linux:   ~/.local/share/mediasort/logs/mediasort.log

static LOG_FILE: OnceLock<Mutex<Option<File>>> = OnceLock::new();

fn log_dir() -> PathBuf {
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
        PathBuf::from(base).join("MediaSorter").join("logs")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let xdg = std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
            format!("{}/.local/share", home)
        });
        PathBuf::from(xdg).join("mediasort/logs")
    }
}

/// Open (or rotate) the log file and register it in LOG_FILE.
/// Returns the path so the startup banner can report where logs live.
fn init_logger() -> PathBuf {
    let dir = log_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("mediasort.log");

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
        .ok();

    if file.is_none() {
        eprintln!(
            "[mediasort] WARNING: Could not open log file at {}; logging to console only",
            path.display()
        );
    }

    LOG_FILE.get_or_init(|| Mutex::new(file));
    path
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
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
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

// ── Tauri commands ────────────────────────────────────────────────────────────

struct BackendState {
    process: Mutex<Option<Child>>,
    api_port: u16,
}

#[tauri::command]
fn get_api_port(state: State<BackendState>) -> u16 {
    state.api_port
}

/// Reveal a file in the OS file manager (Finder / Explorer / file browser),
/// selecting it where the platform supports it. Best-effort: the spawn is
/// non-blocking and any failure is logged rather than surfaced.
#[tauri::command]
fn reveal_path(path: String) {
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg("-R").arg(&path).spawn();

    #[cfg(target_os = "windows")]
    let result = Command::new("explorer")
        .arg(format!("/select,{}", path))
        .spawn();

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result = {
        // No portable "select the file" on Linux — open its parent directory.
        let dir = PathBuf::from(&path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from(&path));
        Command::new("xdg-open").arg(dir).spawn()
    };

    if let Err(e) = result {
        log_error!("reveal_path failed for {}: {}", path, e);
    }
}

// ── Port negotiation ─────────────────────────────────────────────────────────

fn backend_is_ready(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/api/health", port);
    ureq::get(&url)
        .call()
        .map(|r| r.status() == 200)
        .unwrap_or(false)
}

/// Ask the OS for a free loopback port by binding to port 0, then release it so
/// the backend can claim it. Between the release and the child's own bind there
/// is a race window; `acquire_backend` retries to close it.
fn find_available_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap_or_else(|e| {
        let msg = format!(
            "Could not open a local port for the backend: {}\n\
            \n\
            This usually means a firewall or security tool is blocking loopback\n\
            connections. Check the log file at:\n  {}",
            e,
            log_dir().join("mediasort.log").display(),
        );
        log_error!("FATAL — {}", msg);
        panic!("{}", msg);
    });

    listener
        .local_addr()
        .expect("a bound TcpListener always has a local address")
        .port()
}

/// Try to acquire a working port, retrying if another process beats us between
/// the bind probe and the backend's bind. Returns (port, child).
fn acquire_backend(max_tries: u32) -> (u16, Child) {
    let mut attempted_ports = Vec::new();
    for attempt in 1..=max_tries {
        let port = find_available_port();
        attempted_ports.push(port);

        log_info!("Spawning backend on port {} (attempt {}/{})", port, attempt, max_tries);
        let mut child = spawn_backend(port);

        // Quick liveness probe — if the backend can't bind, it dies fast.
        let alive_after_short_wait = {
            thread::sleep(Duration::from_millis(500));
            child.try_wait().ok().flatten().is_none()
        };
        if !alive_after_short_wait {
            log_warn!(
                "Backend exited immediately on port {} (port may have been claimed by another process); retrying.",
                port
            );
            let _ = child.wait(); // reap the zombie so it doesn't linger in the process table
            thread::sleep(Duration::from_millis(100));
            continue;
        }

        // Wrap health check in a catch-all so child is never orphaned if it panics.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            wait_for_backend(port, 30);
        }));
        if result.is_err() {
            log_error!(
                "Backend health check failed unexpectedly on port {}; killing process and retrying.",
                port
            );
            let _ = child.kill();
            let _ = child.wait();
            continue;
        }

        return (port, child);
    }

    let error_msg = format!(
        "The backend failed to start after {} attempts.\n\
        Tried ports: {}\n\
        \n\
        The ports were assigned by the operating system, so a port conflict is\n\
        unlikely — the backend process itself is most likely crashing on startup.\n\
        \n\
        How to fix:\n\
        1. Restart MediaSorter\n\
        2. If it still fails, the log file below records why the backend exited\n\
        \n\
        Log file:\n  {}",
        max_tries,
        attempted_ports
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join(", "),
        log_dir().join("mediasort.log").display(),
    );

    log_error!("FATAL — {}", error_msg);
    panic!("{}", error_msg);
}

fn wait_for_backend(port: u16, max_attempts: u32) {
    let url = format!("http://127.0.0.1:{}/api/health", port);
    for attempt in 1..=max_attempts {
        if let Ok(response) = ureq::get(&url).call() {
            if response.status() == 200 {
                log_info!("Backend ready on port {}", port);
                return;
            }
        }
        if attempt == 1 || attempt % 5 == 0 {
            log_info!("Waiting for backend to be ready… (attempt {}/{})", attempt, max_attempts);
        }
        if attempt < max_attempts {
            let delay_ms = (200u64 * attempt as u64).min(2000);
            thread::sleep(Duration::from_millis(delay_ms));
        }
    }
    let msg = format!(
        "Backend failed to start on port {} after {} attempts. \
        The backend process may have crashed or is not responding. \
        Try restarting MediaSorter.",
        port, max_attempts
    );
    log_error!("{}", msg);
    panic!("{}", msg);
}

// ── Path resolution ───────────────────────────────────────────────────────────

/// Returns the backend directory:
/// - Dev: `<repo>/backend` (relative to CARGO_MANIFEST_DIR)
/// - Release: `<AppBundle>/Resources/backend` (PyInstaller output)
fn resolve_backend_dir() -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let manifest = std::env!("CARGO_MANIFEST_DIR");
        let p = PathBuf::from(manifest).join("../../../backend");
        p.canonicalize().unwrap_or(p)
    }

    #[cfg(not(debug_assertions))]
    {
        let exe = std::env::current_exe().expect("Cannot locate executable");
        let app_dir = exe.parent().expect("Cannot locate app directory");
        #[cfg(target_os = "macos")]
        return app_dir.join("../Resources/resources/backend");
        #[cfg(target_os = "windows")]
        return app_dir.join("../resources/resources/backend");
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        return app_dir.join("resources/backend");
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
        return Some(app_dir.join("../resources/resources/ffmpeg"));
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        return Some(app_dir.join("resources/ffmpeg"));
    }
}

/// Prepend the bundled ffmpeg directory to PATH (release) or leave it unchanged (dev).
fn build_path_with_ffmpeg() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    match resolve_ffmpeg_dir() {
        Some(dir) => {
            let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
            format!("{}{}{}", dir.display(), sep, current)
        }
        None => current,
    }
}

// ── Backend launcher ──────────────────────────────────────────────────────────

fn spawn_backend(port: u16) -> Child {
    let path_env = build_path_with_ffmpeg();

    #[cfg(debug_assertions)]
    {
        let backend_dir = resolve_backend_dir();
        let python = if cfg!(target_os = "windows") { "python.exe" } else { "python3" };

        Command::new(python)
            .args([
                "-m", "uvicorn", "app.main:app",
                "--host", "127.0.0.1",
                "--port", &port.to_string(),
            ])
            .env("MEDIASORT_PORT", port.to_string())
            .env("MEDIASORT_LOG_LEVEL", "info")
            .env("PATH", &path_env)
            .current_dir(&backend_dir)
            .spawn()
            .unwrap_or_else(|e| {
                log_error!("Failed to spawn backend: {}", e);
                panic!("Failed to spawn backend: {}", e)
            })
    }

    #[cfg(not(debug_assertions))]
    {
        let backend_dir = resolve_backend_dir();
        let exe_name = if cfg!(target_os = "windows") {
            "mediasort-backend.exe"
        } else {
            "mediasort-backend"
        };
        let exe_path = backend_dir.join(exe_name);

        log_info!("backend_dir: {}", backend_dir.display());
        log_info!("exe_path: {} (exists={})", exe_path.display(), exe_path.exists());
        log_info!("PATH: {}", path_env);

        Command::new(&exe_path)
            .env("MEDIASORT_PORT", port.to_string())
            .env("MEDIASORT_LOG_LEVEL", "info")
            .env("PATH", &path_env)
            .spawn()
            .unwrap_or_else(|e| {
                log_error!("Failed to spawn bundled backend at {}: {}", exe_path.display(), e);
                panic!("Failed to spawn bundled backend at {}: {}", exe_path.display(), e)
            })
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

fn main() {
    let log_path = init_logger();
    log_info!(
        "=== MediaSorter starting (pid={}) — logs: {} ===",
        std::process::id(),
        log_path.display()
    );

    let (api_port, backend_child) = if cfg!(debug_assertions) && backend_is_ready(8000) {
        log_info!("Found existing backend on port 8000 (hot-reload mode)");
        (8000, None)
    } else {
        // Retry up to 5 times in case another process grabs a port between
        // our probe and the backend's bind (TOCTOU window).
        let (port, child) = acquire_backend(5);
        (port, Some(child))
    };

    log_info!("Starting Tauri window (backend port {})", api_port);

    tauri::Builder::default()
        .manage(BackendState {
            process: Mutex::new(backend_child),
            api_port,
        })
        .setup(|_app| Ok(()))
        .on_window_event(|global_window_event| {
            if let tauri::WindowEvent::Destroyed = global_window_event.event() {
                kill_backend(global_window_event.window().state::<BackendState>().inner());
            }
        })
        .invoke_handler(tauri::generate_handler![get_api_port, reveal_path])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // On macOS Cmd-Q (and other clean-exit paths) WindowEvent::Destroyed
            // may not fire before the process exits. RunEvent::Exit fires
            // reliably so we kill the backend there too.
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                kill_backend(app_handle.state::<BackendState>().inner());
            }
        });
}

fn kill_backend(state: &BackendState) {
    if let Ok(mut guard) = state.process.lock() {
        if let Some(mut child) = guard.take() {
            log_info!("Shutting down backend process");
            graceful_kill(&mut child);
            log_info!("Backend process stopped");
        }
    }
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
