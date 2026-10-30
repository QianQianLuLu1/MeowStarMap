import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'path'
import { fileURLToPath } from 'url'
import {
  MAIN_MARKER_SCOPE,
  treeContainsMarker,
  dirContains,
  nikkiSyncPackedVerdict,
  nikkiSyncMissingDiagnosis,
  missingPackedCapabilityArtifacts,
  artifactBannedStrings,
  scanBufferForBanned,
  resolveVerifyAsarTarget,
  type JsTreeFile
} from '../pre-dist-check'
import {
  CHAIN_REQUIRED_ARTIFACTS,
  METADATA_REQUIRED_ARTIFACTS,
  NIKKISYNC_CAPABILITY_ARTIFACTS,
  SYNC_SERVER_REQUIRED_ARTIFACTS
} from '../verify-nikkisync-link'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const DIST_MAIN = path.join(ROOT, 'dist', 'main', 'main')

/**
 * pre-dist-check 单测：产物修复点标记（第 4/5 项）的检索作用域。
 *
 * 回归背景：断言曾只检索 `dist/main/main/app`。但 main 产物由两套构建器写同一棵树——
 * electron-vite 把 rollup chunk 落在 `app/`（见 electron.vite.config.ts 的 main.outDir），
 * 而 `tsc -b`（.husky/pre-commit 与 npm run verify 都会跑）会把 `app/` 下的同名 chunk
 * 覆盖成 per-file 产物，其依赖模块（含 `.min(0)` 等标记）落在 `app/` 之外。
 * 于是标记随构建顺序漂移，第 4 项反复无谓转红，阻断 npm run dist:win。
 *
 * 覆盖三类：
 *   正常 — rollup 多 chunk 布局与 tsc per-file 布局两种产物形态都必须命中标记
 *   异常 — 标记全树不存在 / 空树 / 目录缺失一律 false（放宽作用域不等于弱化断言）
 *   边界 — 路径分隔符归一、同名前缀兄弟目录不得误命中；结构契约钉住作用域覆盖产物树、且 tsc emit 落在产物树之外
 *
 * 一律注入虚拟文件树：dist/ 被 gitignore，CI 上不存在，且其布局取决于构建顺序。
 */

const MARKER = '.min(0)'

/** electron-vite 单独构建后的布局：标记在 app/ 下的 rollup chunk 里 */
const ROLLUP_LAYOUT: JsTreeFile[] = [
  {
    path: path.join(DIST_MAIN, 'app', 'index.js'),
    content: 'const app = require("./application.js")'
  },
  {
    path: path.join(DIST_MAIN, 'app', 'application.js'),
    content: 'page: zod_1.number().int().min(0).optional(),'
  }
]

/** tsc -b 覆盖 app/application.js 之后的布局：标记被推到 app/ 之外的依赖模块里 */
const TSC_PERFILE_LAYOUT: JsTreeFile[] = [
  {
    path: path.join(DIST_MAIN, 'app', 'application.js'),
    content: 'const media_handler_1 = require("../ipc/handlers/media-handler.js")'
  },
  {
    path: path.join(DIST_MAIN, 'ipc', 'handlers', 'media-handler.js'),
    content: 'page: zod_1.number().int().min(0).optional(),'
  }
]

/** 标记在整棵 main 树里都不存在（真过时的产物形态） */
const NO_MARKER_LAYOUT: JsTreeFile[] = [
  { path: path.join(DIST_MAIN, 'app', 'application.js'), content: 'page: zod_1.number().int()' },
  { path: path.join(DIST_MAIN, 'ipc', 'validator.js'), content: 'exports.schemas = {}' }
]

describe('treeContainsMarker — 正常：两种产物布局都必须命中标记', () => {
  it('rollup 多 chunk 布局：标记在 app/ 内 → 命中', () => {
    expect(treeContainsMarker(MAIN_MARKER_SCOPE, ROLLUP_LAYOUT, MARKER)).toBe(true)
  })

  it('回归：tsc per-file 布局：标记落在 app/ 之外 → 仍须命中', () => {
    expect(treeContainsMarker(MAIN_MARKER_SCOPE, TSC_PERFILE_LAYOUT, MARKER)).toBe(true)
  })
})

