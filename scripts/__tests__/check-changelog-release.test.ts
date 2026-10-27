import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeChangelog, checkChangelogRelease } from '../check-changelog-release'

/**
 * check-changelog-release 单测：变更日志收口闸门（打包前）。
 *
 * 背景：CHANGELOG.md 为手工维护（Keep a Changelog），2026-10-01 发布 2.5.3 后未执行
 * 「将 [Unreleased] 并入版本节并清空」的收口步骤，导致已随 2.5.3 安装包发布的变更
 * 长期标记为「未发布」。计划与执行记录见
 * docs/archive/plans/2026-10-11-changelog-unreleased-rollover.md（已归档，不入仓）。
 *
 * 覆盖三类：
 *   纯函数 — 收口判定（正常 / 异常 / 边界），夹具全部内联
 *   回归样本 — 收口前真实 CHANGELOG.md 的未收口形态（节选快照，永久有效）
 *   配置契约 — 真实 CHANGELOG.md / package.json 的结构不变量（开发期与发布期均须成立）
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 正常夹具：Unreleased 已收口（仅说明段），[2.5.3] 节存在 */
const RELEASED_FIXTURE = [
  '# Changelog | 变更日志',
  '',
  '## [Unreleased] | 未发布',
  '',
  '新增、即将在下个版本发布的功能或修复。',
  '',
  '---',
  '',
  '## [2.5.3] - 2026-10-11',
  '',
  '### Added | 新增',
  '',
  '- 已发布条目 A'
].join('\n')

/** 正常夹具：不存在 [Unreleased] 板块（应通过但告警） */
const NO_UNRELEASED_FIXTURE = [
  '# Changelog',
  '',
  '## [2.5.3] - 2026-10-11',
  '',
  '- 已发布条目'
].join('\n')

/** 异常夹具：Unreleased 含 4 行待发布条目（含缩进子条目与星号列表） */
const DIRTY_FIXTURE = [
  '# Changelog',
  '',
  '## [Unreleased] | 未发布',
  '',
  '### Added | 新增',
  '',
  '- 待发布条目一',
  '- 待发布条目二',
  '  - 嵌套子条目',
  '',
  '### Changed | 变更',
  '',
  '* 星号待发布条目三',
  '',
  '---',
  '',
  '## [2.5.3] - 2026-10-11',
  '',
  '### Fixed | 修复',
  '',
  '- 已有修复条目'
].join('\n')

/**
 * 回归样本：2026-10-11 收口前真实 CHANGELOG.md 的未收口形态（节选，结构保真）。
 * 该状态即本闸门要拦截的 Bug：变更已随 2.5.3 安装包发布，日志仍标记为未发布。
 */
const BUGGY_UNRELEASED_SNAPSHOT = [
  '# Changelog | 变更日志',
  '',
  '## [Unreleased] | 未发布',
  '',
  '新增、即将在下个版本发布的功能或修复。',
  '',
  '### Added | 新增',
  '',
  '- **重扫复位谓词唯一真源**：新增 `src/main/scanner/rescan-restore-sql.ts` 纯字符串常量，`worker-entry.ts` 改为 import 该常量',
  '',
  '### Changed | 变更',
  '',
  '- **工具链跨大版本升级（Electron 41 / Vitest 5 / Vite 6）**：`devDependencies.electron` 40.10.6 → 41.10.6，关闭 DEBT-020',
  '- **Node 下限三处对齐为单一真源**：`.node-version` 由 `20` 改为 `22`，CI 5 个 job 改为 `node-version-file`',
  '',
  '### Fixed | 修复',
  '',
  '- **删除与回收站语义修复（D1–D5）**',
  '',
  '  - **D1 软删除不再搬动文件**：软删除改为纯 DB 标记，恢复 = 翻转标记即完好还原',
  '  - **D2 重扫不再复活用户删除**：`media_files` 新增 `delete_origin` 列（三态）',
  '',
  '---',
  '',
  '## [2.5.3] - 2026-10-01',
  '',
  '### Fixed | 修复',
  '',
  '- 修复底部操作栏层级过高（z-60）遮挡全局 Toast 与任务进度浮层的回归'
].join('\n')

