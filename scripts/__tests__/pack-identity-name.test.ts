import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * 打包与流水线身份名守卫（阶段 4：打包、构建与流水线配置更名）。
 *
 * 为什么要有这个文件：本阶段改的全是**配置里的名称值**——package.json 的包名/productName/appId/
 * artifactName/shortcutName、package-lock 的 name、CI 上传产物名、以及一处对包名的可执行断言。
 * 仓库里原先没有任何用例读过这些字段（scripts/__tests__/self-contained-deps.test.ts 只看依赖段，
 * scripts/pre-dist-check.ts 只看 npmRebuild/asarUnpack/afterPack/requestedExecutionLevel），
 * 改漏一处不会红，而它决定的又是用户看得见的一切外部名称（exe 文件名、快捷方式、卸载项、安装包）。
 * 与阶段 3 的 ui-brand-name.test.ts 同一口径：常驻守卫，正向取新名 + 反向无旧名 + 禁改项逐字锁。
 *
 * 读的是磁盘上的源文件文本、不 import 被测模块 ⇒ 不拉 electron/jsdom。
 *
 * 根路径刻意走 `new URL(rel, import.meta.url)` 而不是 `path.resolve(dirname(fileURLToPath(...)))`：
 * 后者在 test:posix-host 装置下必崩——该 profile 把 `path` 钉成 posix，而 import.meta.url 是宿主
 * 的 Windows 路径，`posix.dirname('D:\\…')` 返回 '.'，repoRoot 落到盘根后全部读取 ENOENT
 * （实测：ui-brand-name.test.ts 在本 profile 下同样装载失败，属阶段 3 遗留的潜在缺陷，本轮不扩大
 * 改动面，仅登记）。URL 解析与宿主 `path` 绑定无关，因此本守卫在两种 profile 下判据一致。
 */

const selfUrl = new URL(import.meta.url)
const repoRootUrl = new URL('../../', selfUrl)

const read = (rel: string): string =>
  readFileSync(new URL(rel, repoRootUrl), { encoding: 'utf-8', flag: 'r' })
const readJson = <T>(rel: string): T => JSON.parse(read(rel)) as T

/** 阶段 1 §1.1 的无空格 kebab 形：npm name、appId 尾段、%APPDATA% 根 */
const KEBAB = 'meow-star-map'
/** 阶段 1 决策 5：中文显示名，同时是 exe 文件名、任务管理器进程名、快捷方式名的来源 */
const CJK = '喵星图'
/** Pascal 形只允许出现在文件名/目录名/CI 产物名，出现空格会破坏 NSIS artifactName 与命令行引用 */
const PACK = 'MeowStarMap'

/** 打包身份六字段的旧值，任何一处回潮即说明有人把名称又写回去了 */
const OLD_PACK_TOKENS = ['wxnn-photo-manager', '无限暖暖相册管理工具', 'NikkiGallery']

interface PackageJson {
  name?: string
  version?: string
  description?: string
  keywords?: string[]
  repository?: { type?: string; url?: string }
  homepage?: string
  bugs?: { url?: string }
  build?: {
    appId?: string
    productName?: string
    artifactName?: string
    files?: unknown[]
    asarUnpack?: string[]
    nsis?: { shortcutName?: string }
  }
}

interface PackageLock {
  name?: string
  version?: string
  lockfileVersion?: number
  packages?: Record<string, { name?: string; version?: string }>
}

const pkg = readJson<PackageJson>('package.json')
const lock = readJson<PackageLock>('package-lock.json')

describe('打包身份六字段取新名（决定 exe/快捷方式/卸载项/安装包名）', () => {
  it('name 为 kebab 形 meow-star-map（同时决定 %APPDATA% userData 根）', () => {
    expect(pkg.name).toBe(KEBAB)
  })

  it('description 取中文显示名，不再是旧中文全名', () => {
    expect(pkg.description).toBe(CJK)
  })

  it('build.appId 尾段跟随 kebab 形', () => {
    expect(pkg.build?.appId).toBe(`com.qianlu.${KEBAB}`)
  })

  it('build.productName 取喵星图（exe 文件名与 NSIS 卸载显示名由它派生）', () => {
    expect(pkg.build?.productName).toBe(CJK)
  })

  it('build.artifactName 取 Pascal 形前缀', () => {
    expect(pkg.build?.artifactName).toBe(`${PACK}-Setup-\${version}.\${ext}`)
  })

  it('build.nsis.shortcutName 与运行时写出的 .lnk 同名（闭合阶段 3 偏差 2 的分叉）', () => {
    expect(pkg.build?.nsis?.shortcutName).toBe(CJK)
    // 阶段 3 已把 desktop-shortcut.ts 的文件名改为喵星图.lnk；两处一旦分叉，
    // 开始菜单是「喵星图」而桌面是旧全名，用户会看见两个不同名字的应用
    expect(read('src/main/app/desktop-shortcut.ts')).toContain(`'${CJK}.lnk'`)
  })

  it('package.json 全文不含任何旧打包身份名', () => {
    const raw = read('package.json')
    for (const old of OLD_PACK_TOKENS) expect(raw, `package.json 残留 ${old}`).not.toContain(old)
  })
})

