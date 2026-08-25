"""
无限暖暖游戏根目录识别模块
优先级：官方启动器版 > Steam版 > Epic版
"""
import os
import winreg
import logging
from pathlib import Path
from typing import Optional

# 日志配置
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler("logs/scanner.log", encoding="utf-8"),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

OFFICIAL_LAUNCHER_PATHS = [
    Path("C:/Program Files/InfinityNikki Launcher/InfinityNikki"),
    Path("C:/Program Files (x86)/InfinityNikki Launcher/InfinityNikki")
]

STUDIO_APP_ID = "2732520"
EPIC_MANIFESTS_PATH = Path("C:/ProgramData/Epic/EpicGamesLauncher/Manifests")
EPIC_GAME_DISPLAY_NAME = "InfinityNikki"

def get_official_launcher_root() -> Optional[Path]:
    """获取官方启动器版游戏根目录"""
    try:
        # 尝试读取注册表
        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\InfinityNikki Launcher")
        install_path, _ = winreg.QueryValueEx(key, "InstallPath")
        winreg.CloseKey(key)
        path = Path(install_path)
        if validate_game_root(path):
            logger.info(f"官方启动器版注册表命中: {path}")
            return path
    except Exception as e:
        logger.warning(f"官方启动器注册表读取失败: {e}, 尝试默认路径扫描")

    # 扫描默认安装路径 + 所有盘符
    all_drives = [f"{d}:\\" for d in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" if os.path.exists(f"{d}:\\")]
    for drive in all_drives:
        default_path = Path(drive) / "InfinityNikki Launcher" / "InfinityNikki"
        if validate_game_root(default_path):
            logger.info(f"官方启动器版默认路径命中: {default_path}")
            return default_path
    return None

def get_steam_root() -> Optional[Path]:
    """获取Steam版游戏根目录"""
    try:
        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, fr"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Steam App {STUDIO_APP_ID}")
        install_path, _ = winreg.QueryValueEx(key, "InstallLocation")
        winreg.CloseKey(key)
        path = Path(install_path)
        if validate_game_root(path):
            logger.info(f"Steam版注册表命中: {path}")
            return path
    except Exception as e:
        logger.warning(f"Steam版注册表读取失败: {e}")
    return None

def get_epic_root() -> Optional[Path]:
    """获取Epic版游戏根目录"""
    if not EPIC_MANIFESTS_PATH.exists():
        logger.warning(f"Epic清单目录不存在: {EPIC_MANIFESTS_PATH}")
        return None

    for manifest_file in EPIC_MANIFESTS_PATH.glob("*.json"):
        try:
            import json
            with open(manifest_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            if data.get("DisplayName") == EPIC_GAME_DISPLAY_NAME:
                install_path = Path(data["InstallLocation"])
                if validate_game_root(install_path):
                    logger.info(f"Epic版清单命中: {install_path}")
                    return install_path
        except Exception as e:
            logger.warning(f"Epic清单文件{manifest_file}解析失败: {e}")
    return None

def validate_game_root(path: Path) -> bool:
    """校验是否为有效的游戏根目录"""
    if not path.exists():
        return False
    # 检查是否包含GamePlayPhotos目录
    gameplay_photos_path = path / "X6Game" / "Saved" / "GamePlayPhotos"
    if not gameplay_photos_path.exists():
        return False
    # 检查读取权限
    if not os.access(path, os.R_OK):
        logger.warning(f"路径无读取权限: {path}")
        return False
    return True

def resolve_game_root(custom_root: Optional[str] = None) -> Optional[Path]:
    """按优先级解析游戏根目录"""
    # 优先使用自定义路径
    if custom_root:
        custom_path = Path(custom_root)
        if validate_game_root(custom_path):
            logger.info(f"使用自定义游戏根目录: {custom_path}")
            return custom_path
        else:
            logger.error(f"自定义路径无效: {custom_root}")

    # 按优先级匹配
    official_root = get_official_launcher_root()
    if official_root:
        return official_root

    steam_root = get_steam_root()
    if steam_root:
        return steam_root

    epic_root = get_epic_root()
    if epic_root:
        return epic_root

    logger.error("所有渠道均未找到有效的游戏根目录")
    return None

if __name__ == "__main__":
    # 测试逻辑
    root = resolve_game_root()
    if root:
        print(f"找到游戏根目录: {root}")
    else:
        print("未找到游戏根目录")
