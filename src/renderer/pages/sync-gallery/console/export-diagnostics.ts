import type { TFunction } from 'i18next'

/**
 * T3/T11：导出诊断包（复用既有 `log:exportZip` 通道）。
 * Android 卡 / 底栏 / About 三处入口共用同一判据：
 * - 桥面缺席（老 preload）⇒ 诚实提示不可用，不伪造成功；
 * - 用户取消 ⇒ 主进程 throw IpcError(IPC_CANCELED)，经 showError（useErrorToast）静默；
 *   成功 ⇒ success 且 Toast 带落盘路径；失败 ⇒ error。
 */
export async function exportDiagnostics(
  t: TFunction,
  showMessage: (message: string, type?: 'success' | 'error' | 'info') => void,
  showError: (error: unknown) => void
): Promise<void> {
  const exportZip = window.electronAPI?.log?.exportZip
  if (typeof exportZip !== 'function') {
    showMessage(t('syncConsole.statusBar.unavailable'), 'info')
    return
  }
  try {
    const result = await exportZip()
    if (result.success) {
      showMessage(t('syncConsole.statusBar.exported', { path: result.message ?? '' }), 'success')
    } else {
      showMessage(t('syncConsole.statusBar.exportFailed'), 'error')
    }
  } catch (error) {
    showError(error)
  }
}

/** 经既有 shell.openExternal 桥打开上游外链；缺席静默、失败走错误 Toast。 */
export async function openUpstreamLink(
  url: string,
  showError: (error: unknown) => void
): Promise<void> {
  const openExternal = window.electronAPI?.shell?.openExternal
  if (typeof openExternal !== 'function') return
  try {
    await openExternal(url)
  } catch (error) {
    showError(error)
  }
}
