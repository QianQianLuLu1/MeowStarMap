/**
 * `vi.mock('path')` / `vi.mock('node:path')` 的共享工厂：把**宿主绑定**换成 posix 语义。
 *
 * 用途：在 Windows 开发机上复现 CI（ubuntu-latest）的 `path` 语义，用来证明「比较层已钉
 * win32 / 混合输入已走方言」的修复真的与宿主无关，而不是只在开发机上看起来对。
 *
 * 成立的根基：`path.posix.win32 === path.win32`、`path.posix.posix === path.posix`，
 * 所以一次 `{...posix}` 展开既给出 posix 的 `sep/join/resolve/dirname/basename/...`
 * 命名导出，也让被测代码里**显式**写的 `path.win32.*` 继续走真 win32（钉过的位置不受影响）。
 *
 * 禁止就地 `Object.assign` 改真 `path`：Windows 上 `path === path.win32`，
 * 那样会把 win32 一起改坏，装置当场失效（且会污染同进程后续用例）。
 */
export async function posixHost(
  importOriginal: () => Promise<unknown>
): Promise<Record<string, unknown>> {
  const actual = (await importOriginal()) as Record<string, unknown> & {
    default?: Record<string, unknown>
  }
  const real = (actual.default ?? actual) as Record<string, unknown>
  const posix = real.posix as Record<string, unknown>
  return { ...posix, default: posix }
}