describe('treeContainsMarker — 异常：不得因放宽作用域而造假绿', () => {
  it('标记在整棵树都不存在 → false', () => {
    expect(treeContainsMarker(MAIN_MARKER_SCOPE, NO_MARKER_LAYOUT, MARKER)).toBe(false)
  })

  it('空树（产物目录为空/未构建）→ false', () => {
    expect(treeContainsMarker(MAIN_MARKER_SCOPE, [], MARKER)).toBe(false)
  })

  it('非 .js 产物含标记 → 不命中（只检索 js 产物）', () => {
    const files: JsTreeFile[] = [
      { path: path.join(DIST_MAIN, 'app', 'application.js.map'), content: `x ${MARKER} x` }
    ]
    expect(treeContainsMarker(MAIN_MARKER_SCOPE, files, MARKER)).toBe(false)
  })
})

describe('treeContainsMarker — 边界：路径归一与作用域前缀', () => {
  it('反斜杠产物路径与 posix 作用域混用 → 仍命中', () => {
    const files: JsTreeFile[] = [
      { path: 'D:\\p\\dist\\main\\main\\ipc\\validator.js', content: `a ${MARKER} b` }
    ]
    expect(treeContainsMarker('D:/p/dist/main/main', files, MARKER)).toBe(true)
  })

  it('同名前缀的兄弟目录不得误命中（main 与 mainx）', () => {
    const files: JsTreeFile[] = [{ path: 'D:/p/dist/main/mainx/a.js', content: `a ${MARKER} b` }]
    expect(treeContainsMarker('D:/p/dist/main/main', files, MARKER)).toBe(false)
  })

  it('作用域尾部多余分隔符不影响判定', () => {
    const files: JsTreeFile[] = [
      { path: path.join(DIST_MAIN, 'ipc', 'validator.js'), content: `a ${MARKER} b` }
    ]
    expect(treeContainsMarker(MAIN_MARKER_SCOPE + path.sep, files, MARKER)).toBe(true)
  })
})

describe('dirContains — 磁盘适配器的 fail-safe 语义', () => {
  it('目录不存在 → false 且不抛错', () => {
    expect(dirContains(path.join(DIST_MAIN, 'no-such-dir-for-test'), MARKER)).toBe(false)
  })
})

describe('nikkiSyncPackedVerdict — 打包态 @nikkisync 缺失判定', () => {
  it('正常：产物里已有 @nikkisync ⇒ 进入逐项断言', () => {
    expect(
      nikkiSyncPackedVerdict({ packedNikkiSyncExists: true, projectNikkiSyncLinkExists: true })
    ).toBe('assert')
  })

  it('异常：项目已建链但产物没带上 ⇒ fail（防静默回归）', () => {
    // 回归背景：2026-10-15 实测 electron-builder 对根 node_modules 有硬排除，
    // build.files 的字符串模式 node_modules/@nikkisync/**/* 永不命中；彼时本项
    // 输出 SKIP 放行，导致安装包缺整个内嵌运行时。已建链而产物缺失必须是失败。
    expect(
      nikkiSyncPackedVerdict({ packedNikkiSyncExists: false, projectNikkiSyncLinkExists: true })
    ).toBe('fail')
  })

  it('边界：项目未建链（CI 只 checkout 本仓）⇒ skip，不把环境缺失伪装成失败', () => {
    expect(
      nikkiSyncPackedVerdict({ packedNikkiSyncExists: false, projectNikkiSyncLinkExists: false })
    ).toBe('skip')
  })
})

