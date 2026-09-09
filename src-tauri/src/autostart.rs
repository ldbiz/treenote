use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunOnStartupStatus {
    pub supported: bool,
    pub enabled: bool,
}

#[cfg(windows)]
mod imp {
    use super::RunOnStartupStatus;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use windows_sys::Win32::Foundation::{
        ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS,
    };
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW,
        RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, KEY_QUERY_VALUE, REG_SZ,
    };

    pub struct RegistryTargets {
        pub run_subkey: &'static str,
        pub startup_approved_subkey: &'static str,
        pub value_name: &'static str,
    }

    pub const PRODUCTION: RegistryTargets = RegistryTargets {
        run_subkey: r"Software\Microsoft\Windows\CurrentVersion\Run",
        startup_approved_subkey:
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
        value_name: "TreeNote",
    };

    fn to_wide(value: &str) -> Vec<u16> {
        OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn open_key(subkey: &str, access: u32) -> Result<HKEY, String> {
        let subkey_wide = to_wide(subkey);
        let mut handle = std::ptr::null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                subkey_wide.as_ptr(),
                0,
                access,
                &mut handle,
            )
        };
        if status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND {
            return Err("missing".into());
        }
        if status != ERROR_SUCCESS {
            return Err(format!("Could not open registry key (error {status})."));
        }
        Ok(handle)
    }

    fn create_or_open_key(subkey: &str) -> Result<HKEY, String> {
        let subkey_wide = to_wide(subkey);
        let mut handle = std::ptr::null_mut();
        let status = unsafe {
            RegCreateKeyW(HKEY_CURRENT_USER, subkey_wide.as_ptr(), &mut handle)
        };
        if status != ERROR_SUCCESS {
            return Err(format!("Could not create registry key (error {status})."));
        }
        Ok(handle)
    }

    pub fn value_exists(subkey: &str, value_name: &str) -> Result<bool, String> {
        let handle = match open_key(subkey, KEY_QUERY_VALUE) {
            Ok(handle) => handle,
            Err(message) if message == "missing" => return Ok(false),
            Err(message) => return Err(message),
        };

        let value_name_wide = to_wide(value_name);
        let mut kind: u32 = 0;
        let mut size: u32 = 0;
        let status = unsafe {
            RegQueryValueExW(
                handle,
                value_name_wide.as_ptr(),
                std::ptr::null_mut(),
                &mut kind,
                std::ptr::null_mut(),
                &mut size,
            )
        };
        unsafe { RegCloseKey(handle) };

        if status == ERROR_FILE_NOT_FOUND {
            return Ok(false);
        }
        if status != ERROR_SUCCESS {
            return Err(format!("Could not read registry value (error {status})."));
        }
        Ok(true)
    }

    pub fn read_string_value(subkey: &str, value_name: &str) -> Result<Option<String>, String> {
        let handle = match open_key(subkey, KEY_QUERY_VALUE) {
            Ok(handle) => handle,
            Err(message) if message == "missing" => return Ok(None),
            Err(message) => return Err(message),
        };

        let value_name_wide = to_wide(value_name);
        let mut kind: u32 = 0;
        let mut size: u32 = 0;
        let query = unsafe {
            RegQueryValueExW(
                handle,
                value_name_wide.as_ptr(),
                std::ptr::null_mut(),
                &mut kind,
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if query == ERROR_FILE_NOT_FOUND {
            unsafe { RegCloseKey(handle) };
            return Ok(None);
        }
        if query != ERROR_SUCCESS {
            unsafe { RegCloseKey(handle) };
            return Err(format!("Could not read registry value (error {query})."));
        }
        if size < 2 || kind != REG_SZ {
            unsafe { RegCloseKey(handle) };
            return Ok(None);
        }

        let mut buffer = vec![0u16; (size as usize / 2).max(1)];
        let status = unsafe {
            RegQueryValueExW(
                handle,
                value_name_wide.as_ptr(),
                std::ptr::null_mut(),
                &mut kind,
                buffer.as_mut_ptr() as *mut u8,
                &mut size,
            )
        };
        unsafe { RegCloseKey(handle) };
        if status != ERROR_SUCCESS {
            return Err(format!("Could not read registry value (error {status})."));
        }

        while buffer.last() == Some(&0) {
            buffer.pop();
        }
        Ok(Some(String::from_utf16_lossy(&buffer)))
    }

    pub fn set_string_value(subkey: &str, value_name: &str, data: &str) -> Result<(), String> {
        let handle = create_or_open_key(subkey)?;
        let value_name_wide = to_wide(value_name);
        let data_wide = to_wide(data);
        let byte_len = ((data_wide.len() - 1) * 2) as u32;
        let status = unsafe {
            RegSetValueExW(
                handle,
                value_name_wide.as_ptr(),
                0,
                REG_SZ,
                data_wide.as_ptr() as *const u8,
                byte_len,
            )
        };
        unsafe { RegCloseKey(handle) };
        if status != ERROR_SUCCESS {
            return Err(format!("Could not write registry value (error {status})."));
        }
        Ok(())
    }

    pub fn delete_value(subkey: &str, value_name: &str) -> Result<(), String> {
        let handle = match open_key(subkey, KEY_SET_VALUE) {
            Ok(handle) => handle,
            Err(message) if message == "missing" => return Ok(()),
            Err(message) => return Err(message),
        };
        let value_name_wide = to_wide(value_name);
        let status = unsafe { RegDeleteValueW(handle, value_name_wide.as_ptr()) };
        unsafe { RegCloseKey(handle) };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(());
        }
        if status != ERROR_SUCCESS {
            return Err(format!("Could not delete registry value (error {status})."));
        }
        Ok(())
    }

    fn startup_command() -> Result<String, String> {
        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        Ok(format!("\"{}\"", exe.display()))
    }

    fn normalize_command(value: &str) -> PathBuf {
        let trimmed = value.trim();
        if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
            return PathBuf::from(&trimmed[1..trimmed.len() - 1]);
        }
        PathBuf::from(trimmed)
    }

    fn delete_startup_approved_overlay(targets: &RegistryTargets) {
        let _ = delete_value(targets.startup_approved_subkey, targets.value_name);
    }

    pub fn status_with(targets: &RegistryTargets) -> RunOnStartupStatus {
        let enabled = value_exists(targets.run_subkey, targets.value_name).unwrap_or(false);
        RunOnStartupStatus {
            supported: true,
            enabled,
        }
    }

    pub fn set_enabled_with(
        targets: &RegistryTargets,
        enabled: bool,
    ) -> Result<RunOnStartupStatus, String> {
        if enabled {
            delete_startup_approved_overlay(targets);
            let command = startup_command()?;
            set_string_value(targets.run_subkey, targets.value_name, &command)?;
        } else {
            delete_value(targets.run_subkey, targets.value_name)?;
        }
        Ok(status_with(targets))
    }

    pub fn repair_path_if_present_with(targets: &RegistryTargets) {
        let Ok(Some(current)) = read_string_value(targets.run_subkey, targets.value_name) else {
            return;
        };
        let Ok(desired) = startup_command() else {
            return;
        };
        if normalize_command(&current) == normalize_command(&desired) {
            return;
        }
        let _ = set_string_value(targets.run_subkey, targets.value_name, &desired);
    }
}

