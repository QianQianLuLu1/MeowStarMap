// 将本地文件路径转换为渲染进程可访问的 URL
// 在 Electron 中使用自定义 media:// 协议，在浏览器预览版中直接使用对象 URL
export function toFileUrl(filePath: string | null | undefined): string | null {
  if (!filePath) return null
  if (
    filePath.startsWith('media://') ||
    filePath.startsWith('blob:') ||
    filePath.startsWith('data:')
  ) {
    return filePath
  }
  if (filePath.startsWith('file://')) {
    return filePath
  }

  // 预览版：不使用 media:// 协议（浏览器不支持）
  // mock:// 路径通过全局解析器获取 data URL
  if (typeof __PREVIEW__ !== 'undefined' && __PREVIEW__) {
    if (filePath.startsWith('mock://')) {
      const resolver = (window as unknown as Record<string, unknown>).__resolveMockFilePath as
        ((path: string) => string | null) | undefined
      if (resolver) return resolver(filePath)
    }
    return filePath
  }

  const normalized = filePath.replace(/\\/g, '/')

  // Electron 环境：使用自定义协议访问本地文件，避免 file:// 跨目录安全限制
  if (typeof window !== 'undefined' && window.electronAPI) {
    return `media://file?path=${encodeURIComponent(normalized)}`
  }

  // 浏览器/预览版：file_path 通常为对象 URL，直接返回
  return filePath
}

/**
 * 判断该 URL 是否需要以 anonymous CORS 模式加载（用于绘制进 canvas 前设置 img.crossOrigin）。
 * media:// scheme 注册为 standard（src/main/index.ts）具有独立 origin，相对页面为跨源；
 * 将其绘制进 canvas 并调用 getImageData 前必须以 anonymous CORS 模式加载，
 * 否则画布被污染（tainted）抛 SecurityError。
 * （替代过时的 U-G14 "本地协议不会 tainted" 认知）
 * blob:/data:/mock:// 等同源或内联协议无需 CORS。
 */
export function needsAnonymousCors(url: string): boolean {
  if (typeof url !== 'string' || !url) return false
  return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('media://')
}

// DU1：渲染进程轻量路径工具（避免依赖 Node.js path 模块）。
// 兼容 Windows（\）与 Unix（/）路径分隔符。

/** 获取文件所在目录（兼容 \ 与 / 分隔符） */
export function getDirName(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return idx >= 0 ? filePath.substring(0, idx) : filePath
}

/** 拼接目录与文件名（自动推断分隔符） */
export function joinPath(dir: string, name: string): string {
  if (!dir) return name
  const sep = dir.includes('/') && !dir.includes('\\') ? '/' : '\\'
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`
}
