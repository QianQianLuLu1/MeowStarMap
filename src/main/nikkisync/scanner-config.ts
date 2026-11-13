/**
 * G3：把上游 `windows-app.ts:151-166` 传给 ScannerService 的构造期选项集中成纯函数。
 *
 * 本仓此前只下发 selectedInstallRoot + watcher，额外目录是 runtime 构造之后才补建的；
 * 上游 ScannerService 在构造期读取 extraDirectories/retiredExtraDirectories，
 * 因此这里按上游形状补齐，同时保持「缺省键连键都不下发」的既有判据。
 */
export interface ScannerConfigInput {
  readonly watcher: boolean
  readonly gameRoot?: string
  readonly extraDirectories?: unknown
  readonly retiredExtraDirectories?: unknown
  readonly cachedInstallRoot?: string
  readonly onProgress?: (progress: unknown) => void
  readonly onSettled?: () => void
  readonly onDiscoveryComplete?: (report: unknown) => void
}

export function buildScannerConfig(input: ScannerConfigInput): Record<string, unknown> {
  return {
    ...(input.gameRoot ? { selectedInstallRoot: input.gameRoot } : {}),
    watcher: input.watcher,
    allowMissingInstallation: true,
    ...(input.extraDirectories === undefined ? {} : { extraDirectories: input.extraDirectories }),
    ...(input.retiredExtraDirectories === undefined
      ? {}
      : { retiredExtraDirectories: input.retiredExtraDirectories }),
    ...(input.cachedInstallRoot ? { cachedInstallRoot: input.cachedInstallRoot } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    ...(input.onSettled ? { onSettled: input.onSettled } : {}),
    ...(input.onDiscoveryComplete ? { onDiscoveryComplete: input.onDiscoveryComplete } : {})
  }
}