/** 异常夹具：[2.5.3] 版本节重复出现两次 */
const DUPLICATE_VERSION_FIXTURE = [
  '## [Unreleased]',
  '',
  '## [2.5.3] - 2026-10-10',
  '',
  '- 条目一',
  '',
  '## [2.5.3] - 2026-10-11',
  '',
  '- 条目二'
].join('\n')

/** 边界夹具：Unreleased 内含 ### 子标题（不得截断节体） */
const SUBSECTION_FIXTURE = [
  '## [Unreleased]',
  '',
  '### Added | 新增',
  '',
  '- 待发布条目一',
  '',
  '### Fixed | 修复',
  '',
  '- 待发布条目二',
  '',
  '## [2.5.3] - 2026-10-11'
].join('\n')

/** 边界夹具：[Unreleased] 位于文件末尾（无后续 ## 节） */
const UNRELEASED_AT_EOF_FIXTURE = [
  '# Changelog',
  '',
  '## [2.5.3] - 2026-10-10',
  '',
  '- 旧条目',
  '',
  '## [Unreleased] | 未发布',
  '',
  '### Added | 新增',
  '',
  '- 文件末尾待发布条目'
].join('\n')

/** 边界夹具：说明段 / 引用 / HTML 注释 / 无空格列表均不算条目 */
const NON_ENTRY_FIXTURE = [
  '## [Unreleased] | 未发布',
  '',
  '这是一段说明文字，不是条目。',
  '> 引用行也不是条目',
  '<!-- HTML 注释不是条目 -->',
  '-item 没有空格不算条目',
  '',
  '## [2.5.3] - 2026-10-11'
].join('\n')

/** 边界夹具：标题含多余空格（##  [2.5.3]  -  2026-10-01） */
const SPACED_HEADING_FIXTURE = ['##  [2.5.3]  -  2026-10-01', '', '- 条目'].join('\n')

