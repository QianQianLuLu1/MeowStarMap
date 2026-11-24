use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::commands::{InstallOptions, InstallSummary, InstallerState};

const UNINSTALL_KEY: &str =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.qianlu.meow-star-map";
const DISPLAY_NAME: &str = "喵星图";
const PRODUCT_NAME: &str = "MeowStarMap";

pub fn detect_state() -> InstallerState {
    let install_dir = read_install_dir();
    let installed = install_dir
        .as_ref()
        .map(|dir| dir.exists())
        .unwrap_or(false);
    let version = install_dir
        .as_ref()
        .and_then(|dir| read_manifest_version(dir))
        .or_else(|| query_reg_value(UNINSTALL_KEY, "DisplayVersion"));
    let app_running = is_app_running();
    let mode = if installed { "upgrade" } else { "install" };

    InstallerState {
        installed,
        version,
        install_dir: install_dir.map(|dir| dir.to_string_lossy().to_string()),
        app_running,
        mode: mode.to_string(),
        payload_path: payload_path().map(|path| path.to_string_lossy().to_string()),
    }
}

pub fn install(options: InstallOptions) -> Result<InstallSummary, String> {
    let install_dir = PathBuf::from(options.install_dir.trim());
    if !install_dir.is_absolute() {
        return Err("安装目录必须是绝对路径".to_string());
    }

    let installed_before = detect_state().installed;
    let mut steps: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    stop_running_app(&mut steps, &mut warnings);
    fs::create_dir_all(&install_dir).map_err(|err| format!("创建安装目录失败: {err}"))?;
    steps.push(format!("创建安装目录: {}", install_dir.display()));

    match payload_path() {
        Some(payload) => extract_payload(&payload, &install_dir, &mut steps, &mut warnings)?,
        None => warnings.push("未找到安装载荷（骨架阶段），已跳过文件解包".to_string()),
    }

    let version = read_manifest_version(&install_dir)
        .or_else(|| query_reg_value(UNINSTALL_KEY, "DisplayVersion"))
        .unwrap_or_else(|| "0.0.0-skeleton".to_string());

    write_uninstall_registry(&install_dir, &version, &mut steps, &mut warnings);
    if options.import_certificate {
        import_certificate(&mut warnings);
    }
    if options.create_desktop_shortcut {
        create_shortcuts(&install_dir, &mut warnings);
    }

    Ok(InstallSummary {
        ok: true,
        mode: if installed_before {
            "upgrade"
        } else {
            "install"
        }
        .to_string(),
        install_dir: install_dir.to_string_lossy().to_string(),
        version,
        steps,
        warnings,
    })
}

pub fn uninstall() -> Result<(), String> {
    let _ = Command::new("reg")
        .args(["delete", UNINSTALL_KEY, "/f"])
        .output();
    Ok(())
}

pub fn launch_app() -> Result<(), String> {
    let install_dir = read_install_dir().ok_or("未找到安装目录".to_string())?;
    let exe = find_app_exe(&install_dir).ok_or("安装目录中未找到应用可执行文件".to_string())?;
    Command::new(exe)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("启动应用失败: {err}"))
}

fn read_install_dir() -> Option<PathBuf> {
    if let Some(value) = query_reg_value(UNINSTALL_KEY, "InstallLocation") {
        let path = PathBuf::from(value);
        if path.exists() {
            return Some(path);
        }
    }
    None
}

fn read_manifest_version(install_dir: &Path) -> Option<String> {
    let manifest = install_dir.join("install-manifest.json");
    let raw = fs::read_to_string(manifest).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("version")
        .and_then(|version| version.as_str())
        .map(|version| version.to_string())
}

