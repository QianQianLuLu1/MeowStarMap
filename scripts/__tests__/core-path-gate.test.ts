import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import eslintConfig from '../../eslint.config.js'
import {
  BATCH_INIT_REASON,
  PROTECTED_DIRS,
  PROTECTED_GLOBS,
  analyzeProtectedDiff,
  evaluateGate,
  extractAuthReason,
  isProtectedPath,
  parseUnifiedDiff,
  type GateEntry
} from '../core-path-gate'

/**
 * core-path-gate 单测：核心路径授权闸门（提交面 diff 判定）。
 *
 * 覆盖三类：
 *   纯函数 — 路径判定、unified diff 解析、授权注释提取、diff 分析、闸门判定
 *   配置契约 — 与 eslint.config.js 中 core-path-guard 块的 files 并集保持一致（双侧漂移即失败）
 *   回归守护 — 真实受保护目录中不得残留批量初始化文案（验收项 3 常驻）
 */

/** 构造一个「实质改动但无新增授权注释」的典型 diff（负例形态） */
const SUBSTANTIVE_WITHOUT_AUTH_DIFF = [
  'diff --git a/src/main/ipc/handlers/media-handler.ts b/src/main/ipc/handlers/media-handler.ts',
  'index 1111111..2222222 100644',
  '--- a/src/main/ipc/handlers/media-handler.ts',
  '+++ b/src/main/ipc/handlers/media-handler.ts',
  '@@ -1,3 +1,4 @@',
  " import { ipcMain } from 'electron'",
  '+import { wrapHandler } from "../validator"',
  ' // 既有注释行',
  '-const old = 1',
  '+const next = 2',
  ''
].join('\n')

/** 当前 WIP 波的形态：仅新增一行 BOM + 批量初始化注释 */
const BATCH_ONLY_DIFF = [
  'diff --git a/src/main/ipc/handlers/app-handler.ts b/src/main/ipc/handlers/app-handler.ts',
  'index aaaaaaa..bbbbbbb 100644',
  '--- a/src/main/ipc/handlers/app-handler.ts',
  '+++ b/src/main/ipc/handlers/app-handler.ts',
  '@@ -1,3 +1,4 @@',
  '+﻿// @core-change: 核心路径保护规则初始化',
  " import { ipcMain } from 'electron'",
  ''
].join('\n')

/** 实质改动 + 同批新增含真实原因的授权注释（正例形态） */
const SUBSTANTIVE_WITH_AUTH_DIFF = [
  'diff --git a/src/main/preload/api/export.ts b/src/main/preload/api/export.ts',
  'index ccccccc..ddddddd 100644',
  '--- a/src/main/preload/api/export.ts',
  '+++ b/src/main/preload/api/export.ts',
  '@@ -1,2 +1,4 @@',
  '+﻿// @core-change: 新增 favorites 批量导出通道',
  " import { ipcMain } from 'electron'",
  '+export const batchExport = (): void => undefined',
  ''
].join('\n')

describe('isProtectedPath', () => {
  it('命中四个受保护目录的直接子文件', () => {
    expect(isProtectedPath('src/main/preload/api/app.ts')).toBe(true)
    expect(isProtectedPath('src/main/ipc/handlers/media-handler.ts')).toBe(true)
    expect(isProtectedPath('src/main/services/file-service.ts')).toBe(true)
    expect(isProtectedPath('src/shared/errors/app-error.ts')).toBe(true)
  })

  it('命中深层嵌套子文件', () => {
    expect(isProtectedPath('src/main/services/sub/dir/x.ts')).toBe(true)
  })

  it('Windows 反斜杠输入归一化后命中', () => {
    expect(isProtectedPath('src\\main\\ipc\\handlers\\media-handler.ts')).toBe(true)
  })

  it('排除测试/规格/快照目录与 handlers 下划线共享文件', () => {
    expect(isProtectedPath('src/main/ipc/handlers/media-handler.test.ts')).toBe(false)
    expect(isProtectedPath('src/main/services/file-service.spec.ts')).toBe(false)
    expect(isProtectedPath('src/main/preload/api/__tests__/app.ts')).toBe(false)
    expect(isProtectedPath('src/main/ipc/handlers/_shared.ts')).toBe(false)
  })

  it('非受保护目录与非 .ts 文件不命中', () => {
    expect(isProtectedPath('src/renderer/pages/Gallery.tsx')).toBe(false)
    expect(isProtectedPath('src/main/ipc/validator.ts')).toBe(false)
    expect(isProtectedPath('src/shared/utils/tool.ts')).toBe(false)
    expect(isProtectedPath('src/main/preload/api/app.tsx')).toBe(false)
    expect(isProtectedPath('src/main/services/file-service.js')).toBe(false)
  })
})

