# 修复概率性 `Maximum call stack size exceeded`（大数组展开求值）

- 日期：2026-09-12
- 状态：已完成（TDD 红-绿闭环，全量回归通过）

## 1. 根因

项目中多处 `Math.max(...arr)` / `Math.min(...arr)` 把**可能超大、数据规模依赖**的数组以展开运算符作为函数实参传入。
当数组长度超过 V8 调用栈参数上限（约数万级，随元素体积浮动）即抛 `RangeError: Maximum call stack size exceeded`。
该错误"概率性"出现：只有相似/重复分组、候选目录池、抽卡记录等数据规模变大时才触发，常规规模不报错。

grep 全量确认运行期命中点（5 个文件），其中 3 处操作数据驱动数组为真凶：

| 文件                                       | 行          | 原代码                                              | 风险                                                  |
| ------------------------------------------ | ----------- | --------------------------------------------------- | ----------------------------------------------------- |
| `src/main/ipc/handlers/similar-handler.ts` | 209/214/215 | `Math.min(...groupRows.map(...))`                   | 相似/重复分组大小完全由用户照片数据决定，**首要真凶** |
| `src/renderer/utils/scan-exclusions.ts`    | 99          | `Math.max(...pool.map(c => c.mtimeMs))`             | 候选目录池（数据驱动）                                |
| `src/renderer/utils/resonance/process.ts`  | 424         | `Math.max(...items.map(item => item.pool_cnt + 1))` | 卡池抽卡记录（`processPearpalData`）                  |

其余 `StatsView` / `RecordsView` / `Histogram` / `diagnostics` 的展开求值对象为固定/有界数组（256 定长、BANNER 键、有限时间序列），正常不可能溢出，本次按最小化改动原则不触碰。
`similar-handler.ts` 的 Union-Find `find` 经确认为迭代式 `while`（非递归），已排除递归溢出。

## 2. 依赖声明

- **无新增依赖、无 lockfile 变更**。复用 `src/shared/utils/` 共享层，零第三方依赖（避免体积与 Safe-Delete 网关下的 lockfile 漂移）。

## 3. 修复方案

新增共享安全极值工具 `src/shared/utils/extremum.ts`：

```ts
export function maxOf<T>(
  values: Iterable<T>,
  selector: (v: T) => number,
  initial = -Infinity
): number
export function minOf<T>(
  values: Iterable<T>,
  selector: (v: T) => number,
  initial = Infinity
): number
```

- 基于单趟 `for...of` 遍历，天然规避"展开为函数实参"的调用栈上限；
- 相比 `Math.min(...arr.map(fn))` 省去中间 `.map` 临时数组，空间 O(1)，反而降低内存峰值；
- 空集合返回 `initial`，边界安全。

将三处运行期展开求值点原地替换为 `maxOf` / `minOf`。`main` 与 `renderer` 均相对引用 `src/shared/utils/extremum`。

## 4. 启动与验证说明

- 环境准备（本机可能无 node_modules）：`npm install`（受 Safe-Delete 网关限制只用增量 install，禁止 `npm ci` / `Remove-Item node_modules`）。
- 局部验证：
  - `npx vitest run src/main/ipc/handlers/similar-handler.test.ts`
  - `npx vitest run src/renderer/utils/scan-exclusions.test.ts`
  - `npx vitest run src/renderer/utils/resonance/process.test.ts`
- 全量回归：`npm test`（vitest run）、`npm run typecheck`、`npm run lint`。

## 5. 错误处理与兜底

- `maxOf`/`minOf` 对空集合返回 `initial`（-Infinity / Infinity），调用方原 `max===0` 退化分支语义不变（`scan-exclusions` 中 `pool` 已前置保证非空）。
- 不引入新日志输出；复现用例仅断言"不抛错 + 聚合正确"，不依赖日志内容。
- 未改动 IPC 通道名 / preload 暴露 / handler 签名，无需改 `docs/IPC_CONTRACT.md`。

## 6. 参数校验

- `maxOf`/`minOf`：`values` 为 `Iterable<T>`；`selector` 必须返回 `number`（调用方传入的映射已保证返回数值）；`initial` 可选。
- 调用方既有校验不变（`pickDefaultSelectedPaths` 已对 `candidates` 做 `Array.isArray` + 非空 guard；`processPearpalData` 对空 `items` 跳过）。

## 7. 基础测试用例设计（TDD 红-绿）

每个修复点均构造 N=200000 的极端边界用例，修复前**稳定失败**（抛 `RangeError`），修复后**稳定通过**：

| 用例         | 文件                              | 场景                                            | 正常                    | 异常           | 边界             |
| ------------ | --------------------------------- | ----------------------------------------------- | ----------------------- | -------------- | ---------------- |
| 超大单组聚合 | `similar-handler.test.ts`         | `startSimilarFind` 返回 200000 行全部相连成一组 | 聚合 1 组 / 200000 文件 | 修复前抛栈溢出 | 单组规模上限     |
| 超大候选集   | `scan-exclusions.test.ts`（新建） | 200000 候选，仅末项 mtimeMs 最大                | 选出 1 项               | 修复前抛栈溢出 | 候选规模上限     |
| 超大单卡池   | `process.test.ts`                 | `processPearpalData` 单卡池 200000 条           | `totalPulls = N`        | 修复前抛栈溢出 | 抽卡记录规模上限 |

## 8. 验证结果

- 三处 RED 用例在修复前确认失败（`RangeError: Maximum call stack size exceeded`）。
- 修复后三处用例转绿；局部相关测试全绿。
- 全量回归：`280 test files / 4728 tests passed`；`npm run typecheck` 退出 0；`npm run lint` 退出 0。
- 仅改动 4 个文件（+ 新增共享工具 + 新增/扩展测试），无无关重构、格式化或功能调整。
