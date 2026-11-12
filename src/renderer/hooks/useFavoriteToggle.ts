import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useMediaStore, type MediaFile } from '../stores/mediaStore'
import { useOperationHistoryStore } from '../stores/operationHistoryStore'
import { extractUserMessage } from '../../shared/errors/app-error'
import type { AssetMediaFile } from '../utils/assetViewModel'
import type { ToastType } from './useToast'

type ShowMessage = (text: string, type?: ToastType) => void

/**
 * P1-C3：收藏/取消收藏共享 hook。
 * 乐观更新 store + 失败回滚 + pushHistory（接入撤销栈）。
 * useFileOperations 和 FullscreenViewer 共用，避免撤销逻辑割裂。
 *
 * 数据源分流：nikkisync 源卡片 id 是字符串 assetId（Number() 即 NaN），
 * 收藏必须写 asset_edits 叠加层；本地源保持 mediaAction.updateFavorite。
 */
export function useFavoriteToggle(onShowMessage?: ShowMessage) {
  const updateMediaFile = useMediaStore((s) => s.updateMediaFile)
  const pushHistory = useOperationHistoryStore((s) => s.push)
  const { t } = useTranslation()

  return useCallback(
    async (file: MediaFile) => {
      if (!window.electronAPI) {
        // 预览环境：直接切换本地状态
        updateMediaFile(file.id, { is_favorite: !file.is_favorite })
        return
      }
      const originalFavorite = file.is_favorite
      const next = !file.is_favorite
      updateMediaFile(file.id, { is_favorite: next })
      const assetId = (file as AssetMediaFile).nikkisync?.assetId
      try {
        // preload call() 已解包 IpcResponse 为 data 并把失败改为抛 IpcError，
        // 此处不应再读取不存在的 result.success/result.message。
        if (assetId) {
          await window.electronAPI.assetEdits.set(assetId, { isFavorite: next })
          pushHistory({
            type: 'favorite_toggle',
            description: next
              ? t('toast.undo.favorite', { name: file.file_name })
              : t('toast.undo.unfavorite', { name: file.file_name }),
            mediaId: file.id,
            payload: { assetId, originalFavorite, newFavorite: next }
          })
        } else {
          await window.electronAPI.mediaAction.updateFavorite(Number(file.id), next)
          pushHistory({
            type: 'favorite_toggle',
            description: next
              ? t('toast.undo.favorite', { name: file.file_name })
              : t('toast.undo.unfavorite', { name: file.file_name }),
            mediaId: file.id,
            payload: { mediaId: Number(file.id), originalFavorite, newFavorite: next }
          })
        }
      } catch (error) {
        // 失败回滚
        updateMediaFile(file.id, { is_favorite: file.is_favorite })
        onShowMessage?.(
          error instanceof Error ? extractUserMessage(error) : t('toast.favoriteFailed'),
          'error'
        )
      }
    },
    [onShowMessage, updateMediaFile, pushHistory, t]
  )
}
