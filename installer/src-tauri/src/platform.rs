use std::env;
use std::fs::{self, File};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::commands::{InstallOptions, InstallSummary, InstallerState};

const UNINSTALL_KEY: &str =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.qianlu.meow-star-map";
const DISPLAY_NAME: &str = "喵星图";
const APP_ID: &str = "com.qianlu.meow-star-map";

static PROGRESS_PERCENT: AtomicU8 = AtomicU8::new(0);
static PROGRESS_MESSAGE: Mutex<String> = Mutex::new(String::new());
static INSTALL_LOGS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);
static COMMIT_POINT: AtomicBool = AtomicBool::new(false);
static NEXT_UNIQUE_PATH: AtomicU64 = AtomicU64::new(0);

pub fn log_line(message: impl Into<String>) {
    if let Ok(mut logs) = INSTALL_LOGS.lock() {
        logs.push(message.into());
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
    if !is_commit_point() {
        CANCEL_REQUESTED.store(true, Ordering::SeqCst);
    }
}

fn reset_cancel() {
    CANCEL_REQUESTED.store(false, Ordering::SeqCst);
    COMMIT_POINT.store(false, Ordering::SeqCst);
}

fn is_cancel_requested() -> bool {
    CANCEL_REQUESTED.load(Ordering::SeqCst)
}

fn is_commit_point() -> bool {
    COMMIT_POINT.load(Ordering::SeqCst)
}

fn mark_commit_point() {
    COMMIT_POINT.store(true, Ordering::SeqCst);
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

fn write_powershell_script(script: &str, stem: &str) -> Result<PathBuf, String> {
    let path = unique_path(&env::temp_dir(), stem).with_extension("ps1");
    fs::write(&path, script).map_err(|err| format!("写入 PowerShell 脚本失败: {err}"))?;
    Ok(path)
}

fn set_progress(percent: u8, message: &str) {
    PROGRESS_PERCENT.store(percent, Ordering::Relaxed);
    if let Ok(mut guard) = PROGRESS_MESSAGE.lock() {
        *guard = message.to_string();
    }
}

pub fn progress_snapshot() -> (u8, String, bool) {
    let percent = PROGRESS_PERCENT.load(Ordering::Relaxed);
    let message = PROGRESS_MESSAGE
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    (percent, message, !is_commit_point())
}

pub fn is_uninstall_requested() -> bool {
    env::args().any(|arg| arg.eq_ignore_ascii_case("--uninstall"))
}

fn validate_uninstall_target(install_dir: &Path) -> Result<(), String> {
    if !install_dir.exists() {
        return Ok(());
    }
    if classify_install_target(install_dir, APP_ID, Some(install_dir))
        == InstallTargetState::Recognized
    {
        Ok(())
    } else {
        Err("注册表记录的目录不是受支持的喵星图安装目录，已拒绝卸载".to_string())
    }
}

pub fn run_uninstall() -> Result<(), String> {
    let current = env::current_exe().ok();
    // 托管卸载：父进程（安装目录内的 Uninstall.exe）退出前仍映射着待删目录里的 exe，
    // 必须等它消失再动手，否则删除必然撞上占用并让卸载半途而废。
    if let Some(parent_pid) = parse_wait_pid(&env::args().collect::<Vec<_>>()) {
        if parent_pid != std::process::id()
            && !wait_for_pid_exit(parent_pid, Duration::from_secs(30), process_exists)
        {
            return Err("等待原安装器退出超时，已取消卸载".to_string());
        }
    }
    let install_dir = read_install_dir();
    if let Some(dir) = install_dir.as_ref() {
        validate_uninstall_target(dir)?;
    }
    let _lock = install_dir
        .as_ref()
        .filter(|dir| dir.exists())
        .map(|dir| InstallLock::acquire(dir.as_path()))
        .transpose()?;

    // 卸载器位于安装目录内时，先复制到临时目录再执行，避免删除正在运行的文件失败
    if let (Some(dir), Some(exe)) = (install_dir.as_ref(), current.as_ref()) {
        if exe.starts_with(dir) {
            let temp =
                unique_path(&env::temp_dir(), "MeowStarMap-Uninstaller").with_extension("exe");
            fs::copy(exe, &temp).map_err(|err| format!("准备卸载器失败: {err}"))?;
            Command::new(&temp)
                .args(uninstaller_relaunch_args(std::process::id()))
                .spawn()
                .map_err(|err| format!("启动卸载器失败: {err}"))?;
            return Ok(());
        }
    }

    remove_shortcuts()?;
    if let Some(dir) = install_dir.as_ref().filter(|dir| dir.exists()) {
        retry_io(3, Duration::from_millis(200), || fs::remove_dir_all(dir))
            .map_err(|err| format!("删除安装目录失败: {err}"))?;
    }
    if install_dir.is_some() {
        let status = hidden_command("reg")
            .args(["delete", UNINSTALL_KEY, "/f"])
            .status()
            .map_err(|err| format!("删除卸载注册表失败: {err}"))?;
        if !status.success() {
            return Err("删除卸载注册表失败".to_string());
        }
    }

    // 临时卸载器：退出前安排删除自身
    if let Some(exe) = current {
        let name = exe
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        if name.starts_with("MeowStarMap-Uninstaller-") {
            let script_path = write_powershell_script(
                "param([string]$Path)\nStart-Sleep -Seconds 1\nRemove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue\nRemove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue\n",
                "meow-self-delete",
            )?;
            hidden_command("powershell")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(&script_path)
                .arg("-Path")
                .arg(&exe)
                .spawn()
                .map_err(|err| format!("安排卸载器自删除失败: {err}"))?;
        }
    }
    Ok(())
}

fn remove_shortcuts() -> Result<(), String> {
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
        match fs::remove_file(target) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("删除快捷方式失败: {err}")),
        }
    }
    Ok(())
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
        && !text
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '?' | '*' | '<' | '>' | '|' | '"'))
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
    let app_running = is_app_running().unwrap_or(true);
    let mode = if installed { "upgrade" } else { "install" };

    InstallerState {
        installed,
        version,
        install_dir: install_dir.map(|dir| dir.to_string_lossy().to_string()),
        app_running,
        mode: mode.to_string(),
        payload_path: payload_hint(),
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
    let _install_lock = InstallLock::acquire(&install_dir)?;

    let installed_before = detect_state().installed;
    let mut steps: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    reset_cancel();
    clear_log();
    log_line(format!("安装目录: {}", install_dir.display()));
    check_cancel()?;

    emit_progress(app, 2, "准备安装");
    log_line("开始安装");
    stop_running_app(&mut steps)?;
    emit_progress(app, 8, "已结束旧进程（如有）");
    log_line("已结束旧进程（如有）");

    let payload = payload_path();
    if let Some(payload) = payload.as_ref() {
        log_line(format!("载荷: {}", payload.display()));
        let unpacked_size = verify_payload(payload, app)?;
        log_line("载荷 sha256/大小校验通过");
        let staging = staging_dir(&install_dir)?;
        let prepare_result: Result<(), String> = (|| {
            emit_progress(app, 20, "正在解包安装文件…");
            extract_to(payload, &staging, app, unpacked_size)?;
            check_cancel()?;
            emit_progress(app, 85, "安装文件已展开");
            emit_progress(app, 90, "正在替换安装目录…");
            swap_in(&install_dir, &staging, &mut steps, &mut warnings)?;
            Ok(())
        })();
        if let Err(err) = prepare_result {
            // 取消/失败：清理暂存目录；swap_in 内部已负责恢复旧版本目录
            let _ = fs::remove_dir_all(&staging);
            log_line(format!("安装失败: {err}"));
            return Err(err);
        }
        emit_progress(app, 92, "文件替换完成");
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
    let uninstaller = match write_uninstaller(&install_dir) {
        Ok(path) => {
            log_line(format!("卸载器已写入: {}", path.display()));
            Some(path)
        }
        Err(err) => {
            log_line(format!("写入卸载器失败: {err}"));
            warnings.push(format!("写入卸载器失败: {err}"));
            None
        }
    };
    let version = read_manifest_version(&install_dir)
        .or_else(|| {
            payload
                .as_ref()
                .and_then(|path| payload_manifest_version(path))
        })
        .or_else(|| query_reg_value(UNINSTALL_KEY, "DisplayVersion"))
        .unwrap_or_else(|| "0.0.0".to_string());

    write_uninstall_registry(&install_dir, uninstaller.as_deref(), &version, &mut steps)?;
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
    run_uninstall()
}

fn wait_for_successful_start(mut child: Child, observe_for: Duration) -> Result<Child, String> {
    let deadline = Instant::now() + observe_for;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(format!("应用启动后提前退出（{status}），请查看应用日志"));
            }
            Ok(None) => {}
            Err(err) => return Err(format!("等待应用启动失败: {err}")),
        }
        if Instant::now() >= deadline {
            return Ok(child);
        }
        thread::sleep(Duration::from_millis(50));
    }
}

