use std::env;
use std::fs::{self, File};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::commands::{InstallOptions, InstallSummary, InstallerState};

const UNINSTALL_KEY: &str =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.qianlu.meow-star-map";
const DISPLAY_NAME: &str = "喵星图";

static PROGRESS_PERCENT: AtomicU8 = AtomicU8::new(0);
static PROGRESS_MESSAGE: Mutex<String> = Mutex::new(String::new());
static INSTALL_LOGS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);

pub fn log_line(message: impl Into<String>) {
    if let Ok(mut logs) = INSTALL_LOGS.lock() {
        logs.push(message.into());
        // 防止极端情况下无限增长
        if logs.len() > 500 {
            let drain = logs.len() - 500;
            logs.drain(0..drain);
        }
    }
}

pub fn install_log() -> Vec<String> {
    INSTALL_LOGS
        .lock()
        .map(|logs| logs.clone())
        .unwrap_or_default()
}

fn clear_log() {
    if let Ok(mut logs) = INSTALL_LOGS.lock() {
        logs.clear();
    }
}

pub fn request_cancel() {
    CANCEL_REQUESTED.store(true, Ordering::SeqCst);
}

fn reset_cancel() {
    CANCEL_REQUESTED.store(false, Ordering::SeqCst);
}

fn is_cancel_requested() -> bool {
    CANCEL_REQUESTED.load(Ordering::SeqCst)
}

fn check_cancel() -> Result<(), String> {
    if is_cancel_requested() {
        Err("安装已取消".to_string())
    } else {
        Ok(())
    }
}

/// 启动控制台子进程时隐藏窗口（CREATE_NO_WINDOW），避免安装过程中闪 cmd 黑框。
#[cfg(windows)]
fn hidden_command(program: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(windows))]
fn hidden_command(program: &str) -> Command {
    Command::new(program)
}

fn set_progress(percent: u8, message: &str) {
    PROGRESS_PERCENT.store(percent, Ordering::Relaxed);
    if let Ok(mut guard) = PROGRESS_MESSAGE.lock() {
        *guard = message.to_string();
    }
}

pub fn progress_snapshot() -> (u8, String) {
    let percent = PROGRESS_PERCENT.load(Ordering::Relaxed);
    let message = PROGRESS_MESSAGE
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    (percent, message)
}

pub fn is_uninstall_requested() -> bool {
    env::args().any(|arg| arg.eq_ignore_ascii_case("--uninstall"))
}

pub fn run_uninstall() -> Result<(), String> {
    remove_shortcuts();
    if let Some(install_dir) = read_install_dir() {
        if install_dir.exists() {
            // 若卸载器自身就在安装目录内，删除自身会失败，忽略该错误并继续清注册表。
            let _ = fs::remove_dir_all(&install_dir);
        }
    }
    let _ = hidden_command("reg")
        .args(["delete", UNINSTALL_KEY, "/f"])
        .output();
    Ok(())
}

fn remove_shortcuts() {
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
        let _ = fs::remove_file(target);
    }
}

pub fn is_silent() -> bool {
    has_silent_flag()
}

fn default_install_dir() -> Option<PathBuf> {
    env::var("LOCALAPPDATA")
        .ok()
        .map(|base| Path::new(&base).join("Programs").join("MeowStarMap"))
}

fn is_sane_install_path(path: &Path) -> bool {
    let text = path.to_string_lossy();
    !text.is_empty()
        && text
            .chars()
            .all(|ch| ch.is_ascii() && !matches!(ch, '?' | '*' | '<' | '>' | '|' | '"'))
}

pub fn detect_state() -> InstallerState {
    let registry_dir = read_install_dir().filter(|path| is_sane_install_path(path));
    let override_dir = arg_value("--install-dir=").or_else(|| arg_value("/D="));
    let install_dir = override_dir
        .map(PathBuf::from)
        .or(registry_dir)
        .or_else(default_install_dir);

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
        default_install_dir: default_install_dir()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        silent: has_silent_flag(),
    }
}

