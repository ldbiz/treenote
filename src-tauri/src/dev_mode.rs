use tauri::{AppHandle, Manager, WebviewWindow};

#[cfg(dev_mode)]
pub fn is_dev_mode() -> bool {
    true
}

#[cfg(not(dev_mode))]
pub fn is_dev_mode() -> bool {
    false
}

pub fn apply_webview_policy(app: &AppHandle) -> Result<(), String> {
    if is_dev_mode() {
        return Ok(());
    }

    for (_label, window) in app.webview_windows() {
        restrict_webview(&window)?;
    }

    Ok(())
}

fn restrict_webview(window: &WebviewWindow) -> Result<(), String> {
    window
        .with_webview(restrict_platform_webview)
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn restrict_platform_webview(webview: tauri::webview::PlatformWebview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        let Ok(settings) = core.Settings() else {
            return;
        };

        // Keep default context menus enabled so contextmenu events still fire for
        // app menus (tree) and native editing menus (textarea). DevTools disabled
        // removes Inspect Element without blocking those menus.
        let _ = settings.SetAreDevToolsEnabled(false);

        if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
            let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
        }
    }
}

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
fn restrict_platform_webview(webview: tauri::webview::PlatformWebview) {
    use webkit2gtk::prelude::{SettingsExt, SettingsExtManual};

    webview
        .inner()
        .settings()
        .expect("failed to read webkit settings")
        .set_enable_developer_extras(false);
}

#[cfg(not(any(
    windows,
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
)))]
fn restrict_platform_webview(_webview: tauri::webview::PlatformWebview) {}
