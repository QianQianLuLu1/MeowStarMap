/**
 * 常驻终扫守卫：把「旧名站点」钉成封闭集（阶段 6 C5 交付）。
 *
 * 存在理由：阶段 1–5 的「零残留」靠人肉 `git grep` + 三个只锁已决策站点的守卫
 * （`ui-brand-name` / `pack-identity-name` / `runtime-disk-name`）。新写的文件里
 * 出现旧产品名，三者都拦不住——`runtime-disk-name` 只管诊断落盘名，
 * `pack-identity-name` 只管打包与流水线身份，`ui-brand-name` 只管界面与语包。
 * 本守卫补上那层「面」：扫描域固定，逐文件逐模式计数**相等**（不是 ≤），
 * 多一处旧名红、少一处（旧站点被顺带清掉）同样红——后者逼着改动者同步台账，
 * 台账即「白名单」的唯一真相源，且每条豁免必须写 `reason`（空理由或整片复制
 * 同一句理由都判红）。
 *
 * 台账里为什么仍有旧名：URL（用户规定不动）、插件清单磁盘键与类型名、
 * 导入信封线格式 `app:'nikkigallery'`、本机真实目录名与历史产物名、
 * 移植面自投 fixture、描述修复前实况的注释，以及三个守卫自身的反向锁。
 * 逐条归属见 `old-name-ledger.json` 的 `reason`，汇总叙述见
 * `docs/plans/2026-10-23-rename-final-pass.md` 的白名单台账。
 *
 * 扫描域口径：`roots` 递归 + `rootFiles` 显式列出的根同层文件。根同层不走「扫一层」，
 * 因为工作区里散落的一次性读数（`.tmp-*.txt`）与别家工具的反馈 md 不属于仓库内容，
 * 扫它们会让守卫在别人机器上随机红；`skipDirs` 同理用于 `.mimosa/`、`archive/`
 * 这类 .gitignore 的本地态目录（新增同类产物时同批登记）。
 *
 * 平台语义（项目约定 §6）：本文件只做「键/计数」用途，路径一律归一成
 * 正斜杠相对形式后再比对，不读宿主分隔符语义，因此 Windows 开发机与
 * ubuntu-latest CI 跑的是同一判据；读盘走 `new URL(rel, import.meta.url)`
 * （不要用 `path.resolve(dirname(fileURLToPath(...)))`，CI 宿主装置下会 ENOENT）。
 * 行尾与 BOM：按 `/\r?\n/` 切行、剥首字符 BOM，兼容 `core.autocrlf=true` 的工作区。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

interface LedgerEntry {
  reason: string
  hits: Record<string, number>
}

interface Ledger {
  version: number
  readme: string
  roots: string[]
  rootFiles: string[]
  exts: string[]
  skipDirs: string[]
  skipPaths: string[]
  patterns: string[]
  minPatterns: number
  expectedTotal: number
  allowed: Record<string, LedgerEntry>
}

/**
 * 仓库根：本文件在 scripts/__tests__/ 下，向上两级。
 * 全程以 **URL** 形态交给 fs 读写（不要 fileURLToPath 落成字符串）：
 * CI 宿主装置 `tests/mocks/ci-linux-fs.ts` 会包 `url` 与 `fs`，落成字符串的仓库根
 * 在装置里会被翻成 `/home/runner/...` 形态而指向不存在的目录（阶段 5 记过的坑）。
 */
const REPO_BASE = new URL('../../', import.meta.url)

const LEDGER = JSON.parse(
  fs.readFileSync(new URL('./old-name-ledger.json', import.meta.url), 'utf8')
) as Ledger

/** rel 全程用正斜杠拼造，不掺宿主分隔符 */
const isSkipped = (rel: string): boolean =>
  LEDGER.skipPaths.some((p) => (rel + '/').startsWith(p)) ||
  rel.split('/').some((seg) => LEDGER.skipDirs.includes(seg))

/** 逐模式计数：与 `git grep -F` 同义（区分大小写的字面量包含） */
function countHits(rel: string): Record<string, number> {
  const raw = fs.readFileSync(new URL(encodeURI(rel), REPO_BASE), 'utf8')
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const lines = text.split(/\r?\n/)
  const hits: Record<string, number> = {}
  for (const pattern of LEDGER.patterns) {
    let n = 0
    for (const line of lines) {
      n += line.split(pattern).length - 1
    }
    if (n > 0) hits[pattern] = n
  }
  return hits
}