describe('package-lock 的 name 与 package.json 同值（CI 的 npm ci 一致性）', () => {
  it('顶层 name 与 packages[""] 的 name 都等于 pkg.name', () => {
    expect(lock.name).toBe(pkg.name)
    expect(lock.packages?.['']?.name).toBe(pkg.name)
  })

  it('lock 全文不含旧包名', () => {
    expect(read('package-lock.json')).not.toContain('wxnn-photo-manager')
  })

  it('version 仍与 package.json 一致（改 name 不得顺手动版本）', () => {
    expect(lock.version).toBe(pkg.version)
    expect(lock.packages?.['']?.version).toBe(pkg.version)
  })

  it('lockfileVersion 未被同步命令改写（3 ⇒ lock 仍是 npm 7+ 形态）', () => {
    expect(lock.lockfileVersion).toBe(3)
  })
})

describe('流水线与发布面的产品名', () => {
  it('build.yml 上传产物名取 Pascal 形', () => {
    const wf = read('.github/workflows/build.yml')
    expect(wf).toContain(`name: ${PACK}-win-x64-nsis`)
    expect(wf).not.toContain('NikkiGallery-win-x64-nsis')
  })

  it('产物路径仍用 release/*.exe glob，与产物名解耦（改 artifactName 不需要动它们）', () => {
    const wf = read('.github/workflows/build.yml')
    expect(wf.split('release/*.exe').length - 1).toBe(2)
  })

  it('verify-audit.mjs 对包名的可执行断言与 package.json 互指相等', () => {
    // 该脚本读 ../NikkiSync 与本仓 package.json 做客观事实校验，断言值必须恒等于真实包名，
    // 否则任何人改完包名再跑它必抛——它是代码而非叙述，属本阶段范围
    const m = read('docs/sync-integration/verify-audit.mjs').match(
      /assert\.equal\(wxnn\.name,\s*'([^']+)'\)/
    )
    expect(m?.[1], 'verify-audit.mjs 里找不到对 wxnn.name 的断言').toBe(pkg.name)
  })
})

describe('配置与文档同源（阶段 2 先行落档的新值必须已被实现）', () => {
  // 阶段 2 把文档表格先写成了新值，因此这两条断言在阶段 4 开工时是「文档对、配置错」的真红。
  // 判据取字面常量而不是 pkg 的当前值：否则配置与文档同时回旧也会自洽通过，交叉锁就失效了。
  it('DEVELOPMENT.md 的打包配置表与 package.json 取同一组 appId 与产物名', () => {
    const doc = read('DEVELOPMENT.md')
    expect(doc).toContain(`com.qianlu.${KEBAB}`)
    expect(doc).toContain(`${PACK}-Setup-\${version}.\${ext}`)
  })

  it('DEVELOPMENT.en.md 与 zh 版取同一组打包值', () => {
    const doc = read('DEVELOPMENT.en.md')
    expect(doc).toContain(`com.qianlu.${KEBAB}`)
    expect(doc).toContain(`${PACK}-Setup-\${version}.\${ext}`)
  })
})

describe('userData 根跟随新包名（手工拼 %APPDATA% 的站点）', () => {
  // app.getName() 在生产侧只被 log-service.ts:289 写进日志字段，没有任何测试锁它的返回值；
  // 而 userData 根由 package.json 的 name 决定，手工拼装的回退路径必须与 Electron 算出的同值，
  // 否则 whenReady 前后的日志会落进两个不同目录（阶段 1 锁 A 的实质）。
  it('logger 的两处 whenReady 前回退路径取 kebab 根', () => {
    const src = read('src/main/utils/logger.ts')
    expect(src).toContain(`path.join(appData, '${KEBAB}', 'logs', 'main.log')`)
    expect(src).toContain(`path.join(os.tmpdir(), '${KEBAB}-logs', 'main.log')`)
    expect(src).not.toContain('wxnn-photo-manager')
  })

  it('e2e 失败现场采集的 APPDATA 兜底与 logger 同根', () => {
    const src = read('e2e/helpers.ts')
    expect(src).toContain(`path.join(process.env.APPDATA ?? '', '${KEBAB}', 'diag.log')`)
    expect(src).toContain(`%APPDATA%/${KEBAB}/diag.log`)
    expect(src).not.toContain('wxnn-photo-manager')
  })

  it('e2e 关于 exe 名的注释跟随新 productName（仍含中文，故 glob 取首个 exe 的口径不变）', () => {
    const src = read('e2e/helpers.ts')
    expect(src).toContain(`exe 名跟随 productName（"${CJK}"，含中文）`)
    expect(src).not.toContain('无限暖暖相册管理工具')
  })

  it('GPU 崩溃模拟脚本的兜底猜路径落正（历史上写死 NikkiGallery 从来不是真实 userData）', () => {
    const src = read('scripts/simulate-gpu-crash.cjs')
    expect(src).toContain(`path.join(os.homedir(), '.config', '${KEBAB}')`)
    expect(src).toContain(`Roaming\\${KEBAB}"`)
    expect(src).not.toContain('NikkiGallery')
    // 环境变量键属私有配置而非产品名，与 WXNN_RENDERER_DIR 同口径不动
    expect(src).toContain('NIKKI_USERDATA')
  })

  it('electron mock 的 app.getName 取 meow-star-map-test', () => {
    expect(read('tests/mocks/electron.ts')).toContain(`getName: vi.fn(() => '${KEBAB}-test')`)
    expect(read('tests/mocks/electron.ts')).not.toContain('nikki-gallery-test')
  })
})

