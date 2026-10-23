import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 界面品牌名守卫（阶段 3：界面文字与多语言资源更名）。
 *
 * 为什么要有这个文件：本轮站点全是**字面量** —— HTML 的 `<title>`、分享页模板串里的 `<h1>`、
 * 原生弹窗 content、默认水印配置、示例插件署名。仓库里没有任何用例断言过它们，`src/**` 下
 * 也没有快照，改漏了不会红。不立一个读源码文本的守卫，「旧名零残留」就只剩人肉 grep。
 * 嗅探源码文本的范式沿用 src/renderer/components/common/UpdateDialog.test.tsx:66-68。
 *
 * 读的是磁盘上的源文件文本、不 import 被测模块 ⇒ 不必把 electron / jsdom 拉进 node project，
 * 也不受装置（tests/ci-linux.setup.ts）伪造 cwd 的影响：根路径按 fileURLToPath 解析，
 * 与 scripts/__tests__/source-encoding.test.ts:19,86 同一口径。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf-8')
const readJson = <T>(rel: string): T => JSON.parse(read(rel)) as T

/** 12 个语包，与 scripts/check-i18n-keys.ts 收的文件集一致 */
const LOCALES = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'th', 'vi', 'zh-CN', 'zh-TW']

/**
 * 展示型应用名的取值依据是 docs/plans/2026-10-23-project-rename-meow-star-map.md §1.1：
 * zh-CN 取简体「喵星图」，zh-TW 按该语种惯例取「喵星圖」，其余 10 包统一拉丁形「Meow Star Map」
 * （三词各一个空格；写成 MeowStarMap 属文件名/目录名专用，出现在 UI 文案即误用）。
 */
const LOCALE_APP_NAME: Record<string, string> = { 'zh-CN': '喵星图', 'zh-TW': '喵星圖' }
const expectedAppName = (locale: string): string => LOCALE_APP_NAME[locale] ?? 'Meow Star Map'

/** 界面可见形态的旧应用名（各语种 + 分享页自称 + 示例签名两词形） */
const OLD_UI_NAMES = [
  '无限暖暖相册管理工具',
  '无限暖暖相册分享',
  '無限暖暖相簿管理工具',
  'My Nikki Gallery'
]

const localeRel = (locale: string): string => `src/renderer/i18n/locales/${locale}.json`

interface AboutBlock {
  settings?: { about?: { appValue?: string } }
  titleBar?: { appTitle?: string }
  main?: { app?: { name?: string } }
  resonance?: { brand?: string }
}

describe('界面自称取新名 —— 渲染层入口标题', () => {
  // OS 窗口标题完全来自 HTML：src/main/app/window-manager.ts:54 的 new BrowserWindow 未传 title，
  // 渲染层也没有任何 document.title 赋值，标题栏的可见文字另由 TitleBar.tsx 走 t('titleBar.appTitle')。
  it('主入口 <title> 为喵星图', () => {
    expect(read('src/renderer/index.html')).toContain('<title>喵星图</title>')
  })

  it('预览入口 <title> 为喵星图 - 预览版', () => {
    expect(read('src/renderer/preview/index.html')).toContain('<title>喵星图 - 预览版</title>')
  })
})

describe('语包软件名值锁（阶段 2 已落地，此处防回归）', () => {
  it.each(LOCALES)('%s 的 settings.about.appValue 与 titleBar.appTitle 取该语种新名', (locale) => {
    const data = readJson<AboutBlock>(localeRel(locale))
    expect(data.settings?.about?.appValue).toBe(expectedAppName(locale))
    expect(data.titleBar?.appTitle).toBe(expectedAppName(locale))
  })

  // 11 个非 zh-CN 包的 main.app.name 本就是空串（阶段 1 §1.2 列为既有缺口，填补属新增功能），
  // 所以只锁 zh-CN：它是 desktop-shortcut.ts:54 写 .lnk 描述时的取值来源。
  it('zh-CN 的 main.app.name 为喵星图', () => {
    expect(readJson<AboutBlock>(localeRel('zh-CN')).main?.app?.name).toBe('喵星图')
  })

  it('12 个语包不含任何旧应用名与旧标识', () => {
    for (const locale of LOCALES) {
      const raw = read(localeRel(locale))
      // expect 的第二参才是失败信息标签，别把它当被测值传进去
      for (const old of OLD_UI_NAMES) expect(raw, `${locale} 残留 ${old}`).not.toContain(old)
      // 品牌标识也不该出现在语包里：出现即说明某条文案把项目名写死了
      for (const token of ['NikkiGallery', 'nikkiGallery', 'WXNN']) {
        expect(raw, `${locale} 残留 ${token}`).not.toContain(token)
      }
    }
  })
})

describe('禁改项未被动 —— 证明更名没有越界', () => {
  const REPO_URL = 'https://github.com/QianQianLuLu1/NikkiGallery'

  it('关于页与更新弹窗的 GitHub URL 逐字保留（仓库尚未改名，动即 404）', () => {
    expect(read('src/renderer/pages/settings/about-sections.tsx')).toContain(
      `const GITHUB_URL = '${REPO_URL}'`
    )
    expect(read('src/renderer/components/common/UpdateDialog.tsx')).toContain(
      `const GITHUB_URL = '${REPO_URL}'`
    )
  })

  it('插件清单磁盘键 nikkiGallery 与类型名 NikkiGalleryManifest 未改名', () => {
    expect(read('plugins-samples/custom-watermark-template/package.json')).toContain(
      '"nikkiGallery"'
    )
    expect(read('src/shared/types/plugin.ts')).toContain('export interface NikkiGalleryManifest')
  })

  it('游戏名与 XMP 线格式保留（无限暖暖是被拍摄的游戏，不是本项目）', () => {
    expect(readJson<AboutBlock>(localeRel('zh-CN')).resonance?.brand).toBe('无限暖暖')
    expect(readJson<AboutBlock>(localeRel('zh-TW')).resonance?.brand).toBe('無限暖暖')
    expect(readJson<AboutBlock>(localeRel('en')).resonance?.brand).toBe('Infinity Nikki')
    const xmp = read('src/main/services/xmp-metadata-service.ts')
    expect(xmp).toContain('http://wxnn.qianlu.com/xmp/1.0/')
  })
})