describe('nikkiSyncMissingDiagnosis — @nikkisync 缺失的原因分档', () => {
  // 回归背景（2026-10-23 实测）：`npm install` 会按锁文件收敛 node_modules，把
  // `npm run link:nikkisync` 建的 4 条 junction 一并清掉，只留一个**空的**
  // `node_modules/@nikkisync` scope 目录。彼时本项仍判「已建链 ⇒ fail」（语义正确：
  // 缺整个内嵌运行时的包不许发布），但文案把矛头指向 build.files，而对象式 from/to
  // 入包项一直是对的（由 self-contained-deps.test.ts 钉住），诊断因此误导排查方向。
  const BUILD_FILES_MSG =
    '@nikkisync 已建链但未随包：build.files 的 node_modules/@nikkisync 入包项失效' +
    '（electron-builder 硬排除根 node_modules，须用对象式 from/to 显式拷贝）；' +
    '修复 package.json build.files 后重新执行 electron-builder'

  it('正常：scope 目录仍有 4 个包 ⇒ 沿用 build.files 入包项失效文案（逐字不变）', () => {
    expect(nikkiSyncMissingDiagnosis({ scopeDirExists: true, scopeEntryCount: 4 })).toBe(
      BUILD_FILES_MSG
    )
  })

  it('异常：scope 目录被 npm install 清空 ⇒ 指向 npm run link:nikkisync，且不再误指 build.files', () => {
    const msg = nikkiSyncMissingDiagnosis({ scopeDirExists: true, scopeEntryCount: 0 })
    expect(msg).toContain('npm run link:nikkisync')
    expect(msg).toContain('npm run verify:nikkisync')
    expect(msg).not.toContain('build.files')
  })

  it('边界：scope 目录只剩 1 个包（半个链）⇒ 仍按打包回归走 build.files 文案', () => {
    expect(nikkiSyncMissingDiagnosis({ scopeDirExists: true, scopeEntryCount: 1 })).toContain(
      'build.files'
    )
  })
})

describe('missingPackedCapabilityArtifacts — 能力深入口产物断言核（兼容层 C2-3）', () => {
  it('正常：解包树内 7 项能力产物全存在 → 空清单（逐项断言全过）', () => {
    expect(missingPackedCapabilityArtifacts(NIKKISYNC_CAPABILITY_ARTIFACTS, () => true)).toEqual([])
  })

  it('异常：缺 DeletionQueue.js → 清单点名缺项（fail 消息取自该清单）', () => {
    const missing = missingPackedCapabilityArtifacts(
      NIKKISYNC_CAPABILITY_ARTIFACTS,
      (relative) => !relative.includes('DeletionQueue.js')
    )
    expect(missing).toHaveLength(1)
    expect(missing[0]).toContain('DeletionQueue.js')
  })

  it('边界：清单为空 → 空清单，不误报（未消费能力面时不造断言）', () => {
    expect(missingPackedCapabilityArtifacts([], () => false)).toEqual([])
  })
})

describe('missingPackedCapabilityArtifacts — 装载链传递依赖断言核（上游 b397e0e 同步）', () => {
  it('正常：解包树内 3 项链上产物全存在 → 空清单（复用同一判定核，不另写一份）', () => {
    expect(missingPackedCapabilityArtifacts(CHAIN_REQUIRED_ARTIFACTS, () => true)).toEqual([])
  })

  it('异常：缺 MediaFingerprint.js → 清单点名（row-mappers.js 装载即 ERR_MODULE_NOT_FOUND）', () => {
    const missing = missingPackedCapabilityArtifacts(
      CHAIN_REQUIRED_ARTIFACTS,
      (relative) => !relative.includes('MediaFingerprint.js')
    )
    expect(missing).toHaveLength(1)
    expect(missing[0]).toContain('MediaFingerprint.js')
  })

  it('边界：链上清单与能力清单不重叠（同一产物不被两张表重复点名）', () => {
    const overlap = CHAIN_REQUIRED_ARTIFACTS.filter((item) =>
      NIKKISYNC_CAPABILITY_ARTIFACTS.includes(item)
    )
    expect(overlap).toEqual([])
  })
})

