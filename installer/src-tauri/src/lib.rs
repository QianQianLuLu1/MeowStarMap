mod commands;
mod legacy;
mod platform;

pub fn run() {
    // 卸载模式（UninstallString 调用，或直接双击安装目录内的 Uninstall.exe）
    let is_uninstaller_binary = std::env::current_exe()
        .ok()
        .and_then(|path| path.file_name().map(|name| name.to_string_lossy().to_string()))
        .map(|name| name.eq_ignore_ascii_case("Uninstall.exe"))
        .unwrap_or(false);
    if platform::is_uninstall_requested() || is_uninstaller_binary {
        let code = match platform::run_uninstall() {
            Ok(()) => 0,
            Err(_) => 1,
        };
        std::process::exit(code);
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::detect_state,
            commands::get_install_progress,
            commands::get_install_log,
            commands::start_install,
            commands::cancel_install,
            commands::uninstall,
            commands::close_installer,
            commands::launch_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
