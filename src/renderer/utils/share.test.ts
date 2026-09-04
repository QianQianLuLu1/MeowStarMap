/**
 * T09 剪贴板分享流程纯函数单测
 *
 * 覆盖计划用例 2-6：三渠道正常分享 / 未选择文件 / 复制业务失败 /
 * 复制 IPC 抛错 / 检测 IPC 抛错 / 应用未安装·已装未运行状态透传。
 * 修复背景：GalleryPage 原实现误读 detectApp 结果的 success 字段（契约中不存在），
 * 且 copyFiles/detectApp 抛 IpcError 时无兜底，导致三渠道分享全部不可用。
 */
import { describe, it, expect, vi } from 'vitest'
import { runClipboardShare, type ClipboardShareAPI } from './share'

/** 构造可断言的 mock API：默认成功复制 + 已安装运行中，可按用例覆盖 */
function makeApi(overrides?: Partial<ClipboardShareAPI>): ClipboardShareAPI & {
  copyFiles: ReturnType<typeof vi.fn>
  detectApp: ReturnType<typeof vi.fn>
} {
  const api = {
    copyFiles:
      overrides?.copyFiles ??
      vi.fn().mockResolvedValue({ success: true, count: 1, skipped: 0, message: 'ok' }),
    detectApp:
      overrides?.detectApp ??
      vi.fn().mockResolvedValue({ installed: true, running: true, installPath: 'C:\\app.exe' })
  }
  return api as ClipboardShareAPI & {
    copyFiles: ReturnType<typeof vi.fn>
    detectApp: ReturnType<typeof vi.fn>
  }
}

describe('runClipboardShare', () => {
  it('三渠道：以文件路径数组调用 copyFiles、以渠道 id 调用 detectApp 并透传检测结果', async () => {
    for (const channelId of ['wechat', 'qq', 'vivo'] as const) {
      const api = makeApi()
      const outcome = await runClipboardShare(api, ['D:\\a.jpg'], channelId)
      expect(api.copyFiles).toHaveBeenCalledWith(['D:\\a.jpg'])
      expect(api.detectApp).toHaveBeenCalledWith(channelId)
      expect(outcome.copyResult.success).toBe(true)
      expect(outcome.installed).toBe(true)
      expect(outcome.running).toBe(true)
    }
  })

  it('未选择文件（空数组）：不调用 copyFiles，返回失败 copyResult', async () => {
    const api = makeApi()
    const outcome = await runClipboardShare(api, [], 'wechat')
    expect(api.copyFiles).not.toHaveBeenCalled()
    expect(api.detectApp).not.toHaveBeenCalled()
    expect(outcome.copyResult.success).toBe(false)
    expect(outcome.installed).toBe(false)
    expect(outcome.running).toBe(false)
  })

  it('复制业务失败：透传原 message，且不再调用 detectApp', async () => {
    const api = makeApi({
      copyFiles: vi
        .fn()
        .mockResolvedValue({ success: false, count: 0, skipped: 2, message: '所有文件均不可访问' })
    })
    const outcome = await runClipboardShare(api, ['D:\\missing.jpg'], 'qq')
    expect(api.detectApp).not.toHaveBeenCalled()
    expect(outcome.copyResult).toEqual({
      success: false,
      count: 0,
      skipped: 2,
      message: '所有文件均不可访问'
    })
  })

  it('复制 IPC 抛错：转为失败 copyResult，消息优先取 userMessage', async () => {
    const err = Object.assign(new Error('路径不在白名单'), {
      name: 'IpcError',
      code: 'IPC_FORBIDDEN',
      userMessage: '该路径不允许读取'
    })
    const api = makeApi({ copyFiles: vi.fn().mockRejectedValue(err) })
    const outcome = await runClipboardShare(api, ['C:\\Windows\\a.jpg'], 'wechat')
    expect(api.detectApp).not.toHaveBeenCalled()
    expect(outcome.copyResult.success).toBe(false)
    expect(outcome.copyResult.message).toBe('该路径不允许读取')
    expect(outcome.copyResult.count).toBe(0)
    expect(outcome.copyResult.skipped).toBe(0)
  })

  it('复制 IPC 抛无 userMessage 的错误：回退到 error.message', async () => {
    const api = makeApi({ copyFiles: vi.fn().mockRejectedValue(new Error('boom')) })
    const outcome = await runClipboardShare(api, ['D:\\a.jpg'], 'vivo')
    expect(outcome.copyResult.success).toBe(false)
    expect(outcome.copyResult.message).toBe('boom')
  })

  it('检测 IPC 抛错：降级 installed/running=false，仍携带成功复制结果', async () => {
    const api = makeApi({ detectApp: vi.fn().mockRejectedValue(new Error('IPC 故障')) })
    const outcome = await runClipboardShare(api, ['D:\\a.jpg'], 'wechat')
    expect(outcome.copyResult.success).toBe(true)
    expect(outcome.installed).toBe(false)
    expect(outcome.running).toBe(false)
  })

  it('应用未安装：透传 installed/running=false（不再被恒置为 false 的错误判断掩盖）', async () => {
    const api = makeApi({
      detectApp: vi.fn().mockResolvedValue({ installed: false, running: false, installPath: null })
    })
    const outcome = await runClipboardShare(api, ['D:\\a.jpg'], 'qq')
    expect(outcome.installed).toBe(false)
    expect(outcome.running).toBe(false)
  })

  it('已安装未运行：透传 installed=true / running=false', async () => {
    const api = makeApi({
      detectApp: vi
        .fn()
        .mockResolvedValue({ installed: true, running: false, installPath: 'C:\\WeChat.exe' })
    })
    const outcome = await runClipboardShare(api, ['D:\\a.jpg'], 'wechat')
    expect(outcome.installed).toBe(true)
    expect(outcome.running).toBe(false)
  })
})
