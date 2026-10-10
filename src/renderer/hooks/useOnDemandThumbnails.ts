import { useCallback, useEffect, useRef, useState } from 'react'

export interface OnDemandThumbnailFile {
  file_path: string
  thumbnail?: string | null
}

interface OnDemandThumbnailsResult {
  ensureThumbnail: (
    file: OnDemandThumbnailFile,
    options?: { force?: boolean }
  ) => Promise<string | null>
  getGeneratedPath: (filePath: string) => string | undefined
  hasFailed: (filePath: string) => boolean
}

const generationRequests = new Map<string, Promise<string | null>>()
const generationResults = new Map<string, string | null>()

/**
 * 可视区缩略图按需生成入口。模块级 Promise 缓存保证所有视图复用同一路径请求。
 */
export function useOnDemandThumbnails(): OnDemandThumbnailsResult {
  const [, setRevision] = useState(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const notifyResult = useCallback((filePath: string, result: string | null) => {
    generationResults.set(filePath, result)
    if (mountedRef.current) setRevision((value) => value + 1)
  }, [])

  const ensureThumbnail = useCallback(
    (file: OnDemandThumbnailFile, options?: { force?: boolean }): Promise<string | null> => {
      const filePath = file.file_path
      if (file.thumbnail && !options?.force) return Promise.resolve(file.thumbnail)
      if (typeof filePath !== 'string' || filePath.length === 0) return Promise.resolve(null)

      const existing = generationRequests.get(filePath)
      if (existing) {
        void existing.then((result) => notifyResult(filePath, result))
        return existing
      }

      const generate = window.electronAPI?.thumbnail?.generate
      if (typeof generate !== 'function') return Promise.resolve(null)

      const request = generate(filePath).catch(() => null)
      generationRequests.set(filePath, request)
      void request.then((result) => notifyResult(filePath, result))
      return request
    },
    [notifyResult]
  )

  const getGeneratedPath = useCallback(
    (filePath: string) => generationResults.get(filePath) ?? undefined,
    []
  )
  const hasFailed = useCallback(
    (filePath: string) =>
      generationResults.has(filePath) && generationResults.get(filePath) === null,
    []
  )

  return { ensureThumbnail, getGeneratedPath, hasFailed }
}
