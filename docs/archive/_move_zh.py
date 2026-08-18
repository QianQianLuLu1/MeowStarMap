import os, glob, shutil

ROOT = r"d:\Nikki Gallery\WXNN XiangCe"
docs = os.path.join(ROOT, "docs")
# 选中 docs 根目录中含 '架'(U+67B6) 的文件，即 项目架构全景.md（避开 技术债清单）
targets = [f for f in glob.glob(os.path.join(docs, "*.md")) if '\u67b6' in os.path.basename(f)]
for f in targets:
    dst = os.path.join(ROOT, "docs", "archive", os.path.basename(f))
    shutil.move(f, dst)
    print("MOVED", os.path.basename(f))
if not targets:
    print("NO_TARGET_FOUND")
print("DONE")
