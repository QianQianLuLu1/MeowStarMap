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
/** 远端仓库仍未改名，URL 属阶段 1 §1.2 禁改项；本轮多处标签改名都必须以它为准逐字不动 */
const REPO_URL = 'https://github.com/QianQianLuLu1/NikkiGallery'

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

describe('局域网分享页取新名 —— 手机浏览器可见', () => {
  // 分享页由主进程模板字符串直接拼出，不经渲染层 i18n（改走 t() 属逻辑变更，本轮禁止）；
  // <title> 与 <h1> 是同一自称的两处落点，必须同源改，漏一处手机上看就是旧名。
  it('分享页 <title> 与 <h1> 均为喵星图分享', () => {
    const src = read('src/main/services/share-wifi-service.ts')
    expect(src).toContain('<title>喵星图分享</title>')
    expect(src).toContain('<h1>喵星图分享</h1>')
  })

  it('分享页不残留旧自称无限暖暖相册分享', () => {
    expect(read('src/main/services/share-wifi-service.ts')).not.toContain('无限暖暖相册分享')
  })
})

describe('应急启动弹窗取新名 —— i18n 就绪前的原生对话框', () => {
  // 硬编码双语串走 dialog.showErrorBox，此时 i18next 还没初始化，不能改走 t()（属逻辑变更）。
  // 只锁两行文案：同文件 :64 的 NikkiGallery-startup-errors.log 是 %TEMP% 兜底日志名，
  // 与 user-diag-path.ts:12 的诊断目录名同批（阶段 1 的 N2），本轮不碰。
  const src = read('src/main/utils/early-crash-guard.ts')

  it('致命弹窗中英两行取新名', () => {
    expect(src).toContain("'喵星图启动失败，程序已退出。'")
    expect(src).toContain("'Meow Star Map failed to start and has exited.'")
  })

  it('两行文案不再以旧名自称', () => {
    expect(src).not.toContain('NikkiGallery 启动失败')
    expect(src).not.toContain('NikkiGallery failed to start')
  })
})

describe('关于页仓库标签取新名', () => {
  // :75 是 <a> 的纯文本节点（上一行是 title={GITHUB_URL}），同文件 :17/:395/:399 三处 URL 属禁改项，
  // 所以只锁「独占一行的文本」：按行 trim 比对，避免把 URL 里的 NikkiGallery 误判成残留。
  const lines = read('src/renderer/pages/settings/about-sections.tsx')
    .split('\n')
    .map((l) => l.trim())

  it('可见文字为 Meow Star Map，不再有 NikkiGallery 文本节点', () => {
    expect(lines).toContain('Meow Star Map')
    expect(lines).not.toContain('NikkiGallery')
  })

  it('仓库地址三处落点仍在原文件（标签改名未波及 URL：常量、onClick、可见文字）', () => {
    const src = read('src/renderer/pages/settings/about-sections.tsx')
    // :17 与 :395 是完整 https URL，:399 是省略协议的同款文字，按 slug 计数才能一次收全
    expect(src.split('github.com/QianQianLuLu1/NikkiGallery').length - 1).toBe(3)
  })
})

describe('默认内容与示例插件署名取新名', () => {
  // 默认水印文本会直接烧进用户导出的照片，示例插件的签名与水印图则是「复制即用」的样板，
  // 两者都是用户可见的软件自称，但都不在扫描域的老 26 条模式里（© My Nikki Gallery 是两词带空格）。
  const SAMPLE = 'plugins-samples/custom-watermark-template'

  it('两处默认水印配置取 Meow Star Map 且不残留 WXNN Photo', () => {
    for (const rel of [
      'src/renderer/hooks/useWatermark.ts',
      'src/renderer/components/editor/WatermarkPanel.tsx'
    ]) {
      const src = read(rel)
      expect(src, rel).toContain("content: 'Meow Star Map',")
      expect(src, rel).not.toContain('WXNN Photo')
    }
  })

  it('示例插件签名、README 镜像与水印图署名同源取新名', () => {
    expect(read(`${SAMPLE}/index.js`)).toContain("text: '© Meow Star Map',")
    expect(read(`${SAMPLE}/README.md`)).toContain('`© Meow Star Map`')
    expect(read(`${SAMPLE}/templates/festival.svg`)).toContain('★ Meow Star Map ★')
  })

  it('示例插件目录不含任何旧应用名（但磁盘键 nikkiGallery 必须仍在）', () => {
    for (const rel of ['index.js', 'README.md', 'package.json', 'templates/festival.svg']) {
      const src = read(`${SAMPLE}/${rel}`)
      for (const old of ['My Nikki Gallery', 'NikkiGallery', 'WXNN Photo']) {
        expect(src, `${rel} 残留 ${old}`).not.toContain(old)
      }
    }
    expect(read(`${SAMPLE}/package.json`)).toContain('"nikkiGallery"')
  })
})

describe('桌面快捷方式名取新名', () => {
  // 文件名须跨语言稳定，所以保持硬编码（行内 eslint-disable 注释与「非 UI 文案」表述原样不动）；
  // 但它是桌面上用户直接看得见的图标名，按用户决策并入阶段 3。nsis.shortcutName 仍属 N1，本轮分叉入档。
  it('两处 .lnk 文件名取喵星图.lnk，旧中文全名不再出现', () => {
    const src = read('src/main/app/desktop-shortcut.ts')
    expect(src.split("'喵星图.lnk'").length - 1).toBe(2)
    expect(src).not.toContain('无限暖暖相册管理工具')
  })

  it('测试常量与源码同值（锁未被拆半）', () => {
    expect(read('src/main/app/__tests__/desktop-shortcut.test.ts')).toContain(
      "const SHORTCUT_NAME = '喵星图.lnk'"
    )
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