pub fn install(options: InstallOptions, app: &AppHandle) -> Result<InstallSummary, String> {
    let install_dir = PathBuf::from(options.install_dir.trim());
    if !install_dir.is_absolute() {
        return Err("安装目录必须是绝对路径".to_string());
    }

    let installed_before = detect_state().installed;
    let mut steps: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    reset_cancel();
    clear_log();
    log_line(format!("安装目录: {}", install_dir.display()));
    check_cancel()?;

    emit_progress(app, 2, "准备安装");
    log_line("开始安装");
    stop_running_app(&mut steps, &mut warnings);
    emit_progress(app, 8, "已结束旧进程（如有）");
    log_line("已结束旧进程（如有）");

    let payload = payload_path();
    if let Some(payload) = payload.as_ref() {
        log_line(format!("载荷: {}", payload.display()));
        verify_payload(payload)?;
        log_line("载荷 sha256/大小校验通过");
        emit_progress(app, 16, "载荷校验通过");
        let staging = staging_dir(&install_dir)?;
        let prepare_result: Result<(), String> = (|| {
            extract_to(payload, &staging)?;
            check_cancel()?;
            emit_progress(app, 48, "安装文件已展开");
            swap_in(&install_dir, &staging, &mut steps, &mut warnings)?;
            Ok(())
        })();
        if let Err(err) = prepare_result {
            // 取消/失败：清理暂存目录；swap_in 内部已负责恢复旧版本目录
            let _ = fs::remove_dir_all(&staging);
            log_line(format!("安装失败: {err}"));
            return Err(err);
        }
        emit_progress(app, 78, "文件替换完成");
        log_line("安装文件替换完成");
    } else {
        // 没有载荷属于安装包不完整：必须失败并保持安装目录/注册表不变（可回滚）。
        return Err("未找到安装载荷：安装包不完整（缺少 payload.zip 或内嵌载荷）".to_string());
    }

    match crate::legacy::prepare() {
        Ok(Some(message)) => {
            log_line(message.clone());
            steps.push(message);
        }
        Ok(None) => log_line("未检测到旧版数据"),
        Err(err) => {
            log_line(format!("旧版数据迁移准备失败: {err}"));
            warnings.push(format!("旧版数据迁移准备失败: {err}"));
        }
    }

    let version = read_manifest_version(&install_dir)
        .or_else(|| {
            payload
                .as_ref()
                .and_then(|path| payload_manifest_version(path))
        })
        .or_else(|| query_reg_value(UNINSTALL_KEY, "DisplayVersion"))
        .unwrap_or_else(|| "0.0.0".to_string());

    write_uninstall_registry(&install_dir, &version, &mut steps, &mut warnings);
    log_line("卸载项注册表已写入");
    if options.import_certificate {
        import_certificate(&mut warnings);
        log_line("证书导入完成（如有）");
    }
    if options.create_desktop_shortcut {
        create_shortcuts(&install_dir, &mut warnings);
        log_line("快捷方式创建完成");
    }
    emit_progress(app, 100, "安装完成");
    log_line("安装完成");

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
    let _ = hidden_command("reg")
        .args(["delete", UNINSTALL_KEY, "/f"])
        .output();
    Ok(())
}

pub fn launch_app() -> Result<(), String> {
    let install_dir = read_install_dir()
        .or_else(|| arg_value("--install-dir=").map(PathBuf::from))
        .ok_or("未找到安装目录".to_string())?;
    let exe = find_app_exe(&install_dir).ok_or("安装目录中未找到应用可执行文件".to_string())?;
    Command::new(exe)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("启动应用失败: {err}"))
}

fn emit_progress(app: &AppHandle, percent: u8, message: &str) {
    set_progress(percent, message);
    let _ = app.emit(
        "installer-progress",
        serde_json::json!({ "percent": percent, "message": message }),
    );
}

fn has_silent_flag() -> bool {
    env::args().any(|arg| {
        let lower = arg.to_ascii_lowercase();
        lower == "/s" || lower == "--silent" || lower == "-s"
    })
}

fn arg_value(prefix: &str) -> Option<String> {
    env::args().find_map(|arg| {
        let lower = arg.to_ascii_lowercase();
        let prefix_lower = prefix.to_ascii_lowercase();
        if lower.starts_with(&prefix_lower) {
            Some(arg[prefix.len()..].to_string())
        } else {
            None
        }
    })
}

fn read_install_dir() -> Option<PathBuf> {
    let value = query_reg_value(UNINSTALL_KEY, "InstallLocation")?;
    let path = PathBuf::from(value);
    Some(path)
}

