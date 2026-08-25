"""
无限暖暖相册扫描模块
实现GamePlayPhotos强制扫描、UID资源隔离、ScreenShot独立扫描
"""
import os
import logging
import sys
from pathlib import Path
from typing import Dict, List, Tuple
sys.path.append(str(Path(__file__).parent))
from path_resolver import resolve_game_root

logger = logging.getLogger(__name__)

# 支持的图片视频后缀
IMG_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp", ".tiff"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".flv", ".wmv"}

def scan_gameplay_photos(root_path: Path) -> Dict[str, Dict[str, List[Path]]]:
    """
    扫描GamePlayPhotos目录，按UID和相册类型分类
    返回结构：{uid: {album_type: [file_paths]}}
    """
    result = {}
    gameplay_photos_path = root_path / "X6Game" / "Saved" / "GamePlayPhotos"
    if not gameplay_photos_path.exists():
        logger.warning(f"GamePlayPhotos目录不存在: {gameplay_photos_path}")
        return result

    # 遍历所有UID目录（纯数字命名）
    for uid_dir in gameplay_photos_path.iterdir():
        if not uid_dir.is_dir():
            continue
        if not uid_dir.name.isdigit():
            logger.warning(f"跳过非UID目录: {uid_dir.name}")
            continue
        
        uid = uid_dir.name
        result[uid] = {
            "high_quality": [],
            "low_quality": [],
            "other": []
        }

        # 遍历UID下的相册目录
        for album_dir in uid_dir.iterdir():
            if not album_dir.is_dir():
                continue
            
            album_type = "other"
            if album_dir.name == "NikkiPhotos_HighQuality":
                album_type = "high_quality"
            elif album_dir.name == "NikkiPhotos_LowQuality":
                album_type = "low_quality"
            
            # 扫描目录下的所有媒体文件
            for file_path in album_dir.rglob("*"):
                if not file_path.is_file():
                    continue
                if file_path.suffix.lower() in IMG_EXTENSIONS | VIDEO_EXTENSIONS:
                    result[uid][album_type].append(file_path)
        
        logger.info(f"UID {uid} 扫描完成: 高清图{len(result[uid]['high_quality'])}张, 缩略图{len(result[uid]['low_quality'])}张, 其他{len(result[uid]['other'])}个")
    
    return result

def scan_screenshots(root_path: Path) -> List[Path]:
    """
    扫描ScreenShot目录，返回所有媒体文件路径
    """
    screenshot_path = root_path / "X6Game" / "ScreenShot"
    if not screenshot_path.exists():
        logger.warning(f"ScreenShot目录不存在: {screenshot_path}")
        return []
    
    result = []
    for file_path in screenshot_path.rglob("*"):
        if not file_path.is_file():
            continue
        if file_path.suffix.lower() in IMG_EXTENSIONS | VIDEO_EXTENSIONS:
            result.append(file_path)
    
    logger.info(f"ScreenShot扫描完成: 共{len(result)}个文件")
    return result

def scan_all(root_path: Path) -> Tuple[Dict[str, Dict[str, List[Path]]], List[Path]]:
    """
    扫描所有相册资源
    返回: (GamePlayPhotos按UID分类结果, ScreenShot文件列表)
    """
    gameplay_photos = scan_gameplay_photos(root_path)
    screenshots = scan_screenshots(root_path)
    return gameplay_photos, screenshots

if __name__ == "__main__":
    # 测试逻辑
    root = resolve_game_root()
    if not root:
        print("未找到游戏根目录，退出")
        exit(1)
    
    gameplay_photos, screenshots = scan_all(root)
    print(f"\n=== 扫描结果 ===")
    print(f"GamePlayPhotos UID数量: {len(gameplay_photos)}")
    for uid, albums in gameplay_photos.items():
        print(f"UID {uid}: 高清图{len(albums['high_quality'])}张, 缩略图{len(albums['low_quality'])}张, 其他{len(albums['other'])}个")
    print(f"ScreenShot文件数量: {len(screenshots)}")
