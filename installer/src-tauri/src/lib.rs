mod commands;
mod platform;

pub fn run() {
    // 卸载模式（UninstallString 调用）：不创建窗口，直接清理后退出。
    if platform::is_uninstall_requested() {
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
            commands::start_install,
            commands::cancel_install,
            commands::uninstall,
            commands::launch_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
