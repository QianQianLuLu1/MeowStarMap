import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  collectNikkiSyncExternalDeps,
  collectRuntimeDepClosure,
  isRuntimeScanSkippedDir,
  missingUnpackCoverage,
  packageRootOf,
  type NikkiSyncSourceFile,
  type RuntimePackagePort
} from '../nikkisync-external-deps'

/**
 * @nikkisync 外部依赖的 unpack 覆盖守护（2026-11-04 装机缺陷的回归锚）。
 *
 * 背景：打包产物把 @nikkisync 解到 app.asar.unpacked 分支，其外部依赖 qrcode
 * 只进了 asar 内部——Node 解析从 unpacked 向上走真实目录树，永远够不到 asar 里的
 * node_modules ⇒ Runtime 装配必败 ⇒ 同步图库「扫描游戏相册」「照片目录」全瘫
 * （详见 docs/plans/2026-11-04-fix-nikkisync-unpacked-external-deps-实施计划.md）。
 * 本文件把「@nikkisync 的外部依赖闭包必须被 build.asarUnpack 覆盖」固化为契约。
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const nikkisyncScope = path.join(projectRoot, 'node_modules', '@nikkisync')

interface PackageJsonShape {
  build?: { asarUnpack?: unknown[] }
}

function readPackageJson(): PackageJsonShape {
  return JSON.parse(
    readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
  ) as PackageJsonShape
}

/** 递归收集 dir 下的 .js/.mjs/.cjs 源文件（跳过测试/示例目录）。 */
function collectSourceFiles(dir: string): NikkiSyncSourceFile[] {
  const out: NikkiSyncSourceFile[] = []
  const walk = (d: string): void => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) {
        if (isRuntimeScanSkippedDir(entry.name)) continue
        walk(full)
      } else if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) {
        try {
          out.push({ path: full, content: readFileSync(full, 'utf8') })
        } catch {
          // 读不动的文件如实跳过；闸门侧对「事实不可得」另有不放行口径
        }
      }
    }
  }
  walk(dir)
  return out
}

/** @nikkisync 四包 dist 产物（真实仓库态，红灯所在）。 */
function nikkisyncDistFiles(): NikkiSyncSourceFile[] {
  const out: NikkiSyncSourceFile[] = []
  for (const pkg of ['core', 'database', 'protocol', 'pc-companion']) {
    const dist = path.join(nikkisyncScope, pkg, 'dist')
    if (existsSync(dist)) out.push(...collectSourceFiles(dist))
  }
  return out
}

/** 仓库 node_modules 的读包端口（file.path 即包内相对路径，见端口契约）。 */
const repoPort: RuntimePackagePort = {
  readPackageFile(pkg, relative) {
    const abs = path.join(projectRoot, 'node_modules', ...pkg.split('/'), ...relative.split('/'))
    try {
      return { path: relative, content: readFileSync(abs, 'utf8') }
    } catch {
      return undefined
    }
  }
}

describe('packageRootOf（specifier → 包根名）', () => {
  it('正常：普通包取首段，@scope 取前两段，深路径取包根', () => {
    expect(packageRootOf('qrcode')).toBe('qrcode')
    expect(packageRootOf('@nikkisync/core')).toBeUndefined()
    expect(packageRootOf('pako/lib/zlib/deflate.js')).toBe('pako')
    expect(packageRootOf('@scope/name/deep.js')).toBe('@scope/name')
  })

  it('边界：相对路径 / node:、bun: / bare 内建 / 非包形态一律 undefined', () => {
    expect(packageRootOf('./x.js')).toBeUndefined()
    expect(packageRootOf('../y')).toBeUndefined()
    expect(packageRootOf('node:fs')).toBeUndefined()
    expect(packageRootOf('bun:sqlite')).toBeUndefined()
    expect(packageRootOf('fs')).toBeUndefined()
    expect(packageRootOf('stream')).toBeUndefined()
    // esbuild/browserify 产物里的正则误命中（2026-11-04 GalleryRuntime.mjs 实测）
    expect(packageRootOf(', ')).toBeUndefined()
    expect(packageRootOf(');\n    }')).toBeUndefined()
    expect(packageRootOf('')).toBeUndefined()
  })
})

describe('collectNikkiSyncExternalDeps（bare import 提取）', () => {
  it('正常：提取 ESM / CJS / 动态字面量三种形态的 bare 依赖', () => {
    const files = [
      {
        path: 'a.mjs',
        content:
          'import QRCode from "qrcode";\nexport { x } from "pngjs";\nconst m = await import("dijkstrajs");'
      },
      { path: 'b.js', content: "const s = require('qrcode');" }
    ]
    expect(collectNikkiSyncExternalDeps(files)).toEqual(['dijkstrajs', 'pngjs', 'qrcode'])
  })

  it('边界：相对路径、内建（含 bare 形式）、@nikkisync/*、正则误命中串均不计入', () => {
    const files = [
      {
        path: 'a.js',
        content:
          'import { a } from "./x.js"; import { b } from "../y.js";\n' +
          'import { c } from "node:fs"; import { d } from "bun:sqlite";\n' +
          'import { e } from "@nikkisync/core";\n' +
          "const f = require('stream'); const g = require('string_decoder/');\n" +
          'import h from ", "; import i from ");\\n    }";'
      }
    ]
    expect(collectNikkiSyncExternalDeps(files)).toEqual([])
  })

  it('边界：空文件集 / 非字符串 content 返回空集', () => {
    expect(collectNikkiSyncExternalDeps([])).toEqual([])
    expect(
      collectNikkiSyncExternalDeps([{ path: 'a.js', content: undefined as unknown as string }])
    ).toEqual([])
  })
})

