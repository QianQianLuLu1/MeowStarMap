# 实施计划：修复全屏查看器属性面板「灯光/滤镜」为"无"时的显示异常

## 1. 问题与根因

### 现象

全屏查看模式 →「属性」面板：

- 灯光应为「无」时，显示 `"None" (50%)`
- 滤镜应为「无」时，显示 `"None" (100%)`

预期行为：整行隐藏（与现有 `None → undefined → 面板行隐藏` 的设计意图一致）。

### 根因

`src/main/services/decryption-service.ts` 的 `parseCameraParams`（L340-347）对"无"的判定是严格相等：

```ts
filter: arr[29] && arr[29] !== 'None' ? { id: ..., strength: Number(arr[30]) || 0 } : undefined,
light:  arr[17] && arr[17] !== 'None' ? { id: ..., strength: Number(arr[18]) || 0 } : undefined,
```

真实解密数据中"无"的表示并非精确字面量 `'None'`（带引号 / 含空白 / 大小写变体），漏过判定后被赋值
`{ id: '"None"', strength: 0.5 | 1 }`（0.5 与 1.0 正是游戏对"无"的默认强度，与 50%/100% 完全吻合）。
展示层 `getLightName`/`getFilterName` 未命中该 id 原样返回，`t()` 无对应键回退原文，故显示 `"None"`。

## 2. 依赖声明

**零新增依赖、零依赖版本变更。** 仅使用 Node 内置能力与现有代码。

| 项       | 说明                                                                        |
| -------- | --------------------------------------------------------------------------- |
| 运行时   | Node ≥ 20（现有环境）                                                       |
| 构建依赖 | electron-vite / vitest / typescript（现有，不改版本）                       |
| 安装方式 | 无需安装；若工作区无 `node_modules`，执行 `npm install`（增量，见启动说明） |

## 3. 启动说明（环境准备 / 启动 / 验证）

```powershell
# 1) 环境准备（工作区缺 node_modules 时执行；约 20s / 1347 包）
npm install

# 2) 红灯验证（复现测试必须失败）
npx vitest run src/main/services/decryption-service.test.ts

# 3) 修复后绿灯
npx vitest run src/main/services/decryption-service.test.ts

# 4) 局部回归
npx vitest run src/main/services src/renderer/components/common/CameraInfoPanel.test.tsx
npm run typecheck

# 5) 全量回归（后台跑 + 轮询 .x.log）
Start-Process cmd.exe "/c npx vitest run > .x.log 2>&1"
npx eslint src/main/services/decryption-service.ts src/main/services/decryption-service.test.ts
```

> 本修复不涉及 UI 运行时验证的必需项；如需人工复核：`npm run dev` 启动应用 → 打开全屏查看 → 点「属性」，
> 检查灯光/滤镜为"无"的照片不再出现 `"None" (...)` 行（注意本机 npm allow-scripts 网关可能拦截，
> 与本修复无关，测试链路不受影响）。

## 4. 改动范围（最小化）

| 文件                                           | 改动                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `src/main/services/decryption-service.ts`      | `parseCameraParams` 内新增两个私有函数 + 替换 L340-347 两处判定（唯一功能改动） |
| `src/main/services/decryption-service.test.ts` | 新增 None 变体复现测试（describe 块）                                           |
| `docs/fix-plan-camera-filter-none.md`          | 本文档                                                                          |

**明确不改**：`CameraInfoPanel.tsx`、`enum-mappings.ts`、类型定义、i18n、IPC 契约、`decodeCameraParamsFromFile` 调用链。

## 5. 错误处理

- 归一化函数对 `null / undefined / 数字 / 空串` 全部安全（`String(v ?? '')`），不抛错。
- 非法值（未命中 none 且无法映射翻译）落入既有 fallback 路径：`getLightName`/`getFilterName` 返回原始 id、`t()` 回退原文 —— 与现状一致，不新增错误分支。
- 保持 `rawParams` 原文不动，「复制参数」功能不受影响。
- 日志：本改动为纯数据归一化，不新增日志；解密链路既有 `logger.info('[decryption] Step 3 ...')` 已输出原文片段，排查时可直接观察。

## 6. 参数校验

### 输入

- `arr` 为 `unknown[]`（JSON 数组 `JSON.parse` 结果或 `text.split(',')` 结果），长度 ≥ 31 由既有守卫保证（三种分支均有 `length < 31` 检查）。
- `arr[17]`/`arr[29]`：灯光/滤镜 id（string | number | null | undefined）；`arr[18]`/`arr[30]`：强度（number | string）。

### 归一化规则