describe('结构契约：标记作用域覆盖产物树，且类型检查 emit 必须在外', () => {
  /** 从已跟踪的 src/main/tsconfig.json 推导 tsc 对 src/main/** 的产出根 */
  function resolveTscMainRoot(): string {
    const tsconfigPath = path.join(ROOT, 'src', 'main', 'tsconfig.json')
    const raw = JSON.parse(readFileSync(tsconfigPath, 'utf-8')) as {
      compilerOptions?: { outDir?: string; rootDir?: string }
    }
    const baseDir = path.dirname(tsconfigPath)
    const outDir = path.resolve(baseDir, raw.compilerOptions?.outDir ?? '')
    const rootDir = path.resolve(baseDir, raw.compilerOptions?.rootDir ?? '')
    const srcMainRel = path.relative(rootDir, path.join(ROOT, 'src', 'main'))
    return path.resolve(outDir, srcMainRel)
  }

  const tscMainRoot = resolveTscMainRoot()

  // 2026-10-19 起的不变量（docs/plans/2026-10-19-fix-e2e-smoke-dist-pollution.md）：
  // tsc 的产出根一旦落回 dist/main，就会把 electron-vite 的 bundle 覆写成 per-file CJS，
  // 使 sandbox preload 桥与 @nikkisync 的变量式 import 同时失效。原用例断言的是覆写态，
  // 现改为断言隔离态——它仍是「读真实 tsconfig 推导落点」，前提自证的方式不变。
  it('tsc 的 main 落点必须落在产物树之外（本用例的前提自证）', () => {
    expect(tscMainRoot.startsWith(DIST_MAIN + path.sep)).toBe(false)
    expect(tscMainRoot).not.toBe(DIST_MAIN)
  })

  it('标记作用域仍须覆盖产物树内所有 .js（tsc 产物已不在其中，收窄回 app/ 依然禁止）', () => {
    expect(treeContainsMarker(MAIN_MARKER_SCOPE, ROLLUP_LAYOUT, MARKER)).toBe(true)
    expect(MAIN_MARKER_SCOPE).toBe(DIST_MAIN)
  })
})

// ===== 产物内容禁串闸门（--verify-asar 的第 3 步）=====
// 回归背景：2026-10-23 16:01 那个安装包出厂时「源码已改、包未重建」，app.asar 里仍含 4 处旧仓库链接
// 与 24 处失效 issues 占位，而 npm test 全绿——旧名守卫的扫描域按设计排除 dist 与 release，
// --verify-asar 又只看原生二进制与清单，两侧都管不到产物内容。本组用例锁住补上的三个纯函数判据。
// 禁串一律用合成 token：scripts/ 在旧名台账的 roots 里，把真实旧名写进 .ts 会立刻让该守卫转红
// （未登记文件 + 总数漂移），所以清单的唯一出处是台账 JSON（它在 skipPaths 内，允许出现旧名）。

const OWNER = 'someone'
const LEGACY_URL = `github.com/${OWNER}/LegacyName`

describe('artifactBannedStrings：由台账 patterns 派生产物禁串', () => {
  it('正常：逐条拼 owner 命名空间下的仓库 URL，再并入显式占位禁串', () => {
    expect(artifactBannedStrings(['LegacyName', 'legacy_name'], OWNER, ['placeholder/x'])).toEqual([
      `github.com/${OWNER}/LegacyName`,
      `github.com/${OWNER}/legacy_name`,
      'placeholder/x'
    ])
  })

  it('异常：owner 为空只返回 extra；空白项与非字符串一律剔除', () => {
    expect(artifactBannedStrings(['A', '', '   '], '', ['B'])).toEqual(['B'])
    expect(
      artifactBannedStrings([undefined as unknown as string], OWNER, [
        null as unknown as string,
        ''
      ])
    ).toEqual([])
  })

  it('边界：派生 URL 与 extra 同形时去重，同一条串不判两遍', () => {
    expect(artifactBannedStrings(['Dup'], OWNER, [`github.com/${OWNER}/Dup`])).toEqual([
      `github.com/${OWNER}/Dup`
    ])
  })

  it('边界：owner 两侧空白被修剪，不产出 github.com/ 空格形态的死禁串', () => {
    expect(artifactBannedStrings(['P'], `  ${OWNER}  `, [])).toEqual([`github.com/${OWNER}/P`])
  })
})

