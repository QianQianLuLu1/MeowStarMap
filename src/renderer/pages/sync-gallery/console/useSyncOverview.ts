import { useEffect, useState } from 'react'
import type { NikkiSyncLibraryOverviewInfo } from '../../../../shared/types/electron-api'

/** 与上游 DesktopPageScript 的状态轮询同口径 2s。 */
export const OVERVIEW_POLL_MS = 2000

/**
 * T3：电脑相册资产总览（`nikkisync:library-overview`，透传上游 DesktopStatusService.getStatus()）。
 *
 * 轮询纪律（keep-alive 页面切走不卸载）：
 * - 仅 `active`（Connect 视图可见 = currentView==='sync-service' 且子视图为 connect）时轮询；
 *   离开/卸载即清定时器，不留后台 IPC（fake timers 断言 vi.getTimerCount()===0 钉住）。
 * - 桥面方法缺席（老 preload / 主进程未落地）⇒ 零调用、恒 null，UI 显示不可用而非报错。
 * - PC 服务缺席时通道按契约回 available:false（不抛）；抛错保留上次成功观测（R5 审查修复：
 *   瞬时 IPC 抖动不得置 null——那会让首跑二维码作废重建、反复 getPairingCode），下一轮重试。
 */
export function useSyncOverview(active: boolean): NikkiSyncLibraryOverviewInfo | null {
  const [overview, setOverview] = useState<NikkiSyncLibraryOverviewInfo | null>(null)

  useEffect(() => {
    if (!active) return
    const client = window.electronAPI?.nikkisync
    if (typeof client?.getLibraryOverview !== 'function') return
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const next = await client.getLibraryOverview()
        if (alive) setOverview(next ?? null)
      } catch {
        // 保留上次成功值；仅从未成功时维持初始 null
      }
    }
    void load()
    const timer = setInterval(() => void load(), OVERVIEW_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [active])

  return overview
}