describe('missingUnpackCoverage（asarUnpack 覆盖判定）', () => {
  it('正常：双星斜杠包裹包名的形态按包名包含判定命中', () => {
    expect(
      missingUnpackCoverage(
        ['qrcode', 'dijkstrajs'],
        ['**/@nikkisync/**', '**/qrcode/**', '**/dijkstrajs/**']
      )
    ).toEqual([])
  })

  it('异常：未覆盖的包名如实返回（2026-11-04 缺陷形态）', () => {
    expect(missingUnpackCoverage(['qrcode'], ['**/@nikkisync/**', '**/better-sqlite3/**'])).toEqual(
      ['qrcode']
    )
    expect(missingUnpackCoverage(['qrcode'], [])).toEqual(['qrcode'])
  })

  it('边界：asarUnpack 非数组或含非字符串/空串条目时 fail-safe 判未覆盖', () => {
    expect(missingUnpackCoverage(['qrcode'], undefined as unknown as unknown[])).toEqual(['qrcode'])
    expect(missingUnpackCoverage(['qrcode'], [null, 42] as unknown[])).toEqual(['qrcode'])
    expect(missingUnpackCoverage(['qrcode'], [''] as unknown[])).toEqual(['qrcode'])
  })
})

describe('collectRuntimeDepClosure（主入口可达图闭包）', () => {
  /** 用文件映射构造虚拟包端口（key = `<pkg>|<relative>`）。 */
  const portOf = (files: Record<string, string>): RuntimePackagePort => ({
    readPackageFile(pkg, relative) {
      const content = files[`${pkg}|${relative}`]
      return content === undefined ? undefined : { path: relative, content }
    }
  })

  it('正常：沿 main 入口的相对边 BFS，并入 bare 依赖；bin 专用依赖不进闭包', () => {
    const port = portOf({
      'qrcode|package.json': '{"main":"lib/index.js"}',
      'qrcode|lib/index.js': "require('dijkstrajs'); const p = require('./png'); require('fs');",
      'qrcode|lib/png.js': "require('pngjs'); require('zlib'); import x from './deep/entry.js';",
      'qrcode|lib/deep/entry.js': "export { y } from '../index.js';",
      // bin/CLI 专用依赖：不可达（bin/qrcode.js 不在 main 可达图内）
      'qrcode|bin/qrcode.js': "require('yargs');",
      'pngjs|package.json': '{"main":"./lib/png.js"}',
      'pngjs|lib/png.js': "require('stream');",
      'dijkstrajs|package.json': '{"main":"dijkstra.js"}',
      'dijkstrajs|dijkstra.js': 'module.exports = function () {};'
    })
    expect(collectRuntimeDepClosure(['qrcode'], port)).toEqual(['dijkstrajs', 'pngjs', 'qrcode'])
  })

  it('异常：包缺 package.json / 入口缺失时，包名仍在闭包内（存在性交由闸门判定）', () => {
    expect(collectRuntimeDepClosure(['missing-pkg'], portOf({}))).toEqual(['missing-pkg'])
    expect(
      collectRuntimeDepClosure(['bad-entry'], portOf({ 'bad-entry|package.json': 'not json' }))
    ).toEqual(['bad-entry'])
  })

  it('边界：种子为空返回空集；相对边成环不死循环', () => {
    expect(
      collectRuntimeDepClosure([], portOf({ 'qrcode|lib/index.js': "require('./index.js')" }))
    ).toEqual([])
    const cyclic = portOf({
      'a|package.json': '{"main":"index.js"}',
      'a|index.js': "require('./b.js'); import q from 'qrcode';",
      'a|b.js': "require('./index.js');",
      'qrcode|package.json': '{"main":"lib/index.js"}',
      'qrcode|lib/index.js': "require('pngjs');",
      'pngjs|package.json': '{"main":"index.js"}',
      'pngjs|index.js': ''
    })
    expect(collectRuntimeDepClosure(['a'], cyclic)).toEqual(['a', 'pngjs', 'qrcode'])
  })
})

describe('真实仓库契约：@nikkisync 外部依赖闭包必须被 build.asarUnpack 覆盖', () => {
  it('正常：闭包（含传递运行时依赖）逐包被 asarUnpack 覆盖——2026-11-04 qrcode 缺陷的回归锚', () => {
    const seed = collectNikkiSyncExternalDeps(nikkisyncDistFiles())
    // 事实口径：@nikkisync 未建链的环境（CI 只 checkout 本仓）没有 dist 可扫，
    // 此时种子为空、闭包为空、断言退化为平凡通过——与 pre-dist-check 的 skip 口径一致，
    // 不把「环境性缺失」伪装成失败，也不伪装成已验证。
    if (seed.length === 0) return
    const closure = collectRuntimeDepClosure(seed, repoPort)
    const missing = missingUnpackCoverage(closure, readPackageJson().build?.asarUnpack ?? [])
    expect(
      missing,
      '以下 @nikkisync 外部依赖未被 build.asarUnpack 覆盖，打包态将从 app.asar.unpacked 分支解析失败' +
        `（Runtime 装配必败）：${missing.join(', ')}；请在 package.json build.asarUnpack 追加对应条目`
    ).toEqual([])
  })

  it('事实口径：本机已建链时 @nikkisync dist 的外部依赖种子集合含 qrcode（钉住缺陷本体）', () => {
    const seed = collectNikkiSyncExternalDeps(nikkisyncDistFiles())
    if (seed.length === 0) return
    expect(seed).toContain('qrcode')
    // 传递闭包含 qrcode 的运行时依赖（dijkstrajs/pngjs，从主入口可达图实测得出）
    const closure = collectRuntimeDepClosure(seed, repoPort)
    expect(closure).toContain('dijkstrajs')
    expect(closure).toContain('pngjs')
  })
})
