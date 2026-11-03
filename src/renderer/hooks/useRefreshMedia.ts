import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  fetchMediaFromDatabase,
  getMediaRefreshGeneration,
  useMediaStore
} from '../stores/mediaStore'

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
      // 每次自己发起之前记一代次：本地整刷在函数入口领走 ++depthRefreshSeq（恒 +1），返回后若
      // 超过「发起前 + 1」，说明期间**别人**起了新一轮 ⇒ 我们这轮的 null 是「被取代」（UI 由那一轮
      // 交付），不是加载失败，不该弹错误 toast。nikkisync 源不 bump 代次 ⇒ 恒判未被取代 ⇒ 真实
      // 失败照常上报，与修复前行为一致。
      let superseded = false
      const fetchOnce = async () => {
        const genBeforeCall = getMediaRefreshGeneration()
        const result = await fetchMediaFromDatabase()
        superseded = getMediaRefreshGeneration() > genBeforeCall + 1
        return result
      }

      let result = await fetchOnce()
      let attempt = 0
      // 首次加载失败时自动重试：主进程 IPC/DB 可能存在初始化时序窗口
      while (!result && attempt < MAX_RETRIES) {
        attempt++
        const delay = RETRY_BASE_DELAY * attempt
        console.warn(`[useRefreshMedia] 加载失败，${delay}ms 后重试 (${attempt}/${MAX_RETRIES})`)
        await new Promise<void>((resolve) => setTimeout(resolve, delay))
        result = await fetchOnce()
      }
      if (result) {
        setMediaFiles(result.files)
        setCategories(result.categories)
      } else if (!superseded) {
        // P2-C9：result 为 null 时提示加载失败，而非静默保留旧数据
        console.error(t('gallery.media.log.refreshNullFailed'))
        onError?.(t('toast.mediaLoadFailed'))
      }
    } finally {
      if (withLoading) setLoading(false)
    }
  }, [setMediaFiles, setCategories, setLoading, withLoading, onError, t])

  return refresh
}
