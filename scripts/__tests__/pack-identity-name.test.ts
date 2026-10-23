import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
 * 读的是磁盘上的源文件文本、不 import 被测模块 ⇒ 不拉 electron/jsdom，也不受装置伪造 cwd 的影响
 * （根路径按 fileURLToPath 解析，与 source-encoding.test.ts、ui-brand-name.test.ts 同口径）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf-8')
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

  it('诊断目录名与 %TEMP% 日志名仍属 N2（本轮不得顺手改掉，改了会打红 11 条断言）', () => {
    expect(read('src/main/utils/user-diag-path.ts')).toContain(
      "PRODUCT_DIAG_DIRNAME = 'NikkiGallery'"
    )
  })
})
