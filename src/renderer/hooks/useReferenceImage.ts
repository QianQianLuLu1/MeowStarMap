import { useEffect, useState } from 'react'
import type { NetworkImageTemplateKind } from '../../shared/types/electron-api'
import { toFileUrl } from '../utils/file'
import { isRemoteImagesEnabled } from '../utils/resonance/remote-images-enabled'

/**
 * 按需解析一张参考数据 CDN 图片（阶段 5）。
 *
 * 调用链：refdata:resolve-image → 主进程授权核实/磁盘缓存/退避 → 本机缓存路径
 * → toFileUrl 拼 media:// 供图。渲染进程永不直连 CDN；一次一张，不预取不批量。
 *
 * 收敛策略：模块级终态缓存（含 null）+ in-flight 去重——同 key 重复挂载零重复 IPC。
 * 主进程侧已有 404 负缓存与失败冷却，渲染层会话内不重试，避免放大请求量。
 * 预览版（__PREVIEW__）与桥缺失静默降级 null，由调用方回退占位。
 */

const settled = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

function keyOf(kind: string, id: number): string {
  return `${kind}:${id}`
}

async function resolveSrc(kind: NetworkImageTemplateKind, id: number): Promise<string | null> {
  try {
    const resolveImage = window.electronAPI?.referenceData?.resolveImage
    if (!resolveImage) return null
    const result = await resolveImage(kind, id)
    return result && typeof result.path === 'string' && result.path ? toFileUrl(result.path) : null
  } catch {
    // 通道本身永不 reject；此处兜底桥异常（预览 mock / 装配竞态），静默降级占位
    return null
  }
}

export function useReferenceImage(
  kind: NetworkImageTemplateKind,
  id: number
): { src: string | null } {
  const usable =
    isRemoteImagesEnabled() &&
    !(typeof __PREVIEW__ !== 'undefined' && __PREVIEW__) &&
    Number.isSafeInteger(id) &&
    id > 0
  const key = keyOf(kind, id)
  const [src, setSrc] = useState<string | null>(() => (usable ? (settled.get(key) ?? null) : null))

  useEffect(() => {
    if (!usable) {
      setSrc(null)
      return
    }
    const cached = settled.get(key)
    if (cached !== undefined) {
      setSrc(cached)
      return
    }
    let cancelled = false
    let task = inflight.get(key)
    if (!task) {
      task = resolveSrc(kind, id).then((value) => {
        settled.set(key, value)
        inflight.delete(key)
        return value
      })
      inflight.set(key, task)
    }
    void task.then((value) => {
      if (!cancelled) setSrc(value)
    })
    return () => {
      cancelled = true
    }
  }, [key, usable, kind, id])

  return { src: usable ? src : null }
}
