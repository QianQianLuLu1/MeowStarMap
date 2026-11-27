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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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
    pub cancellable: bool,
}

#[tauri::command]
pub fn get_install_progress() -> InstallProgress {
    let (percent, message, cancellable) = platform::progress_snapshot();
    InstallProgress {
        percent,
        message,
        cancellable,
    }
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

#[derive(Debug, PartialEq, Eq)]
enum InstallCompletion {
    Exit(i32, Result<InstallSummary, String>),
    Ui(Result<InstallSummary, String>),
}

fn resolve_install_completion(
    silent: bool,
    result: Result<Result<InstallSummary, String>, String>,
) -> InstallCompletion {
    let result = result
        .map_err(|err| format!("安装线程异常: {err}"))
        .and_then(|result| result);

    if silent {
        let code = if result.is_ok() { 0 } else { 1 };
        InstallCompletion::Exit(code, result)
    } else {
        InstallCompletion::Ui(result)
    }
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
            .map_err(|err| format!("安装线程异常: {err}"));

    match resolve_install_completion(platform::is_silent(), result) {
        InstallCompletion::Exit(code, result) => {
            app.exit(code);
            result
        }
        InstallCompletion::Ui(result) => result,
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn successful_summary() -> InstallSummary {
        InstallSummary {
            ok: true,
            mode: "install".to_string(),
            install_dir: r"C:\MeowStarMap".to_string(),
            version: "2.5.7".to_string(),
            steps: vec!["安装完成".to_string()],
            warnings: vec![],
        }
    }

    #[test]
    fn silent_join_failure_exits_with_code_one() {
        // 外层 Err 对应 spawn_blocking join 失败。
        let result: Result<Result<InstallSummary, String>, String> =
            Err("worker panicked".to_string());

        assert_eq!(
            resolve_install_completion(true, result),
            InstallCompletion::Exit(1, Err("安装线程异常: worker panicked".to_string()))
        );
    }

    #[test]
    fn silent_install_failure_exits_with_code_one() {
        // 内层 Err 对应 platform::install 返回 Err。
        let result: Result<Result<InstallSummary, String>, String> =
            Ok(Err("磁盘空间不足".to_string()));

        assert_eq!(
            resolve_install_completion(true, result),
            InstallCompletion::Exit(1, Err("磁盘空间不足".to_string()))
        );
    }

    #[test]
    fn silent_success_exits_with_code_zero() {
        let result: Result<Result<InstallSummary, String>, String> = Ok(Ok(successful_summary()));

        assert_eq!(
            resolve_install_completion(true, result),
            InstallCompletion::Exit(0, Ok(successful_summary()))
        );
    }

    #[test]
    fn interactive_join_failure_returns_error_to_ui() {
        let result: Result<Result<InstallSummary, String>, String> =
            Err("worker panicked".to_string());

        assert_eq!(
            resolve_install_completion(false, result),
            InstallCompletion::Ui(Err("安装线程异常: worker panicked".to_string()))
        );
    }

    #[test]
    fn interactive_install_failure_returns_error_to_ui() {
        let result: Result<Result<InstallSummary, String>, String> =
            Ok(Err("磁盘空间不足".to_string()));

        assert_eq!(
            resolve_install_completion(false, result),
            InstallCompletion::Ui(Err("磁盘空间不足".to_string()))
        );
    }

    #[test]
    fn interactive_success_returns_summary_to_ui() {
        let result: Result<Result<InstallSummary, String>, String> = Ok(Ok(successful_summary()));

        assert_eq!(
            resolve_install_completion(false, result),
            InstallCompletion::Ui(Ok(successful_summary()))
        );
    }
}
