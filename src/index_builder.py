"""
无限暖暖相册索引与缩略图处理模块
实现SQLite索引存储、原生缩略图复用、ScreenShot缩略图生成
"""
import os
import sys
import logging
from pathlib import Path
from typing import Dict, List
from sqlalchemy import create_engine, Column, Integer, String, Enum
from sqlalchemy.orm import declarative_base, sessionmaker
from PIL import Image
sys.path.append(str(Path(__file__).parent))
from album_scanner import scan_all

# 日志配置
logger = logging.getLogger(__name__)

# 数据库配置
DB_PATH = Path(__file__).parent.parent / "data" / "album_index.db"
engine = create_engine(f"sqlite:///{DB_PATH}")
Base = declarative_base()
Session = sessionmaker(bind=engine)

# 缩略图配置
SCREENSHOT_THUMBNAIL_SIZE = (256, 256)
SCREENSHOT_THUMBNAIL_DIR = Path(__file__).parent.parent / "thumbnails" / "screenshot"

class GamePlayPhoto(Base):
    """GamePlayPhotos资源索引模型"""
    __tablename__ = "gameplay_photos"
    id = Column(Integer, primary_key=True, autoincrement=True)
    uid = Column(String, nullable=False, index=True)  # 账号UID
    file_path = Column(String, nullable=False, unique=True)  # 文件原始路径
    file_type = Column(Enum("image", "video", name="file_type"), nullable=False)  # 文件类型
    album_type = Column(String, nullable=False)  # 相册类型：high_quality/low_quality/other
    thumbnail_path = Column(String)  # 缩略图路径，直接使用原生低清图路径

class Screenshot(Base):
    """ScreenShot资源索引模型"""
    __tablename__ = "screenshots"
    id = Column(Integer, primary_key=True, autoincrement=True)
    file_path = Column(String, nullable=False, unique=True)  # 文件原始路径
    file_type = Column(Enum("image", "video", name="file_type"), nullable=False)  # 文件类型
    thumbnail_path = Column(String)  # 生成的缩略图路径

def init_db():
    """初始化数据库表"""
    Base.metadata.create_all(engine)
    logger.info(f"数据库初始化完成: {DB_PATH}")

def generate_thumbnail(source_path: Path, output_dir: Path) -> str:
    """
    生成缩略图，仅用于ScreenShot路径
    输出WebP格式，返回缩略图路径
    """
    try:
        # 创建输出目录
        output_dir.mkdir(parents=True, exist_ok=True)
        # 生成缩略图路径
        thumb_path = output_dir / f"{source_path.stem}.webp"
        if thumb_path.exists():
            return str(thumb_path)
        
        # 仅处理图片，视频暂时不生成缩略图（后续可扩展）
        if source_path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp", ".tiff"}:
            return ""
        
        with Image.open(source_path) as img:
            img = img.convert("RGB")
            img.thumbnail(SCREENSHOT_THUMBNAIL_SIZE)
            img.save(thumb_path, "WEBP", quality=85)
        
        logger.info(f"生成缩略图成功: {thumb_path}")
        return str(thumb_path)
    except Exception as e:
        logger.warning(f"生成缩略图失败{source_path}: {e}")
        return ""

def build_index(root_path: Path):
    """构建全量索引"""
    init_db()
    gameplay_photos, screenshots = scan_all(root_path)
    session = Session()
    
    try:
        # 清空旧索引（全量重建）
        session.query(GamePlayPhoto).delete()
        session.query(Screenshot).delete()
        
        # 处理GamePlayPhotos索引，直接复用原生缩略图
        for uid, albums in gameplay_photos.items():
            # 先收集所有低清图文件名，用于匹配对应的缩略图
            low_quality_files = {p.name: p for p in albums["low_quality"]}
            
            for file_path in albums["high_quality"]:
                file_type = "image" if file_path.suffix.lower() in {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp", ".tiff"} else "video"
                # 匹配同名的低清图作为缩略图
                thumbnail = str(low_quality_files[file_path.name]) if file_path.name in low_quality_files else ""
                session.add(GamePlayPhoto(
                    uid=uid,
                    file_path=str(file_path),
                    file_type=file_type,
                    album_type="high_quality",
                    thumbnail_path=thumbnail
                ))
            
            for file_path in albums["low_quality"]:
                file_type = "image" if file_path.suffix.lower() in {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp", ".tiff"} else "video"
                session.add(GamePlayPhoto(
                    uid=uid,
                    file_path=str(file_path),
                    file_type=file_type,
                    album_type="low_quality",
                    thumbnail_path=str(file_path)  # 自身就是缩略图
                ))
            
            for file_path in albums["other"]:
                file_type = "image" if file_path.suffix.lower() in {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp", ".tiff"} else "video"
                # 尝试匹配同名低清图
                thumbnail = str(low_quality_files[file_path.name]) if file_path.name in low_quality_files else ""
                session.add(GamePlayPhoto(
                    uid=uid,
                    file_path=str(file_path),
                    file_type=file_type,
                    album_type="other",
                    thumbnail_path=thumbnail
                ))
        
        # 处理ScreenShot索引，生成缩略图
        for file_path in screenshots:
            file_type = "image" if file_path.suffix.lower() in {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp", ".tiff"} else "video"
            thumb_path = ""
            if file_type == "image":
                thumb_path = generate_thumbnail(file_path, SCREENSHOT_THUMBNAIL_DIR)
            session.add(Screenshot(
                file_path=str(file_path),
                file_type=file_type,
                thumbnail_path=thumb_path
            ))
        
        session.commit()
        logger.info(f"索引构建完成: GamePlayPhoto{session.query(GamePlayPhoto).count()}条, Screenshot{session.query(Screenshot).count()}条")
    except Exception as e:
        session.rollback()
        logger.error(f"索引构建失败: {e}")
        raise
    finally:
        session.close()

if __name__ == "__main__":
    from path_resolver import resolve_game_root
    root = resolve_game_root()
    if not root:
        print("未找到游戏根目录，退出")
        exit(1)
    build_index(root)
