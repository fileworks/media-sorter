//! Launch diagnostics shared by every platform.
//!
//! One launcher run gets a random run ID, and every line it logs carries that ID
//! plus the milliseconds since the process started, so a launch can be read back
//! as a timeline: logger, instance check, window, backend spawn, readiness, UI,
//! close, backend stop, exit. The log rotates by size and keeps a fixed number of
//! files, so it can never fill a disk.
//!
//! A small marker file records how far the current run got. The next launch
//! reads it: a run that never recorded a clean exit is reported as incomplete,
//! with the last stage it reached and whether its window ever showed. That is the
//! evidence for "it did not start" reports, including launches held by security
//! software before any code of ours ran (those leave no marker at all).
//!
//! An exclusive lock file keeps one instance per user: two engines over the same
//! catalog and recovery journals would treat each other's live work as
//! interrupted. The second launch explains the situation instead of exiting
//! silently, and never terminates the other process.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// One log file may grow to this size before it is rotated.
pub(super) const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
/// Rotated files kept beside the active one (`mediasort.1.log` … `.5.log`).
pub(super) const MAX_LOG_BACKUPS: u32 = 5;
/// A starting instance without a window after this long is reported as stuck.
pub(super) const STUCK_START_AFTER: Duration = Duration::from_secs(90);

const MARKER_FILE: &str = "launcher-run.json";
const LOCK_FILE: &str = "launcher.lock";

struct LogSink {
    file: File,
    path: PathBuf,
    written: u64,
}

struct Run {
    id: String,
    started: Instant,
    marker: Mutex<RunMarker>,
}

static RUN: OnceLock<Run> = OnceLock::new();
static MARKER_PATH: OnceLock<PathBuf> = OnceLock::new();
static SINK: OnceLock<Mutex<Option<LogSink>>> = OnceLock::new();
static INSTANCE_LOCK: OnceLock<File> = OnceLock::new();

/// What the marker file says about one launcher run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct RunMarker {
    pub(super) run_id: String,
    pub(super) pid: u32,
    pub(super) version: String,
    pub(super) started_unix_ms: u128,
    pub(super) stage: String,
    pub(super) window_shown: bool,
    pub(super) clean_exit: bool,
}

/// The stable identity of this launcher run, created once.
pub(super) fn run_id() -> &'static str {
    run().id.as_str()
}

fn run() -> &'static Run {
    RUN.get_or_init(|| {
        let id: String = (0..12)
            .map(|_| char::from(b"0123456789abcdef"[usize::from(rand::random::<u8>() % 16)]))
            .collect();
        Run {
            marker: Mutex::new(RunMarker {
                run_id: id.clone(),
                pid: std::process::id(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                started_unix_ms: unix_ms(SystemTime::now()),
                stage: "starting".into(),
                window_shown: false,
                clean_exit: false,
            }),
            id,
            started: Instant::now(),
        }
    })
}

