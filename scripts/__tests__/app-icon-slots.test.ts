import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * 应用图标「集成装配面」守卫。
 *
 * scripts/__tests__/app-icon.test.ts 覆盖的是图标产物本身（ICO 结构 / 主源 / PE 开关 / 生成器纯函数），
 * 本文件覆盖的是这些产物有没有真正接到每一个图标槽位上：窗口、两个 HTML、构建配置、启动期 AUMID。
 * 只换 icon.ico 而不接槽位，dev 下窗口与任务栏仍是 Electron 默认图标、页面无 favicon，
 * 这属于「仅打包产物生效」，必须由常驻判据挡住。
 *
 * 判据全部落在磁盘文本 / JSON / 字节上，不 import electron、不写盘，沿用 app-icon.test.ts 的
 * new URL(rel, import.meta.url) 根路径写法，避免 posix 装置下 path.dirname 把盘符路径解析成 '.'。
 */
const repoRootUrl = new URL('../../', import.meta.url)
const readText = (rel: string): string => readFileSync(new URL(rel, repoRootUrl), 'utf-8')
const readBuffer = (rel: string): Buffer => readFileSync(new URL(rel, repoRootUrl))
const repoExists = (rel: string): boolean => existsSync(new URL(rel, repoRootUrl))

const ICO_REL = 'resources/icons/icon.ico'
const FAVICON_REL = 'src/renderer/favicon.ico'
const ICON_VALUE = 'resources/icons/icon.ico'
const APP_ID = 'com.qianlu.meow-star-map'

interface PkgBuild {
  appId: string
  win: { icon: string }
  nsis: { shortcutName: string; installerIcon?: string; uninstallerIcon?: string }
  asarUnpack: string[]
}

interface AppIconContext {
  isPackaged: boolean
  resourcesPath?: string
  appDir: string
}

interface AppIconPathModule {
  resolveAppIconPath: (input: AppIconContext, exists?: (p: string) => boolean) => string | null
}

// 模块不存在时（红灯阶段）由 it 内部抛出，静态守卫组仍可逐条给出失败原因
const loadPathModule = async (): Promise<AppIconPathModule> =>
  (await import('../../src/main/app/app-icon-path')) as AppIconPathModule

const build = (JSON.parse(readText('package.json')) as { build: PkgBuild }).build

describe('图标槽位静态守卫', () => {
  it('R1 BrowserWindow 显式传入与 icon.ico 同源的图标路径', () => {
    const source = readText('src/main/app/window-manager.ts')
    expect(source, 'window-manager.ts 未调用 resolveAppIconPath').toContain('resolveAppIconPath')
    expect(source, 'BrowserWindow 构造未传入 icon').toMatch(/icon:\s*iconPath/)
  })

  it('R2 正式版 index.html 声明同源 favicon', () => {
    const html = readText('src/renderer/index.html')
    expect(html, '缺少 favicon link').toContain('rel="icon"')
    expect(html).toContain('href="./favicon.ico"')
    expect(html, '不得改动品牌 title').toContain('<title>喵星图</title>')
  })

  it('R3 预览版 favicon 经入口 JS import 内联且蓝色相机已移除', () => {
    const html = readText('src/renderer/preview/index.html')
    expect(html, '蓝色相机占位仍在').not.toContain('%23007aff')
    expect(html, '内联 SVG 占位仍在').not.toContain('data:image/svg+xml')
    // Vite 对 HTML <link> 引用的资产一律外发文件（assetsInlineLimit 不覆盖），
    // 单文件 preview.html 会断链——favicon 只能走 preview-entry 的 JS import 内联。
    expect(html, 'HTML 外链 favicon 会被 Vite 外发为文件').not.toContain('rel="icon"')
    expect(html, '不得改动品牌 title').toContain('<title>喵星图 - 预览版</title>')
    const entry = readText('src/renderer/preview-entry.tsx')
    expect(entry, 'preview-entry 未 import 同源 favicon').toContain(
      "import faviconUrl from './favicon.ico'"
    )
    expect(entry).toContain("faviconLink.rel = 'icon'")
    expect(entry).toContain("faviconLink.type = 'image/x-icon'")
    expect(entry).toContain('faviconLink.href = faviconUrl')
  })

  it('R4 favicon.ico 存在且与 icon.ico 逐字节同源', () => {
    expect(repoExists(FAVICON_REL), `${FAVICON_REL} 缺失`).toBe(true)
    const favicon = readBuffer(FAVICON_REL)
    const icon = readBuffer(ICO_REL)
    expect(favicon.length).toBeGreaterThan(0)
    expect(favicon.length).toBe(icon.length)
    expect(favicon.equals(icon), 'favicon 与打包图标不同源').toBe(true)
  })

  it('R5 build.nsis 同时配置 installerIcon 与 uninstallerIcon', () => {
    expect(build.nsis.installerIcon).toBe(ICON_VALUE)
    expect(build.nsis.uninstallerIcon).toBe(ICON_VALUE)
    expect(build.nsis.shortcutName).toBe('喵星图')
    expect(build.win.icon).toBe(ICON_VALUE)
  })

  it('R6 build.asarUnpack 解包运行时图标', () => {
    expect(build.asarUnpack).toContain('resources/icons/icon.ico')
    expect(build.asarUnpack, '既有解包项不得被替换').toContain('**/@nikkisync/**')
  })

  it('R7 主进程设置与 build.appId 同源的 AppUserModelID', () => {
    const source = readText('src/main/index.ts')
    expect(source).toContain(`app.setAppUserModelId('${APP_ID}')`)
    expect(build.appId).toBe(APP_ID)
  })
})

