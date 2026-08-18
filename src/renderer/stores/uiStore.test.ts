/**
 * @layer L3
 * @module src/renderer/stores/uiStore
 * @coverage persist partialize 配置：selectedSceneCategories 不持久化
 * @dependencies fs（源码结构检查）+ uiStore 行为验证
 * @remarks 任务 2（P0）验证：partialize 移除 selectedSceneCategories，避免重启后残留筛选导致页面空态。
 *
 * 测试策略：useUIStore.persist API 在 node 环境不可用（localStorage 未注入），
 *   且项目中无该 API 使用先例。参考 GalleryPage.test.tsx 和 right-click-wiring.test.ts
 *   的结构性检查模式，直接验证 partialize 源码配置契约，稳定可维护。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { useUIStore } from './uiStore'

const uiStoreSrc = fs.readFileSync(
  path.resolve(process.cwd(), 'src', 'renderer', 'stores', 'uiStore.ts'),
  'utf-8'
)

/** 提取 partialize 函数体（从 "partialize: (state) => ({" 到对应 "})" 闭合） */
function extractPartializeBody(src: string): string {
  const marker = 'partialize: (state) => ({'
  const startIdx = src.indexOf(marker)
  expect(startIdx, 'partialize 配置未找到').toBeGreaterThan(-1)
  const bodyStart = startIdx + marker.length
  const bodyEnd = src.indexOf('})', bodyStart)
  expect(bodyEnd, 'partialize 闭合未找到').toBeGreaterThan(bodyStart)
  return src.slice(startIdx, bodyEnd + 2)
}

/** 移除注释行，避免注释中的字段名被误判为持久化字段 */
function stripComments(body: string): string {
  return body
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

describe('uiStore partialize 配置（任务 2）', () => {
  it('partialize 配置应存在', () => {
    expect(uiStoreSrc).toContain('partialize:')
    expect(uiStoreSrc).toContain("name: 'wxnn-ui-store'")
  })

  it('selectedSceneCategories 不应被持久化（U-O4 修正）', () => {
    const partializeBody = extractPartializeBody(uiStoreSrc)
    const codeLines = stripComments(partializeBody)

    expect(
      codeLines,
      'partialize 不应含 selectedSceneCategories 作为持久化字段（仅允许在注释中出现）'
    ).not.toMatch(/selectedSceneCategories/)
    // 注释应存在，说明是有意移除
    expect(partializeBody).toContain('U-O4')
  })

  it('应持久化 viewMode / sortBy / sortOrder / filterType / sidebarCollapsed / slideshowConfig', () => {
    const partializeBody = extractPartializeBody(uiStoreSrc)

    expect(partializeBody).toMatch(/viewMode:\s*state\.viewMode/)
    expect(partializeBody).toMatch(/sortBy:\s*state\.sortBy/)
    expect(partializeBody).toMatch(/sortOrder:\s*state\.sortOrder/)
    expect(partializeBody).toMatch(/filterType:\s*state\.filterType/)
    expect(partializeBody).toMatch(/sidebarCollapsed:\s*state\.sidebarCollapsed/)
    expect(partializeBody).toMatch(/slideshowConfig:\s*state\.slideshowConfig/)
  })

  it('不应持久化临时交互状态', () => {
    const partializeBody = extractPartializeBody(uiStoreSrc)
    const codeLines = stripComments(partializeBody)

    const temporaryStates = [
      'filterRating',
      'showMissingOnly',
      'showCorruptedOnly',
      'groupDimension',
      'selectedGroupKey',
      'showDuplicates',
      'searchQuery',
      'currentView',
      'selectedSceneTimes',
      'filterOutfit',
      'filterDateRange'
    ]

    for (const state of temporaryStates) {
      expect(codeLines, `partialize 不应含 ${state}（临时交互状态不应持久化）`).not.toContain(state)
    }
  })
})

describe('uiStore 默认状态与行为', () => {
  it('selectedSceneCategories 默认值应为空数组', () => {
    const state = useUIStore.getState()
    expect(state.selectedSceneCategories).toEqual([])
  })

  it('setSelectedSceneCategories 应能更新场景分类', () => {
    useUIStore.getState().setSelectedSceneCategories(['screenshot', 'collage'])
    expect(useUIStore.getState().selectedSceneCategories).toEqual(['screenshot', 'collage'])
    // 重置
    useUIStore.getState().setSelectedSceneCategories([])
  })
})
