fn main() {
    println!("cargo::rustc-check-cfg=cfg(dev_mode)");

    let dev_mode = std::env::var("TREENOTE_DEV_MODE")
        .ok()
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "TRUE"));

    if dev_mode {
        println!("cargo:rustc-cfg=dev_mode");
    }

    tauri_build::build()
}