function readDir(relDir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(new URL(encodeURI(relDir) + '/', REPO_BASE), { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * 扫描域 = `roots` 递归 + `rootFiles` 显式列出的仓库根同层文件。
 * 根同层文件走白名单而不是「扫一层」：工作区里散落的一次性读数（`.tmp-*.txt`）
 * 与别家工具的反馈文件不属于仓库内容，扫它们会让守卫在别人机器上随机红。
 */
function collectScannedFiles(): string[] {
  const files: string[] = []
  const visit = (relDir: string): void => {
    for (const entry of readDir(relDir)) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!isSkipped(rel)) visit(rel)
        continue
      }
      if (!entry.isFile()) continue
      if (!LEDGER.exts.includes(path.posix.extname(rel))) continue
      if (isSkipped(rel)) continue
      files.push(rel)
    }
  }
  for (const root of LEDGER.roots) visit(root)
  for (const rel of LEDGER.rootFiles) {
    if (fs.existsSync(new URL(encodeURI(rel), REPO_BASE))) files.push(rel)
  }
  return [...new Set(files)].sort()
}

describe('旧名终扫台账 —— 封闭集不增不减', () => {
  const files = collectScannedFiles()
  const actual = new Map<string, Record<string, number>>()
  for (const rel of files) {
    const hits = countHits(rel)
    if (Object.keys(hits).length > 0) actual.set(rel, hits)
  }
  const ledgerFiles = Object.keys(LEDGER.allowed).filter(
    (rel) => Object.keys(LEDGER.allowed[rel].hits).length > 0
  )

  it('扫描域非空（防止 roots/skip 写错导致守卫空转常绿）', () => {
    expect(files.length).toBeGreaterThan(400)
    // 域内必须真扫到源码/语包/文档三类文件，否则等于没守卫
    expect(files.some((f) => f.startsWith('src/main/'))).toBe(true)
    expect(files.some((f) => f.startsWith('src/renderer/i18n/locales/'))).toBe(true)
    expect(files.some((f) => f.endsWith('.md'))).toBe(true)
  })

  it('模式清单不得被顺手删短', () => {
    expect(LEDGER.patterns.length).toBeGreaterThanOrEqual(LEDGER.minPatterns)
    // 三形旧技术标识 + 中英旧展示名，逐条必须在场
    for (const must of [
      'NikkiGallery',
      'nikkiGallery',
      'nikkigallery',
      'wxnn-photo-manager',
      'wxnn_photo_manager',
      '无限暖暖相册管理工具',
      '無限暖暖相簿管理工具'
    ]) {
      expect(LEDGER.patterns, `模式漏了 ${must}`).toContain(must)
    }
  })

  it('每条豁免都写了真实归属理由（无说明的豁免即红）', () => {
    const missing = ledgerFiles.filter((rel) => {
      const reason = LEDGER.allowed[rel].reason?.trim() ?? ''
      // 空串与「批量占位」都不算理由（同一句理由被抄满全场等于没写）
      return reason.length < 8 || /^(待补|暂无|略|N\/A|历史原因)$/.test(reason)
    })
    expect(missing, `缺理由：${missing.join(', ')}`).toEqual([])
    const duplicated = Object.entries(
      ledgerFiles.reduce<Record<string, number>>((acc, rel) => {
        const key = LEDGER.allowed[rel].reason.trim()
        acc[key] = (acc[key] ?? 0) + 1
        return acc
      }, {})
    ).filter(([, n]) => n > 6)
    expect(
      duplicated,
      `同一理由被复制到 ${duplicated.length} 组、每组 >6 个文件：请逐文件写实`
    ).toEqual([])
  })

  it('逐文件逐模式计数与台账相等（多一处少一处都红）', () => {
    const diffs: string[] = []
    for (const [rel, hits] of actual) {
      const entry = LEDGER.allowed[rel]
      if (!entry) {
        diffs.push(`未登记 ${rel} → ${JSON.stringify(hits)}`)
        continue
      }
      const want = entry.hits
      for (const [pattern, n] of Object.entries(hits)) {
        if (want[pattern] !== n) {
          diffs.push(`${rel} [${pattern}] 实际 ${n} ≠ 台账 ${want[pattern] ?? 0}`)
        }
      }
      for (const [pattern, n] of Object.entries(want)) {
        if ((hits[pattern] ?? 0) !== n) diffs.push(`${rel} [${pattern}] 台账 ${n} ≠ 实际 0`)
      }
    }
    for (const rel of ledgerFiles) {
      if (!actual.has(rel)) diffs.push(`台账登记了 ${rel} 但域内已无命中（台账需同步收窄）`)
    }
    expect(diffs, diffs.join('\n')).toEqual([])
  })

  it('台账内旧名命中总数为已知值（改动需同批核账，防「计数会骗人」）', () => {
    const total = [...actual.values()].reduce(
      (sum, hits) => sum + Object.values(hits).reduce((s, n) => s + n, 0),
      0
    )
    expect(total).toBe(LEDGER.expectedTotal)
  })
})