describe('parseUnifiedDiff', () => {
  it('解析元数据与 hunk，提取增删行', () => {
    const parsed = parseUnifiedDiff(SUBSTANTIVE_WITHOUT_AUTH_DIFF)
    expect(parsed.added).toEqual(['import { wrapHandler } from "../validator"', 'const next = 2'])
    expect(parsed.removed).toEqual(['const old = 1'])
    expect(parsed.isNewFile).toBe(false)
    expect(parsed.isDeleted).toBe(false)
  })

  it('识别新文件与删除文件标记', () => {
    const newFileDiff = [
      'diff --git a/src/main/preload/api/newone.ts b/src/main/preload/api/newone.ts',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/src/main/preload/api/newone.ts',
      '@@ -0,0 +1,1 @@',
      "export const x = 'a'",
      ''
    ].join('\n')
    expect(parseUnifiedDiff(newFileDiff).isNewFile).toBe(true)

    const deletedDiff = [
      'diff --git a/src/main/services/old.ts b/src/main/services/old.ts',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/src/main/services/old.ts',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      "export const x = 'a'",
      ''
    ].join('\n')
    expect(parseUnifiedDiff(deletedDiff).isDeleted).toBe(true)
  })

  it('多 hunk 与「文件末尾无换行」标记不误计入增删行', () => {
    const diff = [
      '@@ -1,2 +1,2 @@',
      ' const a = 1',
      '-const b = 2',
      '+const b = 22',
      '@@ -10,2 +10,3 @@',
      ' const c = 3',
      '+const d = 4',
      '\\ No newline at end of file',
      ''
    ].join('\n')
    const parsed = parseUnifiedDiff(diff)
    expect(parsed.added).toEqual(['const b = 22', 'const d = 4'])
    expect(parsed.removed).toEqual(['const b = 2'])
  })

  it('空 diff 返回空解析', () => {
    const parsed = parseUnifiedDiff('')
    expect(parsed.added).toEqual([])
    expect(parsed.removed).toEqual([])
    expect(parsed.isNewFile).toBe(false)
    expect(parsed.isDeleted).toBe(false)
  })

  it('CRLF 行尾不残留到提取内容', () => {
    const parsed = parseUnifiedDiff('@@ -1,1 +1,1 @@\r\n-const a = 1\r\n+const a = 2\r\n')
    expect(parsed.removed).toEqual(['const a = 1'])
    expect(parsed.added).toEqual(['const a = 2'])
  })
})

describe('extractAuthReason', () => {
  it('从带 + 标记的授权注释行提取原因', () => {
    expect(extractAuthReason('+// @core-change: 新增 media:cleanup 清理通道')).toBe(
      '新增 media:cleanup 清理通道'
    )
  })

  it('容忍 BOM 前缀与缩进', () => {
    expect(extractAuthReason('+﻿  // @core-change: 通道调整')).toBe('通道调整')
    expect(extractAuthReason('﻿// @core-change: 无 diff 标记行')).toBe('无 diff 标记行')
  })

  it('空原因返回空字符串（用于空原因违规判定）', () => {
    expect(extractAuthReason('+// @core-change:')).toBe('')
    expect(extractAuthReason('+// @core-change:   ')).toBe('')
  })

  it('非授权行返回 null', () => {
    expect(extractAuthReason("+import { ipcMain } from 'electron'")).toBeNull()
    expect(extractAuthReason('// 普通注释')).toBeNull()
    expect(extractAuthReason('+// core-change 缺少 @ 前缀')).toBeNull()
  })
})

describe('analyzeProtectedDiff', () => {
  it('实质改动（无授权注释）→ substantive 且无新增授权原因', () => {
    const analysis = analyzeProtectedDiff(SUBSTANTIVE_WITHOUT_AUTH_DIFF)
    expect(analysis.substantive).toBe(true)
    expect(analysis.addedAuthReasons).toEqual([])
    expect(analysis.removedAuthCount).toBe(0)
  })

  it('仅新增批量注释（WIP 波形态）→ 非实质，但记录新增授权原因', () => {
    const analysis = analyzeProtectedDiff(BATCH_ONLY_DIFF)
    expect(analysis.substantive).toBe(false)
    expect(analysis.addedAuthReasons).toEqual([BATCH_INIT_REASON])
  })

  it('实质改动 + 同批授权注释 → 双信号齐备', () => {
    const analysis = analyzeProtectedDiff(SUBSTANTIVE_WITH_AUTH_DIFF)
    expect(analysis.substantive).toBe(true)
    expect(analysis.addedAuthReasons).toEqual(['新增 favorites 批量导出通道'])
  })

  it('仅移除旧授权注释 → 非实质（清理过期标记合法），计入 removedAuthCount', () => {
    const diff = [
      '--- a/src/main/ipc/handlers/media-handler.ts',
      '+++ b/src/main/ipc/handlers/media-handler.ts',
      '@@ -1,3 +1,2 @@',
      '-// @core-change: 上一次变更的原因',
      " import { ipcMain } from 'electron'",
      ''
    ].join('\n')
    const analysis = analyzeProtectedDiff(diff)
    expect(analysis.substantive).toBe(false)
    expect(analysis.removedAuthCount).toBe(1)
  })

  it('纯空行新增不算实质改动', () => {
    const diff = ['@@ -1,1 +1,2 @@', ' const a = 1', '+', ''].join('\n')
    expect(analyzeProtectedDiff(diff).substantive).toBe(false)
  })
})

