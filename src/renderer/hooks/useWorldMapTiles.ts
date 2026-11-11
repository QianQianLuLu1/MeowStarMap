import { useEffect, useState } from 'react'
import type { WorldMapTileInfo } from '../../shared/types/electron-api'

/**
 * 阶段 4：消费既有 `refdata:get-world-map-tiles` / `refdata:get-status` 查询通道。
 * 只读取、不新增也不修改任何 IPC 契约；查询面本身 fail-soft（不可用返回空数组）。
 *
 * - 卸载/预览版/桥缺失：不发起或不再消费 IPC 结果（cancelled token）；
 * - 任何异常都映射为可判定的降级态并留 console.error 诊断，不静默吞错；
 * - 不缓存、不预取、不批量：一次挂载查一次，供上层渲染「数据缺失」空态。
 */
export type WorldMapTilesError = 'preview' | 'no-bridge' | 'ipc-error'

export interface WorldMapTilesResult {
  tiles: WorldMapTileInfo[]
  /** refdata:get-status 的 available；false = v1.db 索引未就绪/损坏/离线 */
  serviceAvailable: boolean
  loading: boolean
  error: WorldMapTilesError | null
}

const INITIAL: WorldMapTilesResult = {
  tiles: [],
  serviceAvailable: false,
  loading: true,
  error: null
}

function settled(error: WorldMapTilesError): WorldMapTilesResult {
  return { tiles: [], serviceAvailable: false, loading: false, error }
}

function isPreview(): boolean {
  return typeof __PREVIEW__ !== 'undefined' && __PREVIEW__
}

/**
 * @param enabled false = 宿主不需要地图数据（非游戏图片 / 已注入解密数据），
 *   零 IPC 返回可判定空态（审查修复 2026-11-11：避免无谓的 refdata 查询）
 */
export function useWorldMapTiles(enabled: boolean = true): WorldMapTilesResult {
  const [state, setState] = useState<WorldMapTilesResult>(INITIAL)

  useEffect(() => {
    if (!enabled) {
      setState({ tiles: [], serviceAvailable: false, loading: false, error: null })
      return
    }
    // 预览版复用既有 useReferenceImage 的降级惯例，不新增预览专用取数路径
    if (isPreview()) {
      setState(settled('preview'))
      return
    }
    const api = window.electronAPI?.referenceData
    if (!api?.getWorldMapTiles || !api.getStatus) {
      setState(settled('no-bridge'))
      return
    }

    let cancelled = false
    void (async () => {
      try {
        const [tilesResult, status] = await Promise.all([api.getWorldMapTiles(), api.getStatus()])
        if (cancelled) return
        const tiles = Array.isArray(tilesResult?.tiles) ? tilesResult.tiles : []
        setState({
          tiles,
          serviceAvailable: status?.available === true,
          loading: false,
          error: null
        })
      } catch (err) {
        if (cancelled) return
        console.error('[world-map] failed to load reference tiles:', err)
        setState(settled('ipc-error'))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [enabled])

  return state
}
