import os, shutil, glob

ROOT = r"d:\Nikki Gallery\WXNN XiangCe"

# 1) 移动中文文件到归档
src = os.path.join(ROOT, "docs", "项目架构全景.md")
dst = os.path.join(ROOT, "docs", "archive", "项目架构全景.md")
if os.path.exists(src):
    shutil.move(src, dst)
    print("MOVED 项目架构全景.md -> docs/archive/")
else:
    print("WARN src missing:", src)

# 2) 删除 AI 工具遗留目录下的 .md（保留 .codebuddy/memory）
tool_dirs = [".codebuddy/plans", ".workbuddy", ".workbuddy-ai", ".zcode", ".qoder"]
for d in tool_dirs:
    p = os.path.join(ROOT, d)
    if not os.path.isdir(p):
        print("SKIP missing dir:", d)
        continue
    for f in glob.glob(os.path.join(p, "**", "*.md"), recursive=True):
        try:
            os.remove(f)
            print("DEL", os.path.relpath(f, ROOT))
        except Exception as e:
            print("ERR", f, e)

# 3) 删除过时性能基线草稿
base = os.path.join(ROOT, "scripts", "perf-test", "baseline-2.2.md")
if os.path.exists(base):
    os.remove(base)
    print("DEL scripts/perf-test/baseline-2.2.md")

print("CLEANUP_SCRIPT_DONE")
