# 完整搭配码面板 · 阶段 1 实施计划（service 层 networkData 结构化解析）

> 生成日期：2026-10-31 · 基线：本仓 `main` @ `9d25c73`（`meow-star-map 2.5.6-beta`）
> 状态：已经用户批准（计划模式评审通过），落盘后进入执行
> 数据契约：[cloth-outfit-data-contract.md](cloth-outfit-data-contract.md)（阶段 0 冻结产物，§3/§4/§5/§7.4 为本阶段类型与行为真相源）
> 上游：阶段 0（技术调研与契约冻结）· 本阶段：阶段 1 · 后续：阶段 2 第三方数据源 / 阶段 3 磁盘缓存 / 阶段 4 UI

---

## 一、背景（Context）

`decodeClothDiyShareCode`（`src/main/services/decryption-service.ts:1185`）目前把 DLL 联网拉回的 `networkData` 作为裸字符串透传，渲染层仅截断展示。阶段 0 契约（`docs/plans/cloth-outfit-data-contract.md`，已冻结）查明：networkData 是双层 `Content` 包裹的 JSON，但 `patternData`/`nsHiddenData` 是 `[:k:v,...]` 自定义 IdMap 语法——**7 个实采样本中 4 个直接 `JSON.parse` 必失败**；服饰 ID 可按契约 §5 十进制位段拆解（`outfitFeature` 拆出后本地未持久化）。本阶段把 networkData 解析为强类型 `structured` 字段经既有 IPC 通道透传，raw 字符串原样保留兜底。

## 二、关键决策（依据契约与任务，评审时可否决）

1. **IdMap 处理走契约 §3.2 路线 1（预归一化）**：按 BNF 用容错扫描器把 `[:k:v,...]`/`[:]` 改写为 `{"k":v,...}` 后再 `JSON.parse`（键裸整数、值裸数字，允许负数；不匹配 BNF 的 `[:` 原样保留，交由后续 JSON.parse 自然失败降级——不写宽松正则）。
2. **structured = 任务规定的投影** `{ poseId?: number; clothes: Array<{id, clothType, state, species, outfitFeature}> }`；`wearingDIYInfos`/`patternData`/`nsHiddenData` 本阶段不入 structured（后续阶段以新增可选字段扩展，向后兼容）。
3. **契约 §4 归一化类型全家族**（`ClothDiyNetworkData`/`Content`/`Info`/CoreData 五变体等）本阶段一并声明进 `src/main/types/decryption.ts`——纯类型声明、零运行时、逐字适配（`ClothDiyEmptyMap` 改为 `type = Record<string, never>` 以避开空 interface 规则），DIY 字段消费随后续阶段接入。zod schema 本阶段只覆盖信封层（双层 Content + PoseId/wearingClothes，默认 strip 模式容忍未知字段），DIY 五变体判别随消费阶段补齐。
4. **electron-api.ts 与 ShareCodeDecoderDialog 不动**：任务清单未含；renderer 消费走 `vite-env.d.ts` 环境声明（已核实 dialog 经 `window.electronAPI?.decrypt` 调用）。electron-api.ts 的 §7.1 漂移修正仍是独立后续项。
5. **`ClothParams` 不补 `outfitFeature`**（契约 §7.4.2 独立行动项）：照片路径 IPC 形状零变化，`parseDressingParams` 仅把内联公式替换为共享纯函数调用。
6. **零新增依赖、零新增 i18n 键**：zod ^4.4.3 已在 dependencies；解析失败只降级不打用户文案；日志为中文明文（与文件内既有风格一致），**不含 networkData 内容与 UID**。

## 三、structured 行为语义（可判定验收）

| 输入（IPC data）                                                                                 | structured                                                                                                                                        |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| networkData 缺省（网络失败/桥超时的既有优雅降级）                                                | 缺省 undefined（与 networkData 同进退）                                                                                                           |
| networkData 存在且解析成功                                                                       | `{ poseId?, clothes }`；poseId 仅「正整数」保留（0/负数/非整数/字符串/缺省一律省略）；clothes 保持 wearingClothes 原顺序，`id ≤ 0` 或非有限数跳过 |
| networkData 存在但 JSON.parse 失败 / 信封校验失败（缺双层 Content、wearingClothes 缺失或非数组） | `null`（不抛错、raw 照常返回）                                                                                                                    |
| wearingClothes 为 `[]`                                                                           | `{ clothes: [] }`（合法空搭配）                                                                                                                   |

## 四、子任务（每步验证通过才进下一步；新增行为严格先红后绿）

### T0 计划文件入仓 → 确认

- 新增 `docs/plans/2026-10-31-cloth-outfit-phase1-structured-parse-实施计划.md`（本文件），确认后继续。

### T1 抽共享纯函数 decomposeClothId

