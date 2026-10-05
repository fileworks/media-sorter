//! OS ownership of the backend tree; no process-name matching or PID snapshots.
use std::io;
use std::process::{Command, ExitStatus};
use std::time::{Duration, Instant};

pub(super) struct OwnedBackend {
    process: platform::Process,
    session: Option<super::ApiSession>,
}

impl std::fmt::Debug for OwnedBackend {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OwnedBackend")
            .field("pid", &self.id())
            .finish_non_exhaustive()
    }
}

impl OwnedBackend {
    pub(super) fn spawn(command: &mut Command) -> io::Result<Self> {
        Ok(Self {
            process: platform::Process::spawn(command)?,
            session: None,
        })
    }

    pub(super) fn set_session(&mut self, port: u16, capability: &str) {
        self.session = Some(super::ApiSession {
            port,
            capability: capability.into(),
        });
    }

    pub(super) fn id(&self) -> u32 {
        self.process.id()
    }
    pub(super) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.process.try_wait()
    }

    #[cfg(test)]
    pub(super) fn wait(&mut self) -> io::Result<ExitStatus> {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Some(status) = self.try_wait()? {
                return Ok(status);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "backend fixture did not exit",
        ))
    }

    pub(super) fn stop(&mut self) {
        if let Some(session) = self.session.take() {
            let accepted = ureq::post(&format!(
                "http://127.0.0.1:{}/api/health/shutdown",
                session.port
            ))
            .header("X-MediaSorter-Capability", &session.capability)
            .config()
            .timeout_global(Some(Duration::from_millis(500)))
            .build()
            .send_empty()
            .map(|response| response.status().as_u16() == 200)
            .unwrap_or(false);
            if accepted {
                let deadline = Instant::now() + Duration::from_secs(5);
                while Instant::now() < deadline && matches!(self.try_wait(), Ok(None)) {
                    std::thread::sleep(Duration::from_millis(25));
                }
            }
        }
        self.process.stop();
    }
}

impl Drop for OwnedBackend {
    fn drop(&mut self) {
        self.process.stop();
    }
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::Child;

