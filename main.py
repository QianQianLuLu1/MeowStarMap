"""
无限暖暖相册扫描器入口
"""
import argparse
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).parent / "src"))
from path_resolver import resolve_game_root
from index_builder import build_index

def main():
    parser = argparse.ArgumentParser(description="无限暖暖相册扫描器")
    parser.add_argument("--auto", action="store_true", help="自动扫描所有渠道的游戏根目录")
    parser.add_argument("--root", type=str, help="手动指定游戏根目录路径")
    args = parser.parse_args()

    # 解析游戏根目录
    root = None
    if args.root:
        root = resolve_game_root(custom_root=args.root)
    elif args.auto:
        root = resolve_game_root()
    else:
        parser.print_help()
        return

    if not root:
        print("错误：未找到有效的游戏根目录，请检查游戏安装路径或手动指定--root参数")
        sys.exit(1)

    print(f"找到游戏根目录: {root}")
    print("开始构建索引...")
    try:
        build_index(root)
        print("索引构建完成！")
        print(f"数据库路径: {Path(__file__).parent / 'data' / 'album_index.db'}")
        print(f"ScreenShot缩略图路径: {Path(__file__).parent / 'thumbnails' / 'screenshot'}")
    except Exception as e:
        print(f"索引构建失败: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