describe('scanBufferForBanned：产物字节流的字面量计数', () => {
  it('正常：同一禁串多次出现逐次累加（与 grep -a 计数同义）', () => {
    const bytes = Buffer.from(`x ${LEGACY_URL} y ${LEGACY_URL} z`, 'utf8')
    expect(scanBufferForBanned(bytes, [LEGACY_URL])).toEqual([{ needle: LEGACY_URL, count: 2 }])
  })

  it('正常：零命中返回空数组——这是闸门放行的唯一形状', () => {
    expect(scanBufferForBanned(Buffer.from('clean bundle', 'utf8'), ['nothing'])).toEqual([])
  })

  it('异常：禁串清单为空与 Buffer 为空一律 []，不得判成「全命中」', () => {
    expect(scanBufferForBanned(Buffer.from('anything', 'utf8'), [])).toEqual([])
    expect(scanBufferForBanned(Buffer.alloc(0), ['whatever'])).toEqual([])
  })

  it('边界：按字面量匹配而非正则——needle 里的点号不得当通配符（否则合法 URL 会被误杀）', () => {
    expect(scanBufferForBanned(Buffer.from('abc and a.c', 'utf8'), ['a.c'])).toEqual([
      { needle: 'a.c', count: 1 }
    ])
    expect(scanBufferForBanned(Buffer.from('abc', 'utf8'), ['a.c'])).toEqual([])
  })

  it('边界：非重叠计数，且多类命中按次数降序（失败信息先点名最重的一类）', () => {
    const hits = scanBufferForBanned(Buffer.from('AAAA aaa', 'utf8'), ['AAAA', 'AA', 'aaa'])
    expect(hits.map((h) => h.count)).toEqual([2, 1, 1])
    expect(hits[0].needle).toBe('AA')
  })

  it('边界：CJK 禁串走 utf8 匹配（12 语包的群号串是中文）', () => {
    const bytes = Buffer.from('提示：测试群: 000111 已复制', 'utf8')
    expect(scanBufferForBanned(bytes, ['测试群: 000111'])).toEqual([
      { needle: '测试群: 000111', count: 1 }
    ])
  })
})

