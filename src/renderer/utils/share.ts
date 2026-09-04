/**
 * T09：剪贴板分享流程纯函数（复制文件 → 检测目标应用）
 *
 * 抽取自 GalleryPage.handleShareToClipboard，修复三渠道分享不可用的两个共用缺陷：
 * 1. 契约错位：share:detectApp 实际返回 {installed, running, installPath}（无 success 字段），
 *    原实现误读 detect.success 导致 installed/running 恒为 false；此处直接透传真实字段。
 * 2. 异常无兜底：preload `call()` 在主进程返回失败响应时抛 IpcError（FORBIDDEN /
 *    VALIDATION_ERROR / IPC_MALFORMED_RESPONSE 等），原实现未捕获造成 unhandled rejection、
 *    UI 零反馈；此处将 copyFiles 异常转为失败 copyResult（优先 userMessage），
 *    detectApp 异常降级为未安装（与主进程 handler 的降级语义一致）。
 */
import type { ShareChannelId } from '../components/common/ShareGuideDialog'

/** 剪贴板复制结果（与 share:copyFiles 的业务数据契约一致） */
export interface ClipboardShareCopyResult {
  success: boolean
  message: string
  count: number
  skipped: number
}

/** 分享流程总结果：复制结果 + 目标应用状态 */
export interface ClipboardShareOutcome {
  copyResult: ClipboardShareCopyResult
  installed: boolean
  running: boolean
}

/** share 命名空间的最小结构子集（由 Window['electronAPI'].share 满足） */
export interface ClipboardShareAPI {
  copyFiles: (filePaths: string[]) => Promise<ClipboardShareCopyResult>
  detectApp: (
    channelId: string
  ) => Promise<{ installed: boolean; running: boolean; installPath: string | null }>
}

/** 提取错误提示消息：IpcError 优先 userMessage（主进程已翻译），否则 message */
function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const userMessage = (err as { userMessage?: unknown }).userMessage
    return typeof userMessage === 'string' && userMessage.length > 0 ? userMessage : err.message
  }
  return String(err)
}

/**
 * 执行剪贴板分享流程：复制文件到剪贴板 → 检测目标应用状态
 *
 * - 空数组防御：不调用 IPC，直接返回失败结果
 * - copyFiles 失败（业务失败或 IPC 抛错）：不进入检测步骤，返回失败 copyResult
 * - detectApp 失败：降级为未安装状态，不阻断复制结果展示
 * 本函数永不 reject，调用方据 outcome 渲染引导弹窗即可
 */
export async function runClipboardShare(
  api: ClipboardShareAPI,
  filePaths: string[],
  channelId: ShareChannelId
): Promise<ClipboardShareOutcome> {
  if (filePaths.length === 0) {
    return {
      copyResult: { success: false, message: '', count: 0, skipped: 0 },
      installed: false,
      running: false
    }
  }

  let copyResult: ClipboardShareCopyResult
  try {
    copyResult = await api.copyFiles(filePaths)
  } catch (err) {
    copyResult = { success: false, message: extractErrorMessage(err), count: 0, skipped: 0 }
  }
  if (!copyResult.success) {
    return { copyResult, installed: false, running: false }
  }

  let installed = false
  let running = false
  try {
    const detect = await api.detectApp(channelId)
    installed = detect.installed
    running = !!detect.running
  } catch {
    // 检测失败降级为未安装状态，与主进程 share:detectApp handler 的降级语义一致
  }
  return { copyResult, installed, running }
}