describe('evaluateGate', () => {
  const entry = (path: string, diffText: string, status = 'M'): GateEntry => ({
    path,
    status,
    analysis: analyzeProtectedDiff(diffText)
  })

  it('负例：实质改动且无新增授权注释 → missing-auth', () => {
    const violations = evaluateGate([
      entry('src/main/ipc/handlers/media-handler.ts', SUBSTANTIVE_WITHOUT_AUTH_DIFF)
    ])
    expect(violations).toEqual([
      { path: 'src/main/ipc/handlers/media-handler.ts', type: 'missing-auth' }
    ])
  })

  it('正例：实质改动 + 同批真实原因授权注释 → 通过', () => {
    expect(
      evaluateGate([entry('src/main/preload/api/export.ts', SUBSTANTIVE_WITH_AUTH_DIFF)])
    ).toEqual([])
  })

  it('仅注释增删（无实质改动）→ 通过', () => {
    expect(evaluateGate([entry('src/main/ipc/handlers/app-handler.ts', BATCH_ONLY_DIFF)])).toEqual([
      {
        path: 'src/main/ipc/handlers/app-handler.ts',
        type: 'batch-text',
        reason: BATCH_INIT_REASON
      }
    ])
  })

  it('删除文件跳过判定（无法在已删除文件中补注释）', () => {
    const deletedDiff = [
      'diff --git a/src/main/services/old.ts b/src/main/services/old.ts',
      'deleted file mode 100644',
      '--- a/src/main/services/old.ts',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      "export const x = 'a'",
      ''
    ].join('\n')
    expect(evaluateGate([entry('src/main/services/old.ts', deletedDiff, 'D')])).toEqual([])
  })

  it('新增授权原因为空 → empty-reason；为批量文案 → batch-text', () => {
    const emptyReasonDiff = [
      '@@ -1,2 +1,3 @@',
      '+// @core-change:',
      " import { ipcMain } from 'electron'",
      '+const changed = true',
      ''
    ].join('\n')
    const emptyViolations = evaluateGate([
      entry('src/main/ipc/handlers/media-handler.ts', emptyReasonDiff)
    ])
    // 授权注释已在本次 diff 中新增（只是原因为空）→ 不再报 missing-auth，仅报 empty-reason（同样拦截）
    expect(emptyViolations).toEqual([
      { path: 'src/main/ipc/handlers/media-handler.ts', type: 'empty-reason' }
    ])

    const batchViolations = evaluateGate([
      entry('src/main/ipc/handlers/app-handler.ts', BATCH_ONLY_DIFF)
    ])
    expect(batchViolations).toEqual([
      {
        path: 'src/main/ipc/handlers/app-handler.ts',
        type: 'batch-text',
        reason: BATCH_INIT_REASON
      }
    ])
  })
})

describe('与 eslint.config.js 受保护范围的一致性守护', () => {
  const guardBlocks = (eslintConfig as Array<Record<string, unknown>>).filter(
    (block) =>
      !!block &&
      typeof block === 'object' &&
      (block['rules'] as Record<string, unknown> | undefined)?.['local/core-path-guard'] === 'error'
  )
  const configGlobs = [
    ...new Set(guardBlocks.flatMap((block) => block['files'] as string[]))
  ].sort()

  it('存在至少 3 个 guard 配置块', () => {
    expect(guardBlocks.length).toBeGreaterThanOrEqual(3)
  })

  it('guard 块 files 并集与闸门 PROTECTED_GLOBS 完全一致（双侧漂移即失败）', () => {
    expect(configGlobs).toEqual([...PROTECTED_GLOBS].sort())
  })
})

describe('受保护目录批量文案残留守护（验收项 3 常驻）', () => {
  function listTsFiles(dirUrl: URL): URL[] {
    const out: URL[] = []
    for (const ent of readdirSync(dirUrl, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        out.push(...listTsFiles(new URL(`${ent.name}/`, dirUrl)))
      } else if (ent.name.endsWith('.ts')) {
        out.push(new URL(ent.name, dirUrl))
      }
    }
    return out
  }

  it('四个受保护目录下不存在 "@core-change: 核心路径保护规则初始化"', () => {
    for (const dir of PROTECTED_DIRS) {
      const files = listTsFiles(new URL(`../../${dir}/`, import.meta.url))
      expect(files.length, `${dir} 应存在源文件`).toBeGreaterThan(0)
      for (const file of files) {
        const text = readFileSync(file, 'utf-8')
        expect(
          text.includes(`@core-change: ${BATCH_INIT_REASON}`),
          `${file.href} 残留批量初始化文案`
        ).toBe(false)
      }
    }
  })
})
