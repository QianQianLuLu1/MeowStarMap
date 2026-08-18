import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useUIStore } from '../stores/uiStore'
import { useMediaStore, type MediaFile } from '../stores/mediaStore'
import { type WatermarkConfig } from '../utils/imageProcessor'
// 性能重构 v3 改造项三：水印任务接入 TaskRegistry + ProgressThrottle + EtaCalculator
import type { WatermarkProgressState } from '../components/gallery/WatermarkDialog'
// 性能重构 v3 改造项三：复用 shared/types/progress.ts 的 TaskProgress 类型（消除重复定义）
import type { TaskProgress } from '../../shared/types/progress'

export interface UseBatchOperationsOptions {
  // 与 useToast 的 ToastType 保持一致（'success' | 'error' | 'info'）
  onShowMessage: (text: string, type?: 'success' | 'error' | 'info') => void
}

export function useBatchOperations(options: UseBatchOperationsOptions) {
  const { onShowMessage } = options
  const { t } = useTranslation()
  // 字段级订阅：整 store 订阅会让所有引用本 hook 的组件随任意 state 变化重渲染
  const selectedMediaIds = useUIStore((s) => s.selectedMediaIds)
  const clearSelection = useUIStore((s) => s.clearSelection)
  const mediaFiles = useMediaStore((s) => s.mediaFiles)
  const setMediaFiles = useMediaStore((s) => s.setMediaFiles)
  const updateMediaFile = useMediaStore((s) => s.updateMediaFile)
  const [watermarkDialog, setWatermarkDialog] = useState(false)
  const [watermarkConfig, setWatermarkConfig] = useState<WatermarkConfig | null>(null)
  // 性能重构 v3 改造项三：扩展进度状态类型，包含 ETA + taskId
  const [watermarkProgress, setWatermarkProgress] = useState<WatermarkProgressState | null>(null)
  const [watermarking, setWatermarking] = useState(false)
  // P2-C8：watermarking ref 供 onProgress 回调检查，避免异常后仍触发 setWatermarkProgress
  const watermarkingRef = useRef(false)
  // 性能重构 v3 改造项三：当前水印任务 ID（用于取消）
  const watermarkTaskIdRef = useRef<string | null>(null)
  // T12：批量重命名对话框状态
  const [batchRenameDialog, setBatchRenameDialog] = useState(false)

  // P2-C8：保留旧 watermark:progress 通道监听（向后兼容）
  useEffect(() => {
    if (!window.electronAPI?.watermark?.onProgress) return
    const unsubscribe = window.electronAPI.watermark.onProgress((progress) => {
      // P2-C8：异常/取消后 watermarkingRef 为 false，忽略残留的进度回调
      if (!watermarkingRef.current) return
      // 性能重构 v3：仅更新基础字段，ETA/taskId 由 task:progress 通道补充
      setWatermarkProgress((prev) => ({
        current: progress.current,
        total: progress.total,
        etaMs: prev?.etaMs,
        processedPerSec: prev?.processedPerSec,
        taskId: prev?.taskId
      }))
    })
    return () => {
      unsubscribe()
    }
  }, [])

  // 性能重构 v3 改造项三：订阅统一 task:progress 通道，过滤 taskType='watermark'
  // 该通道推送完整 ETA + taskId，覆盖旧 watermark:progress 的基础字段
  // 终态（done/cancelled/error）由 hook 持有 1.5s 后清除（让用户看到最终状态）
  useEffect(() => {
    const api = window.electronAPI?.task
    if (!api?.onProgress) return
    let clearTimer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = api.onProgress((progress: TaskProgress) => {
      if (progress.taskType !== 'watermark') return
      // 仅在当前 hook 视为 watermarking 状态时接受进度
      // 避免上一次任务的残留进度污染新一轮 UI
      if (!watermarkingRef.current) return

      // 更新进度状态（含 ETA + taskId）
      setWatermarkProgress({
        current: progress.current,
        total: progress.total,
        etaMs: progress.etaMs,
        processedPerSec: progress.processedPerSec,
        taskId: progress.taskId
      })
      // 记录当前 taskId 供取消使用
      if (progress.taskId) {
        watermarkTaskIdRef.current = progress.taskId
      }

      // 终态处理：1.5s 后清空进度状态
      const isTerminal =
        progress.phase === 'done' || progress.phase === 'cancelled' || progress.phase === 'error'
      if (isTerminal) {
        if (clearTimer) clearTimeout(clearTimer)
        clearTimer = setTimeout(() => {
          setWatermarkProgress(null)
          watermarkTaskIdRef.current = null
        }, 1500)
      } else if (clearTimer) {
        // 进入处理中状态时取消待清除的定时器
        clearTimeout(clearTimer)
        clearTimer = null
      }
    })
    return () => {
      unsubscribe()
      if (clearTimer) clearTimeout(clearTimer)
    }
  }, [])

  const getSelectedFilePaths = useCallback(() => {
    return mediaFiles.filter((f) => selectedMediaIds.includes(f.id)).map((f) => f.file_path)
  }, [mediaFiles, selectedMediaIds])

  const handleBatchExport = useCallback(
    async (useDefaultDir = false) => {
      if (!window.electronAPI) {
        onShowMessage(t('toast.exportUnsupported'), 'error')
        return
      }
      try {
        let targetDir = ''
        if (useDefaultDir) {
          // P1-02：使用默认导出路径（主进程从 settings 读取）
          const defaultDir = (await window.electronAPI.settings.get(
            'export.defaultDir',
            ''
          )) as string
          if (!defaultDir) {
            onShowMessage(t('toast.noDefaultExportDir'), 'error')
            return
          }
          targetDir = defaultDir
        } else {
          targetDir = (await window.electronAPI.dialog.selectDirectory()) || ''
          if (!targetDir) return
        }
        const filePaths = getSelectedFilePaths()
        // P1-02：useDefaultDir=true 时让主进程自动应用命名规则
        const result = await window.electronAPI.file.export(
          filePaths,
          targetDir,
          useDefaultDir ? { useDefaultDir: true } : {}
        )
        onShowMessage(result.message, result.success ? 'success' : 'error')
      } catch (error) {
        onShowMessage(
          error instanceof Error ? error.message : t('toast.batchExportFailed'),
          'error'
        )
      }
    },
    [getSelectedFilePaths, onShowMessage, t]
  )

  const handleBatchMove = useCallback(async () => {
    if (!window.electronAPI) {
      onShowMessage(t('toast.moveUnsupported'), 'error')
      return
    }
    try {
      const targetDir = await window.electronAPI.dialog.selectDirectory()
      if (!targetDir) return
      const filePaths = getSelectedFilePaths()
      const result = await window.electronAPI.file.move(filePaths, targetDir)
      if (result.success) {
        const movedIds = new Set(selectedMediaIds)
        setMediaFiles(mediaFiles.filter((f) => !movedIds.has(f.id)))
        clearSelection()
      }
      onShowMessage(result.message, result.success ? 'success' : 'error')
    } catch (error) {
      onShowMessage(error instanceof Error ? error.message : t('toast.batchMoveFailed'), 'error')
    }
  }, [
    getSelectedFilePaths,
    mediaFiles,
    selectedMediaIds,
    setMediaFiles,
    clearSelection,
    onShowMessage,
    t
  ])

  const handleBatchWatermark = useCallback(async () => {
    if (!watermarkConfig) {
      onShowMessage(t('toast.watermarkNotConfigured'), 'error')
      return
    }
    if (!window.electronAPI) {
      onShowMessage(t('toast.watermarkUnsupported'), 'error')
      return
    }
    try {
      const targetDir = await window.electronAPI.dialog.selectDirectory()
      if (!targetDir) return
      const filePaths = mediaFiles
        .filter((f) => selectedMediaIds.includes(f.id) && f.file_type === 'image')
        .map((f) => f.file_path)
      if (filePaths.length === 0) {
        onShowMessage(t('toast.noWatermarkSelection'), 'error')
        return
      }
      setWatermarking(true)
      watermarkingRef.current = true
      setWatermarkProgress({ current: 0, total: filePaths.length })
      const result = await window.electronAPI.watermark.apply(watermarkConfig, filePaths, targetDir)
      // 性能重构 v3 改造项三：处理取消后的 UI 状态
      if ((result as { cancelled?: boolean }).cancelled) {
        onShowMessage(t('toast.watermarkCancelled'), 'info')
      } else {
        onShowMessage(result.message, result.success ? 'success' : 'error')
      }
      // 终态进度由 task:progress 订阅负责清理，这里只复位本地 flag
      // 若 task:progress 未及时推送终态（极端情况），用 fallback 立即清理
      watermarkingRef.current = false
      setWatermarking(false)
      if (result.success && !(result as { cancelled?: boolean }).cancelled) {
        setWatermarkDialog(false)
        // 成功完成：立即清理进度（避免旧进度残留）
        setWatermarkProgress(null)
        watermarkTaskIdRef.current = null
      }
    } catch (error) {
      watermarkingRef.current = false
      setWatermarking(false)
      setWatermarkProgress(null)
      watermarkTaskIdRef.current = null
      onShowMessage(error instanceof Error ? error.message : t('toast.watermarkFailed'), 'error')
    }
  }, [watermarkConfig, mediaFiles, selectedMediaIds, onShowMessage, t])

  // 性能重构 v3 改造项三：取消当前水印任务
  const handleCancelWatermarkTask = useCallback(async () => {
    const taskId = watermarkTaskIdRef.current
    if (!taskId) {
      onShowMessage(t('toast.noCancellableTask'), 'error')
      return
    }
    if (!window.electronAPI?.task?.cancel) {
      onShowMessage(t('toast.cancelUnsupported'), 'error')
      return
    }
    try {
      await window.electronAPI.task.cancel(taskId)
      onShowMessage(t('toast.cancelRequested'), 'info')
    } catch (err) {
      onShowMessage(err instanceof Error ? err.message : t('toast.cancelFailed'), 'error')
    }
  }, [onShowMessage, t])

  // T12：批量重命名选中文件——调用 IPC 完成文件系统+数据库同步更新，再同步本地 store
  const handleBatchRename = useCallback(
    async (operations: { oldPath: string; newName: string }[]) => {
      if (!window.electronAPI?.file?.batchRename) {
        onShowMessage(t('toast.batchRenameUnsupported'), 'error')
        return
      }
      try {
        const result = await window.electronAPI.file.batchRename(operations)
        // 同步本地 store：用返回的新路径/新文件名更新对应 MediaFile
        if (result.renamed.length > 0) {
          const pathMap = new Map(
            result.renamed.map((r) => [
              r.oldPath,
              { newPath: r.newPath, newFileName: r.newFileName }
            ])
          )
          for (const file of mediaFiles) {
            const mapped = pathMap.get(file.file_path)
            if (mapped) {
              updateMediaFile(file.id, { file_path: mapped.newPath, file_name: mapped.newFileName })
            }
          }
        }
        onShowMessage(result.message, result.success ? 'success' : 'error')
        if (result.success) {
          setBatchRenameDialog(false)
          clearSelection()
        }
      } catch (error) {
        onShowMessage(
          error instanceof Error ? error.message : t('toast.batchRenameFailed'),
          'error'
        )
      }
    },
    [mediaFiles, updateMediaFile, clearSelection, onShowMessage, t]
  )

  // T12：当前选中的文件列表（供 BatchRenameDialog 预览使用）
  const selectedFiles: MediaFile[] = useMemo(() => {
    return mediaFiles.filter((f) => selectedMediaIds.includes(f.id))
  }, [mediaFiles, selectedMediaIds])

  // P1-04：跨档案转移——批量更新 account_uid
  const handleTransferToProfile = useCallback(
    async (targetUid: string) => {
      if (!window.electronAPI?.profile?.transferFiles) {
        onShowMessage(t('toast.transferUnsupported'), 'error')
        return
      }
      if (selectedMediaIds.length === 0) {
        onShowMessage(t('toast.noSelectionTransfer'), 'error')
        return
      }
      try {
        // selectedMediaIds 是 string[]（uiStore），主进程需要 number[]
        const mediaIds = selectedMediaIds.map((id) => Number(id)).filter((n) => !Number.isNaN(n))
        if (mediaIds.length === 0) {
          onShowMessage(t('toast.invalidIds'), 'error')
          return
        }
        const result = await window.electronAPI.profile.transferFiles(mediaIds, targetUid)
        onShowMessage(
          result.message ??
            (result.success ? t('toast.transferSuccess') : t('toast.transferFailed')),
          result.success ? 'success' : 'error'
        )
        if (result.success) {
          // 本地同步 account_uid 字段
          const targetSet = new Set(selectedMediaIds)
          for (const file of mediaFiles) {
            if (targetSet.has(file.id) && file.account_uid !== undefined) {
              updateMediaFile(file.id, { account_uid: targetUid } as Partial<MediaFile>)
            }
          }
          clearSelection()
        }
      } catch (error) {
        onShowMessage(error instanceof Error ? error.message : t('toast.transferError'), 'error')
      }
    },
    [selectedMediaIds, mediaFiles, updateMediaFile, clearSelection, onShowMessage, t]
  )

  return useMemo(
    () => ({
      watermarkDialog,
      setWatermarkDialog,
      watermarkConfig,
      setWatermarkConfig,
      watermarkProgress,
      watermarking,
      handleBatchExport,
      handleBatchMove,
      handleBatchWatermark,
      // 性能重构 v3 改造项三：取消水印任务
      handleCancelWatermarkTask,
      // T12：批量重命名
      batchRenameDialog,
      setBatchRenameDialog,
      selectedFiles,
      handleBatchRename,
      // P1-04：跨档案转移
      handleTransferToProfile
    }),
    [
      watermarkDialog,
      setWatermarkDialog,
      watermarkConfig,
      setWatermarkConfig,
      watermarkProgress,
      watermarking,
      handleBatchExport,
      handleBatchMove,
      handleBatchWatermark,
      handleCancelWatermarkTask,
      batchRenameDialog,
      setBatchRenameDialog,
      selectedFiles,
      handleBatchRename,
      handleTransferToProfile
    ]
  )
}
