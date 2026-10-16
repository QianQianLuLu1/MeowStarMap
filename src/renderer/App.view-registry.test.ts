/**
 * @module src/renderer/App.tsx + components/layout/AppShell.tsx
 * @layer L3
 *
 * 视图层级注册表的结构断言（同步服务迁入同步图库板块，新增 `sync-service` 二级页）。
 *
 * 为什么用源码结构断言而不是渲染测试：`App.tsx` 的 `renderPage` 有 `default: return <GalleryPage />`
 * 兜底、`AppShell.tsx` 的 `getViewStatusLabel` 有 `default: ''` 兜底，`ALL_VIEWS` 漏一项则 keep-alive
 * 循环根本不挂载该页 —— 三处漏登记**都不会编译失败**，只表现为「点进去渲染成图库 / 状态栏空白 /
 * 整块空白」这种静默缺陷。沿用仓库既有的源码结构断言范式（`App.theme.test.tsx`、
 * `VirtualImageGrid.thumb.test.tsx`、`uiStore.test.ts` 的 partialize 检查）把它焊成契约。
 *
 * 运行：npx vitest run src/renderer/App.view-registry.test.ts
 */
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

const appSrc = fs.readFileSync(path.resolve(process.cwd(), 'src', 'renderer', 'App.tsx'), 'utf-8')
const appShellSrc = fs.readFileSync(
  path.resolve(process.cwd(), 'src', 'renderer', 'components', 'layout', 'AppShell.tsx'),
  'utf-8'
)
const uiStoreSrc = fs.readFileSync(
  path.resolve(process.cwd(), 'src', 'renderer', 'stores', 'uiStore.ts'),
  'utf-8'
)

/** 剔除注释行：修复说明注释会引用缺陷写法本身，不剔除则断言会被注释里的字面量骗绿 */
function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

const appCode = stripComments(appSrc)
const appShellCode = stripComments(appShellSrc)

/** 从 `const NAME: T = [` 抠出数组字面量正文（必须锚在 `= [` 上：类型标注 `ViewLevel[]` 里也有方括号） */
function extractArrayLiteral(src: string, name: string): string {
  const startIdx = src.indexOf(`const ${name}`)
  expect(startIdx, `App.tsx 未找到 ${name}`).toBeGreaterThan(-1)
  const open = src.indexOf('= [', startIdx)
  expect(open, `${name} 未找到数组字面量起始`).toBeGreaterThan(startIdx)
  const close = src.indexOf(']', open)
  expect(close, `${name} 数组未闭合`).toBeGreaterThan(open)
  return src.slice(open, close)
}

/** 从 `const NAME: T = {` 抠出对象字面量正文 */
function extractObjectLiteral(src: string, name: string): string {
  const startIdx = src.indexOf(`const ${name}`)
  expect(startIdx, `App.tsx 未找到 ${name}`).toBeGreaterThan(-1)
  const open = src.indexOf('= {', startIdx)
  expect(open, `${name} 未找到对象字面量起始`).toBeGreaterThan(startIdx)
  const close = src.indexOf('}', open)
  expect(close, `${name} 对象未闭合`).toBeGreaterThan(open)
  return src.slice(open, close)
}

/** ViewLevel 联合类型的全部字面量取值（uiStore 是唯一真相源） */
function viewLevelLiterals(): string[] {
  const startIdx = uiStoreSrc.indexOf('export type ViewLevel')
  expect(startIdx, 'uiStore.ts 未找到 ViewLevel').toBeGreaterThan(-1)
  const block = uiStoreSrc.slice(startIdx, uiStoreSrc.indexOf('export type', startIdx + 1))
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1])
}

describe('视图层级注册表（App.tsx / AppShell.tsx）', () => {
  it("ViewLevel 必须登记 'sync-service'（同步服务二级子页的层级入口）", () => {
    expect(viewLevelLiterals(), "uiStore ViewLevel 缺 'sync-service'").toContain('sync-service')
  })

  it('ViewLevel 的每一个取值都必须登记进 ALL_VIEWS —— 漏一项则 keep-alive 不挂载，点进去整块空白', () => {
    const allViews = extractArrayLiteral(appCode, 'ALL_VIEWS')
    for (const view of viewLevelLiterals()) {
      expect(allViews, `ALL_VIEWS 未登记 '${view}'`).toContain(`'${view}'`)
    }
  })

  it('ViewLevel 的每一个取值都必须登记进 VIEW_LEVEL_MAP —— 漏一项 tsc 即报，此项为冗余防线', () => {
    // 键的写法混用（gallery: 1 与 'sync-gallery': 1），逐条抠出键名再比对，
    // 不能用 toContain("'gallery'")——那会漏判所有不带引号的合法写法
    const mapKeys = new Set(
      [...extractObjectLiteral(appCode, 'VIEW_LEVEL_MAP').matchAll(/(?:'([^']+)'|(\w+))\s*:/g)].map(
        (m) => m[1] ?? m[2]
      )
    )
    for (const view of viewLevelLiterals()) {
      expect(mapKeys.has(view), `VIEW_LEVEL_MAP 未登记 '${view}'`).toBe(true)
    }
  })

  it('sync-service 的毛玻璃层级必须是 2（板块内子页，与 detail 同层，不是一级板块）', () => {
    expect(appCode).toMatch(/'sync-service':\s*2\b/)
  })

  it("renderPage 必须有 case 'sync-service' 且渲染 SyncServicePage（default 会静默兜到 GalleryPage）", () => {
    const caseIdx = appCode.indexOf("case 'sync-service'")
    expect(caseIdx, "renderPage 缺 case 'sync-service'").toBeGreaterThan(-1)
    // 锚在 case 之后的紧邻代码上：只 grep 字面量的话，注释或其他 case 里的命中也会假绿
    expect(
      appCode.slice(caseIdx, caseIdx + 200),
      "case 'sync-service' 未渲染 SyncServicePage"
    ).toContain('SyncServicePage')
  })

  it("getViewStatusLabel 必须有 case 'sync-service' 并引用 appShell.viewStatus.syncService（default: '' 会静默留白）", () => {
    const caseIdx = appShellCode.indexOf("case 'sync-service'")
    expect(caseIdx, "getViewStatusLabel 缺 case 'sync-service'").toBeGreaterThan(-1)
    expect(
      appShellCode.slice(caseIdx, caseIdx + 200),
      "case 'sync-service' 未引用 appShell.viewStatus.syncService"
    ).toContain('appShell.viewStatus.syncService')
  })
})