#[cfg(windows)]
pub fn status() -> RunOnStartupStatus {
    imp::status_with(&imp::PRODUCTION)
}

#[cfg(windows)]
pub fn set_enabled(enabled: bool) -> Result<RunOnStartupStatus, String> {
    imp::set_enabled_with(&imp::PRODUCTION, enabled)
}

#[cfg(windows)]
pub fn repair_path_if_present() {
    imp::repair_path_if_present_with(&imp::PRODUCTION);
}

#[cfg(not(windows))]
pub fn status() -> RunOnStartupStatus {
    RunOnStartupStatus {
        supported: false,
        enabled: false,
    }
}

#[cfg(not(windows))]
pub fn set_enabled(_enabled: bool) -> Result<RunOnStartupStatus, String> {
    Err("Run on startup is only available on Windows.".into())
}

#[cfg(not(windows))]
pub fn repair_path_if_present() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_windows_stub_reports_unsupported() {
        let status = status();
        if cfg!(windows) {
            assert!(status.supported);
        } else {
            assert!(!status.supported);
            assert!(!status.enabled);
            assert!(set_enabled(true).is_err());
        }
    }

    #[cfg(windows)]
    mod windows_tests {
        use super::super::imp::{
            delete_value, read_string_value, repair_path_if_present_with, set_enabled_with,
            status_with, value_exists, RegistryTargets,
        };
        use std::sync::{Mutex, OnceLock};

        fn test_lock() -> &'static Mutex<()> {
            static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
            LOCK.get_or_init(|| Mutex::new(()))
        }

        fn with_registry_lock<F: FnOnce()>(f: F) {
            let _guard = test_lock().lock().expect("registry test lock");
            f();
        }

        const TEST_TARGETS: RegistryTargets = RegistryTargets {
            run_subkey: r"Software\TreeNote\AutostartTest\Run",
            startup_approved_subkey: r"Software\TreeNote\AutostartTest\StartupApproved",
            value_name: "TreeNoteTest",
        };

        fn cleanup(targets: &RegistryTargets) {
            let _ = delete_value(targets.run_subkey, targets.value_name);
            let _ = delete_value(targets.startup_approved_subkey, targets.value_name);
        }

        #[test]
        fn status_reports_disabled_when_absent() {
            with_registry_lock(|| {
                cleanup(&TEST_TARGETS);
                let status = status_with(&TEST_TARGETS);
                assert!(status.supported);
                assert!(!status.enabled);
            });
        }

        #[test]
        fn enable_is_idempotent() {
            with_registry_lock(|| {
                cleanup(&TEST_TARGETS);
                let first = set_enabled_with(&TEST_TARGETS, true).expect("enable");
                assert!(first.enabled);
                let second = set_enabled_with(&TEST_TARGETS, true).expect("enable again");
                assert!(second.enabled);
                assert!(value_exists(TEST_TARGETS.run_subkey, TEST_TARGETS.value_name).unwrap());
                cleanup(&TEST_TARGETS);
            });
        }

        #[test]
        fn disable_removes_value_and_is_idempotent() {
            with_registry_lock(|| {
                cleanup(&TEST_TARGETS);
                set_enabled_with(&TEST_TARGETS, true).expect("enable");
                let disabled = set_enabled_with(&TEST_TARGETS, false).expect("disable");
                assert!(!disabled.enabled);
                let again = set_enabled_with(&TEST_TARGETS, false).expect("disable again");
                assert!(!again.enabled);
            });
        }

        #[test]
        fn repair_rewrites_stale_path_without_creating_value() {
            with_registry_lock(|| {
                cleanup(&TEST_TARGETS);
                repair_path_if_present_with(&TEST_TARGETS);
                assert!(!value_exists(TEST_TARGETS.run_subkey, TEST_TARGETS.value_name).unwrap());

                set_enabled_with(&TEST_TARGETS, true).expect("enable");
                let stale = r#""C:\Old\TreeNote.exe""#;
                imp_set_stale(&TEST_TARGETS, stale);
                repair_path_if_present_with(&TEST_TARGETS);
                let current = read_string_value(TEST_TARGETS.run_subkey, TEST_TARGETS.value_name)
                    .expect("read")
                    .expect("present");
                assert_ne!(current, stale);
                cleanup(&TEST_TARGETS);
            });
        }

        #[test]
        fn repair_is_noop_when_path_matches() {
            with_registry_lock(|| {
                cleanup(&TEST_TARGETS);
                set_enabled_with(&TEST_TARGETS, true).expect("enable");
                let before = read_string_value(TEST_TARGETS.run_subkey, TEST_TARGETS.value_name)
                    .expect("read")
                    .expect("present");
                repair_path_if_present_with(&TEST_TARGETS);
                let after = read_string_value(TEST_TARGETS.run_subkey, TEST_TARGETS.value_name)
                    .expect("read")
                    .expect("present");
                assert_eq!(before, after);
                cleanup(&TEST_TARGETS);
            });
        }

        #[test]
        fn enable_tolerates_missing_startup_approved_overlay() {
            with_registry_lock(|| {
                cleanup(&TEST_TARGETS);
                let status = set_enabled_with(&TEST_TARGETS, true).expect("enable");
                assert!(status.enabled);
                cleanup(&TEST_TARGETS);
            });
        }

        fn imp_set_stale(targets: &RegistryTargets, value: &str) {
            super::super::imp::set_string_value(targets.run_subkey, targets.value_name, value)
                .expect("set stale");
        }
    }
}
