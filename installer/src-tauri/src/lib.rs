mod commands;
mod platform;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::detect_state,
            commands::start_install,
            commands::cancel_install,
            commands::uninstall,
            commands::launch_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
