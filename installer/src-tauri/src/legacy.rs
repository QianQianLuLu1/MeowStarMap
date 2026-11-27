// 旧版 wxnn-photo-manager 数据准备：拷贝旧库/目录到新版数据目录并写迁移标记。
// 真正的新旧库合并由新版应用首次启动执行（Node + better-sqlite3）。
use std::env;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct LegacyData {
    pub data_dir: PathBuf,
    pub install_dir: Option<PathBuf>,
    pub db_path: PathBuf,
}

static PREPARE_LOCK: Mutex<()> = Mutex::new(());
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

pub fn detect() -> Option<LegacyData> {
    let appdata = env::var("APPDATA").ok()?;
    let local = env::var("LOCALAPPDATA").ok();
    let data_dir = Path::new(&appdata).join("wxnn-photo-manager");
    let install_dir = local
        .map(|p| Path::new(&p).join("Programs").join("wxnn-photo-manager"))
        .filter(|p| p.exists());
    let db_path = data_dir.join("database").join("wxnn_photo_manager.db");
    if !data_dir.exists() && install_dir.is_none() {
        return None;
    }
    Some(LegacyData {
        data_dir,
        install_dir,
        db_path,
    })
}

pub fn prepare() -> Result<Option<String>, String> {
    let _guard = PREPARE_LOCK
        .lock()
        .map_err(|_| "旧版数据迁移准备锁不可用".to_string())?;
    let Some(legacy) = detect() else {
        return Ok(None);
    };
    let appdata = env::var("APPDATA").map_err(|err| err.to_string())?;
    let new_root = Path::new(&appdata).join("meow-star-map");
    let marker_path = new_root.join("legacy-migration-pending.json");
    match prepare_legacy(&legacy, &new_root, &marker_path) {
        Ok(result) => Ok(result),
        Err(err) => match clear_marker(&marker_path) {
            Ok(()) => Err(err),
            Err(cleanup) => Err(format!("{err}; {cleanup}")),
        },
    }
}

fn prepare_legacy(
    legacy: &LegacyData,
    new_root: &Path,
    marker_path: &Path,
) -> Result<Option<String>, String> {
    ensure_legacy_stopped()?;
    fs::create_dir_all(new_root).map_err(|err| format!("创建新版数据目录失败: {err}"))?;
    let staging = new_root.join("legacy");
    if pending_snapshot_current(marker_path, legacy, &staging)? {
        return Ok(Some(success_message(legacy)));
    }
    clear_marker(marker_path)?;

    let mut snapshot_temp = None;
    let result = (|| {
        let temp = create_snapshot_dir(new_root)?;
        snapshot_temp = Some(temp.clone());
        copy_database_snapshot(&legacy.db_path, &temp)?;

        for dir in ["thumbnails", "backups", "plugins", "logs"] {
            copy_missing(&legacy.data_dir.join(dir), &new_root.join(dir))?;
        }
        copy_missing(
            &legacy.data_dir.join("search-index"),
            &new_root.join("search-index-legacy"),
        )?;

        ensure_legacy_stopped()?;
        publish_snapshot(&temp, &staging, new_root)?;
        snapshot_temp = None;

        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let marker = serde_json::json!({
            "schema": 1,
            "sourceAppData": legacy.data_dir.to_string_lossy(),
            "sourceInstallDir": legacy.install_dir.as_ref().map(|p| p.to_string_lossy().to_string()),
            "stagedDb": staging.join("wxnn_photo_manager.db").to_string_lossy(),
            "createdAt": created_at
        });
        write_marker_atomic(marker_path, &marker.to_string())
    })();
    if let Err(err) = result {
        if let Some(temp) = snapshot_temp {
            let _ = fs::remove_dir_all(temp);
        }
        return Err(err);
    }
    Ok(Some(success_message(legacy)))
}

fn success_message(legacy: &LegacyData) -> String {
    format!("已准备旧版数据迁移（{}）", legacy.data_dir.display())
}

