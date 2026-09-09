use std::path::{Path, PathBuf};

pub const DEFAULT_NOTEBOOK_FILENAME: &str = "treenote.sqlite3";
const SETTINGS_FILENAME: &str = "settings.json";
const NOTEBOOKS_DIR_NAME: &str = "notebooks";
const BACKUPS_DIR_NAME: &str = "backups";
const EXPORTS_DIR_NAME: &str = "exports";

pub fn default_data_root() -> PathBuf {
    dirs::data_dir()
        .expect("Could not get app data dir")
        .join("treenote")
}

pub fn notebooks_dir(data_root: &Path) -> PathBuf {
    data_root.join(NOTEBOOKS_DIR_NAME)
}

pub fn backups_dir(data_root: &Path) -> PathBuf {
    data_root.join(BACKUPS_DIR_NAME)
}

pub fn exports_dir(data_root: &Path) -> PathBuf {
    data_root.join(EXPORTS_DIR_NAME)
}

pub fn settings_path(data_root: &Path) -> PathBuf {
    data_root.join(SETTINGS_FILENAME)
}

pub fn default_notebook_path(data_root: &Path) -> PathBuf {
    notebooks_dir(data_root).join(DEFAULT_NOTEBOOK_FILENAME)
}

pub fn interpret_configured_data_root(value: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("TreeNote data folder is not configured correctly.".into());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("TreeNote data folder must be an absolute path.".into());
    }
    Ok(Some(path))
}

pub fn resolve_data_root_from_configured(
    configured: Result<Option<PathBuf>, String>,
) -> Result<PathBuf, String> {
    Ok(configured?.unwrap_or_else(default_data_root))
}

#[cfg(windows)]
pub fn read_configured_data_root() -> Result<Option<PathBuf>, String> {
    read_hkcu_data_root()
}

#[cfg(not(windows))]
pub fn read_configured_data_root() -> Result<Option<PathBuf>, String> {
    Ok(None)
}

pub fn resolve_data_root() -> Result<PathBuf, String> {
    resolve_data_root_from_configured(read_configured_data_root())
}

#[cfg(windows)]
fn read_hkcu_data_root() -> Result<Option<PathBuf>, String> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Foundation::{
        ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS,
    };
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, KEY_QUERY_VALUE,
        REG_EXPAND_SZ, REG_SZ,
    };

    fn to_wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let subkey = to_wide(r"Software\TreeNote");
    let mut hkey = std::ptr::null_mut();
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            KEY_QUERY_VALUE,
            &mut hkey,
        )
    };
    if status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND {
        return Ok(None);
    }
    if status != ERROR_SUCCESS {
        return Err("TreeNote could not read its data folder location.".into());
    }

    let value_name = to_wide("DataRoot");
    let mut kind: u32 = 0;
    let mut size: u32 = 0;
    let query = unsafe {
        RegQueryValueExW(
            hkey,
            value_name.as_ptr(),
            std::ptr::null_mut(),
            &mut kind,
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if query == ERROR_FILE_NOT_FOUND {
        unsafe { RegCloseKey(hkey) };
        return Ok(None);
    }
    if query != ERROR_SUCCESS {
        unsafe { RegCloseKey(hkey) };
        return Err("TreeNote could not read its data folder location.".into());
    }

    let mut buf = vec![0u8; size as usize];
    let query2 = unsafe {
        RegQueryValueExW(
            hkey,
            value_name.as_ptr(),
            std::ptr::null_mut(),
            &mut kind,
            buf.as_mut_ptr(),
            &mut size,
        )
    };
    unsafe { RegCloseKey(hkey) };
    if query2 != ERROR_SUCCESS {
        return Err("TreeNote could not read its data folder location.".into());
    }
    if kind != REG_SZ && kind != REG_EXPAND_SZ {
        return Err("TreeNote data folder is not configured correctly.".into());
    }

    let u16s: Vec<u16> = buf
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    let end = u16s.iter().position(|&c| c == 0).unwrap_or(u16s.len());
    let value = std::ffi::OsString::from_wide(&u16s[..end]);
    interpret_configured_data_root(Some(&value.to_string_lossy()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_configuration_resolves_to_default_data_root() {
        let resolved = resolve_data_root_from_configured(Ok(None)).expect("resolve");
        assert_eq!(resolved, default_data_root());
    }

    #[test]
    fn configured_absolute_data_root_is_respected() {
        let configured = PathBuf::from(if cfg!(windows) {
            r"D:\TreeNoteData"
        } else {
            "/tmp/treenote-data"
        });
        let resolved = resolve_data_root_from_configured(Ok(Some(configured.clone())))
            .expect("resolve");
        assert_eq!(resolved, configured);
        assert_eq!(notebooks_dir(&resolved), configured.join("notebooks"));
        assert_eq!(backups_dir(&resolved), configured.join("backups"));
        assert_eq!(exports_dir(&resolved), configured.join("exports"));
        assert_eq!(settings_path(&resolved), configured.join("settings.json"));
        assert_eq!(
            default_notebook_path(&resolved),
            configured.join("notebooks").join(DEFAULT_NOTEBOOK_FILENAME)
        );
    }

    #[test]
    fn malformed_or_relative_configured_root_is_an_error() {
        let empty = interpret_configured_data_root(Some("   ")).expect_err("empty");
        assert!(empty.contains("not configured correctly"));
        let relative = interpret_configured_data_root(Some("treenote")).expect_err("relative");
        assert!(relative.contains("absolute"));
        let failed = resolve_data_root_from_configured(Err("registry failed".into()))
            .expect_err("read failure");
        assert_eq!(failed, "registry failed");
    }

    #[test]
    fn installer_get_data_root_never_returns_empty() {
        let iss = include_str!("../../installer/treenote.iss");
        assert!(iss.contains("function DefaultDataRoot"));
        assert!(iss.contains("if Result = '' then"));
        assert!(iss.contains("Result := DefaultDataRoot"));
        assert!(iss.contains("Root := GetDataRoot('')"));
        assert!(!iss.contains("Trim(GetDataRoot(''))"));
    }

    #[test]
    fn installer_script_writes_data_root_without_uninstall_delete() {
        let iss = include_str!("../../installer/treenote.iss");
        assert!(iss.contains("ValueName: \"DataRoot\""));
        assert!(iss.contains("ProbeDataRootWritable"));
        assert!(iss.contains("ExistingDataRoot"));
        assert!(iss.contains("{userappdata}\\treenote"));
        assert!(!iss.contains("uninsneveruninstall"));
        assert!(!iss.contains("notebook_root"));
        assert!(!iss.contains("notebook_root.pending"));

        let data_root_line = iss
            .lines()
            .find(|line| line.contains("ValueName: \"DataRoot\""))
            .expect("DataRoot registry line");
        assert!(!data_root_line.contains("uninsdelete"));

        for line in iss.lines() {
            if line.contains("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
                && line.contains("TreeNote")
            {
                assert!(line.contains("dontcreatekey"));
                assert!(line.contains("uninsdeletevalue"));
            }
            if line.contains("StartupApproved\\Run") && line.contains("TreeNote") {
                assert!(line.contains("dontcreatekey"));
                assert!(line.contains("uninsdeletevalue"));
            }
        }
    }

    #[test]
    fn absent_option_is_not_an_error() {
        assert!(interpret_configured_data_root(None)
            .expect("absent")
            .is_none());
    }
}
