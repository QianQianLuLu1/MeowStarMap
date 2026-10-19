/**
 * e2e 产物守卫：识别「dist/main 被 tsc -b 覆写成 per-file CJS」的环境态。
 *
 * 为什么需要它：electron-vite 把 main/preload 产物写在 dist/main/main/**，而历史上
 * src/main/tsconfig.json 的 outDir 也指向同一棵树。一次 `tsc -b`（typecheck / verify /
 * pre-commit 都会跑）就把 rollup bundle 覆写成 per-file 转译体，于是：
 * - window-manager 以 sandbox:true 加载的 preload 无法 require 兄弟模块
 *   → contextBridge 完全不执行 → `window.electronAPI` 整体 undefined；
 * - 变量式 `await import(specifier)` 被 TS 折叠成 `require()`
 *   → `@nikkisync/*` 的 ESM 图（含 top-level await）装载即失败。
 * 走 launchBuiltApp() 的用例（nikkisync-runtime N1 等）因此报成「代码缺陷」。
 * 本模块只做判定，不做修复：判据全在文件头，读取成本恒定。
 *
 * 两个判据取自真实产物形状：vite bundle 既不出现 __esModule 也无相对 require、且不产 .d.ts；
 * tsc 转译体三者齐备。详见 docs/plans/2026-10-19-fix-e2e-smoke-dist-pollution.md。
 */

/** 判定窗口：只消费头部，避免为一次启动校验读满整份 bundle */
const HEAD_LIMIT = 512

/** TS 把 ES 模块降级为 CJS 时写的互操作标记 */
const TSC_CJS_INTEROP = 'Object.defineProperty(exports, "__esModule"'

/** 跨文件相对 require：per-file 布局的标志，rollup 单 bundle 不会出现 */
const CROSS_FILE_REQUIRE = /require\(["']\.\.?\//

function pollutionMessage(): string {
  return (
    'dist/main/main/preload.js 已不是 electron-vite 的 bundle，而是 tsc -b 的 per-file CJS 产物：' +
    'sandbox:true 的 preload 无法 require 兄弟模块，window.electronAPI 不会暴露，' +
    '且变量式 import 会被折叠成 require() 导致 @nikkisync 装载失败。' +
    '请先执行 npm run build 再跑本用例（根因与口径见 docs/plans/2026-10-19-fix-e2e-smoke-dist-pollution.md）。'
  )
}

/**
 * 纯函数：判定 preload 产物是否被 tsc 覆写。
 *
 * @param head preload.js 文本（超长内容由本函数截断）
 * @param hasDeclarationSibling 同目录是否存在 preload.d.ts（electron-vite 从不产出声明）
 * @returns 污染时返回用户可读的中文原因；干净或信息不足时返回 null（不猜测）
 */
export function detectTscOverwrittenDist(
  head: string,
  hasDeclarationSibling: boolean
): string | null {
  if (hasDeclarationSibling === true) return pollutionMessage()
  if (typeof head !== 'string' || head.length === 0) return null
  const window = head.slice(0, HEAD_LIMIT)
  if (window.includes(TSC_CJS_INTEROP) && CROSS_FILE_REQUIRE.test(window)) {
    return pollutionMessage()
  }
  return null
}
