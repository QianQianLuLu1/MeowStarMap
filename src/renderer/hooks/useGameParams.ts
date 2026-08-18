import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { GameParamsData } from '../types/decryption'

interface UseGameParamsResult {
  data: GameParamsData | null
  loading: boolean
  error: string | null
  refresh: () => void
}

/**
 * P0-C1/P1-F3：LRU + TTL 缓存
 * - 上限 200 条（单条约 3-5KB，含 photography/nikki/dressing/interactions 扩展字段，峰值约 1MB）
 * - 命中时 delete+set 把 key 移到末尾，实现"最近访问优先"
 * - 超限删除 Map.keys().next().value（最久未访问）
 * - 5 分钟 TTL，避免文件外部修改后返回旧参数
 */
const CACHE_MAX_SIZE = 200
const CACHE_TTL_MS = 5 * 60 * 1000

interface CacheEntry {
  data: GameParamsData
  expireAt: number
}

const cache = new Map<string, CacheEntry>()

function cacheGet(key: string): GameParamsData | null {
  const entry = cache.get(key)
  if (!entry) return null
  // 过期则剔除
  if (Date.now() > entry.expireAt) {
    cache.delete(key)
    return null
  }
  // LRU：删除后重新插入，使其成为最新访问
  cache.delete(key)
  cache.set(key, entry)
  return entry.data
}

function cacheSet(key: string, data: GameParamsData): void {
  // 容量淘汰：删除最久未访问项（Map 迭代顺序 = 插入顺序）
  if (cache.size >= CACHE_MAX_SIZE && !cache.has(key)) {
    const oldestKey = cache.keys().next().value
    if (oldestKey !== undefined) cache.delete(oldestKey)
  }
  cache.set(key, { data, expireAt: Date.now() + CACHE_TTL_MS })
}

function cacheDelete(key: string): void {
  cache.delete(key)
}

/** 清空全部缓存（用于媒体更新、编辑保存后强制刷新） */
export function clearAllGameParamsCache(): void {
  cache.clear()
}

export function useGameParams(
  filePath: string | undefined,
  albumType: string | undefined,
  uid: string | undefined,
  enabled: boolean = true
): UseGameParamsResult {
  const { t } = useTranslation()
  const [data, setData] = useState<GameParamsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tokenRef = useRef({ cancelled: false })

  const doFetch = useCallback(() => {
    if (!filePath || !albumType || !enabled) {
      setData(null)
      setError(null)
      return
    }

    const cacheKey = `${filePath}::${uid || ''}`
    const cached = cacheGet(cacheKey)
    if (cached) {
      setData(cached)
      setLoading(false)
      setError(null)
      return
    }

    const token = { cancelled: false }
    tokenRef.current = token
    setLoading(true)
    setError(null)

    window
      .electronAPI!.decrypt.decodeFile(filePath, albumType, uid)
      .then((result) => {
        if (token.cancelled) return
        if (result.ok && result.data) {
          cacheSet(cacheKey, result.data)
          setData(result.data)
        } else {
          setData({ hasParams: false, error: result.message || t('toast.decodeFailed') })
        }
      })
      .catch((err: unknown) => {
        if (token.cancelled) return
        setData({
          hasParams: false,
          error: err instanceof Error ? err.message : t('toast.unknownError')
        })
      })
      .finally(() => {
        if (!token.cancelled) setLoading(false)
      })
  }, [filePath, albumType, uid, enabled, t])

  useEffect(() => {
    doFetch()
    return () => {
      tokenRef.current.cancelled = true
    }
  }, [doFetch])

  const refresh = useCallback(() => {
    if (filePath && albumType) {
      const cacheKey = `${filePath}::${uid || ''}`
      cacheDelete(cacheKey)
    }
    doFetch()
  }, [filePath, albumType, uid, doFetch])

  return { data, loading, error, refresh }
}
