import { useCallback, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useUIStore } from '../stores/uiStore'
import { useMediaStore, type MediaFile } from '../stores/mediaStore'
import { useOperationHistoryStore } from '../stores/operationHistoryStore'
import type { ToastType } from './useToast'
import { useFavoriteToggle } from './useFavoriteToggle'
import { useStagedTask } from './useStagedTask'
import { settleWithConcurrency } from '../../shared/utils/concurrency'
import { formatFileSize } from '../utils/format'
import { formatDate } from '../utils/date'
// DU1：路径工具统一到 utils/file.ts
import { getDirName, joinPath } from '../utils/file'

export interface UseFileOperationsOptions {
  filteredFiles: MediaFile[]
  onShowMessage: (text: string, type?: ToastType) => void
  onRefreshMedia: () => Promise<void>
}

export interface DeleteConfirmConfig {
  title: string
  message: string
  onConfirm: () => Promise<void>
}

export interface BatchDeleteFailure {
  id: string
  error: string
}

export interface BatchDeleteResult {
  succeeded: string[]
  failed: BatchDeleteFailure[]
}

// 批量删除并发上限：一次性发起数百个 IPC 会把主进程事件循环打满
const DELETE_CONCURRENCY = 5

export function useFileOperations(options: UseFileOperationsOptions) {
  const { filteredFiles, onShowMessage, onRefreshMedia } = options
  const { t } = useTranslation()
  // 字段级订阅：整 store 订阅会让所有引用本 hook 的组件随任意 state 变化重渲染
  const selectMedia = useUIStore((s) => s.selectMedia)
  const navigateTo = useUIStore((s) => s.navigateTo)
  const openFullscreen = useUIStore((s) => s.openFullscreen)
  const deleteMediaFiles = useMediaStore((s) => s.deleteMediaFiles)
  const updateMediaFile = useMediaStore((s) => s.updateMediaFile)
  const pushHistory = useOperationHistoryStore((s) => s.push)
  const registerUndoHandler = useOperationHistoryStore((s) => s.registerUndoHandler)

  // 建议改#9：注册 4 个 undoHandler（按 type 分发，避免闭包捕获）
  // 使用 ref 保存最新的 onRefreshMedia/updateMediaFile，handler 内通过 ref 访问
  useEffect(() => {
    // P1-C8：收集各 registerUndoHandler 返回的注销函数，在 cleanup 中调用
    const unsubscribers: Array<() => void> = []

    // file_move: 将文件从 newPath 移回原目录
    unsubscribers.push(
      registerUndoHandler('file_move', async (payload) => {
        if (!window.electronAPI) return { success: false, message: t('toast.undoUnsupported') }
        const { newPath, originalPath } = payload as { newPath: string; originalPath: string }
        try {
          const undoResult = await window.electronAPI.file.move([newPath], getDirName(originalPath))
          if (!undoResult.success) return { success: false, message: undoResult.message }
          await onRefreshMedia()
          return { success: true }
        } catch (err) {
          return { success: false, message: err instanceof Error ? err.message : String(err) }
        }
      })
    )

    // file_rename: 将文件名改回 originalName
    unsubscribers.push(
      registerUndoHandler('file_rename', async (payload) => {
        if (!window.electronAPI) return { success: false, message: t('toast.undoUnsupported') }
        const { newPath, originalName } = payload as { newPath: string; originalName: string }
        try {
          const undoResult = await window.electronAPI.file.rename(newPath, originalName)
          if (!undoResult.success) return { success: false, message: undoResult.message }
          await onRefreshMedia()
          return { success: true }
        } catch (err) {
          return { success: false, message: err instanceof Error ? err.message : String(err) }
        }
      })
    )

    // media_soft_delete: 从回收站恢复
    unsubscribers.push(
      registerUndoHandler('media_soft_delete', async (payload) => {
        if (!window.electronAPI) return { success: false, message: t('toast.undoUnsupported') }
        const { mediaId } = payload as { mediaId: number }
        try {
          // preload call() 解包 IpcResponse 只回传 data（{ message }，无 success 字段），
          // 成功 = 未抛 IpcError；缺陷写法读取恒为 undefined 的 undoResult.success
          // 会导致撤销恢复误报失败并跳过图库刷新（#fix-restore-sync）
          const undoResult = await window.electronAPI.mediaAction.restore([mediaId])
          await onRefreshMedia()
          return { success: true, message: undoResult.message }
        } catch (err) {
          return { success: false, message: err instanceof Error ? err.message : String(err) }
        }
      })
    )

    // favorite_toggle: 恢复收藏状态
    unsubscribers.push(
      registerUndoHandler('favorite_toggle', async (payload, mediaId) => {
        if (!window.electronAPI || !mediaId)
          return { success: false, message: t('toast.undoUnsupported') }
        const { originalFavorite } = payload as { originalFavorite: boolean }
        try {
          // preload call() 解包 IpcResponse 为 data（{ updated: true }），失败抛 IpcError。
          // 复用与 useFavoriteToggle 一致的契约，不再误判恒为 undefined 的 undoResult.success。
          await window.electronAPI.mediaAction.updateFavorite(Number(mediaId), originalFavorite)
          updateMediaFile(mediaId, { is_favorite: originalFavorite })
          return { success: true }
        } catch (err) {
          return { success: false, message: err instanceof Error ? err.message : String(err) }
        }
      })
    )

    // P1-C8：组件卸载时注销所有 handler，避免撤销调用已卸载闭包
    return () => {
      unsubscribers.forEach((unsub) => unsub())
    }
  }, [registerUndoHandler, onRefreshMedia, updateMediaFile, t])

  const staged = useStagedTask()
  const stagedRef = useRef(staged)
  stagedRef.current = staged

  const handleOpen = useCallback(
    (file: MediaFile) => {
      selectMedia(file.id)
      openFullscreen(filteredFiles.findIndex((f) => f.id === file.id))
    },
    [filteredFiles, selectMedia, openFullscreen]
  )

  const handleEdit = useCallback(
    (file: MediaFile) => {
      selectMedia(file.id)
      navigateTo('editor')
    },
    [selectMedia, navigateTo]
  )

  const handleSaveAs = useCallback(
    async (file: MediaFile) => {
      if (!window.electronAPI) {
        onShowMessage(t('toast.saveAsUnsupported'), 'error')
        return
      }
      try {
        const targetDir = await window.electronAPI.dialog.selectDirectory()
        if (!targetDir) return
        const result = await window.electronAPI.file.saveAs(file.file_path, targetDir)
        onShowMessage(result.message, result.success ? 'success' : 'error')
      } catch (error) {
        onShowMessage(error instanceof Error ? error.message : t('toast.saveAsFailed'), 'error')
      }
    },
    [onShowMessage, t]
  )

  const handleCopy = useCallback(
    async (file: MediaFile) => {
      if (!window.electronAPI) {
        onShowMessage(t('toast.copyUnsupported'), 'error')
        return
      }
      try {
        const targetDir = await window.electronAPI.dialog.selectDirectory()
        if (!targetDir) return
        const result = await window.electronAPI.file.copy([file.file_path], targetDir)
        onShowMessage(result.message, result.success ? 'success' : 'error')
      } catch (error) {
        onShowMessage(error instanceof Error ? error.message : t('toast.copyFailed'), 'error')
      }
    },
    [onShowMessage, t]
  )

  const handleMove = useCallback(
    async (file: MediaFile) => {
      if (!window.electronAPI) {
        onShowMessage(t('toast.moveUnsupported'), 'error')
        return
      }
      try {
        const targetDir = await window.electronAPI.dialog.selectDirectory()
        if (!targetDir) return
        const originalPath = file.file_path
        const result = await window.electronAPI.file.move([originalPath], targetDir)
        if (result.success) {
          deleteMediaFiles([file.id])
          // P1-C2：使用主进程返回的实际路径（冲突时可能被自动重命名），避免撤销时找不到文件
          const newPath = result.actualPaths?.[0] ?? joinPath(targetDir, file.file_name)
          pushHistory({
            type: 'file_move',
            description: t('toast.undo.move', { name: file.file_name }),
            mediaId: file.id,
            payload: { originalPath, newPath, targetDir }
          })
        }
        onShowMessage(result.message, result.success ? 'success' : 'error')
      } catch (error) {
        onShowMessage(error instanceof Error ? error.message : t('toast.moveFailed'), 'error')
      }
    },
    [deleteMediaFiles, onShowMessage, pushHistory, t]
  )

  const handleRename = useCallback(
    async (file: MediaFile, newName: string) => {
      if (!window.electronAPI) {
        onShowMessage(t('toast.renameUnsupported'), 'error')
        return
      }
      try {
        const originalPath = file.file_path
        const originalName = file.file_name
        const result = await window.electronAPI.file.rename(originalPath, newName)
        if (result.success) {
          await onRefreshMedia()
          // 建议改#9：不传 undoFn，仅传 type + payload
          // FIX(组21-2): 主进程 renameFile 会保留并追加原扩展名（"photo.jpg"→输入"vacation"
          // 实际落盘 vacation.jpg），渲染端自行拼接 joinPath(dir, newName) 不含扩展名，
          // 撤销时 file.rename(newPath, originalName) 因源路径不存在而失败、重命名不可撤销。
          // 改用主进程返回的 renamed[0].newPath（含正确路径），renamed 缺失时回退拼接兜底
          const dir = getDirName(originalPath)
          const newPath = result.renamed?.[0]?.newPath ?? joinPath(dir, newName)
          pushHistory({
            type: 'file_rename',
            description: t('toast.undo.rename', { oldName: originalName, newName }),
            mediaId: file.id,
            payload: { originalPath, newPath, originalName, newName }
          })
        }
        onShowMessage(result.message, result.success ? 'success' : 'error')
      } catch (error) {
        onShowMessage(error instanceof Error ? error.message : t('toast.renameFailed'), 'error')
      }
    },
    [onShowMessage, onRefreshMedia, pushHistory, t]
  )

  const getDeleteConfirm = useCallback(
    (file: MediaFile, permanent = false): DeleteConfirmConfig => ({
      title: permanent ? t('toast.permanentDeleteTitle') : t('toast.deleteFileTitle'),
      message: permanent
        ? t('toast.permanentDeleteConfirm', { name: file.file_name })
        : t('toast.moveToRecycleConfirm', { name: file.file_name }),
      onConfirm: async () => {
        const api = window.electronAPI
        if (!api) {
          onShowMessage(t('toast.deleteUnsupported'), 'error')
          return
        }
        let toastText = permanent
          ? t('toast.permanentDeleteConfirm', { name: file.file_name })
          : t('toast.moveToRecycleConfirm', { name: file.file_name })
        let toastType: 'success' | 'error' = 'success'
        const final = await stagedRef.current.run({
          taskType: 'batch',
          title: permanent
            ? t('toast.permanentDeleteConfirm', { name: file.file_name })
            : t('toast.moveToRecycleConfirm', { name: file.file_name }),
          stageLabels: [
            t('taskProgress.phase.preparing'),
            t('taskProgress.phase.processing'),
            t('taskProgress.phase.finalizing')
          ],
          canCancel: false,
          execute: async ({ setStage, tick }) => {
            if (permanent) {
              setStage(0)
              const result = await api.file.deletePermanent([file.file_path])
              if (!result.success) throw new Error(result.message)
              toastText = result.message
              toastType = 'success'
              setStage(0, 'done')
              setStage(1)
              // #fix-permanent-delete-error-toast：preload call() 成功只返回 data
              // （media:delete → { deleted: true }，无 success 字段），失败会抛 IpcError
              // 由 staged.run 捕获；不可读取 result.success 判定（恒 undefined → 删除成功却误报失败）
              await api.mediaAction.delete(Number(file.id))
              setStage(1, 'done')
              setStage(2)
              deleteMediaFiles([file.id])
              setStage(2, 'done')
            } else {
              setStage(0)
              const result = await api.file.delete([file.file_path])
              if (!result.success) throw new Error(result.message)
              toastText = result.message
              toastType = 'success'
              setStage(0, 'done')
              setStage(1)
              const dbRes = await api.mediaAction.softDelete([Number(file.id)])
              if (!dbRes.success) throw new Error(dbRes.message)
              setStage(1, 'done')
              setStage(2)
              deleteMediaFiles([file.id])
              // 建议改#9：不传 undoFn，仅传 type + payload
              pushHistory({
                type: 'media_soft_delete',
                description: t('toast.undo.moveToRecycle', { name: file.file_name }),
                mediaId: file.id,
                payload: { mediaId: Number(file.id), originalPath: file.file_path }
              })
              setStage(2, 'done')
            }
            tick(1, 1)
          }
        })
        onShowMessage(
          final?.phase === 'error' ? (final.message ?? toastText) : toastText,
          final?.phase === 'error' ? 'error' : toastType
        )
      }
    }),
    [deleteMediaFiles, onShowMessage, pushHistory, t]
  )

  // 批量软删除：对每个 id 复用单文件软删除的操作序列（IPC 删文件 → 软删除数据库记录）
  // 只把删除成功的 id 移出 store，失败项保留在列表中供用户重试
  const deleteFilesBatch = useCallback(
    async (ids: string[]): Promise<BatchDeleteResult> => {
      if (ids.length === 0) return { succeeded: [], failed: [] }

      const api = window.electronAPI
      if (!api) {
        const message = t('toast.deleteUnsupported')
        onShowMessage(message, 'error')
        return { succeeded: [], failed: ids.map((id) => ({ id, error: message })) }
      }

      // 从 store 全量列表取路径：选中项可能已被当前筛选条件隐藏，filteredFiles 不可靠
      const pathById = new Map(
        useMediaStore.getState().mediaFiles.map((file) => [file.id, file.file_path])
      )

      const succeeded: string[] = []
      const failed: BatchDeleteFailure[] = []
      const makeAbort = (): Error => {
        const e = new Error('aborted')
        e.name = 'AbortError'
        return e
      }

      const final = await stagedRef.current.run({
        taskType: 'batch',
        title: t('taskProgress.phase.processing'),
        stageLabels: [
          t('taskProgress.phase.preparing'),
          t('taskProgress.phase.processing'),
          t('taskProgress.phase.finalizing')
        ],
        canCancel: true,
        total: ids.length,
        execute: async ({ setStage, tick, signal }) => {
          setStage(0)
          setStage(0, 'done')
          setStage(1)
          const settled = await settleWithConcurrency(
            ids,
            DELETE_CONCURRENCY,
            async (id) => {
              if (signal.aborted) throw makeAbort()
              const filePath = pathById.get(id)
              if (!filePath) throw new Error(t('toast.batchDelete.missingFile', { id }))
              const fileResult = await api.file.delete([filePath])
              if (!fileResult.success) throw new Error(fileResult.message)
              const dbResult = await api.mediaAction.softDelete([Number(id)])
              if (!dbResult.success) throw new Error(dbResult.message)
            },
            (done) => tick(done, ids.length),
            signal
          )
          settled.forEach((result, index) => {
            const id = ids[index]
            if (result.status === 'fulfilled') {
              succeeded.push(id)
              return
            }
            const reason: unknown = result.reason
            failed.push({ id, error: reason instanceof Error ? reason.message : String(reason) })
          })
          if (signal.aborted) throw makeAbort()
          setStage(1, 'done')
          setStage(2)
          if (succeeded.length > 0) deleteMediaFiles(succeeded)
          setStage(2, 'done')
        }
      })

      if (final?.phase === 'cancelled') {
        onShowMessage(t('taskProgress.phase.cancelled'), 'error')
      } else if (failed.length === 0) {
        onShowMessage(t('toast.batchDelete.allSucceeded', { count: succeeded.length }), 'success')
        return { succeeded, failed }
      } else {
        console.error('[deleteFilesBatch] partial failure:', failed)
        onShowMessage(
          t('toast.batchDelete.partial', {
            succeeded: succeeded.length,
            failed: failed.length
          }),
          'error'
        )
      }
      return { succeeded, failed }
    },
    [deleteMediaFiles, onShowMessage, t]
  )

  // P1-C3：复用共享 hook，保持与 FullscreenViewer 收藏撤销逻辑一致
  const handleToggleFavorite = useFavoriteToggle(onShowMessage)

  const formatProperties = useCallback(
    (file: MediaFile): string => {
      const typeLabel =
        file.file_type === 'image'
          ? t('toast.fileProperties.typeImage')
          : t('toast.fileProperties.typeVideo')
      const resolution =
        file.width && file.height
          ? `${file.width}x${file.height}`
          : t('toast.fileProperties.resolutionDash')
      return t('toast.fileProperties.template', {
        name: file.file_name,
        path: file.file_path,
        type: typeLabel,
        size: formatFileSize(file.file_size),
        resolution,
        createdAt: formatDate(file.created_at)
      })
    },
    [t]
  )

  return useMemo(
    () => ({
      handleOpen,
      handleEdit,
      handleSaveAs,
      handleCopy,
      handleMove,
      handleRename,
      getDeleteConfirm,
      deleteFilesBatch,
      handleToggleFavorite,
      formatProperties,
      deleteProgress: staged.progress,
      cancelDelete: staged.cancel,
      resetDelete: staged.reset
    }),
    [
      handleOpen,
      handleEdit,
      handleSaveAs,
      handleCopy,
      handleMove,
      handleRename,
      getDeleteConfirm,
      deleteFilesBatch,
      handleToggleFavorite,
      formatProperties,
      staged.progress,
      staged.cancel,
      staged.reset
    ]
  )
}