fn payload_manifest_version(payload: &Path) -> Option<String> {
    let manifest = PathBuf::from(format!("{}.json", payload.display()));
    let raw = fs::read_to_string(manifest).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("version")
        .and_then(|version| version.as_str())
        .map(|version| version.to_string())
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
    let output = hidden_command("reg")
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
    if let Some(path) = embedded_payload() {
        return Some(path);
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

const PAYLOAD_TRAILER_MAGIC: &[u8; 8] = b"MEOWPAY1";
const PAYLOAD_TRAILER_LEN: u64 = 24;

/// 读取追加在安装器 exe 末尾的内嵌载荷：
/// [zip][manifest json][zip_size u64 le][manifest_size u64 le][magic 8]，
/// 解出 zip 与同名 .json 清单到临时目录，供校验/版本读取。
fn embedded_payload() -> Option<PathBuf> {
    let exe = env::current_exe().ok()?;
    let mut file = File::open(&exe).ok()?;
    let len = file.metadata().ok()?.len();
    if len <= PAYLOAD_TRAILER_LEN {
        return None;
    }
    file.seek(SeekFrom::End(-8)).ok()?;
    let mut magic = [0u8; 8];
    file.read_exact(&mut magic).ok()?;
    if &magic != PAYLOAD_TRAILER_MAGIC {
        return None;
    }
    file.seek(SeekFrom::End(-24)).ok()?;
    let mut zip_size_buf = [0u8; 8];
    let mut manifest_size_buf = [0u8; 8];
    file.read_exact(&mut zip_size_buf).ok()?;
    file.read_exact(&mut manifest_size_buf).ok()?;
    let zip_size = u64::from_le_bytes(zip_size_buf);
    let manifest_size = u64::from_le_bytes(manifest_size_buf);
    if zip_size == 0 || zip_size + manifest_size + PAYLOAD_TRAILER_LEN >= len {
        return None;
    }
    let zip_offset = len - PAYLOAD_TRAILER_LEN - zip_size - manifest_size;
    let manifest_offset = zip_offset + zip_size;
    let stem = env::temp_dir().join(format!("meow-installer-payload-{}", std::process::id()));
    let zip_path = stem.with_extension("zip");
    let manifest_path = stem.with_extension("zip.json");
    file.seek(SeekFrom::Start(zip_offset)).ok()?;
    copy_range(&mut file, &zip_path, zip_size)?;
    file.seek(SeekFrom::Start(manifest_offset)).ok()?;
    copy_range(&mut file, &manifest_path, manifest_size)?;
    Some(zip_path)
}

fn copy_range(file: &mut File, target: &Path, mut remaining: u64) -> Option<()> {
    let mut out = File::create(target).ok()?;
    let mut buffer = [0u8; 64 * 1024];
    while remaining > 0 {
        let want = std::cmp::min(buffer.len() as u64, remaining) as usize;
        let read = file.read(&mut buffer[..want]).ok()?;
        if read == 0 {
            break;
        }
        out.write_all(&buffer[..read]).ok()?;
        remaining -= read as u64;
    }
    if remaining == 0 {
        Some(())
    } else {
        let _ = fs::remove_file(target);
        None
    }
}

fn is_app_running() -> bool {
    let output = hidden_command("tasklist")
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
    let status = hidden_command("taskkill")
        .args(["/IM", "喵星图.exe", "/F"])
        .status();
    match status {
        Ok(status) if status.success() => steps.push("已结束正在运行的喵星图进程".to_string()),
        _ => warnings.push("结束喵星图进程失败，请手动关闭后重试".to_string()),
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|err| format!("打开载荷失败: {err}"))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|err| format!("读取载荷失败: {err}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn verify_payload(payload: &Path) -> Result<(), String> {
    let manifest_path = PathBuf::from(format!("{}.json", payload.display()));
    if !manifest_path.exists() {
        // 清单可选：没有清单时跳过哈希校验（由发布流程决定是否提供）
        return Ok(());
    }
    let raw =
        fs::read_to_string(&manifest_path).map_err(|err| format!("读取载荷清单失败: {err}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|err| format!("解析载荷清单失败: {err}"))?;
    let expected = value
        .get("sha256")
        .and_then(|item| item.as_str())
        .ok_or("载荷清单缺少 sha256")?;
    if let Some(size) = value.get("size").and_then(|item| item.as_u64()) {
        let actual_size = fs::metadata(payload)
            .map_err(|err| format!("读取载荷大小失败: {err}"))?
            .len();
        if actual_size != size {
            return Err(format!("载荷大小不匹配（期望 {size}，实际 {actual_size}）"));
        }
    }
    let actual = sha256_file(payload)?;
    if !actual.eq_ignore_ascii_case(expected) {
        return Err("载荷 sha256 校验失败，安装包可能已损坏".to_string());
    }
    Ok(())
}

fn staging_dir(install_dir: &Path) -> Result<PathBuf, String> {
    let parent = install_dir
        .parent()
        .ok_or("安装目录缺少父目录")?
        .to_path_buf();
    fs::create_dir_all(&parent).map_err(|err| format!("创建安装父目录失败: {err}"))?;
    let name = format!(
        ".{}.staging",
        install_dir
            .file_name()
            .map(|item| item.to_string_lossy().to_string())
            .unwrap_or_else(|| "meow-starmap".to_string())
    );
    Ok(parent.join(name))
}

fn extract_to(payload: &Path, staging: &Path) -> Result<(), String> {
    if staging.exists() {
        fs::remove_dir_all(staging).map_err(|err| format!("清理暂存目录失败: {err}"))?;
    }
    fs::create_dir_all(staging).map_err(|err| format!("创建暂存目录失败: {err}"))?;

    if payload.is_dir() {
        copy_dir_all(payload, staging)?;
        return Ok(());
    }
    if payload.extension().and_then(|ext| ext.to_str()) != Some("zip") {
        return Err(format!("暂不支持的载荷类型: {}", payload.display()));
    }
    let script = format!(
        "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
        payload.display(),
        staging.display()
    );
    let mut child = hidden_command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("调用 PowerShell 解包失败: {err}"))?;
    loop {
        if is_cancel_requested() {
            let _ = child.kill();
            let _ = child.wait();
            log_line("用户取消：已终止解包进程");
            return Err("安装已取消".to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut output = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    let _ = stdout.read_to_string(&mut output);
                }
                if let Some(mut stderr) = child.stderr.take() {
                    let _ = stderr.read_to_string(&mut output);
                }
                for line in output.lines().filter(|line| !line.trim().is_empty()) {
                    log_line(format!("[unzip] {line}"));
                }
                if !status.success() {
                    log_line("解包失败");
                    return Err("解包安装文件失败".to_string());
                }
                log_line("解包完成");
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(200)),
            Err(err) => return Err(format!("等待解包进程失败: {err}")),
        }
    }
    Ok(())
}

fn copy_dir_all(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|err| format!("创建目录失败: {err}"))?;
    for entry in fs::read_dir(source).map_err(|err| format!("读取目录失败: {err}"))? {
        let entry = entry.map_err(|err| format!("读取目录项失败: {err}"))?;
        let target = destination.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target).map_err(|err| format!("复制文件失败: {err}"))?;
        }
    }
    Ok(())
}

