/**
 * CI（ubuntu-latest）宿主模拟装置 —— 环境闸门（本体在 `./ci-linux-node.setup.ts`）。
 *
 * 跑法：`npm run test:ci-linux`（或 `npx vitest run --config vitest.ci-linux.config.ts <路径>`）
 *
 * 为什么需要闸门：node 项目里带 `// @vitest-environment jsdom` 逐文件注解的用例会在
 * client 环境装载本 setup——vite 6.4.4 的内置模块清单还没有 `node:sqlite`，把装置本体
 * 拉进 client 打包图会报「Cannot bundle built-in module "node:sqlite"」，凡带该注解的
 * 套件整批装载失败（2026-11-14 实测 8 个文件级失败、0 个用例执行）。
 *
 * 判定与语义：
 * - client 环境（jsdom，含逐文件注解）下 `window`/`document` 在场 ⇒ 跳过装置本体。
 *   CI 上这些用例跑的也是真实宿主 + 基座 setup，装置缺失只影响本地模拟保真度，
 *   不改变「装置不进 CI」的定位（本体头注的「已知失真」口径同样适用）。
 * - node 环境经运行期动态 import 装载本体：specifier 必须是 vite 不可静态分析的形态
 *   （变量 + @vite-ignore），否则闸门文件自身又会被拉进 client 打包图。
 * - 本体经顶层 await 完整装载后才返回，vitest 保证 setup 完成后才加载测试模块，
 *   `vi.mock` 注册时机语义与原先单文件形态一致。
 */
const isClientLike = typeof window !== 'undefined' && typeof document !== 'undefined'

if (!isClientLike) {
  const apparatusSpecifier = './ci-linux-node.setup.ts'
  await import(/* @vite-ignore */ apparatusSpecifier)
}
