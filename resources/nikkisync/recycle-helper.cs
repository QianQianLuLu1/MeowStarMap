// NikkiSync 回收站 helper（K8-a，能力层执行记录见 docs/plans/2026-10-25-nikkisync-upstream-sync-04）。
//
// 上游调用契约（pc-companion dist/src/organizer/DeletionQueue.js:379-382）：
//   execFile(process.env.NIKKISYNC_RECYCLE_HELPER,
//            ['--recycle-file', file.path, file.sha256, String(file.size)],
//            { windowsHide: true, timeout: 120000 })
// 非零退出即失败；env 未设置时上游抛 recycle_unavailable（fail-safe，不会退化为永久删除）。
//
// 职责：参数解析 → 文件存在且 size 匹配 → 流式 SHA256 复核匹配 →
//       Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(OnlyErrorDialogs, SendToRecycleBin)
//       → 退出 0。任一步失败：stderr 写英文原因并退出非零（不弹窗、不静默）。
// 构建 scripts/build-recycle-helper.cjs 用 .NET Framework4 csc.exe /r:Microsoft.VisualBasic.dll 编译，
// 因此只用 Framework 4 的 API 面（SHA256.Create / BitConverter / FileSystem.DeleteFile）。
using System;
using System.IO;
using System.Security.Cryptography;
using Microsoft.VisualBasic.FileIO;

class RecycleHelper
{
    static int Main(string[] args)
    {
        if (args.Length != 4 || args[0] != "--recycle-file")
        {
            Console.Error.WriteLine("usage: nikkisync-recycle-helper --recycle-file <path> <sha256> <size>");
            return 2;
        }
        string path = args[1];
        string expectedSha256 = args[2].ToLowerInvariant();
        long expectedSize;
        if (!long.TryParse(args[3], out expectedSize))
        {
            Console.Error.WriteLine("invalid size argument");
            return 2;
        }
        try
        {
            FileInfo info = new FileInfo(path);
            if (!info.Exists)
            {
                Console.Error.WriteLine("file not found");
                return 1;
            }
            if (info.Length != expectedSize)
            {
                Console.Error.WriteLine("size mismatch");
                return 1;
            }
            if (ComputeSha256(path) != expectedSha256)
            {
                Console.Error.WriteLine("sha256 mismatch");
                return 1;
            }
            FileSystem.DeleteFile(path, UIOption.OnlyErrorDialogs, RecycleOption.SendToRecycleBin);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("recycle failed: " + ex.Message);
            return 1;
        }
    }

    static string ComputeSha256(string path)
    {
        using (SHA256 sha = SHA256.Create())
        using (FileStream stream = File.OpenRead(path))
        {
            return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }
    }
}
