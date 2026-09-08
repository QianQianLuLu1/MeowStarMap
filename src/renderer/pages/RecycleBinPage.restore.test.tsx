/**
 * @vitest-environment jsdom
 * @module src/renderer/pages/RecycleBinPage
 * @coverage 恢复成功契约：渲染端不得误读 result.success（preload call() 不回传 success 字段），
 *   且图库刷新必须写回 store（fetchMediaFromDatabase 是纯取数函数，丢弃返回值则 UI 不更新）
 * @dependencies fs（源码结构检查）
 * @remarks 修复 #fix-restore-sync 根因：preload call() 解包 IpcResponse 只回传 data，
 *   restore 实际返回 { message }（无 success 字段）。handleRestore 此前读取恒为 undefined 的
 *   result.success，导致成功路径（loadRecycleBin + 图库刷新）被整体跳过；且图库刷新调用
 *   fetchMediaFromDatabase 后丢弃返回值，即使执行也不会更新 mediaStore.mediaFiles。
 *
 * 测试策略：沿用 RecycleBinPage.empty.test.tsx（#fix-empty-recycle-bin-contract）确立的
 *   源码结构性断言模式——直接 render 需 mock 数十个模块且脆弱。做否定断言前先剔除注释行，
 *   避免误命中本文件修复说明注释中引用的缺陷写法本身。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.resolve(process.cwd(), 'src', 'renderer', 'pages', 'RecycleBinPage.tsx'),
  'utf-8'
)

// 剔除注释行后再做否定断言，避免误命中修复说明注释中引用的缺陷写法本身
function stripComments(code: string): string {
  return code
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('RecycleBinPage 恢复成功契约（#fix-restore-sync）', () => {
  it('handleRestore 成功路径不得读取 result.success（preload call() 仅回传 data，无 success 字段）', () => {
    const code = stripComments(src)
    // 缺陷写法：result.success 恒为 undefined，成功分支永不执行
    expect(code).not.toMatch(/result\.success/)
  })

  it('handleRestore 不得丢弃图库刷新的取数结果（fetchMediaFromDatabase 纯取数不写 store，UI 不会更新）', () => {
    const code = stripComments(src)
    // 修复后应经 useRefreshMedia 写回 store，不再出现裸调用 fetchMediaFromDatabase
    expect(code).not.toContain('fetchMediaFromDatabase')
  })

  it('成功路径必须调用图库刷新写回函数 refreshMedia()', () => {
    const code = stripComments(src)
    expect(code).toContain('await refreshMedia()')
  })

  it('成功路径在 await 后必须调用 loadRecycleBin() 刷新回收站列表', () => {
    const code = stripComments(src)
    expect(code).toContain('await loadRecycleBin()')
  })
})
