import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  fetchMediaFromDatabase,
  getMediaRefreshAbortKind,
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
      // 弃权与取数失败在 fetchMediaFromDatabase 的返回值上同形（都是 null）——语义分离由
      // mediaStore 的契约访问器承担（DEBT-053 收口）：弃权记 'superseded'、取数失败记 'failed'。
      // 被取代的 null 是**成功**语义（UI 由最新一轮交付）——不重试、不弹错误 toast；
      // nikkisync 源不参与代次 ⇒ 恒判非弃权 ⇒ 真实失败照常重试与上报，与修复前行为一致。
      let superseded = false
      const fetchOnce = async () => {
        const result = await fetchMediaFromDatabase()
        superseded = getMediaRefreshAbortKind() === 'superseded'
        return result
      }

      let result = await fetchOnce()
      let attempt = 0
      // 首次加载失败时自动重试：主进程 IPC/DB 可能存在初始化时序窗口。
      // 被取代路径不进本循环（DEBT-053）：重试会白废 3 次全量深度取数，且最新一轮已经在交付。
      while (!result && !superseded && attempt < MAX_RETRIES) {
        attempt++
        const delay = RETRY_BASE_DELAY * attempt
        console.warn(`[useRefreshMedia] 加载失败，${delay}ms 后重试 (${attempt}/${MAX_RETRIES})`)
        await new Promise<void>((resolve) => setTimeout(resolve, delay))
        result = await fetchOnce()
      }
      if (!result && superseded) {
        // 契约访问器判定的成功语义：打一条开发者可读的说明，不进重试、不算失败。
        // 沿用本文件既有 dev 日志形态（中文模板串，i18n 护栏盲区，DEBT-058 在案）。
        console.warn(`[useRefreshMedia] 本轮已被新一轮整刷取代，UI 由最新一轮交付，不再重试`)
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
