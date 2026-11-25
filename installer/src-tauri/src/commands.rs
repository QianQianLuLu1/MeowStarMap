use serde::{Deserialize, Serialize};

use crate::platform;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallerState {
    pub installed: bool,
    pub version: Option<String>,
    pub install_dir: Option<String>,
    pub app_running: bool,
    pub mode: String,
    pub payload_path: Option<String>,
    /// 默认安装目录（输入框兜底，避免空值）
    pub default_install_dir: String,
    /// 是否由更新流程/命令行以静默模式启动（/S、--silent、-s）
    pub silent: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOptions {
    pub install_dir: String,
    pub create_desktop_shortcut: bool,
    pub import_certificate: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSummary {
    pub ok: bool,
    pub mode: String,
    pub install_dir: String,
    pub version: String,
    pub steps: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub percent: u8,
    pub message: String,
}

#[tauri::command]
pub fn get_install_progress() -> InstallProgress {
    let (percent, message) = platform::progress_snapshot();
    InstallProgress { percent, message }
}

#[tauri::command]
pub fn get_install_log() -> Vec<String> {
    platform::install_log()
}

#[tauri::command]
pub async fn detect_state() -> Result<InstallerState, String> {
    tauri::async_runtime::spawn_blocking(platform::detect_state)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn start_install(
    app: tauri::AppHandle,
    options: InstallOptions,
) -> Result<InstallSummary, String> {
    // 安装是大文件 IO（解包/哈希/替换），放到 blocking 线程，避免阻塞主线程导致
    // 进度事件无法重绘（2026-11-25 冒烟测试发现页面会停在 0%）。
    let install_app = app.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || platform::install(options, &install_app))
            .await
            .map_err(|err| format!("安装线程异常: {err}"))?;
    let summary = result.map_err(|err| err.to_string())?;

    // 静默模式（/S、--silent、-s）：安装完成后直接退出进程，供旧 electron-updater 等待退出码。
    if platform::is_silent() {
        app.exit(0);
    }
    Ok(summary)
}

#[tauri::command]
pub fn cancel_install() -> Result<(), String> {
    platform::request_cancel();
    Ok(())
}

#[tauri::command]
pub fn uninstall() -> Result<(), String> {
    platform::uninstall().map_err(|err| err.to_string())
}

#[tauri::command]
pub fn launch_app(app: tauri::AppHandle) -> Result<(), String> {
    platform::launch_app(app).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn close_installer(app: tauri::AppHandle) {
    app.exit(0);
}