describe('resolveVerifyAsarTarget：待审 app.asar 的选取', () => {
  const releaseDir = path.join(ROOT, 'release')

  it('异常：--asar= 空值判非法，不静默回落到默认路径', () => {
    const r = resolveVerifyAsarTarget(['--asar='], releaseDir)
    expect(r.asarPath).toBeNull()
    expect(r.reason).toContain('--asar')
  })

  it('异常：显式指向 *.tmp 解压中途目录一律拒绝（残壳不是产物）', () => {
    const r = resolveVerifyAsarTarget(
      ['--asar=release/win-unpacked.tmp/resources/app.asar'],
      releaseDir
    )
    expect(r.asarPath).toBeNull()
    expect(r.reason).toContain('中途')
  })

  it('异常：目标不存在时给出 reason 供上层 fail-closed，而不是当无事发生', () => {
    const r = resolveVerifyAsarTarget(['--asar=release/definitely-not-here/app.asar'], releaseDir)
    expect(r.asarPath).toBeNull()
    expect(r.reason.length).toBeGreaterThan(0)
  })

  // 真 IO 落临时目录：产物树布局是被测判据的一部分，注入虚拟路径等于没测 existsSync 那一支
  it('正常：默认取 release/win-unpacked/resources/app.asar；--asar 相对路径按仓库根解析', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'pdc-asar-'))
    try {
      const tmpRelease = path.join(tmp, 'release')
      const asar = path.join(tmpRelease, 'win-unpacked', 'resources', 'app.asar')
      mkdirSync(path.dirname(asar), { recursive: true })
      writeFileSync(asar, 'fake asar bytes', 'utf8')
      expect(resolveVerifyAsarTarget([], tmpRelease).asarPath).toBe(asar)
      expect(
        resolveVerifyAsarTarget(
          [`--asar=${path.join('release', 'win-unpacked', 'resources', 'app.asar')}`],
          tmpRelease
        ).asarPath
      ).toBe(asar)
      expect(resolveVerifyAsarTarget([`--asar=${asar}`], tmpRelease).asarPath).toBe(asar)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('边界：默认路径缺失但另有陈旧树时仍返回 null——宁可红也不在陈旧树上假绿', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'pdc-stale-'))
    try {
      const tmpRelease = path.join(tmp, 'release')
      mkdirSync(path.join(tmpRelease, 'win-unpacked-old', 'resources'), { recursive: true })
      writeFileSync(path.join(tmpRelease, 'win-unpacked-old', 'resources', 'app.asar'), 'x', 'utf8')
      const r = resolveVerifyAsarTarget([], tmpRelease)
      expect(r.asarPath).toBeNull()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('台账是禁串清单的唯一出处（闸门自身不得自带旧名）', () => {
  const ledgerPath = path.join(ROOT, 'scripts', '__tests__', 'old-name-ledger.json')
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
    patterns?: string[]
    artifactBanned?: { owner?: string; extra?: string[] }
  }

  it('artifactBanned.owner 与 extra 就位，patterns 非空', () => {
    expect((ledger.artifactBanned?.owner ?? '').trim().length).toBeGreaterThan(0)
    expect((ledger.artifactBanned?.extra ?? []).length).toBeGreaterThan(0)
    expect((ledger.patterns ?? []).length).toBeGreaterThan(0)
  })

  it('派生清单必须真的含 owner 命名空间下的 URL 形态，否则闸门等于无判据', () => {
    const banned = artifactBannedStrings(
      ledger.patterns ?? [],
      ledger.artifactBanned?.owner ?? '',
      ledger.artifactBanned?.extra ?? []
    )
    expect(banned.length).toBe(
      (ledger.patterns ?? []).length + (ledger.artifactBanned?.extra ?? []).length
    )
    expect(
      banned.filter((s) => s.startsWith(`github.com/${ledger.artifactBanned?.owner}/`)).length
    ).toBe((ledger.patterns ?? []).length)
  })
})

// ===== 打包态产物清单覆盖面（M3）=====
// 回归背景：开发态 verify:nikkisync 对 SYNC_SERVER/METADATA/CAPABILITY/CHAIN 四组清单逐一
// fs.existsSync，打包态 pre-dist-check 却把同步服务器两项硬编码、METADATA 直接漏掉 —— 同一张
// 真相源在两种宿主下覆盖面漂移。缺件只会在运行期 ERR_MODULE_NOT_FOUND，闸门先红才拦得住。
// 前两条是「接线契约」：读真实 pre-dist-check.ts 源码文本断言它确已复用两组清单（纯函数核对任意
// 清单恒绿，证明不了接线发生，故必须锚源码）；第三条验行为：缺件时两组各自点名。
describe('打包态产物清单覆盖面：SYNC_SERVER + METADATA 两组复用同一真相源（M3）', () => {
  const pdcSource = readFileSync(path.join(ROOT, 'scripts', 'pre-dist-check.ts'), 'utf-8')

  it('接线契约：pre-dist-check.ts 须对 SYNC_SERVER 清单做打包态断言（修复前必红）', () => {
    expect(pdcSource).toMatch(/missingPackedCapabilityArtifacts\(\s*SYNC_SERVER_REQUIRED_ARTIFACTS/)
  })

  it('接线契约：pre-dist-check.ts 须对 METADATA 清单做打包态断言（修复前必红）', () => {
    expect(pdcSource).toMatch(/missingPackedCapabilityArtifacts\(\s*METADATA_REQUIRED_ARTIFACTS/)
  })

  it('单一真相源：两组常量须从 verify-nikkisync-link import，不得本地硬编码（修复前必红）', () => {
    const importBlock = pdcSource.match(/import\s*\{[^}]*\}\s*from\s*'\.\/verify-nikkisync-link'/s)
    expect(importBlock, '前置：须存在从 verify-nikkisync-link 的 import').not.toBeNull()
    expect(importBlock?.[0]).toContain('SYNC_SERVER_REQUIRED_ARTIFACTS')
    expect(importBlock?.[0]).toContain('METADATA_REQUIRED_ARTIFACTS')
  })

  it('行为：虚拟解包树缺 GalleryRuntime.mjs / Nuan5CompatibleResolver.js 时两组各自点名缺项', () => {
    const serverMissing = missingPackedCapabilityArtifacts(
      SYNC_SERVER_REQUIRED_ARTIFACTS,
      (relative) => !relative.includes('GalleryRuntime.mjs')
    )
    expect(serverMissing).toHaveLength(1)
    expect(serverMissing[0]).toContain('GalleryRuntime.mjs')
    const metaMissing = missingPackedCapabilityArtifacts(
      METADATA_REQUIRED_ARTIFACTS,
      (relative) => !relative.includes('Nuan5CompatibleResolver.js')
    )
    expect(metaMissing).toHaveLength(1)
    expect(metaMissing[0]).toContain('Nuan5CompatibleResolver.js')
  })
})