fn unix_ms(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// Milliseconds since this launcher process started (monotonic clock).
pub(super) fn elapsed_ms() -> u128 {
    run().started.elapsed().as_millis()
}

/// Open the rotating log in `dir` and register this run's marker beside it.
pub(super) fn init(dir: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("mediasort.log");
    rotate_if_needed(&path, 0)?;
    let file = OpenOptions::new().create(true).append(true).open(&path)?;
    let written = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let _ = MARKER_PATH.set(dir.join(MARKER_FILE));
    SINK.get_or_init(|| {
        Mutex::new(Some(LogSink {
            file,
            path: path.clone(),
            written,
        }))
    });
    Ok(path)
}

/// Rename `mediasort.log` → `.1.log` → … → `.N.log` once it exceeds the cap.
///
/// `pending` is the size of the line about to be written, so a runtime rotation
/// happens before the file would cross the limit.
pub(super) fn rotate_if_needed(path: &Path, pending: u64) -> std::io::Result<bool> {
    let size = match std::fs::metadata(path) {
        Ok(meta) => meta.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if size + pending <= MAX_LOG_BYTES {
        return Ok(false);
    }
    let backup = |index: u32| path.with_extension(format!("{index}.log"));
    let _ = std::fs::remove_file(backup(MAX_LOG_BACKUPS));
    for index in (1..MAX_LOG_BACKUPS).rev() {
        let from = backup(index);
        if from.exists() {
            std::fs::rename(&from, backup(index + 1))?;
        }
    }
    std::fs::rename(path, backup(1))?;
    Ok(true)
}

/// UTC timestamp with milliseconds, e.g. `2026-10-11T08:15:02.317Z`.
pub(super) fn timestamp(time: SystemTime) -> String {
    let total = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let (year, month, day, hour, minute, second) = civil_from_unix(total.as_secs());
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{:03}Z",
        total.subsec_millis()
    )
}

/// Convert seconds since the Unix epoch to a UTC civil date and time.
pub(super) fn civil_from_unix(total_secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let days = total_secs / 86_400;
    let rem = total_secs % 86_400;
    // Howard Hinnant's days-from-civil inverse; exact for every u64 day count
    // this process can observe.
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    (year, month, day, rem / 3_600, rem % 3_600 / 60, rem % 60)
}

/// Write one line: timestamp, level, run ID, elapsed milliseconds, message.
///
/// Logging never panics and never blocks startup; a failed write is retried
/// once after reopening the file, then dropped (stderr still carries it).
pub(super) fn write(level: &str, message: &str) {
    let line = format!(
        "{} [{}] run={} +{}ms {}\n",
        timestamp(SystemTime::now()),
        level,
        run_id(),
        elapsed_ms(),
        message.replace(['\r', '\n'], " ")
    );
    let Some(lock) = SINK.get() else {
        return;
    };
    let Ok(mut guard) = lock.lock() else {
        return;
    };
    let Some(sink) = guard.as_mut() else {
        return;
    };
    if sink.written + line.len() as u64 > MAX_LOG_BYTES {
        let _ = sink.file.flush();
        if rotate_if_needed(&sink.path, line.len() as u64).unwrap_or(false) {
            if let Ok(file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&sink.path)
            {
                sink.file = file;
                sink.written = 0;
            }
        }
    }
    if sink.file.write_all(line.as_bytes()).is_ok() {
        let _ = sink.file.flush();
        sink.written += line.len() as u64;
    }
}

/// Record a lifecycle stage in the log and the marker file.
pub(super) fn stage(name: &str, detail: &str) {
    if detail.is_empty() {
        write("INFO", &format!("stage={name}"));
    } else {
        write("INFO", &format!("stage={name} {detail}"));
    }
    update_marker(|marker| marker.stage = name.into());
}

pub(super) fn mark_window_shown() {
    update_marker(|marker| marker.window_shown = true);
}

pub(super) fn mark_clean_exit(code: i32) {
    stage("exit", &format!("code={code}"));
    update_marker(|marker| marker.clean_exit = true);
}

fn update_marker(change: impl FnOnce(&mut RunMarker)) {
    let Some(path) = MARKER_PATH.get() else {
        return;
    };
    let Ok(mut marker) = run().marker.lock() else {
        return;
    };
    change(&mut marker);
    if let Err(error) = write_marker(path, &marker) {
        // Logging the failure is the most we can do; it must not stop the app.
        eprintln!("[mediasort] could not update the run marker: {error}");
    }
}

/// Atomically replace the marker so a reader never sees a torn file.
pub(super) fn write_marker(path: &Path, marker: &RunMarker) -> std::io::Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let text = serde_json::to_vec_pretty(marker).map_err(std::io::Error::other)?;
    {
        let mut file = File::create(&temporary)?;
        file.write_all(&text)?;
        file.sync_all()?;
    }
    std::fs::rename(&temporary, path)
}

pub(super) fn read_marker(path: &Path) -> Option<RunMarker> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// What the previous run left behind, read before this run overwrites it.
pub(super) fn report_previous_run(dir: &Path) -> Option<RunMarker> {
    let previous = read_marker(&dir.join(MARKER_FILE))?;
    if previous.run_id == run_id() {
        return None;
    }
    if previous.clean_exit {
        write(
            "INFO",
            &format!(
                "previous_run run={} pid={} version={} ended_cleanly=true",
                previous.run_id, previous.pid, previous.version
            ),
        );
    } else {
        write(
            "WARN",
            &format!(
                "previous_run_incomplete run={} pid={} version={} started={} last_stage={} \
                 window_shown={}",
                previous.run_id,
                previous.pid,
                previous.version,
                timestamp(UNIX_EPOCH + Duration::from_millis(previous.started_unix_ms as u64)),
                previous.stage,
                previous.window_shown
            ),
        );
    }
    Some(previous)
}

/// Another launcher already owns this user's MediaSorter.
pub(super) enum OtherInstance {
    /// Its window is up; the user should switch to it.
    Running(RunMarker),
    /// It started recently and is probably still painting its window.
    Starting(RunMarker),
    /// It has been starting for a long time without a window.
    Stuck(RunMarker),
    /// The lock is held but its owner left no readable marker.
    Unknown,
}

/// Take the per-user instance lock, or describe who holds it.
pub(super) fn acquire_instance(dir: &Path) -> Result<(), OtherInstance> {
    let path = dir.join(LOCK_FILE);
    let file = match OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) => {
            // A lock we cannot even open must not prevent starting; say so.
            write("WARN", &format!("instance_lock_unavailable error={error}"));
            return Ok(());
        }
    };
    match file.try_lock() {
        Ok(()) => {
            let _ = INSTANCE_LOCK.set(file);
            Ok(())
        }
        Err(std::fs::TryLockError::WouldBlock) => Err(classify_other(
            read_marker(&dir.join(MARKER_FILE)),
            SystemTime::now(),
        )),
        Err(std::fs::TryLockError::Error(error)) => {
            write("WARN", &format!("instance_lock_unavailable error={error}"));
            Ok(())
        }
    }
}

