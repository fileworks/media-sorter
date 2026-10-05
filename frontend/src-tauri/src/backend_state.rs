//! Own the child from creation through shutdown, including an unfinished startup.
use std::process::ExitStatus;
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use super::{ApiSession, OwnedBackend, StartupError, StartupStage};

#[derive(Default)]
struct Inner {
    closed: bool,
    child: Option<OwnedBackend>,
    session: Option<Result<ApiSession, StartupError>>,
}

#[derive(Default)]
pub(super) struct BackendStartup {
    inner: Mutex<Inner>,
    changed: Condvar,
}

impl BackendStartup {
    fn stopped() -> StartupError {
        StartupError::new(
            StartupStage::Readiness,
            "MediaSorter is closing.",
            "backend startup cancelled by window shutdown",
            super::log_dir().join("mediasort.log"),
        )
    }

    pub(super) fn spawn(
        &self,
        create: impl FnOnce() -> Result<OwnedBackend, StartupError>,
    ) -> Result<u32, StartupError> {
        // Closing and publishing a newly created child must be atomic. The lock
        // is held only for process creation, never during readiness polling.
        let mut inner = self.inner.lock().expect("backend startup mutex");
        if inner.closed {
            return Err(Self::stopped());
        }
        let child = create()?;
        let id = child.id();
        inner.child = Some(child);
        Ok(id)
    }

    pub(super) fn probe(&self) -> Result<Option<ExitStatus>, StartupError> {
        let mut inner = self.inner.lock().expect("backend startup mutex");
        if inner.closed {
            return Err(Self::stopped());
        }
        inner
            .child
            .as_mut()
            .ok_or_else(Self::stopped)?
            .try_wait()
            .map_err(|error| {
                StartupError::new(
                    StartupStage::Readiness,
                    "MediaSorter could not inspect the backend process.",
                    error.to_string(),
                    super::log_dir().join("mediasort.log"),
                )
            })
    }

    pub(super) fn stop_process(&self) {
        let child = self
            .inner
            .lock()
            .expect("backend startup mutex")
            .child
            .take();
        if let Some(mut child) = child {
            super::write_log("INFO", "Shutting down backend process");
            child.stop();
            super::write_log("INFO", "Backend process stopped");
        }
    }

    pub(super) fn finish(&self, session: Result<ApiSession, StartupError>) {
        let mut inner = self.inner.lock().expect("backend startup mutex");
        if !inner.closed {
            inner.session = Some(session);
        }
        self.changed.notify_all();
    }

    pub(super) fn session(&self) -> Result<ApiSession, StartupError> {
        let mut inner = self.inner.lock().expect("backend startup mutex");
        loop {
            if let Some(session) = &inner.session {
                return session.clone();
            }
            inner = self.changed.wait(inner).expect("backend startup mutex");
        }
    }

    pub(super) fn is_closed(&self) -> bool {
        self.inner.lock().expect("backend startup mutex").closed
    }

    /// Interrupt retry delays immediately when the window is closed.
    pub(super) fn wait_or_closed(&self, delay: Duration) -> bool {
        let inner = self.inner.lock().expect("backend startup mutex");
        let (inner, _) = self
            .changed
            .wait_timeout_while(inner, delay, |inner| !inner.closed)
            .expect("backend startup mutex");
        inner.closed
    }