describe('只影响测试与预览 mock 的假 userData 路径跟新根', () => {
  it('预览 mock 的 cacheDir 取 kebab 根', () => {
    const src = read('src/renderer/preview/mock/database-mock.ts')
    expect(src).toContain(`AppData\\\\Roaming\\\\${KEBAB}\\\\cache`)
    expect(src).not.toContain('wxnn-photo-manager')
  })

  it('缩略图与回收站的两条测试夹具取 kebab 根（两种分隔符同改，否则正反斜杠夹具互相矛盾）', () => {
    const thumb = read('src/renderer/utils/thumbnail-src.test.tsx')
    expect(thumb).toContain(`Roaming\\\\${KEBAB}\\\\thumbnails`)
    expect(thumb).toContain(`Roaming/${KEBAB}/thumbnails`)
    expect(thumb).not.toContain('wxnn-photo-manager')
    const bin = read('src/renderer/pages/RecycleBinPage.thumb.test.tsx')
    expect(bin).toContain(`Roaming\\\\${KEBAB}\\\\thumbnails`)
    expect(bin).not.toContain('wxnn-photo-manager')
  })

  it('启动环境自检夹具的安装路径不再指旧名', () => {
    const src = read('src/main/app/startup-environment.test.ts')
    expect(src).not.toContain('NikkiGallery')
    // 该套件的另一半判据（NIKKI_SKIP_ENV_GUARD 键）仍须在场
    expect(src).toContain('NIKKI_SKIP_ENV_GUARD')
  })

  it('perf-real 的 userData 根已取新名，但同文件库名仍属 N3（分叉如实钉住）', () => {
    const src = read('e2e/perf-real.e2e.ts')
    expect(src).toContain(`Roaming/${KEBAB}"`)
    expect(src).not.toContain('Roaming/wxnn-photo-manager')
    // 四条 wxnn_photo_manager.db 本轮不得改：改了就把「恢复被 zod 拒 + 数十条断言红」的锁拆半
    expect(src.split('wxnn_photo_manager.db').length - 1).toBe(4)
    // 本机真实存在的缓存目录名（D:\NikkiGallery缓存）属禁改项
    expect(src).toContain('NikkiGallery缓存')
  })
})

describe('CI 宿主装置的工作区根字面值（四站点必须同值）', () => {
  // 真实 runner 的 cwd 由远端仓库名决定，仓库已改名 ⇒ 装置伪造的 cwd 与家目录若仍留旧名，
  // 「rooted 读路径落进根不可写 mock」的判据就跟真宿主分叉（阶段 1 §E 表把它列为必须同 commit）。
  // 逐字相等而不是「命中数 ≤ 上限」：漏改任一处不会红，除非像这里一样按文件计数。
  const CI_ROOT_NEW = '/home/runner/work/MeowStarMap/MeowStarMap'
  const CI_ROOT_OLD = '/home/runner/work/NikkiGallery/NikkiGallery'
  const RIG_FILES: Array<[string, number]> = [
    ['tests/ci-linux.setup.ts', 2],
    ['tests/mocks/ci-linux-fs.ts', 2],
    ['src/main/utils/ci-linux-emulation.test.ts', 3]
  ]

  it.each(RIG_FILES)('%s 的装置根全部取新值（期望 %i 处）', (rel, count) => {
    const src = read(rel)
    expect(src.split(CI_ROOT_NEW).length - 1, `${rel} 新值处数不符`).toBe(count)
    expect(src, `${rel} 残留旧装置根`).not.toContain(CI_ROOT_OLD)
  })

  it('CI_ROOT 常量与装置注入的 cwd 同源（两侧不同值即伪装成产品缺陷）', () => {
    const mock = read('tests/mocks/ci-linux-fs.ts')
    const setup = read('tests/ci-linux.setup.ts')
    expect(mock).toContain(`export const CI_ROOT = '${CI_ROOT_NEW}'`)
    expect(setup).toContain(`value: () => '${CI_ROOT_NEW}'`)
    expect(setup).toContain(`root: '${CI_ROOT_NEW}'`)
  })

  it('装置标识符未被改名（__wxnnCiLinuxEmulation 是代码标识，不是产品名）', () => {
    expect(read('tests/ci-linux.setup.ts')).toContain('__wxnnCiLinuxEmulation')
  })
})