- **文件**：`src/main/services/decryption-service.ts`（新增导出 `decomposeClothId(rawId: number): ClothIdParts`，公式逐字来自 `parseDressingParams:566-569`，`parseDressingParams` 改为调用它，push 结构与 debug 日志不变；Eureka 拆解不动）；`src/main/types/decryption.ts`（新增 `ClothIdParts`）；`src/main/services/decryption-service.test.ts`（新增用例）。
- **输入/输出**：number → `{ outfitFeature, clothType, state, species }`。
- **红灯口径**：新用例 import 该导出——抽取前 import 失败即红；另加 1 条「经 decodeFileParams 全链路断言 dressing.clothes 拆解字段」的表征用例护住照片路径（抽取前后均须绿）。
- **验收**：`npx vitest run src/main/services/decryption-service.test.ts` 全绿、既有用例零回归；契约 §5 示例 `1020100001` → species 102/state 0/clothType 10/outfitFeature 1 断言通过。

### T2 结构化解析函数 + 类型

- **文件**：`src/main/types/decryption.ts`（§4 家族 + `ClothDiyStructuredCloth` + `ClothDiyStructuredOutfit`）；`src/main/services/decryption-service.ts`（`normalizeClothDiyIdMap` + zod 信封 schema + `parseClothDiyNetworkData(networkData: string): ClothDiyStructuredOutfit | null`，失败分支一律 `return null` + `logger.warn` 无内容，成功打 debug 计数）；同目录测试。
- **实现链**：预归一化 → JSON.parse（try/catch）→ zod 信封 safeParse → 投影（语义表规则）。
- **用例**（fixture 逐字取自契约 §3.6 样本 1/2/3 原文）：正常=样本 1（9 件，首件 1023100090→clothType 10/state 3/species 102/outfitFeature 90）、**样本 3（含 patternData，14 件——契约 §7.4.1 点名必测）**、样本 2（DIY 混合不干扰投影，13 件）、PoseId 正整数保留；异常=畸形 JSON→null、缺双层 Content→null、wearingClothes 缺失/非数组→null；边界=`[]`→clothes:[]、PoseId 0/-5/"123"→省略、ID=0/负数跳过、`nsHiddenData:[:]` 空表容忍。
- **验收**：同 T1 测试命令全绿；新用例先红（函数不存在）后绿。

### T3 decodeClothDiyShareCode 挂 structured

- **文件**：`decryption-service.ts`：`ClothDiyDecodeResult` 增 `structured?: ClothDiyStructuredOutfit | null`；返回处 `structured: net.networkData === undefined ? undefined : parseClothDiyNetworkData(net.networkData)`；现有字段一字不动。
- **用例**：桥返回样本 3 原文→`structured.clothes.length===14` 且 networkData 保留原文；桥返回信封不符 JSON→structured=null 且 networkData 保留；网络失败路径→structured undefined（现有用例补断言）。
- **验收**：先红（现返回无 structured）后绿；全文件测试绿。

### T4 IPC 透传 + 渲染层类型

- **文件**：`src/main/ipc/handlers/decrypt-handler.ts`（data 增 `structured: result.structured` 一行）；`src/renderer/vite-env.d.ts`（环境接口 + decodeClothDiy data 增 `structured?: ClothDiyStructuredOutfit | null`）；`src/main/ipc/handlers/decrypt-handler.test.ts`（透传断言：有值透传/无值缺省）。
- **验收**：handler 测试先红后绿；`npm run typecheck` 绿。

### T5 核心路径保护 + 全量回归

- `decryption-service.ts`、`decrypt-handler.ts` 顶部第 1 行各加 `// @core-change: 搭配码 networkData 结构化解析新增 structured 通道字段`（两文件均属保护路径；测试文件豁免）。
- `npm run verify`（typecheck+lint+core-gate+format+相关单测）→ `npm test` 全量 → `git status --porcelain` 复核仅预期文件。

### T6 提交（用户确认后）

- `feat(decrypt): 搭配码 networkData 结构化解析新增 structured 字段`；docs/plans 阶段文档是否随提交由用户定。

## 五、必备章节声明

- **依赖声明**：零新增（zod ^4.4.3、vitest 均已有）。
- **启动说明**：无需 `npm run dev`；验证链 = `npx vitest run src/main/services/decryption-service.test.ts src/main/ipc/handlers/decrypt-handler.test.ts` → `npm run verify` → `npm test`。真机联调（可选）：`npm run dev` + 分享码解码对话框粘贴契约样本码。
- **错误处理**：语义表全覆盖；解析路径零抛错（归一化/JSON.parse/取值全部内层防护），失败仅 warn 且不含 networkData 内容与 UID。
- **参数校验**：IPC 层既有 zod（min1/max1024）不变；解析层 = 信封 zod + 语义表规则（poseId 正整数、id>0 有限数、数组形态）。
- **不做什么**：第三方数据源（阶段 2）、磁盘缓存（阶段 3）、UI（阶段 4）、decodeFileParams 行为、electron-api.ts、ClothParams 扩展、IPC_CONTRACT.md（已核实未收录 decrypt 域）。