describe('checkChangelogRelease：正常场景', () => {
  it('Unreleased 已收口且存在对应版本节 → 通过', () => {
    const result = checkChangelogRelease({
      changelogText: RELEASED_FIXTURE,
      packageVersion: '2.5.3'
    })
    expect(result.ok).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.unreleasedEntries).toHaveLength(0)
  })

  it('节解析：识别 Unreleased 与版本节的标题、日期与顺序', () => {
    const { sections } = analyzeChangelog(RELEASED_FIXTURE)
    expect(sections).toEqual([
      { version: 'Unreleased', date: null, line: 3 },
      { version: '2.5.3', date: '2026-10-11', line: 9 }
    ])
  })

  it('无 [Unreleased] 板块 → 通过但给出警告', () => {
    const result = checkChangelogRelease({
      changelogText: NO_UNRELEASED_FIXTURE,
      packageVersion: '2.5.3'
    })
    expect(result.ok).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})

describe('checkChangelogRelease：异常场景', () => {
  it('Unreleased 含待发布条目（含缩进与星号列表）→ 失败并给出条目数与指引', () => {
    const result = checkChangelogRelease({
      changelogText: DIRTY_FIXTURE,
      packageVersion: '2.5.3'
    })
    expect(result.ok).toBe(false)
    expect(result.unreleasedEntries).toHaveLength(4)
    expect(result.errors.join('\n')).toContain('4')
    expect(result.errors.join('\n')).toContain('[Unreleased]')
    expect(result.errors.join('\n')).toContain('[2.5.3]')
  })

  it('回归样本：收口前真实 CHANGELOG 的未收口形态 → 判失败', () => {
    const result = checkChangelogRelease({
      changelogText: BUGGY_UNRELEASED_SNAPSHOT,
      packageVersion: '2.5.3'
    })
    expect(result.ok).toBe(false)
    expect(result.unreleasedEntries).toHaveLength(6)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('package.json version 无对应版本节 → 失败', () => {
    const result = checkChangelogRelease({
      changelogText: RELEASED_FIXTURE,
      packageVersion: '9.9.9'
    })
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('9.9.9')
  })

  it('对应版本节重复出现 → 失败', () => {
    const result = checkChangelogRelease({
      changelogText: DUPLICATE_VERSION_FIXTURE,
      packageVersion: '2.5.3'
    })
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('重复')
  })

  it('package.json version 非法（非 x.y.z 形态）→ 失败（参数校验）', () => {
    const result = checkChangelogRelease({
      changelogText: RELEASED_FIXTURE,
      packageVersion: 'abc'
    })
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('非法')
  })
})

describe('checkChangelogRelease：边界场景', () => {
  it('CRLF 行尾正常解析（本机 autocrlf 工作区形态）', () => {
    const result = checkChangelogRelease({
      changelogText: RELEASED_FIXTURE.replace(/\n/g, '\r\n'),
      packageVersion: '2.5.3'
    })
    expect(result.ok).toBe(true)
    expect(result.unreleasedEntries).toHaveLength(0)
  })

  it('Unreleased 内的 ### 子标题不截断节体（仅 ## 截断）', () => {
    const result = checkChangelogRelease({
      changelogText: SUBSECTION_FIXTURE,
      packageVersion: '2.5.3'
    })
    expect(result.unreleasedEntries).toHaveLength(2)
    expect(result.ok).toBe(false)
  })

  it('[Unreleased] 位于文件末尾（无后续节）仍可收集条目', () => {
    const result = checkChangelogRelease({
      changelogText: UNRELEASED_AT_EOF_FIXTURE,
      packageVersion: '2.5.3'
    })
    expect(result.unreleasedEntries).toHaveLength(1)
    expect(result.ok).toBe(false)
  })

  it('说明段 / 引用 / HTML 注释 / 无空格列表均不计为条目', () => {
    const result = checkChangelogRelease({
      changelogText: NON_ENTRY_FIXTURE,
      packageVersion: '2.5.3'
    })
    expect(result.unreleasedEntries).toHaveLength(0)
    expect(result.ok).toBe(true)
  })

  it('标题含多余空格仍识别版本与日期', () => {
    const { sections } = analyzeChangelog(SPACED_HEADING_FIXTURE)
    expect(sections).toEqual([{ version: '2.5.3', date: '2026-10-01', line: 1 }])
  })
})

describe('配置契约（真实仓库文件，开发期与发布期均须成立）', () => {
  const realChangelog = readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf-8')
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as {
    version: string
  }

  it('真实 CHANGELOG.md 存在 [Unreleased] 板块（Keep a Changelog 格式）', () => {
    const { sections } = analyzeChangelog(realChangelog)
    expect(sections.some((s) => s.version.toLowerCase() === 'unreleased')).toBe(true)
  })

  it('package.json version 在 CHANGELOG.md 中有对应版本节且不重复', () => {
    const { sections } = analyzeChangelog(realChangelog)
    expect(sections.filter((s) => s.version === pkg.version)).toHaveLength(1)
  })

  it('版本节标识无重复', () => {
    const { sections } = analyzeChangelog(realChangelog)
    const versions = sections.map((s) => s.version.toLowerCase())
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('[Unreleased] 链接引用指向 compare/v<最新版本节>...HEAD', () => {
    const { sections } = analyzeChangelog(realChangelog)
    const latest = sections.find((s) => s.version.toLowerCase() !== 'unreleased')
    expect(latest).toBeDefined()
    const link = /^\[Unreleased\]:\s+(\S+)/m.exec(realChangelog)
    expect(link).not.toBeNull()
    expect(link?.[1].endsWith(`/compare/v${latest?.version}...HEAD`)).toBe(true)
  })
})
