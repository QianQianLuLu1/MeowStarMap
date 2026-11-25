// 旧版 wxnn-photo-manager 数据准备：拷贝旧库/目录到新版数据目录并写迁移标记。
// 真正的新旧库合并由新版应用首次启动执行（Node + better-sqlite3）。
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct LegacyData {
    pub data_dir: PathBuf,
    pub install_dir: Option<PathBuf>,
    pub db_path: PathBuf,
}

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
    let Some(legacy) = detect() else {
        return Ok(None);
    };
    let appdata = env::var("APPDATA").map_err(|err| err.to_string())?;
    let new_root = Path::new(&appdata).join("meow-star-map");
    fs::create_dir_all(&new_root).map_err(|err| format!("创建新版数据目录失败: {err}"))?;
    let staging = new_root.join("legacy");
    fs::create_dir_all(&staging).map_err(|err| format!("创建迁移暂存目录失败: {err}"))?;

    if legacy.db_path.exists() {
        fs::copy(
            &legacy.db_path,
            staging.join("wxnn_photo_manager.db"),
        )
        .map_err(|err| format!("复制旧数据库失败: {err}"))?;
    }

    for dir in ["thumbnails", "backups", "plugins", "logs"] {
        copy_missing(&legacy.data_dir.join(dir), &new_root.join(dir))?;
    }
    copy_missing(
        &legacy.data_dir.join("search-index"),
        &new_root.join("search-index-legacy"),
    )?;

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
    fs::write(
        new_root.join("legacy-migration-pending.json"),
        marker.to_string(),
    )
    .map_err(|err| format!("写入迁移标记失败: {err}"))?;

    Ok(Some(format!(
        "已准备旧版数据迁移（{}）",
        legacy.data_dir.display()
    )))
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
            fs::copy(entry.path(), &target_path)
                .map_err(|err| format!("复制文件失败: {err}"))?;
        }
    }
    Ok(())
}
