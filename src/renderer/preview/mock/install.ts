// Mock 层安装入口：在 window.electronAPI 上注入预览版 Mock
// 已实现的命名空间直接挂载，未实现的通过 Proxy 兜底自动抛 PREVIEW_UNSUPPORTED

import { databaseMock } from './database-mock'
import { filesystemMock } from './filesystem-mock'
import { eventMock } from './event-mock'
import { resonanceMock } from './resonance-mock'
import { IpcError } from './ipc-error'
import { MOCK_FULL_IMAGES } from './data/full-images'
import { MOCK_THUMBNAILS } from './data/thumbnails'
import i18n from '../../i18n'

// 合并 databaseMock 与 filesystemMock 同名命名空间，eventMock 仅注入 onXxx 方法
function mergeNamespace(ns: string): Record<string, unknown> {
  const db = (databaseMock as Record<string, Record<string, unknown>>)[ns] ?? {}
  const fs = (filesystemMock as Record<string, Record<string, unknown>>)[ns] ?? {}
  const ev = (eventMock as Record<string, Record<string, unknown>>)[ns] ?? {}
  return { ...db, ...fs, ...ev }
}

// 已实现的命名空间集合（databaseMock ∪ filesystemMock ∪ eventMock ∪ resonance）
const IMPLEMENTED_NAMESPACES = new Set<string>([
  ...Object.keys(databaseMock),
  ...Object.keys(filesystemMock),
  ...Object.keys(eventMock),
  'resonance'
])

// 构建已实现命名空间的对象
function buildImplementedAPI(): Record<string, Record<string, unknown>> {
  const api: Record<string, Record<string, unknown>> = {}
  for (const ns of IMPLEMENTED_NAMESPACES) {
    // resonance 独立命名空间，不从 databaseMock/filesystemMock 合并
    if (ns === 'resonance') {
      api[ns] = resonanceMock as unknown as Record<string, unknown>
    } else {
      api[ns] = mergeNamespace(ns)
    }
  }
  return api
}

// 在 window 上注入 electronAPI Mock 与 IpcError 类
export function installPreviewMock(): void {
  if (typeof window === 'undefined') return

  // 已存在 electronAPI（理论上预览版不会有 preload 注入）则跳过
  if (window.electronAPI) {
    console.warn(i18n.t('mock.log.skipInstall'))
    return
  }

  const implemented = buildImplementedAPI()

  // Proxy 兜底：未实现的命名空间/方法自动抛 PREVIEW_UNSUPPORTED
  const electronAPI = new Proxy(implemented, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver)
      if (prop in target) return Reflect.get(target, prop, receiver)
      // 未实现的命名空间：返回一个自动抛错的命名空间代理
      return new Proxy(
        {},
        {
          get: () => async () => {
            throw new IpcError(
              'PREVIEW_UNSUPPORTED',
              `预览版不支持：${prop}`,
              { namespace: prop },
              `此功能需要 exe 程序支持，请下载安装完整版`
            )
          }
        }
      )
    }
  })

  Object.defineProperty(window, 'electronAPI', {
    value: electronAPI,
    writable: false,
    configurable: false
  })

  Object.defineProperty(window, 'IpcError', {
    value: IpcError,
    writable: false,
    configurable: false
  })

  // 注：pluginAPI / pluggableElectronIpc / __setPluginI18nT 仅在插件系统真实运行时存在
  // 预览版插件系统不可用，相关代码（plugin-runtime.ts）已用 try/catch 兜底，无需注入 Mock

  // 注入 mock:// 路径解析器：
  // - mock://thumb-N.jpg → 缩略图 data URL（320x240，图库列表用）
  // - mock://sample-N.jpg → 大图 data URL（1280px，详情页/编辑器/全屏用）
  // toFileUrl 在预览版通过此解析器获取 data URL，避免返回浏览器不支持的 media:// 协议
  ;(window as unknown as Record<string, unknown>).__resolveMockFilePath = (
    filePath: string
  ): string | null => {
    const thumbMatch = filePath?.match(/thumb-(\d+)/)
    if (thumbMatch) return MOCK_THUMBNAILS[thumbMatch[1]] ?? null
    const fullMatch = filePath?.match(/sample-(\d+)/)
    if (fullMatch) return MOCK_FULL_IMAGES[fullMatch[1]] ?? null
    return null
  }
}
