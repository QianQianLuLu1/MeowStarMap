import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  deriveUnpackedTarget,
  type JsTreeFile
} from '../pre-dist-check'
import {
  CHAIN_REQUIRED_ARTIFACTS,
  METADATA_REQUIRED_ARTIFACTS,
  NIKKISYNC_CAPABILITY_ARTIFACTS,
  SYNC_SERVER_REQUIRED_ARTIFACTS,
  closureLoadChain
} from '../verify-nikkisync-link'
import {
  collectNikkiSyncExternalDeps,
  collectRuntimeDepClosure,
  type NikkiSyncSourceFile,
  type RuntimePackagePort
} from '../nikkisync-external-deps'

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

/**
 * 解包根的选择必须与待审 app.asar **同源**。
 *
 * 回归背景：原生二进制校验步原先用 findAsarUnpacked（递归 readdir、取首个命中），
 * 而禁串步用 resolveVerifyAsarTarget（显式 --asar 或固定 win-unpacked）。两条判据
 * 各自取根，release/ 下同时躺着两棵完整树时就会分叉：实测（2026-11-04 取证探针）
 * build-20250101-old 与 win-unpacked 并存时，readdir 首命中返回 **陈旧树** 的
 * app.asar.unpacked，禁串步却审现役树 ⇒ better-sqlite3/sharp/VC++/@nikkisync 四项
 * 整份验在旧产物上，闸门绿而新产物缺件，属**假绿**。
 * 判据收敛为一条：解包根 = 已解析 asarPath 的 `.unpacked` 兄弟；不命中即 fail-closed，
 * 绝不回退目录扫描。探针「恰好被调用一次」是「不再扫目录」的可证形式。
 */
