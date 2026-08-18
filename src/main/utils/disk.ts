import fsp from 'fs/promises'

/**
 * 检查目标目录所在分区可用空间是否足够。
 * 不足时抛 Error，statfs 不可用时静默跳过（不阻断主流程）。
 * 抽取自 file-service / video-service 中重复实现。
 */
export async function assertDiskSpace(dir: string, requiredBytes: number): Promise<void> {
  try {
    const stat = await fsp.statfs(dir)
    const available = stat.bavail * stat.bsize
    if (available < requiredBytes) {
      const needMB = (requiredBytes / 1024 / 1024).toFixed(1)
      const availMB = (available / 1024 / 1024).toFixed(1)
      throw new Error(`磁盘空间不足，需要 ${needMB} MB，仅剩 ${availMB} MB`)
    }
  } catch (error) {
    // statfs 不可用时跳过检查（不阻断主流程），仅磁盘空间不足错误向上抛
    if (error instanceof Error && error.message.includes('磁盘空间不足')) throw error
  }
}
