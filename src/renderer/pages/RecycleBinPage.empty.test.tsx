/**
 * @vitest-environment jsdom
 * @module src/renderer/pages/RecycleBinPage
 * @coverage 清空回收站成功契约：渲染端不得误读 result.success（preload call() 不回传 success 字段）
 * @dependencies fs（源码结构检查）
 * @remarks 修复 #fix-empty-recycle-bin-contract 根因：preload call() 解包 IpcResponse 只回传 data，
 *   返回值形态为 { message, movedCount, missingCount, failedCount }（无 success 字段）。
 *   渲染端 handleEmptyRecycleBin 此前读取恒为 undefined 的 result.success 并误抛，导致成功路径被判定为失败。
 *
 * 测试策略：RecycleBinPage 依赖 react-virtuoso / store / i18n 等大量子组件，直接 render 需 mock 数十个模块且脆弱。
 *   沿用 GalleryPage.test.tsx 的源码结构性断言模式，通过源码结构验证成功契约，保证测试稳定可维护。
 *   做「不得包含某写法」的否定断言时，先剔除注释行再匹配，避免误命中本文件修复说明注释中引用的缺陷写法本身。
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

describe('RecycleBinPage 清空回收站成功契约（#fix-empty-recycle-bin-contract）', () => {
  it('成功路径不得误读 result.success（preload call() 仅回传 data，无 success 字段）', () => {
    const code = stripComments(src)
    // 修复前写法：if (!result.success) throw new Error(result.message)
    expect(code).not.toMatch(/if\s*\(\s*!\s*result\.success\s*\)\s*throw/)
  })

  it('成功路径在 await 后必须调用 loadRecycleBin() 刷新列表', () => {
    const code = stripComments(src)
    expect(code).toContain('await loadRecycleBin()')
  })

  it('成功 toast 使用 success 语义且优先主进程返回文案（兜底 recycleBin.emptySuccess）', () => {
    const code = stripComments(src)
    expect(code).toMatch(/showMessage\([\s\S]*?'success'\)/)
    // 兜底文案 key 必须存在（已在 12 个语言包补齐），避免显示原始 key
    expect(code).toContain('recycleBin.emptySuccess')
  })
})