fn ensure_legacy_stopped() -> Result<(), String> {
    let output = tasklist_command()
        .args(["/FI", "IMAGENAME eq wxnn-photo-manager.exe", "/NH"])
        .output()
        .map_err(|err| format!("检查旧版 wxnn-photo-manager 进程失败: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "检查旧版 wxnn-photo-manager 进程失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    if text.lines().any(|line| {
        line.split_whitespace()
            .next()
            .is_some_and(|name| name.eq_ignore_ascii_case("wxnn-photo-manager.exe"))
    }) {
        return Err("请先停止旧版 wxnn-photo-manager 进程后再重试".to_string());
    }
    Ok(())
}

fn tasklist_command() -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new("tasklist");
        command.creation_flags(0x0800_0000);
        command
    }
    #[cfg(not(windows))]
    Command::new("tasklist")
}

fn sidecar_path(db_path: &Path, suffix: &str) -> PathBuf {
    let mut path = db_path.as_os_str().to_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

fn copy_database_snapshot(source: &Path, target: &Path) -> Result<(), String> {
    if !source.exists() {
        for suffix in ["-wal", "-shm"] {
            if sidecar_path(source, suffix).exists() {
                return Err("旧数据库主库缺失，无法复制一致快照".to_string());
            }
        }
        return Ok(());
    }
    let target_db = target.join("wxnn_photo_manager.db");
    for suffix in ["", "-wal", "-shm"] {
        let source_file = sidecar_path(source, suffix);
        if !source_file.exists() {
            continue;
        }
        fs::copy(&source_file, sidecar_path(&target_db, suffix)).map_err(|err| {
            format!(
                "复制旧数据库失败 ({} -> {}): {err}",
                source_file.display(),
                sidecar_path(&target_db, suffix).display()
            )
        })?;
    }
    for suffix in ["", "-wal", "-shm"] {
        let source_file = sidecar_path(source, suffix);
        if source_file.exists()
            && !files_equal(&source_file, &sidecar_path(&target_db, suffix))
                .map_err(|err| format!("校验旧数据库快照失败: {err}"))?
        {
            return Err("校验旧数据库快照失败: 复制内容不一致".to_string());
        }
    }
    Ok(())
}

fn files_equal(left: &Path, right: &Path) -> Result<bool, String> {
    let mut left = File::open(left).map_err(|err| err.to_string())?;
    let mut right = File::open(right).map_err(|err| err.to_string())?;
    let mut left_buffer = [0; 64 * 1024];
    let mut right_buffer = [0; 64 * 1024];
    loop {
        let left_read = left.read(&mut left_buffer).map_err(|err| err.to_string())?;
        let right_read = right
            .read(&mut right_buffer)
            .map_err(|err| err.to_string())?;
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
    }
}

fn pending_snapshot_current(
    marker_path: &Path,
    legacy: &LegacyData,
    staging: &Path,
) -> Result<bool, String> {
    let raw = match fs::read(marker_path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(format!("读取迁移标记失败: {err}")),
    };
    let marker: serde_json::Value = match serde_json::from_slice(&raw) {
        Ok(marker) => marker,
        Err(_) => return Ok(false),
    };
    if marker.get("schema").and_then(|value| value.as_u64()) != Some(1)
        || marker.get("stagedDb").and_then(|value| value.as_str())
            != Some(
                staging
                    .join("wxnn_photo_manager.db")
                    .to_string_lossy()
                    .as_ref(),
            )
    {
        return Ok(false);
    }
    for suffix in ["", "-wal", "-shm"] {
        let source = sidecar_path(&legacy.db_path, suffix);
        let target = sidecar_path(staging.join("wxnn_photo_manager.db").as_path(), suffix);
        match (source.exists(), target.exists()) {
            (true, true) if !files_equal(&source, &target)? => return Ok(false),
            (true, false) | (false, true) => return Ok(false),
            _ => {}
        }
    }
    Ok(true)
}

fn create_snapshot_dir(new_root: &Path) -> Result<PathBuf, String> {
    loop {
        let path = new_root.join(format!(
            ".legacy-snapshot-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("创建迁移暂存目录失败: {err}")),
        }
    }
}

fn publish_snapshot(temp: &Path, staging: &Path, new_root: &Path) -> Result<(), String> {
    let backup = new_root.join(format!(
        ".legacy-backup-{}-{}",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let had_existing = staging.exists();
    if had_existing {
        fs::rename(staging, &backup).map_err(|err| format!("备份旧迁移快照失败: {err}"))?;
    }
    if let Err(err) = fs::rename(temp, staging) {
        if had_existing {
            let _ = fs::rename(&backup, staging);
        }
        return Err(format!("发布迁移快照失败: {err}"));
    }
    if had_existing {
        let _ = fs::remove_dir_all(&backup);
    }
    Ok(())
}

fn write_marker_atomic(marker_path: &Path, contents: &str) -> Result<(), String> {
    let temp = marker_path.with_file_name(format!(
        ".legacy-migration-pending-{}-{}.tmp",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    if let Err(err) = fs::write(&temp, contents) {
        let _ = fs::remove_file(&temp);
        return Err(format!("写入迁移标记失败: {err}"));
    }
    if let Err(err) = fs::rename(&temp, marker_path) {
        let _ = fs::remove_file(&temp);
        return Err(format!("写入迁移标记失败: {err}"));
    }
    Ok(())
}

fn clear_marker(marker_path: &Path) -> Result<(), String> {
    match fs::remove_file(marker_path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("清理迁移标记失败: {err}")),
    }
}

fn copy_missing(source: &Path, target: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    fs::create_dir_all(target).map_err(|err| format!("创建目录失败: {err}"))?;
    let entries = fs::read_dir(source).map_err(|err| format!("读取目录失败: {err}"))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("读取目录项失败: {err}"))?;
        let target_path = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|err| format!("读取文件类型失败: {err}"))?;
        if file_type.is_dir() {
            copy_missing(&entry.path(), &target_path)?;
        } else if !target_path.exists() {
            fs::copy(entry.path(), &target_path).map_err(|err| format!("复制文件失败: {err}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Mutex, MutexGuard};
    use std::thread;
    use std::time::Duration;

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct TestEnv {
        _lock: MutexGuard<'static, ()>,
        root: PathBuf,
        old_appdata: Option<OsString>,
        old_local_appdata: Option<OsString>,
    }

    impl TestEnv {
        fn new(label: &str) -> Self {
            let lock = ENV_LOCK.lock().unwrap_or_else(|err| err.into_inner());
            let root = env::temp_dir().join(format!(
                "meow-legacy-test-{label}-{}-{}",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).unwrap();
            let old_appdata = env::var_os("APPDATA");
            let old_local_appdata = env::var_os("LOCALAPPDATA");
            env::set_var("APPDATA", &root);
            env::set_var("LOCALAPPDATA", root.join("local"));
            Self {
                _lock: lock,
                root,
                old_appdata,
                old_local_appdata,
            }
        }

        fn legacy_data(&self) -> PathBuf {
            self.root.join("wxnn-photo-manager")
        }

        fn new_root(&self) -> PathBuf {
            self.root.join("meow-star-map")
        }

        fn marker(&self) -> PathBuf {
            self.new_root().join("legacy-migration-pending.json")
        }
    }

    impl Drop for TestEnv {
        fn drop(&mut self) {
            restore_var("APPDATA", &self.old_appdata);
            restore_var("LOCALAPPDATA", &self.old_local_appdata);
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn restore_var(name: &str, value: &Option<OsString>) {
        match value {
            Some(value) => env::set_var(name, value),
            None => env::remove_var(name),
        }
    }

    fn write_database_files(env: &TestEnv) {
        let database = env.legacy_data().join("database");
        fs::create_dir_all(&database).unwrap();
        fs::write(database.join("wxnn_photo_manager.db"), b"main-db").unwrap();
        fs::write(database.join("wxnn_photo_manager.db-wal"), b"wal-frame").unwrap();
        fs::write(database.join("wxnn_photo_manager.db-shm"), b"shm-index").unwrap();
    }

    #[test]
    fn prepare_copies_wal_and_shm_and_is_idempotent() {
        let env = TestEnv::new("snapshot");
        write_database_files(&env);

        prepare().unwrap().expect("应准备旧版迁移");
        let staging = env.new_root().join("legacy");
        assert_eq!(
            fs::read(staging.join("wxnn_photo_manager.db")).unwrap(),
            b"main-db"
        );
        assert_eq!(
            fs::read(staging.join("wxnn_photo_manager.db-wal")).unwrap(),
            b"wal-frame"
        );
        assert_eq!(
            fs::read(staging.join("wxnn_photo_manager.db-shm")).unwrap(),
            b"shm-index"
        );

        let mut marker: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(env.marker()).unwrap()).unwrap();
        marker["createdAt"] = serde_json::json!(1);
        fs::write(env.marker(), marker.to_string()).unwrap();
        let marker_before = fs::read(env.marker()).unwrap();

        prepare().unwrap().expect("重复准备应成功");
        assert_eq!(fs::read(env.marker()).unwrap(), marker_before);
        assert_eq!(
            fs::read(staging.join("wxnn_photo_manager.db-wal")).unwrap(),
            b"wal-frame"
        );
        assert_eq!(
            fs::read(staging.join("wxnn_photo_manager.db-shm")).unwrap(),
            b"shm-index"
        );
    }

    #[test]
    fn prepare_copy_failure_leaves_no_pending_marker() {
        let env = TestEnv::new("copy-failure");
        write_database_files(&env);
        fs::create_dir_all(env.new_root()).unwrap();
        fs::write(env.marker(), b"stale marker").unwrap();
        let wal = env
            .legacy_data()
            .join("database")
            .join("wxnn_photo_manager.db-wal");
        fs::remove_file(&wal).unwrap();
        fs::create_dir_all(&wal).unwrap();

        let error = prepare().expect_err("侧车复制失败必须拒绝准备");
        assert!(error.contains("复制"), "应报告复制失败: {error}");
        assert!(!env.marker().exists(), "失败后不得留下迁移标记");
        assert!(!env.new_root().join("legacy").exists(), "不得发布半套快照");
    }

    #[test]
    fn prepare_rejects_a_running_legacy_process() {
        let env = TestEnv::new("running");
        write_database_files(&env);
        let process_exe = env.root.join("wxnn-photo-manager.exe");
        fs::copy(env::current_exe().unwrap(), &process_exe).unwrap();
        let release = env.root.join("release");
        let child = Command::new(&process_exe)
            .args([
                "--exact",
                "legacy::tests::legacy_process_probe_waits_for_release",
                "--nocapture",
            ])
            .env("MEOW_LEGACY_TEST_RELEASE", &release)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut child = ChildGuard(child);
        assert!(
            wait_for_legacy_process(&mut child.0),
            "测试进程未出现在 tasklist 中"
        );

        let error = prepare().expect_err("旧版进程运行时必须拒绝准备");
        assert!(
            error.contains("wxnn-photo-manager"),
            "错误应指明旧版进程: {error}"
        );
        assert!(!env.marker().exists(), "拒绝后不得留下迁移标记");
        assert!(!env.new_root().exists(), "拒绝前不得创建新版数据目录");
    }

    #[test]
    fn legacy_process_probe_waits_for_release() {
        let Some(release) = env::var_os("MEOW_LEGACY_TEST_RELEASE") else {
            return;
        };
        while !Path::new(&release).exists() {
            thread::sleep(Duration::from_millis(20));
        }
    }

    struct ChildGuard(std::process::Child);

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn wait_for_legacy_process(child: &mut std::process::Child) -> bool {
        for _ in 0..100 {
            if let Ok(Some(status)) = child.try_wait() {
                let mut stderr = String::new();
                if let Some(output) = child.stderr.as_mut() {
                    use std::io::Read;
                    let _ = output.read_to_string(&mut stderr);
                }
                panic!("测试进程提前退出: {status}; stderr: {stderr}");
            }
            let output = Command::new("tasklist")
                .args(["/FI", "IMAGENAME eq wxnn-photo-manager.exe", "/NH"])
                .output();
            if let Ok(output) = output {
                let text = String::from_utf8_lossy(&output.stdout);
                if text.lines().any(|line| {
                    line.split_whitespace()
                        .next()
                        .is_some_and(|name| name.eq_ignore_ascii_case("wxnn-photo-manager.exe"))
                }) {
                    return true;
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
        false
    }
}
