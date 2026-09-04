/**
 * 文件大小格式化（B/KB/MB/GB/TB 五档，自动选择合适单位）
 * 所有需要展示文件大小的组件统一调用此函数，避免多处重复实现
 *
 * P2-C2：增加 'TB' 单位，避免 TB 级返回 undefined
 * P2-C3：开头增加 isFinite 校验，负数/NaN 返回 '0 B'
 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`
}

// DU2：formatFileSize 委托给 formatSize，统一实现消除两套逻辑共存
export function formatFileSize(bytes: number): string {
  return formatSize(bytes)
}

/**
 * 将毫秒格式化为 mm:ss 或 h:mm:ss
 * 性重构 v3 改造项三：统一 ETA 显示格式（消除 WatermarkDialog/BatchApplyDialog/DuplicatesPage/ScanProgress 4 处重复实现）
 * - 0 或负数返回 '—'
 * - < 1 小时返回 mm:ss
 * - ≥ 1 小时返回 h:mm:ss
 */
export function formatEta(ms: number): string {
  if (!ms || ms <= 0) return '—'
  const totalSec = Math.ceil(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}