describe('deriveUnpackedTarget：解包根与待审 app.asar 同源', () => {
  /** 造一棵 release 树：现役 win-unpacked + 名字排在它之前的陈旧完整诱饵树 */
  function makeTwoTreeRelease(tmp: string): {
    tmpRelease: string
    liveRoot: string
    decoyRoot: string
  } {
    const tmpRelease = path.join(tmp, 'release')
    const live = path.join(tmpRelease, 'win-unpacked', 'resources')
    const decoy = path.join(tmpRelease, 'aaa-stale-win-unpacked', 'resources')
    mkdirSync(path.join(live, 'app.asar.unpacked', 'node_modules'), { recursive: true })
    writeFileSync(path.join(live, 'app.asar'), 'live asar', 'utf8')
    mkdirSync(
      path.join(decoy, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release'),
      { recursive: true }
    )
    writeFileSync(
      path.join(
        decoy,
        'app.asar.unpacked',
        'node_modules',
        'better-sqlite3',
        'build',
        'Release',
        'better_sqlite3.node'
      ),
      'stale binary',
      'utf8'
    )
    writeFileSync(path.join(decoy, 'app.asar'), 'stale asar', 'utf8')
    return {
      tmpRelease,
      liveRoot: path.join(live, 'app.asar.unpacked'),
      decoyRoot: path.join(decoy, 'app.asar.unpacked')
    }
  }

  it('正常：只从已解析的 app.asar 派生，字典序更靠前的陈旧诱饵树不得被选中，且不扫目录', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'pdc-unpacked-'))
    try {
      const { tmpRelease, liveRoot, decoyRoot } = makeTwoTreeRelease(tmp)
      const { asarPath } = resolveVerifyAsarTarget([], tmpRelease)
      const probed: string[] = []
      const target = deriveUnpackedTarget(asarPath, (p) => {
        probed.push(p)
        return existsSync(p)
      })
      expect(target.unpackedRoot).toBe(liveRoot)
      expect(target.appOutDir).toBe(path.join(tmpRelease, 'win-unpacked'))
      expect(target.reason).toBe('')
      // 「不回落扫描」的可证形式：只问了自己那一个候选，没探诱饵树也没遍历目录
      expect(probed).toEqual([`${asarPath}.unpacked`])
      // 夹具必须有牙：诱饵树真在位且完整到「按旧判据就会被选中」，否则本用例是空过
      expect(existsSync(path.join(decoyRoot, 'node_modules', 'better-sqlite3'))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('正常：electronDist 旁路时解包根跟着 --asar 走，不跟着目录名走', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'pdc-bypass-'))
    try {
      const { tmpRelease } = makeTwoTreeRelease(tmp)
      const bypassAsar = path.join(tmpRelease, 'build-20261104-label', 'resources', 'app.asar')
      mkdirSync(path.dirname(bypassAsar), { recursive: true })
      mkdirSync(`${bypassAsar}.unpacked/node_modules`, { recursive: true })
      writeFileSync(bypassAsar, 'bypass asar', 'utf8')
      const { asarPath } = resolveVerifyAsarTarget([`--asar=${bypassAsar}`], tmpRelease)
      const target = deriveUnpackedTarget(asarPath, (p) => existsSync(p))
      expect(target.unpackedRoot).toBe(`${bypassAsar}.unpacked`)
      expect(target.appOutDir).toBe(path.join(tmpRelease, 'build-20261104-label'))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('异常：app.asar 在位而 .unpacked 缺失 ⇒ fail-closed 并给出候选路径，绝不回退扫描', () => {
    const probed: string[] = []
    const target = deriveUnpackedTarget('/abs/release/win-unpacked/resources/app.asar', (p) => {
      probed.push(p)
      return false
    })
    expect(target.unpackedRoot).toBeNull()
    expect(target.appOutDir).toBeNull()
    expect(target.reason).toContain('app.asar.unpacked')
    expect(target.reason).toContain('--asar')
    expect(probed).toHaveLength(1)
  })

  it('边界：asarPath 为 null（默认路径缺失 / *.tmp 被拒）时不得凭空造根，且一次都不探盘', () => {
    const probed: string[] = []
    const target = deriveUnpackedTarget(null, (p) => {
      probed.push(p)
      return true
    })
    expect(target.unpackedRoot).toBeNull()
    expect(target.appOutDir).toBeNull()
    expect(target.reason.length).toBeGreaterThan(0)
    expect(probed).toHaveLength(0)
  })

  // 与 verify-nikkisync-link.test.ts 同口径：唯一读真实产物树的用例按产物在位门控。
  // 本机未打包 / CI（ubuntu）没有 release/ 树，前提不成立 ⇒ 显式 skip，不判缺陷。
  const REAL_ASAR = path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar')
  const HAS_ARTIFACT = existsSync(REAL_ASAR)
  const realSuite = HAS_ARTIFACT ? describe : describe.skip

  realSuite('实树契约：本机现役产物的派生根就是既学校验所在的那棵树', () => {
    it('派生根落在 win-unpacked 下且含 better-sqlite3 二进制', () => {
      const { asarPath } = resolveVerifyAsarTarget([], path.join(ROOT, 'release'))
      const target = deriveUnpackedTarget(asarPath, (p) => existsSync(p))
      expect(target.unpackedRoot).toBe(`${REAL_ASAR}.unpacked`)
      expect(target.appOutDir).toBe(path.join(ROOT, 'release', 'win-unpacked'))
      expect(
        existsSync(
          path.join(
            String(target.unpackedRoot),
            'node_modules',
            'better-sqlite3',
            'build',
            'Release',
            'better_sqlite3.node'
          )
        )
      ).toBe(true)
    })
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

// ===== 打包态装载链闭包的接线（DEBT-040 收口）=====
// 回归背景：四张人工点名清单只能覆盖「已知的那几条边」，上游每加一条静态依赖都得回来补表；
// 漏补一次就是「闸门全绿 + 运行期 ERR_MODULE_NOT_FOUND」。改成按 import 图派生闭包后，判据与
// 清单条目数无关。本 describe 锚两件事：打包态确已复用同一个判定核（接线契约，读源码文本），
// 以及那三个探针在真解包树形态下判得对（行为，用 mkdtemp 造一棵小树，宿主分隔符语义与生产一致）。
describe('打包态装载链闭包：判定核复用同一真相源（DEBT-040）', () => {
  const pdcSource = readFileSync(path.join(ROOT, 'scripts', 'pre-dist-check.ts'), 'utf-8')

  it('接线契约：pre-dist-check.ts 须以 LOAD_CHAIN_ROOTS 为根调用 closureLoadChain（修复前必红）', () => {
    expect(pdcSource).toMatch(/closureLoadChain\(\s*LOAD_CHAIN_ROOTS/)
  })

  it('单一真相源：闭包判定核与根清单都须从 verify-nikkisync-link import，本地不得再抄一份根表', () => {
    const importBlock = pdcSource.match(/import\s*\{[^}]*\}\s*from\s*'\.\/verify-nikkisync-link'/s)
    expect(importBlock, '前置：须存在从 verify-nikkisync-link 的 import').not.toBeNull()
    expect(importBlock?.[0]).toContain('closureLoadChain')
    expect(importBlock?.[0]).toContain('LOAD_CHAIN_ROOTS')
    // 本地另起一张根表 = 两套真相源，正是本轮要消灭的形状
    expect(pdcSource).not.toMatch(/const\s+(LOAD_CHAIN_ROOTS|packedChainRoots|CHAIN_ROOTS)\b/)
  })

  it('行为：mkdtemp 造的最小解包树里，边齐则判绿、缺一个目标文件就点名该条边', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wxnn-chain-'))
    try {
      const rel = (p: string): string => p.split(path.sep).join('/')
      const files: Record<string, string> = {
        'dist/src/index.js': "export * from './src/a.js'\n",
        'dist/src/src/a.js': "import { b } from './b.js'\nexport const a = 1\n",
        'dist/src/src/b.js': 'export const b = 2\n'
      }
      const write = (relative: string, text: string): void => {
        const target = path.join(root, ...relative.split('/'))
        mkdirSync(path.dirname(target), { recursive: true })
        writeFileSync(target, text)
      }
      for (const [relative, text] of Object.entries(files)) write(relative, text)
      const probes = {
        readSource: (relative: string): string | null => {
          try {
            return readFileSync(path.join(root, relative), 'utf8')
          } catch {
            return null
          }
        },
        resolveRelative: (from: string, specifier: string): string =>
          rel(path.normalize(path.join(path.dirname(from), specifier))),
        exists: (relative: string): boolean => existsSync(path.join(root, relative))
      }
      const full = closureLoadChain(
        ['dist/src/index.js'],
        probes.readSource,
        probes.resolveRelative,
        probes.exists
      )
      expect(full.dangling).toEqual([])
      expect(full.unreadable).toEqual([])
      expect(full.visited).toBe(3)

      rmSync(path.join(root, ...'dist/src/src/b.js'.split('/')), { force: true })
      const broken = closureLoadChain(
        ['dist/src/index.js'],
        probes.readSource,
        probes.resolveRelative,
        probes.exists
      )
      expect(broken.dangling).toEqual([{ from: 'dist/src/src/a.js', specifier: './b.js' }])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    }
  })
})

// ===== 打包态 @nikkisync 外部依赖闭包闸门的接线（2026-11-04 qrcode 装机缺陷）=====
// 回归背景：@nikkisync 经 asarUnpack 解到 app.asar.unpacked 分支后，其外部纯 JS 依赖
// （qrcode 及传递依赖）若只进 asar 内部 node_modules，Node 从 unpacked 文件向上走真实
// 目录树、永远够不到 asar 旁支里的 node_modules ⇒ `Cannot find package 'qrcode'` ⇒
// Runtime 装配必败（同步图库扫描/照片目录全瘫，2026-11-04 装机日志实锤）。既有闸门只跟随
// 相对 import 边，bare import 不可见。本轮在 checkUnpackedNativeBinaries 内补外部依赖
// 闭包断言；本 describe 锚三件事（M3/DEBT-040 同款三件套）：打包态确已接线（读源码文本）、
// 判定核来自单一真相源（本地不得另抄）、判定链在虚拟解包树上判得对——正常过 / qrcode 缺红 /
// 空集过，与闸门的 pass / fail / skip 三分支一一对应。
describe('打包态 @nikkisync 外部依赖闭包闸门：判定核复用同一真相源（2026-11-04）', () => {
  const pdcSource = readFileSync(path.join(ROOT, 'scripts', 'pre-dist-check.ts'), 'utf-8')

  it('接线契约：须对解包树 @nikkisync dist 产物提取外部依赖种子（修复前必红）', () => {
    expect(pdcSource).toMatch(/collectNikkiSyncExternalDeps\(\s*nikkisyncDistSources/)
  })

  it('接线契约：须对种子求运行时传递闭包（修复前必红）', () => {
    expect(pdcSource).toMatch(/collectRuntimeDepClosure\(\s*externalSeed/)
  })

  it('接线契约：闭包须交 missingPackedCapabilityArtifacts 做存在性断言（修复前必红）', () => {
    expect(pdcSource).toMatch(/missingPackedCapabilityArtifacts\(\s*externalClosure/)
  })

  it('接线契约：skip 只留给「无 dist 可扫」，扫到产物而闭包为空须记 pass（2026-11-05 复查）', () => {
    // 判据失真修复：skip 此前只看 externalClosure.length === 0 ⇒ 「dist 扫到了、只是零
    // bare 依赖」也会打出「解包树无 dist 可扫」，两件事混成一件（出货闸门读数必须对得上事实）
    expect(pdcSource).toMatch(/nikkisyncDistSources\.length === 0/)
    expect(pdcSource).toMatch(/无外部 bare 依赖/)
  })

  it('单一真相源：外部依赖判定核须从 nikkisync-external-deps import，本地不得另抄一份', () => {
    const importBlock = pdcSource.match(
      /import\s*\{[^}]*\}\s*from\s*'\.\/nikkisync-external-deps'/s
    )
    expect(importBlock, '前置：须存在从 nikkisync-external-deps 的 import').not.toBeNull()
    expect(importBlock?.[0]).toContain('collectNikkiSyncExternalDeps')
    expect(importBlock?.[0]).toContain('collectRuntimeDepClosure')
    expect(importBlock?.[0]).toContain('isRuntimeScanSkippedDir')
    // 本地另起判定核 = 两套真相源，正是 M3/DEBT-040 消灭过的形状
    expect(pdcSource).not.toMatch(
      /function\s+(collectNikkiSyncExternalDeps|collectRuntimeDepClosure|packageRootOf)\b/
    )
  })

  /** 把相对路径文件集写进虚拟解包树的 node_modules 下。 */
  const writeUnpackedTree = (nmRoot: string, files: Record<string, string>): void => {
    for (const [relative, text] of Object.entries(files)) {
      const target = path.join(nmRoot, ...relative.split('/'))
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, text)
    }
  }

  /** 按闸门同款判定链串联（collect → closure → missing），返回三段读数。 */
  const verdictOf = (
    root: string,
    withNikkiSyncDist: boolean
  ): { seed: string[]; closure: string[]; missing: string[] } => {
    const nmRoot = path.join(root, 'app.asar.unpacked', 'node_modules')
    // 闸门的 collectModuleTree 只扫 @nikkisync/*/dist 下的 .js/.mjs/.cjs；虚拟树里只有
    // GalleryRuntime.mjs 一个产物文件，等价于把扫描结果直接摆出来
    const sources: NikkiSyncSourceFile[] = withNikkiSyncDist
      ? [
          {
            path: path.join(
              nmRoot,
              '@nikkisync',
              'pc-companion',
              'dist',
              'src',
              'wechat',
              'GalleryRuntime.mjs'
            ),
            content: 'import QRCode from "qrcode"\nexport const runtime = QRCode\n'
          }
        ]
      : []
    const port: RuntimePackagePort = {
      readPackageFile(pkg, relative) {
        try {
          return {
            path: relative,
            content: readFileSync(
              path.join(nmRoot, ...pkg.split('/'), ...relative.split('/')),
              'utf8'
            )
          }
        } catch {
          return undefined
        }
      }
    }
    const seed = collectNikkiSyncExternalDeps(sources)
    const closure = collectRuntimeDepClosure(seed, port)
    const missing = missingPackedCapabilityArtifacts(closure, (pkg) =>
      existsSync(path.join(nmRoot, ...pkg.split('/')))
    )
    return { seed, closure, missing }
  }

  /** 最小解包树：@nikkisync dist 引 qrcode，qrcode 主入口可达 dijkstrajs/pngjs。 */
  const MINIMAL_TREE: Record<string, string> = {
    '@nikkisync/pc-companion/dist/src/wechat/GalleryRuntime.mjs':
      'import QRCode from "qrcode"\nexport const runtime = QRCode\n',
    'qrcode/package.json': '{"main":"lib/index.js"}',
    'qrcode/lib/index.js': "require('dijkstrajs'); const p = require('./png');",
    'qrcode/lib/png.js': "require('pngjs');",
    'dijkstrajs/package.json': '{"main":"dijkstra.js"}',
    'dijkstrajs/dijkstra.js': 'module.exports = function () {};',
    'pngjs/package.json': '{"main":"lib/png.js"}',
    'pngjs/lib/png.js': "require('stream');"
  }

  it('行为：三包齐全时闭包钉住 qrcode/dijkstrajs/pngjs 且不点名（闸门 pass 形状）', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wxnn-extdeps-'))
    try {
      writeUnpackedTree(path.join(root, 'app.asar.unpacked', 'node_modules'), MINIMAL_TREE)
      const v = verdictOf(root, true)
      expect(v.seed).toEqual(['qrcode'])
      expect(v.closure).toEqual(['dijkstrajs', 'pngjs', 'qrcode'])
      expect(v.missing).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    }
  })

  it('行为：删掉 qrcode 目录 → 判定链点名 qrcode（2026-11-04 缺陷本体复现，闸门 fail 形状）', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wxnn-extdeps-'))
    try {
      const nmRoot = path.join(root, 'app.asar.unpacked', 'node_modules')
      writeUnpackedTree(nmRoot, MINIMAL_TREE)
      rmSync(path.join(nmRoot, 'qrcode'), { recursive: true, force: true })
      const v = verdictOf(root, true)
      // 入口没了 ⇒ 传递依赖不可达，闭包只剩种子 qrcode 本身，且存在性探针点名它
      expect(v.closure).toEqual(['qrcode'])
      expect(v.missing).toEqual(['qrcode'])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    }
  })

  it('行为：解包树无 @nikkisync dist 可扫 → 种子与闭包为空、不点名（闸门 skip 形状）', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wxnn-extdeps-'))
    try {
      const v = verdictOf(root, false)
      expect(v.seed).toEqual([])
      expect(v.closure).toEqual([])
      expect(v.missing).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    }
  })
})