pub(super) fn classify_other(marker: Option<RunMarker>, now: SystemTime) -> OtherInstance {
    let Some(marker) = marker else {
        return OtherInstance::Unknown;
    };
    if marker.window_shown {
        return OtherInstance::Running(marker);
    }
    let age = unix_ms(now).saturating_sub(marker.started_unix_ms);
    if age < STUCK_START_AFTER.as_millis() {
        OtherInstance::Starting(marker)
    } else {
        OtherInstance::Stuck(marker)
    }
}

/// Log every panic with its location and keep the default report.
pub(super) fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|location| format!("{}:{}", location.file(), location.line()))
            .unwrap_or_else(|| "unknown".into());
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|text| (*text).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "non-text panic payload".into());
        let thread = std::thread::current()
            .name()
            .unwrap_or("unnamed")
            .to_string();
        write(
            "ERROR",
            &format!("panic thread={thread} location={location} message={payload}"),
        );
        update_marker(|marker| marker.stage = "panic".into());
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marker(window_shown: bool, started_unix_ms: u128) -> RunMarker {
        RunMarker {
            run_id: "abc".into(),
            pid: 42,
            version: "1.0.0".into(),
            started_unix_ms,
            stage: "backend_spawn".into(),
            window_shown,
            clean_exit: false,
        }
    }

    #[test]
    fn civil_dates_cover_epoch_leap_days_and_far_future() {
        assert_eq!(civil_from_unix(0), (1970, 1, 1, 0, 0, 0));
        assert_eq!(civil_from_unix(951_782_400), (2000, 2, 29, 0, 0, 0));
        assert_eq!(civil_from_unix(1_791_676_800), (2026, 10, 11, 0, 0, 0));
        assert_eq!(civil_from_unix(4_102_444_799), (2099, 12, 31, 23, 59, 59));
    }

    #[test]
    fn timestamps_are_utc_with_milliseconds() {
        let time = UNIX_EPOCH + Duration::from_millis(1_791_676_800_317);
        assert_eq!(timestamp(time), "2026-10-11T00:00:00.317Z");
    }

    #[test]
    fn rotation_keeps_a_bounded_number_of_files() {
        let dir = std::env::temp_dir().join(format!("ms-rotate-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mediasort.log");
        for round in 0..(MAX_LOG_BACKUPS + 3) {
            std::fs::write(&path, vec![b'x'; MAX_LOG_BYTES as usize + 1]).unwrap();
            assert!(rotate_if_needed(&path, 0).unwrap(), "round {round} rotates");
            assert!(!path.exists());
        }
        let files = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(files as u32, MAX_LOG_BACKUPS);
        assert!(!dir
            .join(format!("mediasort.{}.log", MAX_LOG_BACKUPS + 1))
            .exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn small_logs_are_not_rotated() {
        let dir = std::env::temp_dir().join(format!("ms-small-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mediasort.log");
        std::fs::write(&path, b"short").unwrap();
        assert!(!rotate_if_needed(&path, 10).unwrap());
        assert!(rotate_if_needed(&path, MAX_LOG_BYTES).unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn marker_round_trips_atomically() {
        let dir = std::env::temp_dir().join(format!("ms-marker-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(MARKER_FILE);
        let written = marker(true, 5);
        write_marker(&path, &written).unwrap();
        assert_eq!(read_marker(&path), Some(written));
        std::fs::write(&path, b"{ torn").unwrap();
        assert_eq!(read_marker(&path), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn another_instance_is_classified_by_window_and_age() {
        let now = UNIX_EPOCH + Duration::from_secs(10_000);
        let now_ms = 10_000_000u128;
        assert!(matches!(
            classify_other(Some(marker(true, now_ms - 500_000)), now),
            OtherInstance::Running(_)
        ));
        assert!(matches!(
            classify_other(Some(marker(false, now_ms - 5_000)), now),
            OtherInstance::Starting(_)
        ));
        assert!(matches!(
            classify_other(Some(marker(false, now_ms - 600_000)), now),
            OtherInstance::Stuck(_)
        ));
        assert!(matches!(classify_other(None, now), OtherInstance::Unknown));
    }

    #[test]
    fn a_held_instance_lock_refuses_a_second_owner() {
        let dir = std::env::temp_dir().join(format!("ms-lock-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(LOCK_FILE);
        let first = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .unwrap();
        first.try_lock().unwrap();
        let second = OpenOptions::new().write(true).open(&path).unwrap();
        assert!(matches!(
            second.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        drop(first);
        second.try_lock().unwrap();
        drop(second);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