fn swap_in(
    install_dir: &Path,
    staging: &Path,
    steps: &mut Vec<String>,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let parent = install_dir.parent().ok_or("安装目录缺少父目录")?;
    let backup = parent.join(format!(
        ".{}.backup",
        install_dir
            .file_name()
            .map(|item| item.to_string_lossy().to_string())
            .unwrap_or_else(|| "meow-starmap".to_string())
    ));
    if backup.exists() {
        let _ = fs::remove_dir_all(&backup);
    }

    let had_existing = install_dir.exists();
    if had_existing {
        fs::rename(install_dir, &backup).map_err(|err| format!("备份旧版本失败: {err}"))?;
        steps.push("已备份旧版本".to_string());
    }

    match fs::rename(staging, install_dir) {
        Ok(()) => {
            if had_existing {
                let _ = fs::remove_dir_all(&backup);
            }
            steps.push(format!("安装文件已就位: {}", install_dir.display()));
            Ok(())
        }
        Err(err) => {
            if had_existing {
                let _ = fs::rename(&backup, install_dir);
                warnings.push("文件替换失败，已回滚到安装前状态".to_string());
            }
            Err(format!("替换安装目录失败: {err}"))
        }
    }
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
        let status = hidden_command("reg")
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

    let status = hidden_command("certutil")
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
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("创建快捷方式目录失败: {err}"))?;
    }
    let script_path = env::temp_dir().join("meow-installer-shortcut.ps1");
    // PowerShell 5.1 读取无 BOM 的 UTF-8 会按 ANSI 解释，中文路径会变乱码；加 BOM 修正。
    let script = format!(
        "\u{feff}$W = New-Object -ComObject WScript.Shell\n$s = $W.CreateShortcut('{}')\n$s.TargetPath = '{}'\n$s.WorkingDirectory = '{}'\n$s.IconLocation = '{}'\n$s.Save()\n",
        target.display(),
        exe.display(),
        workdir.display(),
        exe.display()
    );
    fs::write(&script_path, script).map_err(|err| err.to_string())?;
    let status = hidden_command("powershell")
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
        return Err(format!("PowerShell 创建快捷方式失败: {}", target.display()));
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
