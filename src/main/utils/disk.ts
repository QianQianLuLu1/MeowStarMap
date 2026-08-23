import fsp from 'fs/promises'
import { t } from '../i18n'

/**
 * 磁盘空间不足错误的机器可读标记。
 * 消费方（video-service 等）优先判断该 code，避免依赖中文文案匹配（语言切换后失效）；
 * includes(t('main.disk.keyword.insufficient')) 仅作旧错误对象的兜底。
 */
export const DISK_FULL_ERROR_CODE = 'APP_DISK_FULL'

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
      const err = new Error(t('main.disk.error.insufficient', { need: needMB, avail: availMB }))
      ;(err as Error & { code?: string }).code = DISK_FULL_ERROR_CODE
      throw err
    }
  } catch (error) {
    // statfs 不可用时跳过检查（不阻断主流程），仅磁盘空间不足错误向上抛
    if (
      (error as NodeJS.ErrnoException).code === DISK_FULL_ERROR_CODE ||
      (error instanceof Error && error.message.includes(t('main.disk.keyword.insufficient')))
    ) {
      throw error
    }
  }
}