1. `normalizeParamId(v)`: `String(v ?? '').trim()` → 剥首尾 `'`/`"` 引号 → 再 `trim()`。
2. `isNoneParam(v)`: 归一化结果 `toLowerCase() === 'none'`。

### 边界条件

| 输入值（arr[17]/arr[29]）    | 修复前                                 | 修复后                             |
| ---------------------------- | -------------------------------------- | ---------------------------------- |
| `'None'`（精确）             | undefined（隐藏）                      | undefined（不回退）                |
| `'"None"'`（引号包裹）       | `{id:'"None"'}`（Bug）                 | undefined                          |
| `' None '` / `'NONE'`        | `{id:...}`（Bug）                      | undefined                          |
| `0` / `null` / `''`（falsy） | undefined                              | undefined                          |
| `'"VibeLight_001"'`          | `{id:'"VibeLight_001"'}`（翻译不命中） | `{id:'VibeLight_001'}`（翻译命中） |
| `'VibeLight_001'`            | 正常                                   | 正常（不受影响）                   |

## 7. 基础测试用例（TDD：先红后绿）

全部走 `decodeFileParams` 全链路（mock koffi：`step1Json` 含 `CameraParams` base64 + `step3Arr` 为解密后参数文本），复用测试文件既有 `setupKoffiDecode` / `setupAbiVersion` / `setupValidFile` 模式。

| #   | 用例                                                                      | 断言                                                 | 修复前                |
| --- | ------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------- |
| 1   | JSON 数组分支：arr[17]='"None"', arr[18]=0.5, arr[29]='"None"', arr[30]=1 | `camera.light`、`camera.filter` 均 `undefined`       | **失败（红灯）**      |
| 2   | 变体：arr[17]=' NONE '、arr[29]='None'（空格+大小写）                     | 均 `undefined`                                       | **失败**              |
| 3   | 逗号分隔分支：含 `"None"` 段                                              | 均 `undefined`                                       | **失败**              |
| 4   | 真实值：arr[17]='"VibeLight_001"', arr[18]=0.8                            | `light.id === 'VibeLight_001'` 且 `strength === 0.8` | **失败**（id 带引号） |
| 5   | 回归：arr[17]='None'、arr[29]='None'（精确）                              | 均 `undefined`                                       | 通过（防回退）        |
| 6   | 展示层回归（既有用例）                                                    | `CameraInfoPanel.test.tsx` 全部通过                  | —                     |

## 8. 验收标准（可量化）

1. `npx vitest run src/main/services/decryption-service.test.ts`：新增用例在修复前失败（红灯）、修复后全部通过（绿灯）。
2. `npx vitest run src/main/services src/renderer/components/common/CameraInfoPanel.test.tsx`：0 failed。
3. `npm run typecheck`：exit 0。
4. `npx eslint <两个改动源文件>`：0 error / 0 warning。
5. 全量 `npx vitest run`：相对基线（263 文件 / 4476 用例）无新增失败。
6. 改动仅限上表 3 个文件，`git diff --stat` 可核验。

## 9. 执行记录（2026-09-08）

- [x] 红灯：新增用例「灯光/滤镜 id 为带引号的 "None" 时按"无"处理」运行失败，
      失败信息 `expected { id: '"None"', strength: 0.5 } to be undefined` —— 精确复现 Bug（带引号 id + 默认强度 0.5）。
- [x] 修复：`parseCameraParams` 新增 `normalizeParamId` / `isNoneParam` 私有函数，
      两处判定改为 `arr[N] && !isNoneParam(arr[N])`，命中后 id 以 `normalizeParamId` 赋值。
- [x] 绿灯 + 局部回归：
  - `npx vitest run src/main/services/decryption-service.test.ts` → **33 passed**（含新增 5 用例）。
  - `npx vitest run src/main/services src/renderer/components/common/CameraInfoPanel.test.tsx` → **16 文件 / 425 用例全部通过，0 failed**。
  - `npm run typecheck` → **exit 0**。
  - `npx eslint src/main/services/decryption-service.ts src/main/services/decryption-service.test.ts` → **0 error / 0 warning**。
- [x] 全量回归：`npx vitest run`（后台执行）→ **267 文件 / 4532 用例全部通过，0 failed**
      （基线 263/4476，新增文件与用例后无任何失败项）。
- [x] 改动范围核验：本次修复新增/修改仅 3 个文件（`decryption-service.ts`、`decryption-service.test.ts`、本文档）；
      `git diff` 中其余 modified 文件均为本任务开始前工作区已存在的未提交改动（见会话起始 git status 快照），与本次修复无关。