fn query_reg_value(key: &str, value: &str) -> Option<String> {
    let output = Command::new("reg")
        .args(["query", key, "/v", value])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if let Some(position) = line.find("REG_SZ") {
            let value = line[position + "REG_SZ".len()..].trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn payload_path() -> Option<PathBuf> {
    if let Ok(custom) = env::var("MEOW_INSTALLER_PAYLOAD") {
        let path = PathBuf::from(custom);
        if path.exists() {
            return Some(path);
        }
    }
    let exe_dir = env::current_exe().ok()?.parent()?.to_path_buf();
    for candidate in ["payload.zip", "payload"] {
        let path = exe_dir.join(candidate);
        if path.exists() {
            return Some(path);
        }
    }
    None
}

fn is_app_running() -> bool {
    let output = Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq 喵星图.exe", "/NH"])
        .output();
    if let Ok(output) = output {
        let text = String::from_utf8_lossy(&output.stdout);
        if text.contains("喵星图.exe") {
            return true;
        }
    }
    false
}

fn stop_running_app(steps: &mut Vec<String>, warnings: &mut Vec<String>) {
    if !is_app_running() {
        return;
    }
    let status = Command::new("taskkill")
        .args(["/IM", "喵星图.exe", "/F"])
        .status();
    match status {
        Ok(status) if status.success() => steps.push("已结束正在运行的喵星图进程".to_string()),
        _ => warnings.push("结束喵星图进程失败，请手动关闭后重试".to_string()),
    }
}

fn extract_payload(
    payload: &Path,
    install_dir: &Path,
    steps: &mut Vec<String>,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    if payload.is_dir() {
        warnings.push("载荷目录解包尚未实现（骨架阶段）".to_string());
        return Ok(());
    }
    if payload.extension().and_then(|ext| ext.to_str()) != Some("zip") {
        warnings.push(format!("暂不支持的载荷类型: {}", payload.display()));
        return Ok(());
    }

    let script = format!(
        "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
        payload.display(),
        install_dir.display()
    );
    let status = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .status()
        .map_err(|err| format!("调用 PowerShell 解包失败: {err}"))?;
    if !status.success() {
        return Err("解包安装文件失败".to_string());
    }
    steps.push(format!("解包安装文件: {}", payload.display()));
    Ok(())
}

fn write_uninstall_registry(
    install_dir: &Path,
    version: &str,
    steps: &mut Vec<String>,
    warnings: &mut Vec<String>,
) {
    let exe = find_app_exe(install_dir)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    let uninstall_string = env::current_exe()
        .map(|path| format!("\"{}\" --uninstall", path.display()))
        .unwrap_or_default();
    let pairs: [(&str, String); 5] = [
        ("DisplayName", DISPLAY_NAME.to_string()),
        ("DisplayVersion", version.to_string()),
        ("InstallLocation", install_dir.to_string_lossy().to_string()),
        ("DisplayIcon", exe),
        ("UninstallString", uninstall_string),
    ];

    for (name, value) in pairs {
        let status = Command::new("reg")
            .args([
                "add",
                UNINSTALL_KEY,
                "/v",
                name,
                "/t",
                "REG_SZ",
                "/d",
                &value,
                "/f",
            ])
            .status();
        match status {
            Ok(status) if status.success() => {}
            _ => warnings.push(format!("写入注册表项 {name} 失败")),
        }
    }
    steps.push("写入卸载项注册表".to_string());
}

fn import_certificate(warnings: &mut Vec<String>) {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("root.cer"));
            candidates.push(dir.join("resources").join("trust").join("root.cer"));
        }
    }
    let Some(cert) = candidates.into_iter().find(|path| path.exists()) else {
        warnings.push("未找到根证书文件，已跳过证书导入".to_string());
        return;
    };

    let status = Command::new("certutil")
        .args(["-user", "-addstore", "-f", "Root"])
        .arg(&cert)
        .status();
    match status {
        Ok(status) if status.success() => {}
        _ => warnings.push("导入根证书失败（不影响安装）".to_string()),
    }
}

fn create_shortcuts(install_dir: &Path, warnings: &mut Vec<String>) {
    let Some(exe) = find_app_exe(install_dir) else {
        warnings.push("未找到应用可执行文件，已跳过快捷方式创建".to_string());
        return;
    };

    let mut targets: Vec<PathBuf> = Vec::new();
    if let Ok(profile) = env::var("USERPROFILE") {
        targets.push(Path::new(&profile).join("Desktop").join("喵星图.lnk"));
    }
    if let Ok(appdata) = env::var("APPDATA") {
        targets.push(
            Path::new(&appdata)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs")
                .join("喵星图.lnk"),
        );
    }

    for target in targets {
        if let Err(err) = create_shortcut(&target, &exe, install_dir) {
            warnings.push(format!("创建快捷方式失败: {err}"));
        }
    }
}

fn create_shortcut(target: &Path, exe: &Path, workdir: &Path) -> Result<(), String> {
    let script_path = env::temp_dir().join("meow-installer-shortcut.ps1");
    let script = format!(
        "$W = New-Object -ComObject WScript.Shell\n$s = $W.CreateShortcut('{}')\n$s.TargetPath = '{}'\n$s.WorkingDirectory = '{}'\n$s.IconLocation = '{}'\n$s.Save()\n",
        target.display(),
        exe.display(),
        workdir.display(),
        exe.display()
    );
    fs::write(&script_path, script).map_err(|err| err.to_string())?;
    let status = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&script_path)
        .status()
        .map_err(|err| err.to_string())?;
    if !status.success() {
        return Err("PowerShell 创建快捷方式失败".to_string());
    }
    Ok(())
}

fn find_app_exe(install_dir: &Path) -> Option<PathBuf> {
    let preferred = ["喵星图.exe", "MeowStarMap.exe", "meow-star-map.exe"];
    for name in preferred {
        let path = install_dir.join(name);
        if path.exists() {
            return Some(path);
        }
    }
    let entries = fs::read_dir(install_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("exe") {
            let name = path.file_name()?.to_string_lossy().to_string();
            if !name.starts_with("Uninstall") {
                return Some(path);
            }
        }
    }
    None
}

// 占位：避免未使用常量告警（品牌名后续用于 AUMID/注册表扩展）
#[allow(dead_code)]
fn product_name() -> &'static str {
    PRODUCT_NAME
}
