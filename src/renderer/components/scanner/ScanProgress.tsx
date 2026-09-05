import React, { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useMediaStore, refreshMediaAfterScan } from '../../stores/mediaStore'
import { useUIStore } from '../../stores/uiStore'
import { useGlobalToast } from '../../pages/settings/sections'
import { TaskProgressOverlay } from '../common/TaskProgressOverlay'
import type { TaskProgress } from '../../../shared/types/progress'

// 性能重构 v3 改造项三 §4.5.1：
//   - 复用 TaskProgressOverlay 通用浮窗（统一 ETA + 取消按钮 UI）
//   - 订阅 task:progress 通道获取扫描任务的 ETA / percent / taskId
//   - 保留 scanProgress（mediaStore）作为显示开关与 fallback：
//     ScanButton 仍通过 scanner:progress 推送 scanned/found/currentPath
//   - 取消按钮优先调用 task.cancel(taskId)（统一通道），fallback 到 scanner.stop()
// 索引进度修复：
//   - 过滤条件扩展到 batch/duplicate（worker 逐张真实进度），解决索引浮窗长期停在 0%
//   - batch/duplicate 自带 current/total/percent/eta，归一显示到本浮窗
//   - 终态清除仅针对 scan/indexing；batch/duplicate 终态是单阶段收尾，不清空、由下一阶段覆盖
//   - taskIdRef 不被 batch/duplicate 覆盖，取消始终指向 indexing 伞 taskId
// 本浮窗响应的任务类型：scan（扫描）/ indexing（索引伞）/ batch（缩略图）/ duplicate（pHash）
const ACCEPTED_TASK_TYPES: TaskProgress['taskType'][] = ['scan', 'indexing', 'batch', 'duplicate']
export const ScanProgress: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useGlobalToast()
  const scanProgress = useMediaStore((state) => state.scanProgress)
  const setScanProgress = useMediaStore((state) => state.setScanProgress)
  const [stopping, setStopping] = useState(false)
  // 扫描任务的统一进度（含 ETA），由 task:progress 推送
  const [taskProgress, setTaskProgress] = useState<TaskProgress | null>(null)
  // 当前扫描任务 ID（用于取消）
  const taskIdRef = React.useRef<string | null>(null)
  // 索引伞任务是否活动（2.3 门控）：仅在其活动时，batch/duplicate 子阶段进度才并入本浮窗，
  // 防止用户手动重复检测/相似检测（DuplicatesPage 自绘进度）时出现双浮窗打架
  const indexingActiveRef = React.useRef(false)
  // T3/D5：「扫描成功但图库仍为空」引导 Toast 的会话级去重标记（组件存活期间只提示一次）
  const galleryEmptyHintShownRef = React.useRef(false)

  // 订阅 task:progress：响应 scan / indexing / batch / duplicate 四类活动任务
  // 显示门控已解耦到 taskProgress（见下方 if (!taskProgress)），不再依赖 scanProgress.scanning
  useEffect(() => {
    const api = window.electronAPI?.task
    if (!api?.onProgress) return
    let clearTimer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = api.onProgress((progress: TaskProgress) => {
      if (!ACCEPTED_TASK_TYPES.includes(progress.taskType)) return
      const isIndexingTask = progress.taskType === 'indexing'
      const isTerminal =
        progress.phase === 'done' || progress.phase === 'cancelled' || progress.phase === 'error'

      // 维护 indexing 伞任务的活动状态（收到非终态 indexing 事件时置真）
      if (isIndexingTask) indexingActiveRef.current = !isTerminal

      // 2.3 门控：batch/duplicate 仅在 indexing 伞任务活动时并入浮窗
      const isWorkerStage = progress.taskType === 'batch' || progress.taskType === 'duplicate'
      if (isWorkerStage && !indexingActiveRef.current) return

      // 2.4 取消目标保护：仅 scan/indexing 事件更新 taskIdRef；
      // batch/duplicate 只是单阶段，取消必须仍指向 indexing 伞 taskId 才能一次停掉整条链
      if (progress.taskType === 'scan' || progress.taskType === 'indexing') {
        if (progress.taskId) taskIdRef.current = progress.taskId
      }

      // 2.2 归一显示：batch/duplicate 自带真实 current/total/percent/eta，直接透传给浮窗
      setTaskProgress(progress)

      // 2.3 终态清除收紧：仅 scan/indexing 终态触发 1.5s 后清空浮窗；
      // batch/duplicate 终态只是单阶段收尾（indexing 伞仍在运行），不清空、由下一阶段覆盖
      if (isTerminal && (progress.taskType === 'scan' || progress.taskType === 'indexing')) {
        if (clearTimer) clearTimeout(clearTimer)
        clearTimer = setTimeout(() => {
          setTaskProgress(null)
          taskIdRef.current = null
          indexingActiveRef.current = false
        }, 1500)
      } else if (clearTimer) {
        clearTimeout(clearTimer)
        clearTimer = null
      }
    })
    return () => {
      unsubscribe()
      if (clearTimer) clearTimeout(clearTimer)
    }
  }, [])

  // 挂载即拉快照：补偿"渲染订阅晚于扫描发起"导致订阅前事件丢失（等效重放）
  // 启动自动扫描常在窗口加载前就已开始，前几帧 task:progress 已发出且无法重放，
  // 故挂载时主动拉取一次当前活动任务，使弹窗在挂载瞬间即出现。
  useEffect(() => {
    const api = window.electronAPI?.task
    if (!api?.getActive) return
    void api
      .getActive()
      .then((snapshot) => {
        if (!snapshot) return
        const isTerminal =
          snapshot.phase === 'done' || snapshot.phase === 'cancelled' || snapshot.phase === 'error'
        if (isTerminal) return
        // 快照为 indexing 时置 indexingActive（2.3/2.6）：挂载发生在缩略图阶段时，
        // 快照返回 indexing 的 preparing（0%），随后的 live batch 事件即可并入并覆盖显示
        if (snapshot.taskType === 'indexing') indexingActiveRef.current = true
        setTaskProgress(snapshot)
        if (snapshot.taskId) taskIdRef.current = snapshot.taskId
      })
      .catch((err) => {
        console.error(t('scanProgress.log.getActiveFailed'), err)
      })
  }, [t])

  // 兜底：监听 scanner:complete，扫描完成后立即刷新媒体列表
  // 正常链路是 scanner:complete → notifyMediaUpdated → media:updated → GalleryPage refresh
  // 此订阅作为兜底，防止 GalleryPage 订阅时序问题导致页面未刷新
  useEffect(() => {
    const api = window.electronAPI?.scanner
    if (!api?.onComplete) return

    const unsubscribe = api.onComplete((result) => {
      // D2：启动自动扫描失败原先完全静默（首装无游戏/注册表未命中时用户毫无感知），
      // 此处兜底展示失败原因；手动触发的扫描由 ScanButton.reportScanFailure 提示详情
      // （含手动路径引导），manualScan 标记用于跳过手动路径，避免双弹
      if (result && !result.success && !useMediaStore.getState().scanProgress.manualScan) {
        showMessage(
          `${t('toast.scanFailed')}: ${result.message || t('toast.unknownError')}`,
          'error'
        )
      }
      // D5：扫描成功但图库仍为空（本机无游戏截图/仅启动器缓存）时首装用户毫无感知，
      // 误以为自动扫描失败；此处提示真实状态并引导出路。手动成功路径 ScanButton 无成功
      // Toast，无双弹风险；失败路径由上方 D2 分支处理。
      // D1（评审修复批次 B）：mediaFiles 是 fetchMediaFromDatabase 按 currentView 过滤后的
      // 结果（launcher-cache → 仅启动器图；favorites → 仅收藏），非 gallery 视图下列表
      // 为空只代表该板块空，不代表图库空——引导 Toast 仅在 gallery 视图下判定与弹出。
      const afterRefresh = async () => {
        await refreshMediaAfterScan()
        if (
          result?.success &&
          !galleryEmptyHintShownRef.current &&
          useUIStore.getState().currentView === 'gallery' &&
          useMediaStore.getState().mediaFiles.length === 0
        ) {
          galleryEmptyHintShownRef.current = true
          const found = Number(result.filesFound)
          showMessage(
            Number.isFinite(found) && found > 0
              ? t('toast.scanFoundButGalleryEmpty', { count: found })
              : t('toast.scanCompletedNoGameShots'),
            'info'
          )
        }
      }
      void afterRefresh()
    })
    return () => {
      if (unsubscribe) unsubscribe()
    }
    // refreshMediaAfterScan 为模块级导入（稳定引用），无需列入依赖数组
  }, [showMessage, t])

  const handleStop = useCallback(async () => {
    if (stopping) return
    setStopping(true)
    try {
      // 优先走统一 task:cancel 通道（触发主进程 TaskRegistry.abort → SCAN_STOP）
      const taskId = taskIdRef.current
      const taskApi = window.electronAPI?.task
      if (taskId && taskApi?.cancel) {
        await taskApi.cancel(taskId)
      } else if (window.electronAPI?.scanner?.stop) {
        // fallback：旧版本无 task:cancel，直接调用 scanner.stop
        await window.electronAPI.scanner.stop()
      }
      // 取消后重新加载已扫描的数据，统一走 refreshMediaAfterScan 消除重复 DB 读取
      await refreshMediaAfterScan()
    } catch (error) {
      console.error(t('scanProgress.log.stopFailed'), error)
    } finally {
      setStopping(false)
      setScanProgress({ scanning: false, status: 'completed' })
    }
    // refreshMediaAfterScan 为模块级导入（稳定引用），无需列入依赖数组
  }, [stopping, setScanProgress, t])

  // 解耦显示门控：不再依赖 scanProgress.scanning / status，
  // 直接由 task:progress（scan 或 indexing 活动任务）驱动；无活动任务则不渲染
  if (!taskProgress) {
    return null
  }

  // 优先使用 taskProgress 的字段（含 ETA），fallback 到 scanProgress
  const current = taskProgress?.current ?? scanProgress.scanned
  const total =
    taskProgress?.total ??
    (scanProgress as { total?: number }).total ??
    Math.max(scanProgress.scanned, scanProgress.found, 1)
  const percent = taskProgress?.percent ?? Math.min(100, (scanProgress.scanned / total) * 100)
  const message = stopping
    ? t('scanProgress.stopping')
    : (taskProgress?.message ?? t('scanProgress.scanning'))

  // 合成 TaskProgress 传给 Overlay
  const mergedProgress: TaskProgress | null = taskProgress
    ? {
        ...taskProgress,
        // stopping 状态下强制 message 为「正在停止...」
        message,
        // 取消能力以任务自身 canCancel 为准（scan 可取消 / indexing 不可取消），stopping 时禁止重复点击
        canCancel: taskProgress.canCancel && !stopping
      }
    : {
        // task:progress 未到达时，由 scanProgress 构造最小 TaskProgress
        taskId: taskIdRef.current ?? `scan-fallback-${Date.now()}`,
        taskType: 'scan',
        phase: 'processing',
        current,
        total,
        percent,
        message,
        startedAt: Date.now(),
        canCancel: !stopping
      }

  return (
    <TaskProgressOverlay progress={mergedProgress} onCancel={handleStop} title={message}>
      {/* 当前扫描路径（优先取 taskProgress 透传字段，回退 scanProgress） */}
      {(taskProgress.currentPath ?? scanProgress.currentPath) && (
        <p
          className="text-xs ellipsis mt-1"
          style={{
            color: 'var(--text-tertiary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
          title={taskProgress.currentPath ?? scanProgress.currentPath}
        >
          {taskProgress.currentPath ?? scanProgress.currentPath}
        </p>
      )}
      {/* 已找到文件数（优先取 taskProgress.found，回退 scanProgress；仅当有数量时展示） */}
      {(taskProgress.found ?? scanProgress.found) > 0 && (
        <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
          {t('scanProgress.foundFiles', { count: taskProgress.found ?? scanProgress.found })}
        </p>
      )}
    </TaskProgressOverlay>
  )
}