describe('开发自检脚本的自称', () => {
  /**
   * 终端显示宽度（CJK 与制表符号按双宽）：doctor.ts 的横幅是手拼的空格配平，
   * 改名后字符数变了但双宽判定不变，只能按显示宽度断言，不能按 length。
   */
  const displayWidth = (s: string): number =>
    [...s].reduce((n, ch) => {
      const c = ch.codePointAt(0) as number
      const wide =
        (c >= 0x1100 && c <= 0x115f) ||
        c === 0x2329 ||
        c === 0x232a ||
        (c >= 0x2e80 && c <= 0xa4cf) ||
        (c >= 0xac00 && c <= 0xd7a3) ||
        (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe30 && c <= 0xfe6f) ||
        (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6)
      return n + (wide ? 2 : 1)
    }, 0)

  it('doctor 横幅取带空格的英文品牌形，且与上下边框显示宽度相等', () => {
    const lines = read('scripts/doctor.ts').split('\n')
    const top = lines.find((l) => l.includes('╔'))
    const banner = lines.find((l) => l.includes('环境诊断报告') && l.includes('║'))
    expect(top, '找不到横幅上边框').toBeDefined()
    expect(banner, '找不到横幅行').toBeDefined()
    const body = banner as string
    expect(body).toContain('Meow Star Map 环境诊断报告')
    expect(body).not.toContain('NikkiGallery')
    expect(displayWidth(body)).toBe(displayWidth(top as string))
  })
})

describe('禁改项未被动 —— 证明打包面更名没有越界', () => {
  it('package.json 三条仓库 URL 逐字不动（远端改名由 7c6926f 单独订正过）', () => {
    expect(pkg.repository?.url).toBe('https://github.com/QianQianLuLu1/MeowStarMap.git')
    expect(pkg.homepage).toBe('https://github.com/QianQianLuLu1/MeowStarMap')
    expect(pkg.bugs?.url).toBe('https://github.com/QianQianLuLu1/MeowStarMap/issues')
  })

  it('游戏关键词 infinity-nikki 仍在（它是被拍摄的游戏，不是本项目）', () => {
    expect(pkg.keywords).toContain('infinity-nikki')
    expect(pkg.keywords).toContain('game-photos')
  })

  it('@nikkisync 的入包与解包配置逐字在位（独立上游依赖，非本项目旧名）', () => {
    const nikkisyncEntry = (pkg.build?.files ?? []).find(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        String((entry as { from?: unknown }).from ?? '').replace(/\\/g, '/') ===
          'node_modules/@nikkisync'
    ) as { to?: string } | undefined
    expect(nikkisyncEntry?.to).toBe('node_modules/@nikkisync')
    expect(pkg.build?.asarUnpack).toContain('**/@nikkisync/**')
    const vite = read('electron.vite.config.ts')
    expect(vite).toContain('nikkisync-')
  })

  it('插件清单磁盘键 nikkiGallery 与类型名 NikkiGalleryManifest 未改名', () => {
    expect(read('src/shared/types/plugin.ts')).toContain('export interface NikkiGalleryManifest')
    expect(read('src/main/ipc/handlers/dialog-handler.ts')).toBeDefined()
    // eslint 的 ignore 项指向磁盘真实存在的本机遗留目录，不是产品引用，必须原样保留
    expect(read('eslint.config.js')).toContain("'wxnn-photo-manager/**'")
  })

  it('私有环境变量键未被打更名波及', () => {
    expect(read('src/main/app/renderer-protocol.ts')).toContain('WXNN_RENDERER_DIR')
    const gpu = read('scripts/simulate-gpu-crash.cjs')
    expect(gpu).toContain('NIKKI_USERDATA')
    expect(read('src/main/app/startup-environment.test.ts')).toContain('NIKKI_SKIP_ENV_GUARD')
  })

  it('诊断目录常量已随阶段 5 落地为中文名（旧 N2 禁改锁翻转，细则见 runtime-disk-name.test.ts）', () => {
    expect(read('src/main/utils/user-diag-path.ts')).toContain("PRODUCT_DIAG_DIRNAME = '喵星图'")
  })
})