    pub(super) struct Process {
        child: Child,
        stopped: bool,
    }
    impl Process {
        pub(super) fn spawn(command: &mut Command) -> io::Result<Self> {
            Ok(Self {
                child: command.process_group(0).spawn()?,
                stopped: false,
            })
        }
        pub(super) fn id(&self) -> u32 {
            self.child.id()
        }
        pub(super) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            self.child.try_wait()
        }
        pub(super) fn stop(&mut self) {
            if self.stopped {
                return;
            }
            self.stopped = true;
            // SAFETY: spawn created a new process group whose ID is this owned
            // child's PID. The GUI and unrelated applications are outside it.
            unsafe {
                libc::kill(-(self.id() as i32), libc::SIGTERM);
            }
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline && matches!(self.try_wait(), Ok(None)) {
                std::thread::sleep(Duration::from_millis(25));
            }
            // Kill remaining descendants even if the root already exited.
            unsafe {
                libc::kill(-(self.id() as i32), libc::SIGKILL);
            }
            let _ = self.child.wait();
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::collections::BTreeMap;
    use std::ffi::{OsStr, OsString};
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::ExitStatusExt;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::System::Threading::*;

    pub(super) struct Process {
        process: OwnedHandle,
        job: OwnedHandle,
        pid: u32,
        stopped: bool,
    }

    fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
        let mut encoded: Vec<_> = value.encode_wide().collect();
        if encoded.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "NUL in backend command",
            ));
        }
        encoded.push(0);
        Ok(encoded)
    }

    /// Quote an argument for the Windows CRT, including trailing backslashes.
    fn quote(value: &OsStr) -> io::Result<Vec<u16>> {
        let encoded = wide(value)?;
        let mut output = vec![b'"' as u16];
        let mut slashes = 0;
        for &unit in &encoded[..encoded.len() - 1] {
            if unit == b'\\' as u16 {
                slashes += 1;
                continue;
            }
            output.extend(std::iter::repeat_n(
                b'\\' as u16,
                if unit == b'"' as u16 {
                    slashes * 2 + 1
                } else {
                    slashes
                },
            ));
            slashes = 0;
            output.push(unit);
        }
        output.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
        output.push(b'"' as u16);
        Ok(output)
    }

    struct Attributes {
        storage: Vec<usize>,
    }
    impl Attributes {
        fn new() -> io::Result<Self> {
            let mut bytes = 0;
            // SAFETY: first call obtains the required allocation size.
            unsafe {
                InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes);
            }
            let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
            if bytes == 0
                || unsafe {
                    InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 1, 0, &mut bytes)
                } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(Self { storage })
        }
        fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
            self.storage.as_mut_ptr().cast()
        }
    }
    impl Drop for Attributes {
        fn drop(&mut self) {
            // SAFETY: initialized list backed by our live, aligned allocation.
            unsafe {
                DeleteProcThreadAttributeList(self.ptr());
            }
        }
    }

    impl Process {
        pub(super) fn spawn(command: &mut Command) -> io::Result<Self> {
            let mut line = quote(command.get_program())?;
            for arg in command.get_args() {
                line.push(b' ' as u16);
                line.extend(quote(arg)?);
            }
            line.push(0);
            let cwd = command
                .get_current_dir()
                .map(|path| wide(path.as_os_str()))
                .transpose()?;
            let mut env: BTreeMap<OsString, (OsString, OsString)> = std::env::vars_os()
                .map(|(key, value)| {
                    (
                        OsString::from(key.to_string_lossy().to_uppercase()),
                        (key, value),
                    )
                })
                .collect();
            for (key, value) in command.get_envs() {
                let folded = OsString::from(key.to_string_lossy().to_uppercase());
                if let Some(value) = value {
                    env.insert(folded, (key.into(), value.into()));
                } else {
                    env.remove(&folded);
                }
            }
            // lpApplicationName does not search PATH. Resolve our executable
            // explicitly, preserving the command's private backend PATH.
            let program = std::path::Path::new(command.get_program());
            let resolved = if program.is_absolute() {
                program.to_path_buf()
            } else if program.components().count() > 1 {
                std::env::current_dir()?.join(program)
            } else {
                env.get(OsStr::new("PATH"))
                    .and_then(|(_, path)| {
                        std::env::split_paths(path)
                            .map(|directory| directory.join(program))
                            .find(|candidate| candidate.is_file())
                    })
                    .ok_or_else(|| {
                        io::Error::new(io::ErrorKind::NotFound, "backend executable is not on PATH")
                    })?
            };
            let application = wide(resolved.as_os_str())?;
            let mut environment = Vec::<u16>::new();
            for (_, (key, value)) in env {
                let mut entry = key;
                entry.push("=");
                entry.push(value);
                environment.extend(wide(&entry)?);
            }
            environment.push(0);
            // SAFETY: unnamed job has no inheritable security descriptor. Every
            // successful raw handle is immediately given one RAII owner.
            let handle = unsafe { CreateJobObjectW(null(), null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = unsafe { OwnedHandle::from_raw_handle(handle) };
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            let mut jobs: [HANDLE; 1] = [handle];
            // The value buffer must outlive the attribute list. Rust drops
            // locals in reverse declaration order, so declare the list last.
            let mut attributes = Attributes::new()?;
            // Atomic containment: the process joins the job before any Python
            // or PyInstaller code can create descendants. No suspension race.
            if unsafe {
                UpdateProcThreadAttribute(
                    attributes.ptr(),
                    0,
                    PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                    jobs.as_mut_ptr().cast(),
                    size_of_val(&jobs),
                    null_mut(),
                    null(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
            startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
            startup.lpAttributeList = attributes.ptr();
            let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
            // SAFETY: all UTF-16 buffers, the job handle and attribute list live
            // through CreateProcessW. No handles or pipe endpoints are inherited.
            let created = unsafe {
                CreateProcessW(
                    application.as_ptr(),
                    line.as_mut_ptr(),
                    null(),
                    null(),
                    0,
                    CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                    environment.as_ptr().cast(),
                    cwd.as_ref().map_or(null(), |value| value.as_ptr()),
                    &startup.StartupInfo,
                    &mut info,
                )
            };
            if created == 0 {
                return Err(io::Error::last_os_error());
            }
            let process = unsafe { OwnedHandle::from_raw_handle(info.hProcess) };
            let _thread = unsafe { OwnedHandle::from_raw_handle(info.hThread) };
            Ok(Self {
                process,
                job,
                pid: info.dwProcessId,
                stopped: false,
            })
        }
        pub(super) fn id(&self) -> u32 {
            self.pid
        }
        pub(super) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            // SAFETY: process is an owned, live handle. Check signalled state
            // first so an actual exit code of STILL_ACTIVE is not mistaken.
            match unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) } {
                WAIT_TIMEOUT => return Ok(None),
                WAIT_OBJECT_0 => {}
                _ => return Err(io::Error::last_os_error()),
            }
            let mut code = 0;
            if unsafe { GetExitCodeProcess(self.process.as_raw_handle(), &mut code) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Some(ExitStatus::from_raw(code)))
        }
        pub(super) fn stop(&mut self) {
            if self.stopped {
                return;
            }
            self.stopped = true;
            // SAFETY: job contains only this backend and its descendants. This
            // also removes descendants whose parent has already exited.
            unsafe {
                TerminateJobObject(self.job.as_raw_handle(), 1);
                WaitForSingleObject(self.process.as_raw_handle(), 2000);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn quoting_preserves_spaces_quotes_unicode_and_trailing_slashes() {
            assert_eq!(
                quote(OsStr::new("A B\\")).unwrap(),
                "\"A B\\\\\"".encode_utf16().collect::<Vec<_>>()
            );
            assert_eq!(
                quote(OsStr::new("ä\"b")).unwrap(),
                "\"ä\\\"b\"".encode_utf16().collect::<Vec<_>>()
            );
            assert!(quote(OsStr::new("a\0b")).is_err());
        }
    }
}
