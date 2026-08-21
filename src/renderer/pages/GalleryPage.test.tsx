/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/pages/GalleryPage
 * @coverage useEffect 拆分契约：media:updated 订阅独立于 currentView/showCorruptedOnly
 * @dependencies fs（源码结构检查）
 * @remarks 任务 3（P1）验证：useEffect 已拆分为两个，订阅 media:updated 的 useEffect 仅依赖
 *   [setMediaFiles]，避免依赖变化时解绑订阅导致扫描完成通知丢失。
 *
 * 测试策略：GalleryPage 依赖 VirtualImageGrid/ListView/TimelineView/MasonryView/EventTimelineView
 *   等大量子组件与 hooks，直接 render 需 mock 数十个模块且脆弱。参考项目已有的
 *   right-click-wiring.test.ts 结构性检查模式，通过源码结构验证 useEffect 拆分契约，
 *   保证测试稳定可维护。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const galleryPageSrc = fs.readFileSync(
  path.resolve(process.cwd(), 'src', 'renderer', 'pages', 'GalleryPage.tsx'),
  'utf-8'
)

describe('GalleryPage useEffect 拆分契约（任务 3）', () => {
  it('应存在两个独立的 useEffect 块（订阅与加载分离）', () => {
    // 统计 useEffect 调用次数（含前导空格避免匹配注释）
    const useEffectMatches = galleryPageSrc.match(/\buseEffect\(/g)
    expect(useEffectMatches, 'GalleryPage 应至少包含 2 个 useEffect 调用').not.toBeNull()
    expect(useEffectMatches!.length).toBeGreaterThanOrEqual(2)
  })

  it('useEffect 1：响应 currentView/showCorruptedOnly 变化触发首次加载', () => {
    // 定位"仅响应 currentView/showCorruptedOnly 变化触发首次加载"注释
    const refreshMarker = '仅响应 currentView/showCorruptedOnly 变化触发首次加载'
    expect(galleryPageSrc).toContain(refreshMarker)

    // 定位 useEffect 1 的依赖数组：[setMediaFiles, setLoading, currentView, showCorruptedOnly]
    const refreshBlockStart = galleryPageSrc.indexOf(refreshMarker)
    const depArrayEnd = galleryPageSrc.indexOf('])', refreshBlockStart)
    expect(depArrayEnd, 'useEffect 1 依赖数组未找到').toBeGreaterThan(refreshBlockStart)
    const refreshBlock = galleryPageSrc.slice(refreshBlockStart, depArrayEnd + 2)

    expect(refreshBlock).toContain('setMediaFiles')
    expect(refreshBlock).toContain('setLoading')
    expect(refreshBlock).toContain('currentView')
    expect(refreshBlock).toContain('showCorruptedOnly')
    expect(refreshBlock).toContain('fetchMediaFromDatabase')
  })

  it('useEffect 2：media:updated 订阅仅依赖 [setMediaFiles]（不含 currentView/showCorruptedOnly）', () => {
    // 定位"全局订阅 media:updated"注释
    const subscribeMarker = '全局订阅 media:updated，仅注册一次'
    expect(galleryPageSrc).toContain(subscribeMarker)

    const subscribeBlockStart = galleryPageSrc.indexOf(subscribeMarker)
    // 取从注释到该 useEffect 闭合 } 的片段
    const depArrayStart = galleryPageSrc.indexOf('[', subscribeBlockStart)
    const depArrayEnd = galleryPageSrc.indexOf('])', depArrayStart)
    expect(depArrayEnd, 'useEffect 2 依赖数组未找到').toBeGreaterThan(depArrayStart)
    const depArray = galleryPageSrc.slice(depArrayStart, depArrayEnd + 2)

    // 关键契约：依赖数组仅含 setMediaFiles
    expect(depArray).toContain('setMediaFiles')
    // 不应包含 currentView 或 showCorruptedOnly（避免依赖变化时解绑订阅）
    expect(depArray).not.toContain('currentView')
    expect(depArray).not.toContain('showCorruptedOnly')
  })

  it('useEffect 2：订阅 media.onUpdated 并在回调内调用 fetchMediaFromDatabase', () => {
    const subscribeMarker = '全局订阅 media:updated，仅注册一次'
    const subscribeBlockStart = galleryPageSrc.indexOf(subscribeMarker)
    // 取该 useEffect 块足够长的片段验证订阅内容
    const subscribeBlock = galleryPageSrc.slice(subscribeBlockStart, subscribeBlockStart + 600)

    expect(subscribeBlock).toContain('media')
    expect(subscribeBlock).toContain('onUpdated')
    expect(subscribeBlock).toContain('fetchMediaFromDatabase')
    expect(subscribeBlock).toContain('setMediaFiles')
  })

  it('useEffect 2：cleanup 应解绑订阅（unsubscribe）', () => {
    const subscribeMarker = '全局订阅 media:updated，仅注册一次'
    const subscribeBlockStart = galleryPageSrc.indexOf(subscribeMarker)
    const subscribeBlock = galleryPageSrc.slice(subscribeBlockStart, subscribeBlockStart + 800)

    // 验证返回的 cleanup 函数调用 unsubscribe
    expect(subscribeBlock).toContain('return')
    expect(subscribeBlock).toMatch(/unsubscribe/)
  })
})

/**
 * 回归测试：永久删除确认弹窗在确认后应自动关闭（#fix-permanent-delete-dialog）
 * 根因：handleDelete 曾直接把 fileOperations.getDeleteConfirm 返回的 onConfirm 透传为
 *   ConfirmDialog 的 onConfirm，而该回调只负责执行删除、从不关闭对话框，导致
 *   系统删除二次确认后软件内弹窗常驻不关闭。
 * 约定：沿用本文件源码结构性断言模式；断言范围严格限定在 handleDelete 函数体内，
 *   以 'const handleDelete = useCallback(' 起、下一个 '// 稳定回调' 注释止，
 *   避免误命中 handleBatchDelete / handleCleanupCorrupted 中已有的同类「关闭弹窗」写法。
 */
describe('GalleryPage handleDelete 确认后关闭弹窗（#fix-permanent-delete-dialog）', () => {
  it('handleDelete 的 onConfirm 在确认后应将确认弹窗 open 置为 false', () => {
    const startMarker = 'const handleDelete = useCallback('
    const endMarker = '  // 稳定回调'
    const startIdx = galleryPageSrc.indexOf(startMarker)
    const endIdx = galleryPageSrc.indexOf(endMarker, startIdx)
    expect(startIdx, 'handleDelete 定义未找到').toBeGreaterThan(-1)
    expect(endIdx, 'handleDelete 函数体结束标记（稳定回调注释）未找到').toBeGreaterThan(startIdx)

    // 仅截取 handleDelete 函数体（不含后续 handleBatchDelete 等），检查是否在该作用域内关闭弹窗
    const handleDeleteBlock = galleryPageSrc.slice(startIdx, endIdx)

    // 修复写法：用 finally 包裹 config.onConfirm，并在其中 setConfirmDialog(...) open:false
    expect(handleDeleteBlock).toContain('setConfirmDialog((prev) => ({ ...prev, open: false }))')
  })
})