describe('图标路径纯函数', () => {
  it('R8 正常：打包态返回 app.asar.unpacked 下的真实图标路径', async () => {
    const mod = await loadPathModule()
    const got = mod.resolveAppIconPath(
      { isPackaged: true, resourcesPath: 'RESOURCES', appDir: 'APPDIR' },
      () => true
    )
    expect(got).toBe(path.join('RESOURCES', 'app.asar.unpacked', 'resources', 'icons', 'icon.ico'))
  })

  it('R9 正常：dev 态返回项目根下的图标路径', async () => {
    const mod = await loadPathModule()
    const got = mod.resolveAppIconPath(
      { isPackaged: false, appDir: path.join('repo', 'dist', 'main', 'main', 'app') },
      () => true
    )
    expect(got).not.toBeNull()
    expect(got).toContain(path.join('resources', 'icons', 'icon.ico'))
    expect(path.isAbsolute(got!)).toBe(true)
  })

  it('R10 异常：打包态 resourcesPath 缺失/空/空白/非字符串返回 null 且不抛', async () => {
    const mod = await loadPathModule()
    const invalid: Array<string | undefined> = [undefined, '', '   ', 123 as unknown as string]
    for (const resourcesPath of invalid) {
      expect(() =>
        mod.resolveAppIconPath({ isPackaged: true, resourcesPath, appDir: 'APPDIR' }, () => true)
      ).not.toThrow()
      expect(
        mod.resolveAppIconPath({ isPackaged: true, resourcesPath, appDir: 'APPDIR' }, () => true),
        `resourcesPath=${String(resourcesPath)} 应判为非法`
      ).toBeNull()
    }
  })

  it('R11 边界：appDir 为空、文件全不存在、resourcesPath 带尾分隔符', async () => {
    const mod = await loadPathModule()
    expect(mod.resolveAppIconPath({ isPackaged: false, appDir: '' }, () => true)).toBeNull()
    expect(mod.resolveAppIconPath({ isPackaged: false, appDir: 'APPDIR' }, () => false)).toBeNull()
    const got = mod.resolveAppIconPath(
      { isPackaged: true, resourcesPath: 'RESOURCES' + path.sep, appDir: 'APPDIR' },
      () => true
    )
    expect(got).not.toBeNull()
    expect(got).toBe(path.join('RESOURCES', 'app.asar.unpacked', 'resources', 'icons', 'icon.ico'))
  })
})
