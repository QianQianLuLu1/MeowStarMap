import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import {
  MAIN_MARKER_SCOPE,
  treeContainsMarker,
  dirContains,
  nikkiSyncPackedVerdict,
  nikkiSyncMissingDiagnosis,
  type JsTreeFile
} from '../pre-dist-check'

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
