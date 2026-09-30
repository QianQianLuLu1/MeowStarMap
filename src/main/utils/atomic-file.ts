// 缩略图落盘原子化工具（fix-thumbnail-display-and-latency N2）。
//
// 缺陷背景：直接写最终路径时，渲染进程经 media:// 流式读取可能读到半截 JPEG（裂图）；
// 且主进程按需生成、media-worker 批量、白帧自愈可能对同一 ${hash}.jpg 并发写入。
// rename 在同一卷内为原子操作：读方要么看到旧完整文件、要么看到新完整文件，
// 永远读不到半截内容。失败时清理临时文件，旧最终文件保持完整。
//
// 零依赖设计（仅 Node 内置模块）：thumbnail worker 与 media-worker 均可安全引入。
import fsp from 'fs/promises'
import path from 'path'

/** 生成与最终路径同目录的临时文件名：`.basename.tmp-<pid>-<随机>`（点前缀避免被当作缩略图产物扫描） */
export function tempSiblingPath(finalPath: string): string {
  const dir = path.dirname(finalPath)
  const base = path.basename(finalPath)
  return path.join(dir, `.${base}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`)
}

/** 清理残留临时文件（best-effort，不抛错：文件不存在/被占用等均忽略） */
export async function removeTempFileQuietly(tmpPath: string): Promise<void> {
  try {
    await fsp.unlink(tmpPath)
  } catch {
    // 忽略
  }
}

/**
 * 以「写临时文件 → rename 替换」方式落盘。
 * @param finalPath 最终落盘路径
 * @param write 目标写入函数，入参为同目录临时文件路径；必须把完整内容写入该路径，
 *   抛错时本函数自动清理临时文件并向上抛出，最终路径保持原状不被触碰。
 *   返回值仅用于 await 完成时机（如 sharp toFile 的 OutputInfo），不参与 rename 逻辑。
 */
export async function writeFileAtomic(
  finalPath: string,
  write: (tmpPath: string) => Promise<unknown>
): Promise<void> {
  const tmpPath = tempSiblingPath(finalPath)
  try {
    await write(tmpPath)
    await fsp.rename(tmpPath, finalPath)
  } catch (err) {
    await removeTempFileQuietly(tmpPath)
    throw err
  }
}