pub fn launch_app(app: AppHandle) -> Result<(), String> {
    let install_dir = read_install_dir()
        .or_else(|| arg_value("--install-dir=").map(PathBuf::from))
        .ok_or("未找到安装目录".to_string())?;
    let exe = find_app_exe(&install_dir).ok_or("安装目录中未找到应用可执行文件".to_string())?;
    let child = Command::new(exe)
        .spawn()
        .map_err(|err| format!("启动应用失败: {err}"))?;
    let child = wait_for_successful_start(child, Duration::from_millis(800))?;
    // 应用进程成功创建后自动关闭安装器，避免残留窗口
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(800));
        let _ = child.id();
        app.exit(0);
    });
    Ok(())
}

fn emit_progress(app: &AppHandle, percent: u8, message: &str) {
    set_progress(percent, message);
    let _ = app.emit(
        "installer-progress",
        serde_json::json!({
            "percent": percent,
            "message": message,
            "cancellable": !is_commit_point()
        }),
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

fn payload_hint() -> Option<String> {
    if let Ok(custom) = env::var("MEOW_INSTALLER_PAYLOAD") {
        let path = PathBuf::from(custom);
        if path.exists() {
            return Some(path.to_string_lossy().to_string());
        }
    }
    if has_embedded_payload() {
        return Some("embedded".to_string());
    }
    let exe_dir = env::current_exe().ok()?.parent()?.to_path_buf();
    for candidate in ["payload.zip", "payload"] {
        let path = exe_dir.join(candidate);
        if path.exists() {
            return Some(path.to_string_lossy().to_string());
        }
    }
    None
}

/// 只检查 exe 尾部 footer（不复制/解包 245MB 载荷），供 detect_state 快速返回。
fn has_embedded_payload() -> bool {
    let Ok(exe) = env::current_exe() else {
        return false;
    };
    let Ok(mut file) = File::open(exe) else {
        return false;
    };
    let Ok(len) = file.metadata().map(|meta| meta.len()) else {
        return false;
    };
    if len <= PAYLOAD_TRAILER_LEN {
        return false;
    }
    if file.seek(SeekFrom::End(-8)).is_err() {
        return false;
    }
    let mut magic = [0u8; 8];
    if file.read_exact(&mut magic).is_err() || &magic != PAYLOAD_TRAILER_MAGIC {
        return false;
    }
    if file.seek(SeekFrom::End(-24)).is_err() {
        return false;
    }
    let mut zip_size_buf = [0u8; 8];
    let mut manifest_size_buf = [0u8; 8];
    if file.read_exact(&mut zip_size_buf).is_err()
        || file.read_exact(&mut manifest_size_buf).is_err()
    {
        return false;
    }
    parse_payload_footer(
        len,
        u64::from_le_bytes(zip_size_buf),
        u64::from_le_bytes(manifest_size_buf),
    )
    .is_some()
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
const MAX_PAYLOAD_MANIFEST_SIZE: u64 = 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
enum InstallTargetState {
    Missing,
    Empty,
    Recognized,
    Rejected,
}

fn parse_payload_footer(file_len: u64, zip_size: u64, manifest_size: u64) -> Option<u64> {
    if file_len <= PAYLOAD_TRAILER_LEN
        || zip_size == 0
        || manifest_size == 0
        || manifest_size > MAX_PAYLOAD_MANIFEST_SIZE
    {
        return None;
    }
    let payload_len = zip_size
        .checked_add(manifest_size)?
        .checked_add(PAYLOAD_TRAILER_LEN)?;
    if payload_len >= file_len {
        return None;
    }
    Some(file_len - payload_len)
}

fn classify_install_target(
    target: &Path,
    app_id: &str,
    registry_dir: Option<&Path>,
) -> InstallTargetState {
    if !target.exists() {
        return InstallTargetState::Missing;
    }
    if !target.is_dir() {
        return InstallTargetState::Rejected;
    }
    let Ok(mut entries) = fs::read_dir(target) else {
        return InstallTargetState::Rejected;
    };
    if entries.next().is_none() {
        return InstallTargetState::Empty;
    }
    if find_expected_app_exe(target).is_none() {
        return InstallTargetState::Rejected;
    }

    let registry_match = registry_dir.is_some_and(|recorded| {
        recorded == target
            || match (recorded.canonicalize(), target.canonicalize()) {
                (Ok(recorded), Ok(target)) => recorded == target,
                _ => false,
            }
    });
    let manifest_match = fs::read_to_string(target.join("install-manifest.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| value.get("appId")?.as_str().map(str::to_string))
        .is_some_and(|id| id == app_id);

    if registry_match || manifest_match {
        InstallTargetState::Recognized
    } else {
        InstallTargetState::Rejected
    }
}

fn extract_archive_script() -> String {
    "param([string]$Payload, [string]$Destination)\n\
     $ErrorActionPreference = 'Stop'\n\
     Expand-Archive -LiteralPath $Payload -DestinationPath $Destination -Force\n"
        .to_string()
}

fn create_shortcut_script() -> String {
    "param([string]$Target, [string]$Exe, [string]$WorkDir)\n\
     $ErrorActionPreference = 'Stop'\n\
     $W = New-Object -ComObject WScript.Shell\n\
     $s = $W.CreateShortcut($Target)\n\
     $s.TargetPath = $Exe\n\
     $s.WorkingDirectory = $WorkDir\n\
     $s.IconLocation = $Exe\n\
     $s.Save()\n"
        .to_string()
}

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
    let zip_offset = parse_payload_footer(len, zip_size, manifest_size)?;
    let manifest_offset = zip_offset.checked_add(zip_size)?;
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

fn is_app_running() -> Result<bool, String> {
    let output = hidden_command("tasklist")
        .args(["/FI", "IMAGENAME eq 喵星图.exe", "/NH"])
        .output()
        .map_err(|err| format!("查询喵星图进程失败: {err}"))?;
    if !output.status.success() {
        return Err("查询喵星图进程失败".to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text.contains("喵星图.exe"))
}

fn verify_app_stopped(
    taskkill_succeeded: bool,
    still_running: bool,
    steps: &mut Vec<String>,
) -> Result<(), String> {
    if !taskkill_succeeded {
        return Err("结束喵星图进程失败，请手动关闭后重试".to_string());
    }
    if still_running {
        return Err("喵星图进程仍在运行，请手动关闭后重试".to_string());
    }
    steps.push("已结束正在运行的喵星图进程".to_string());
    Ok(())
}

fn stop_running_app(steps: &mut Vec<String>) -> Result<(), String> {
    if !is_app_running()? {
        return Ok(());
    }
    let status = hidden_command("taskkill")
        .args(["/IM", "喵星图.exe", "/F"])
        .status()
        .map_err(|err| format!("结束喵星图进程失败: {err}"))?;
    verify_app_stopped(status.success(), is_app_running()?, steps)
}

fn sha256_file_with_progress(path: &Path, app: &AppHandle) -> Result<String, String> {
    let file = File::open(path).map_err(|err| format!("打开载荷失败: {err}"))?;
    let total = file
        .metadata()
        .map_err(|err| format!("读取载荷大小失败: {err}"))?
        .len();
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    let mut done: u64 = 0;
    let mut last_percent = 0u8;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|err| format!("读取载荷失败: {err}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        done += read as u64;
        let percent = if total > 0 {
            2 + ((done.min(total) as f64 / total as f64) * 18.0) as u8
        } else {
            2
        };
        if percent != last_percent {
            last_percent = percent;
            emit_progress(app, percent, "正在校验载荷…");
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn read_payload_manifest(path: &Path) -> Result<serde_json::Value, String> {
    let size = fs::metadata(path)
        .map_err(|err| format!("读取载荷清单失败: {err}"))?
        .len();
    if size > MAX_PAYLOAD_MANIFEST_SIZE {
        return Err("载荷清单超过大小上限".to_string());
    }
    let raw = fs::read_to_string(path).map_err(|err| format!("读取载荷清单失败: {err}"))?;
    serde_json::from_str(&raw).map_err(|err| format!("解析载荷清单失败: {err}"))
}

fn valid_version(version: &str) -> bool {
    let core = version.split(['-', '+']).next().unwrap_or_default();
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn validate_payload_manifest(value: &serde_json::Value, payload: &Path) -> Result<(), String> {
    let sha256 = value
        .get("sha256")
        .and_then(|item| item.as_str())
        .ok_or("载荷清单缺少 sha256")?;
    if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("载荷清单 sha256 格式非法".to_string());
    }
    for field in ["size", "unpackedSize"] {
        if value.get(field).is_some_and(|item| item.as_u64().is_none()) {
            return Err(format!("载荷清单 {field} 必须是正整数"));
        }
    }
    if let Some(file) = value.get("file") {
        let file = file.as_str().ok_or("载荷清单 file 必须是字符串")?;
        if payload.file_name().and_then(|name| name.to_str()) != Some(file) {
            return Err("载荷清单 file 与载荷文件名不一致".to_string());
        }
    }
    if let Some(version) = value.get("version") {
        let version = version.as_str().ok_or("载荷清单 version 必须是字符串")?;
        if !valid_version(version) {
            return Err("载荷清单 version 格式非法".to_string());
        }
    }
    if let Some(format) = value.get("format") {
        if format.as_str() != Some("zip") {
            return Err("载荷清单 format 必须是 zip".to_string());
        }
    }
    Ok(())
}

fn verify_payload(payload: &Path, app: &AppHandle) -> Result<Option<u64>, String> {
    let manifest_path = PathBuf::from(format!("{}.json", payload.display()));
    if !manifest_path.exists() {
        // 清单可选：没有清单时跳过哈希校验（由发布流程决定是否提供）
        return Ok(None);
    }
    let value = read_payload_manifest(&manifest_path)?;
    validate_payload_manifest(&value, payload)?;
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
    let actual = sha256_file_with_progress(payload, app)?;
    if !actual.eq_ignore_ascii_case(expected) {
        return Err("载荷 sha256 校验失败，安装包可能已损坏".to_string());
    }
    Ok(value.get("unpackedSize").and_then(|item| item.as_u64()))
}

fn lock_path(install_dir: &Path) -> Result<PathBuf, String> {
    let parent = install_dir.parent().ok_or("安装目录缺少父目录")?;
    let name = install_dir
        .file_name()
        .map(|item| item.to_string_lossy().to_string())
        .unwrap_or_else(|| "meow-starmap".to_string());
    Ok(parent.join(format!(".{name}.installer.lock")))
}

fn process_exists(pid: u32) -> bool {
    let Ok(output) = hidden_command("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
    else {
        return true;
    };
    if !output.status.success() {
        return true;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().any(|line| {
        line.split(',')
            .nth(1)
            .is_some_and(|value| value.trim().trim_matches('"') == pid.to_string())
    })
}

/// 卸载器托管启动参数：多带一个父进程 pid，供子进程等父进程退出后再删安装目录
/// （父进程此时仍映射着安装目录内的 Uninstall.exe，Windows 不允许删除运行中的镜像）。
fn uninstaller_relaunch_args(parent_pid: u32) -> Vec<String> {
    vec![
        "--uninstall".to_string(),
        format!("--wait-pid={parent_pid}"),
    ]
}

fn parse_wait_pid(args: &[String]) -> Option<u32> {
    args.iter()
        .find_map(|arg| arg.strip_prefix("--wait-pid="))
        .and_then(|value| value.trim().parse::<u32>().ok())
}

/// 轮询等待目标进程消失；超时返回 false。probe 注入使判据可在单测里替换。
fn wait_for_pid_exit<F>(pid: u32, timeout: Duration, mut probe: F) -> bool
where
    F: FnMut(u32) -> bool,
{
    let deadline = Instant::now() + timeout;
    loop {
        if !probe(pid) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

/// 有限次重试：杀软/索引器短暂持有句柄时，删除目录类动作不该一次失败就放弃。
fn retry_io<F>(attempts: u32, delay: Duration, mut op: F) -> std::io::Result<()>
where
    F: FnMut() -> std::io::Result<()>,
{
    let mut last = Ok(());
    for attempt in 0..attempts.max(1) {
        match op() {
            Ok(()) => return Ok(()),
            Err(err) => {
                last = Err(err);
                if attempt + 1 < attempts.max(1) {
                    thread::sleep(delay);
                }
            }
        }
    }
    last
}

fn clear_stale_lock(path: &Path) -> bool {
    match fs::read_to_string(path.join("owner")) {
        Ok(owner) => {
            let alive = owner
                .split_once('-')
                .and_then(|(pid, _)| pid.parse::<u32>().ok())
                .is_none_or(process_exists);
            if alive {
                return false;
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let fresh = match fs::metadata(path) {
                Ok(meta) => meta
                    .modified()
                    .ok()
                    .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                    .is_some_and(|age| age < Duration::from_secs(30)),
                Err(_) => return false,
            };
            if fresh {
                return false;
            }
        }
        Err(_) => return false,
    }
    fs::remove_dir_all(path).is_ok()
}

struct InstallLock {
    path: PathBuf,
    token: String,
}

impl InstallLock {
    fn try_acquire(install_dir: &Path) -> Result<Self, String> {
        let path = lock_path(install_dir)?;
        loop {
            match fs::create_dir(&path) {
                Ok(()) => {
                    let token = format!(
                        "{}-{}",
                        std::process::id(),
                        NEXT_UNIQUE_PATH.fetch_add(1, Ordering::Relaxed)
                    );
                    if let Err(err) = fs::write(path.join("owner"), &token) {
                        let _ = fs::remove_dir_all(&path);
                        return Err(format!("写入安装锁失败: {err}"));
                    }
                    return Ok(Self { path, token });
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                    if clear_stale_lock(&path) {
                        continue;
                    }
                    return Err("另一安装器正在使用该目录，请等待其完成后重试".to_string());
                }
                Err(err) => return Err(format!("创建安装锁失败: {err}")),
            }
        }
    }

    fn acquire(install_dir: &Path) -> Result<Self, String> {
        let parent = install_dir.parent().ok_or("安装目录缺少父目录")?;
        fs::create_dir_all(parent).map_err(|err| format!("创建安装父目录失败: {err}"))?;
        for _ in 0..50 {
            match Self::try_acquire(install_dir) {
                Ok(lock) => return Ok(lock),
                Err(err) if lock_path(install_dir).is_ok_and(|path| path.exists()) => {
                    thread::sleep(Duration::from_millis(100));
                    if err.starts_with("创建安装锁失败") {
                        return Err(err);
                    }
                }
                Err(err) => return Err(err),
            }
        }
        Err("等待另一安装器超时，请稍后重试".to_string())
    }
}

impl Drop for InstallLock {
    fn drop(&mut self) {
        if fs::read_to_string(self.path.join("owner")).is_ok_and(|owner| owner == self.token) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn unique_path(directory: &Path, stem: &str) -> PathBuf {
    loop {
        let sequence = NEXT_UNIQUE_PATH.fetch_add(1, Ordering::Relaxed);
        let candidate = directory.join(format!("{stem}-{}-{sequence}", std::process::id()));
        if fs::symlink_metadata(&candidate).is_err() {
            return candidate;
        }
    }
}

fn staging_dir(install_dir: &Path) -> Result<PathBuf, String> {
    let parent = install_dir
        .parent()
        .ok_or("安装目录缺少父目录")?
        .to_path_buf();
    fs::create_dir_all(&parent).map_err(|err| format!("创建安装父目录失败: {err}"))?;
    let name = install_dir
        .file_name()
        .map(|item| item.to_string_lossy().to_string())
        .unwrap_or_else(|| "meow-starmap".to_string());
    Ok(unique_path(&parent, &format!(".{name}.staging")))
}

fn extract_to(
    payload: &Path,
    staging: &Path,
    app: &AppHandle,
    expected_unpacked: Option<u64>,
) -> Result<(), String> {
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
    let script_path = write_powershell_script(&extract_archive_script(), "meow-extract")?;
    let result = (|| {
        let mut child = hidden_command("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&script_path)
            .args(["-Payload"])
            .arg(payload)
            .args(["-Destination"])
            .arg(staging)
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
                Ok(None) => {
                    if let Some(expected) = expected_unpacked.filter(|value| *value > 0) {
                        let extracted = dir_size(staging);
                        let percent =
                            20 + ((extracted.min(expected) as f64 / expected as f64) * 65.0) as u8;
                        emit_progress(app, percent.min(84), "正在解包安装文件…");
                    }
                    thread::sleep(Duration::from_millis(200))
                }
                Err(err) => return Err(format!("等待解包进程失败: {err}")),
            }
        }
        Ok(())
    })();
    let _ = fs::remove_file(script_path);
    result
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            total += dir_size(&entry.path());
        } else {
            total += metadata.len();
        }
    }
    total
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
    let registry_dir = read_install_dir();
    if classify_install_target(install_dir, APP_ID, registry_dir.as_deref())
        == InstallTargetState::Rejected
    {
        return Err("安装目录非空且不是受支持的喵星图安装目录，已拒绝替换".to_string());
    }
    check_cancel()?;
    let name = install_dir
        .file_name()
        .map(|item| item.to_string_lossy().to_string())
        .unwrap_or_else(|| "meow-starmap".to_string());
    let backup = unique_path(parent, &format!(".{name}.backup"));
    let had_existing = install_dir.exists();
    if had_existing {
        fs::rename(install_dir, &backup).map_err(|err| format!("备份旧版本失败: {err}"))?;
        mark_commit_point();
        steps.push("已备份旧版本".to_string());
    }

    match fs::rename(staging, install_dir) {
        Ok(()) => {
            mark_commit_point();
            if had_existing {
                if let Err(err) = fs::remove_dir_all(&backup) {
                    warnings.push(format!("旧版本备份清理失败，已保留: {}", backup.display()));
                    log_line(format!("备份清理失败: {err}"));
                }
            }
            steps.push(format!("安装文件已就位: {}", install_dir.display()));
            Ok(())
        }
        Err(err) => {
            if had_existing {
                fs::rename(&backup, install_dir).map_err(|rollback| {
                    format!(
                        "替换安装目录失败: {err}；回滚失败: {rollback}；旧版本保留在 {}",
                        backup.display()
                    )
                })?;
                COMMIT_POINT.store(false, Ordering::SeqCst);
                warnings.push("文件替换失败，已回滚到安装前状态".to_string());
            }
            Err(format!("替换安装目录失败: {err}"))
        }
    }
}

fn write_uninstaller(install_dir: &Path) -> Result<PathBuf, String> {
    let current = env::current_exe().map_err(|err| format!("读取安装器路径失败: {err}"))?;
    let total = fs::metadata(&current)
        .map_err(|err| format!("读取安装器大小失败: {err}"))?
        .len();
    // 单文件安装包 = [原始 exe][payload][footer]；只复制 PE 本体，卸载器约 10MB
    let exe_len = payload_offset(&current).unwrap_or(total);
    let destination = install_dir.join("Uninstall.exe");
    let source = File::open(&current).map_err(|err| format!("打开安装器失败: {err}"))?;
    let mut target = File::create(&destination).map_err(|err| format!("创建卸载器失败: {err}"))?;
    let copied = std::io::copy(&mut source.take(exe_len), &mut target)
        .map_err(|err| format!("写入卸载器失败: {err}"))?;
    if copied != exe_len {
        let _ = fs::remove_file(&destination);
        return Err("写入卸载器不完整".to_string());
    }
    Ok(destination)
}

fn payload_offset(exe: &Path) -> Option<u64> {
    let mut file = File::open(exe).ok()?;
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
    parse_payload_footer(len, zip_size, manifest_size)
}

fn verify_registry_write(succeeded: bool, name: &str) -> Result<(), String> {
    if succeeded {
        Ok(())
    } else {
        Err(format!("写入注册表项 {name} 失败"))
    }
}

fn write_uninstall_registry(
    install_dir: &Path,
    uninstaller: Option<&Path>,
    version: &str,
    steps: &mut Vec<String>,
) -> Result<(), String> {
    let exe = find_app_exe(install_dir)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    let uninstall_string = uninstaller
        .map(|path| format!("\"{}\" --uninstall", path.display()))
        .or_else(|| {
            env::current_exe()
                .ok()
                .map(|path| format!("\"{}\" --uninstall", path.display()))
        })
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
            .status()
            .map_err(|err| format!("写入注册表项 {name} 失败: {err}"))?;
        verify_registry_write(status.success(), name)?;
    }
    steps.push("写入卸载项注册表".to_string());
    Ok(())
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
    let script_path = write_powershell_script(&create_shortcut_script(), "meow-shortcut")?;
    let result = (|| {
        let status = hidden_command("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&script_path)
            .args(["-Target"])
            .arg(target)
            .args(["-Exe"])
            .arg(exe)
            .args(["-WorkDir"])
            .arg(workdir)
            .status()
            .map_err(|err| err.to_string())?;
        if !status.success() {
            return Err(format!("PowerShell 创建快捷方式失败: {}", target.display()));
        }
        Ok(())
    })();
    let _ = fs::remove_file(script_path);
    result
}

fn find_expected_app_exe(install_dir: &Path) -> Option<PathBuf> {
    for name in ["喵星图.exe", "MeowStarMap.exe", "meow-star-map.exe"] {
        let path = install_dir.join(name);
        if path.exists() {
            return Some(path);
        }
    }
    None
}

fn find_app_exe(install_dir: &Path) -> Option<PathBuf> {
    if let Some(path) = find_expected_app_exe(install_dir) {
        return Some(path);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
    static TEST_STATE_LOCK: Mutex<()> = Mutex::new(());

    fn temp_dir(label: &str) -> PathBuf {
        let path = env::temp_dir().join(format!(
            "meow-installer-test-{label}-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn cancellation_is_ignored_after_the_commit_point() {
        let _guard = TEST_STATE_LOCK.lock().unwrap();
        reset_cancel();
        request_cancel();
        assert!(is_cancel_requested());

        reset_cancel();
        mark_commit_point();
        request_cancel();
        assert!(!is_cancel_requested());
        assert!(is_commit_point());
        reset_cancel();
    }

    #[test]
    fn stop_result_rejects_failed_or_still_running_processes() {
        let mut steps = Vec::new();
        assert!(verify_app_stopped(false, false, &mut steps).is_err());
        assert!(verify_app_stopped(true, true, &mut steps).is_err());
        assert!(verify_app_stopped(true, false, &mut steps).is_ok());
        assert_eq!(steps, vec!["已结束正在运行的喵星图进程".to_string()]);
    }

    #[cfg(windows)]
    #[test]
    fn launch_probe_rejects_a_child_that_exits_early() {
        let child = hidden_command("cmd")
            .args(["/C", "exit", "7"])
            .spawn()
            .unwrap();
        assert!(wait_for_successful_start(child, Duration::from_millis(500)).is_err());
    }

    #[test]
    fn registry_write_failure_is_an_install_failure() {
        assert!(verify_registry_write(false, "DisplayName").is_err());
        assert!(verify_registry_write(true, "DisplayName").is_ok());
    }

    #[test]
    fn uninstall_target_rejects_an_unowned_nonempty_directory() {
        let root = temp_dir("uninstall-target");
        let target = root.join("app");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("unrelated.txt"), "keep").unwrap();

        assert!(validate_uninstall_target(&target).is_err());
        assert_eq!(
            fs::read_to_string(target.join("unrelated.txt")).unwrap(),
            "keep"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn install_target_whitelist_requires_the_expected_application_executable() {
        let root = temp_dir("wrong-exe");
        let target = root.join("app");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("Other.exe"), "MZ").unwrap();
        fs::write(
            target.join("install-manifest.json"),
            r#"{"appId":"com.qianlu.meow-star-map"}"#,
        )
        .unwrap();

        assert_eq!(
            classify_install_target(&target, APP_ID, None),
            InstallTargetState::Rejected
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn install_lock_excludes_concurrent_installers_and_releases_on_drop() {
        let root = temp_dir("lock");
        let target = root.join("app");
        fs::create_dir_all(&target).unwrap();
        let first = InstallLock::try_acquire(&target).unwrap();

        assert!(InstallLock::try_acquire(&target).is_err());
        drop(first);
        let second = InstallLock::try_acquire(&target).unwrap();
        drop(second);
        assert!(!lock_path(&target).unwrap().exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn install_lock_recovers_a_stale_owner() {
        let root = temp_dir("stale-lock");
        let target = root.join("app");
        fs::create_dir_all(&target).unwrap();
        let path = lock_path(&target).unwrap();
        let mut child = hidden_command("cmd")
            .args(["/C", "exit", "0"])
            .spawn()
            .unwrap();
        let stale_pid = child.id();
        child.wait().unwrap();
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("owner"), format!("{stale_pid}-0")).unwrap();

        let lock = InstallLock::try_acquire(&target).unwrap();
        drop(lock);
        assert!(!lock_path(&target).unwrap().exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn install_path_validation_accepts_unicode_and_rejects_windows_invalid_chars() {
        assert!(is_sane_install_path(Path::new(r"C:\用户\喵星图")));
        assert!(!is_sane_install_path(Path::new(r"C:\bad?")));
        assert!(!is_sane_install_path(Path::new("C:\\bad\npath")));
    }

    #[test]
    fn payload_manifest_rejects_malformed_metadata_fields() {
        let payload = PathBuf::from("payload.zip");
        let mut manifest = serde_json::json!({
            "file": "payload.zip",
            "version": "2.5.7",
            "format": "zip",
            "size": 7,
            "unpackedSize": 9,
            "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        });
        assert!(validate_payload_manifest(&manifest, &payload).is_ok());

        manifest["size"] = serde_json::json!("7");
        assert!(validate_payload_manifest(&manifest, &payload).is_err());
        manifest["size"] = serde_json::json!(7);
        manifest["file"] = serde_json::json!("other.zip");
        assert!(validate_payload_manifest(&manifest, &payload).is_err());
        manifest["file"] = serde_json::json!("payload.zip");
        manifest["version"] = serde_json::json!("bad");
        assert!(validate_payload_manifest(&manifest, &payload).is_err());
        manifest["version"] = serde_json::json!("2.5.7");
        manifest["format"] = serde_json::json!("tar");
        assert!(validate_payload_manifest(&manifest, &payload).is_err());
        manifest["format"] = serde_json::json!("zip");
        manifest["sha256"] = serde_json::json!("abc");
        assert!(validate_payload_manifest(&manifest, &payload).is_err());
    }

    #[test]
    fn payload_manifest_reader_rejects_oversized_files() {
        let root = temp_dir("manifest-limit");
        let manifest = root.join("payload.zip.json");
        fs::write(
            &manifest,
            vec![b' '; (MAX_PAYLOAD_MANIFEST_SIZE + 1) as usize],
        )
        .unwrap();

        assert!(read_payload_manifest(&manifest).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn payload_footer_rejects_overflow_and_oversized_manifest() {
        assert!(parse_payload_footer(100, u64::MAX, 1).is_none());
        assert!(parse_payload_footer(100, 1, u64::MAX).is_none());
        assert!(parse_payload_footer(100, 1, MAX_PAYLOAD_MANIFEST_SIZE + 1).is_none());
        assert!(parse_payload_footer(100, 1, 0).is_none());
    }

    #[test]
    fn payload_footer_returns_checked_zip_offset() {
        assert_eq!(parse_payload_footer(100, 40, 20), Some(16));
    }

    #[test]
    fn payload_offset_rejects_overflow_without_panicking() {
        let root = temp_dir("footer");
        let exe = root.join("installer.exe");
        let mut bytes = vec![0u8; 25];
        bytes[17..25].copy_from_slice(PAYLOAD_TRAILER_MAGIC);
        bytes[1..9].copy_from_slice(&u64::MAX.to_le_bytes());
        bytes[9..17].copy_from_slice(&1u64.to_le_bytes());
        fs::write(&exe, bytes).unwrap();

        let result = std::panic::catch_unwind(|| payload_offset(&exe));
        assert!(result.is_ok(), "malformed footer must not panic");
        assert_eq!(result.unwrap(), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn install_target_whitelist_rejects_unowned_nonempty_directory() {
        let root = temp_dir("target");
        let target = root.join("app");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("unrelated.txt"), "keep").unwrap();

        assert_eq!(
            classify_install_target(&target, "com.qianlu.meow-star-map", None),
            InstallTargetState::Rejected
        );
        assert_eq!(
            fs::read_to_string(target.join("unrelated.txt")).unwrap(),
            "keep"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn install_target_whitelist_accepts_empty_manifest_and_registry_directories() {
        let root = temp_dir("target");
        let empty = root.join("empty");
        fs::create_dir_all(&empty).unwrap();
        assert_eq!(
            classify_install_target(&empty, "com.qianlu.meow-star-map", None),
            InstallTargetState::Empty
        );

        let manifest = root.join("manifest");
        fs::create_dir_all(&manifest).unwrap();
        fs::write(manifest.join("MeowStarMap.exe"), "MZ").unwrap();
        fs::write(
            manifest.join("install-manifest.json"),
            r#"{"appId":"com.qianlu.meow-star-map"}"#,
        )
        .unwrap();
        assert_eq!(
            classify_install_target(&manifest, "com.qianlu.meow-star-map", None),
            InstallTargetState::Recognized
        );

        let registry = root.join("registry");
        fs::create_dir_all(&registry).unwrap();
        fs::write(registry.join("MeowStarMap.exe"), "MZ").unwrap();
        assert_eq!(
            classify_install_target(&registry, "com.qianlu.meow-star-map", Some(&registry)),
            InstallTargetState::Recognized
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn swap_in_rejects_unowned_nonempty_target_without_changing_it() {
        let root = temp_dir("swap-target");
        let target = root.join("app");
        let staging = root.join("staging");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&staging).unwrap();
        fs::write(target.join("unrelated.txt"), "keep").unwrap();
        fs::write(staging.join("new.txt"), "new").unwrap();
        let mut steps = Vec::new();
        let mut warnings = Vec::new();

        assert!(swap_in(&target, &staging, &mut steps, &mut warnings).is_err());
        assert_eq!(
            fs::read_to_string(target.join("unrelated.txt")).unwrap(),
            "keep"
        );
        assert!(!target.join("new.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn swap_in_preserves_unrelated_preexisting_backup() {
        let _guard = TEST_STATE_LOCK.lock().unwrap();
        let root = temp_dir("swap-backup");
        let target = root.join("app");
        let staging = root.join("staging");
        let old_backup = root.join(".app.backup");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&staging).unwrap();
        fs::create_dir_all(&old_backup).unwrap();
        fs::write(old_backup.join("keep.txt"), "keep").unwrap();
        fs::write(staging.join("new.txt"), "new").unwrap();
        let mut steps = Vec::new();
        let mut warnings = Vec::new();

        assert!(swap_in(&target, &staging, &mut steps, &mut warnings).is_ok());
        assert_eq!(
            fs::read_to_string(old_backup.join("keep.txt")).unwrap(),
            "keep"
        );
        assert_eq!(fs::read_to_string(target.join("new.txt")).unwrap(), "new");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn shortcut_creation_accepts_paths_with_apostrophes() {
        let root = temp_dir("shortcut");
        let workdir = root.join("owner's app");
        fs::create_dir_all(&workdir).unwrap();
        let exe = workdir.join("MeowStarMap.exe");
        fs::write(&exe, "MZ").unwrap();
        let target = root.join("owner's shortcut.lnk");

        assert!(create_shortcut(&target, &exe, &workdir).is_ok());
        assert!(target.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn powershell_scripts_parameterize_paths_instead_of_interpolating_them() {
        let extract = extract_archive_script();
        assert!(extract.contains("param([string]$Payload, [string]$Destination)"));
        assert!(extract.contains("-LiteralPath $Payload"));
        assert!(!extract.contains("'{}'"));

        let shortcut = create_shortcut_script();
        assert!(shortcut.contains("param([string]$Target, [string]$Exe, [string]$WorkDir)"));
        assert!(shortcut.contains("$W.CreateShortcut($Target)"));
        assert!(!shortcut.contains("'{}'"));
    }

    #[test]
    fn uninstaller_relaunch_waits_for_the_parent_installer_pid() {
        // 安装目录内的 Uninstall.exe 会把自身复制到临时目录再托管卸载；父进程此时
        // 仍映射着安装目录里的 exe，子进程必须先等它退出，否则删除目录必然撞上占用。
        assert_eq!(
            uninstaller_relaunch_args(4321),
            vec!["--uninstall".to_string(), "--wait-pid=4321".to_string()]
        );
        assert_eq!(parse_wait_pid(&["--uninstall".to_string()]), None);
        assert_eq!(
            parse_wait_pid(&["--uninstall".to_string(), "--wait-pid=99".to_string()]),
            Some(99)
        );
        assert_eq!(parse_wait_pid(&["--wait-pid=abc".to_string()]), None);
    }

    #[test]
    fn wait_for_pid_exit_polls_until_the_process_disappears() {
        let mut probes = 0;
        let exited = wait_for_pid_exit(7, Duration::from_millis(500), |_| {
            probes += 1;
            probes < 3
        });
        assert!(exited);
        assert!(probes >= 3);
    }

    #[test]
    fn wait_for_pid_exit_reports_timeout_for_a_live_process() {
        assert!(!wait_for_pid_exit(7, Duration::from_millis(60), |_| true));
    }

    #[test]
    fn retry_io_recovers_from_a_transient_failure() {
        let mut attempts = 0;
        let outcome = retry_io(3, Duration::ZERO, || {
            attempts += 1;
            if attempts < 3 {
                Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
            } else {
                Ok(())
            }
        });
        assert!(outcome.is_ok());
        assert_eq!(attempts, 3);
    }

    #[test]
    fn retry_io_surfaces_the_last_error_after_exhausting_attempts() {
        let mut attempts = 0;
        let outcome = retry_io(3, Duration::ZERO, || {
            attempts += 1;
            Err::<(), _>(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        });
        assert_eq!(
            outcome.unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
        assert_eq!(attempts, 3);
    }
}
