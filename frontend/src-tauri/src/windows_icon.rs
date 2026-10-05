//! Tauri sets ICON_SMALL; provide a separate high-resolution taskbar ICON_BIG.
use std::io;
use std::ptr::null;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    LoadImageW, SendMessageW, ICON_BIG, IMAGE_ICON, LR_SHARED, WM_SETICON,
};

pub(super) fn apply<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> io::Result<()> {
    let hwnd = window.hwnd().map_err(io::Error::other)?.0;
    // SAFETY: the current executable module remains loaded for this process's
    // lifetime. tauri-build/tauri-winres embeds our ICO under resource ID 32512.
    let module = unsafe { GetModuleHandleW(null()) };
    if module.is_null() {
        return Err(io::Error::last_os_error());
    }
    // LR_SHARED leaves lifetime ownership with Windows, so no transient Rust
    // guard can destroy an icon still referenced by the window/taskbar. Use the
    // 256px ICO frame; Windows scales it for the taskbar's current DPI.
    let icon = unsafe {
        LoadImageW(
            module,
            32512usize as *const u16,
            IMAGE_ICON,
            256,
            256,
            LR_SHARED,
        )
    };
    if icon.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: hwnd belongs to this live Tauri window, and icon is a shared
    // resource handle valid until process exit. ICON_SMALL remains Tauri-owned.
    unsafe {
        SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, icon as isize);
    }
    Ok(())
}
