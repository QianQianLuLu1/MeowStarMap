import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { fetchMediaFromDatabase, useMediaStore } from '../stores/mediaStore'

/** 首次加载最大重试次数 */
const MAX_RETRIES = 3
/** 重试间隔（ms），逐次递增 */
const RETRY_BASE_DELAY = 500

export function useRefreshMedia(options?: {
  withLoading?: boolean
  onError?: (msg: string) => void
}): () => Promise<void> {
  const { t } = useTranslation()
  const setMediaFiles = useMediaStore((state) => state.setMediaFiles)
  const setCategories = useMediaStore((state) => state.setCategories)
  const setLoading = useMediaStore((state) => state.setLoading)
  const withLoading = options?.withLoading ?? false
  const onError = options?.onError

  const refresh = useCallback(async () => {
    if (withLoading) setLoading(true)
    try {
      let result = await fetchMediaFromDatabase()
      let attempt = 0
      // 首次加载失败时自动重试：主进程 IPC/DB 可能存在初始化时序窗口
      while (!result && attempt < MAX_RETRIES) {
        attempt++
        const delay = RETRY_BASE_DELAY * attempt
        console.warn(`[useRefreshMedia] 加载失败，${delay}ms 后重试 (${attempt}/${MAX_RETRIES})`)
        await new Promise<void>((resolve) => setTimeout(resolve, delay))
        result = await fetchMediaFromDatabase()
      }
      if (result) {
        setMediaFiles(result.files)
        setCategories(result.categories)
      } else {
        // P2-C9：result 为 null 时提示加载失败，而非静默保留旧数据
        console.error('[useRefreshMedia] fetchMediaFromDatabase 返回 null，媒体数据加载失败')
        onError?.(t('toast.mediaLoadFailed'))
      }
    } finally {
      if (withLoading) setLoading(false)
    }
  }, [setMediaFiles, setCategories, setLoading, withLoading, onError, t])

  return refresh
}