    pub(super) fn close(&self) {
        {
            let mut inner = self.inner.lock().expect("backend startup mutex");
            inner.closed = true;
            inner.session = Some(Err(Self::stopped()));
            self.changed.notify_all();
        }
        self.stop_process();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn session_waits_for_readiness_and_preserves_capability() {
        let state = Arc::new(BackendStartup::default());
        let waiting = Arc::clone(&state);
        let waiter = thread::spawn(move || waiting.session());
        assert!(!waiter.is_finished());
        state.finish(Ok(ApiSession {
            port: 1234,
            capability: "fixture-capability".into(),
        }));
        let session = waiter.join().expect("waiter").expect("ready session");
        assert_eq!(session.port, 1234);
        assert_eq!(session.capability, "fixture-capability");
    }

    #[test]
    fn close_releases_pending_ipc_and_cannot_be_overwritten_by_readiness() {
        let state = Arc::new(BackendStartup::default());
        let waiting = Arc::clone(&state);
        let waiter = thread::spawn(move || waiting.session());
        state.close();
        state.finish(Ok(ApiSession {
            port: 1234,
            capability: "fixture".into(),
        }));
        assert!(waiter.join().expect("waiter").is_err());
        let mut called = false;
        assert!(state
            .spawn(|| {
                called = true;
                unreachable!()
            })
            .is_err());
        assert!(!called);
    }

    #[test]
    fn startup_failure_is_delivered_to_pending_ipc() {
        let state = BackendStartup::default();
        let error = StartupError::new(
            StartupStage::Spawn,
            "Unavailable",
            "fixture detail",
            "/tmp/log".into(),
        );
        state.finish(Err(error.clone()));
        assert_eq!(state.session().expect_err("startup failed"), error);
    }

    #[test]
    fn close_reaps_child_before_readiness() {
        let state = BackendStartup::default();
        let mut command = if cfg!(windows) {
            let mut command =
                std::process::Command::new(std::env::current_exe().expect("test executable"));
            command.args([
                "--exact",
                "backend_state::tests::child_wait_fixture",
                "--ignored",
            ]);
            command
        } else {
            let mut command = std::process::Command::new("sleep");
            command.arg("30");
            command
        };
        state
            .spawn(|| {
                super::super::spawn_with_startup_error(
                    &mut command,
                    "fixture",
                    "fixture".into(),
                    std::path::Path::new("/tmp/log"),
                )
            })
            .expect("spawn");
        state.close();
        assert!(state.inner.lock().expect("mutex").child.is_none());
        assert!(state.session().is_err());
    }

    #[test]
    #[ignore = "only launched as the controlled child of close_reaps_child_before_readiness"]
    fn child_wait_fixture() {
        thread::sleep(Duration::from_secs(30));
    }

    #[cfg(windows)]
    #[test]
    fn close_terminates_backend_descendants() {
        assert_descendants_stop(true);
    }

    #[cfg(windows)]
    #[test]
    fn dropping_backend_terminates_descendants() {
        assert_descendants_stop(false);
    }

    #[cfg(windows)]
    fn assert_descendants_stop(explicit_close: bool) {
        use std::ffi::c_void;
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
            fn WaitForSingleObject(handle: *mut c_void, timeout: u32) -> u32;
            fn TerminateProcess(handle: *mut c_void, code: u32) -> i32;
            fn CloseHandle(handle: *mut c_void) -> i32;
        }
        let path =
            std::env::temp_dir().join(format!("mediasorter-child-{}.pid", rand::random::<u64>()));
        let state = BackendStartup::default();
        let mut command =
            std::process::Command::new(std::env::current_exe().expect("test executable"));
        command
            .args([
                "--exact",
                "backend_state::tests::descendant_fixture",
                "--ignored",
            ])
            .env("MEDIASORT_TEST_CHILD_PID", &path);
        state
            .spawn(|| {
                super::super::spawn_with_startup_error(
                    &mut command,
                    "fixture",
                    "fixture".into(),
                    std::path::Path::new("/tmp/log"),
                )
            })
            .expect("spawn fixture");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !path.exists() && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let pid: u32 = std::fs::read_to_string(&path)
            .expect("descendant pid")
            .parse()
            .expect("pid");
        // SAFETY: the fixture reports its own child; retain its process handle
        // so PID reuse cannot target another application's process.
        let handle = unsafe { OpenProcess(0x0010_0001, 0, pid) };
        assert!(!handle.is_null());
        if explicit_close {
            state.close();
        } else {
            drop(state);
        }
        // Always clean up the controlled descendant, even on the regression.
        let stopped = unsafe { WaitForSingleObject(handle, 2000) } == 0;
        if !stopped {
            unsafe {
                TerminateProcess(handle, 1);
                WaitForSingleObject(handle, 2000);
            }
        }
        unsafe {
            CloseHandle(handle);
        }
        std::fs::remove_file(path).expect("remove fixture pid");
        assert!(stopped, "closing the backend left its descendant running");
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "controlled child fixture for close_terminates_backend_descendants"]
    fn descendant_fixture() {
        use std::os::windows::process::CommandExt;
        let mut child =
            std::process::Command::new(std::env::current_exe().expect("test executable"))
                .args([
                    "--exact",
                    "backend_state::tests::child_wait_fixture",
                    "--ignored",
                ])
                .creation_flags(0x0800_0000)
                .spawn()
                .expect("spawn descendant");
        std::fs::write(
            std::env::var_os("MEDIASORT_TEST_CHILD_PID").expect("fixture pid path"),
            child.id().to_string(),
        )
        .expect("write pid");
        thread::sleep(Duration::from_secs(30));
        let _ = child.wait();
    }

    #[cfg(windows)]
    #[test]
    fn spawned_console_backend_has_no_console_window() {
        let mut command =
            std::process::Command::new(std::env::current_exe().expect("test executable"));
        command.args([
            "--exact",
            "backend_state::tests::console_probe_fixture",
            "--ignored",
        ]);
        let mut child = super::super::spawn_with_startup_error(
            &mut command,
            "fixture",
            "fixture".into(),
            std::path::Path::new("/tmp/log"),
        )
        .expect("spawn console fixture");
        assert!(child.wait().expect("wait console fixture").success());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "only launched as the controlled child of spawned_console_backend_has_no_console_window"]
    fn console_probe_fixture() {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetConsoleWindow() -> *mut std::ffi::c_void;
        }
        // SAFETY: GetConsoleWindow takes no pointers and only queries this
        // disposable fixture process's console handle.
        assert!(unsafe { GetConsoleWindow() }.is_null());
    }
}
