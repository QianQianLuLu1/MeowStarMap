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

#[tauri::command]
pub fn detect_state() -> Result<InstallerState, String> {
    Ok(platform::detect_state())
}

#[tauri::command]
pub fn start_install(options: InstallOptions) -> Result<InstallSummary, String> {
    platform::install(options).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn cancel_install() -> Result<(), String> {
    // 骨架阶段：安装为同步短流程，暂无可取消点
    Ok(())
}

#[tauri::command]
pub fn uninstall() -> Result<(), String> {
    platform::uninstall().map_err(|err| err.to_string())
}

#[tauri::command]
pub fn launch_app() -> Result<(), String> {
    platform::launch_app().map_err(|err| err.to_string())
}
