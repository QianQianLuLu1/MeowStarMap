import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import {
  MAIN_MARKER_SCOPE,
  treeContainsMarker,
  dirContains,
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
 *   边界 — 路径分隔符归一、同名前缀兄弟目录不得误命中；结构契约钉住作用域必须覆盖 tsc 落点
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

describe('结构契约：标记作用域必须覆盖 tsc 的 main 落点', () => {
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

  it('tsconfig 推导出的 tsc main 落点即 dist/main/main（本用例的前提自证）', () => {
    expect(tscMainRoot).toBe(DIST_MAIN)
  })

  it('标记作用域必须包含 tsc 的 main 落点（否则 per-file 产物里的标记会漏检）', () => {
    const covered =
      tscMainRoot === MAIN_MARKER_SCOPE || tscMainRoot.startsWith(MAIN_MARKER_SCOPE + path.sep)
    expect(covered).toBe(true)
  })

  it('标记作用域就是整个 main 输出根，不得再收窄回 app/', () => {
    expect(MAIN_MARKER_SCOPE).toBe(DIST_MAIN)
  })
})
