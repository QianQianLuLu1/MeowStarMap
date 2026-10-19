# 同步集成 · 阶段 1：NikkiSync Protocol v1 移植计划（01-protocol-port-plan）

> 状态：已批准（2026-10-11）｜ 对应交付物：`src/shared/sync/`（protocol.ts / domain-types.ts / protocol.test.ts / README.md）｜ 本阶段对 NikkiSync 仓库只读，零改动

## 1. 目标

将 NikkiSync 的协议层（Protocol v1）移植到 WXNN XiangCe 作为内部模块：

- 协议字段名、路由常量、错误码与原版**逐字一致**（客户端兼容硬约束，不可变更）。
- 类型完整、可被 WXNN 任意模块导入。
- 零运行时依赖，不引入 NikkiSync 其他包（规避阶段0识别的 ESM/CJS 互操作风险——纯源码移植天然无此问题）。
- 只新增文件，不修改任何现有文件与配置。

## 2. 探查结论（计划依据）

- 移植最小集 = 上游两个文件，逐字可移植：
  - `NikkiSync/packages/protocol/src/index.ts`（337 行）：`PROTOCOL_VERSION`、`API_ROUTES`（12 项，含 4 个函数路由）、`API_ERROR_CODES`（9 个错误码）、`CHANGE_TYPES`、`WsEvent` 联合类型、配对类型（`PairingQrPayload`/`PairRequest`/`PairResponse`/`AuthHeaders`）、搜索/统计/变更/分页等全部消息类型、3 个 type guard、5 个路由构建函数。
  - `NikkiSync/packages/core/src/types.ts`（147 行，零 import）：`METADATA_SCHEMA_VERSION`、`ASSET_TYPES`、`RESOURCE_ROLES`、`ASSET_STATES` 及 `NikkiAsset`/`MediaResource`/`InfinityPhotoMetadata`/`MotionAssetInfo` 等领域类型。protocol 对 core 的实际依赖仅此一个文件。
- 上游源码无外部 npm 依赖、无 node 内置 import、无 `any`、字符串字面量无中文（WXNN ESLint i18n 护栏可过）、格式与 WXNN prettier 规则一致（无分号/单引号）。
- 放置目录定为 `src/shared/sync/`：协议类型是跨进程契约，shared 是项目既有共享类型归宿；main tsconfig（include `../shared/**/*`）与根项目经 import 图均自动纳入类型检查；vitest node project 自动收录测试；不在 core-path 四个受保护目录内，无需 `@core-change`；满足 shared 禁 Node/Electron import 硬约束。
- 命名冲突已排查：`API_ROUTES`/`API_ERROR_CODES`/`PROTOCOL_VERSION` 等全仓无冲突；与既有 `ERROR_CODES`/`IPC_ERROR_CODES`/`IPC_CHANNELS` 语义不同、互不干扰，不挂 barrel，消费方相对路径直连导入（同 `errors/`、`settings-keys.ts` 惯例）。

## 3. 依赖声明

| 类别                | 内容                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| 新增 npm 依赖       | **无**（协议模块零运行时依赖；无需 zod——上游为手写 type guard）                                          |
| 复用既有依赖        | vitest ^5.0.3（测试）、typescript ^5.9.3（类型检查）                                                     |
| 配置改动            | **无**。不改 package.json、不改任何 tsconfig（`URLSearchParams` 在 main 项目 lib `ES2020`+`DOM` 中可用） |
| 对 NikkiSync 的依赖 | 仅移植时读取源码（commit `284d4a6`），运行时零依赖                                                       |

## 4. 新增文件及输入输出

| 路径（WXNN XiangCe/ 下）                         | 操作 | 输入 → 输出                                                                                                                                                              |
| ------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/sync-integration/01-protocol-port-plan.md` | 新增 | 本计划                                                                                                                                                                   |
| `src/shared/sync/README.md`                      | 新增 | 模块说明：上游溯源、逐字移植维护规则、消费方式                                                                                                                           |
| `src/shared/sync/domain-types.ts`                | 新增 | 上游 `packages/core/src/types.ts` 147 行逐字移植；仅文件头加 WXNN 风格中文 JSDoc                                                                                         |
| `src/shared/sync/protocol.ts`                    | 新增 | 上游 `packages/protocol/src/index.ts` 337 行逐字移植；唯一代码改动：`from '@nikkisync/core'` → `from './domain-types'`（import 与 re-export 两处），保留原协议规则头注释 |
| `src/shared/sync/protocol.test.ts`               | 新增 | vitest 测试，覆盖正常/异常/边界（见 §7）                                                                                                                                 |

**修改的现有文件：无。**

拆两文件而非合并的原因：与上游包文件 1:1 对应，后续阶段可直接按文件 diff 同步上游演进；保持上游"protocol 原名 re-export 领域类型、PC 端不另建 DTO"的契约。消费方统一 `from '<相对路径>/shared/sync/protocol'` 导入。

> **阶段 9 回写（真相源定案）**：本目录即 XiangCe 侧协议契约的**唯一真相源**；`@nikkisync/protocol`
> 不再作为契约来源（已退出依赖声明与类型锚点），仅作为链接态漂移比对对象。
> 防分叉手段：`src/main/nikkisync/protocol-contract.ts`（逐值快照 + 差异函数）与
> `protocol-drift.test.ts`（未链接时 skip）。口径见 `src/shared/sync/README.md` 与
> [`09-legacy-debt-remediation-plan.md`](./09-legacy-debt-remediation-plan.md) §5。

## 5. 启动 / 验证方式（命令表）

| 动作       | 命令                             | 期望                                         |
| ---------- | -------------------------------- | -------------------------------------------- |
| 红灯确认   | `npx vitest run src/shared/sync` | 实现前失败（模块不存在）                     |
| 绿灯确认   | 同上                             | 全部用例通过                                 |
| 类型检查   | `npm run typecheck`              | 通过、0 错误（基线 0）                       |
| Lint       | `npm run lint`                   | 0 errors、warnings ≤ 11（基线 11，均为存量） |
| 回归子集   | `npx vitest run src/shared/sync` | 全绿                                         |
| 改动面核对 | `git status --porcelain`         | 仅本计划 §4 所列新增文件                     |

## 6. 错误处理与参数校验

- 模块为纯类型 + 常量 + 纯函数，无 I/O、无新增错误路径。
- 运行时校验面仅上游 3 个 type guard（`isProtocolVersionSupported`/`isAssetType`/`isResourceRole`），原样保留；URL 编码逻辑（`encodeURIComponent`）逐字保留，不新增校验逻辑。
- 若上游代码在 WXNN 编译配置下报错（预期不会：WXNN 未开 `exactOptionalPropertyTypes`/`noUncheckedIndexedAccess`，比上游宽松，编译方向安全），记录并做**最小适配**，禁止改动任何符号名或常量值。

## 7. 基础测试用例

**正常（T1–T6）**

- T1 协议版本冻结：`PROTOCOL_VERSION === 1`，`isProtocolVersionSupported(1) === true`（移植上游用例）。
- T2 五张常量表逐值断言：`ASSET_TYPES`、`RESOURCE_ROLES`、`ASSET_STATES`、`CHANGE_TYPES`、`API_ERROR_CODES`（与上游清单逐项一致，9 个错误码含 `protocol_mismatch`/`revision_too_old` 等）。
- T3 静态路由：`API_ROUTES` 的 `serverInfo`/`pair`/`assets`/`suitSearch`/`clothingSearch`/`profileStats`/`changes`/`websocket`（8 项）逐值断言；函数路由 `asset`/`metadata`/`resource`/`clothingThumbnail` 正常值。
- T4 路由构建函数：`buildAssetsRoute` 全参（cursor/limit/type/includeDeleted）/无参（`/v1/assets`）/部分参；`buildChangesRoute(42)`；`buildSuitSearchRoute`/`buildClothingSearchRoute` 的 q 编码。
- T5 配对 URI：`buildPairingUri` 输出 `NS1|` 前缀、7 段、TLS 指纹结尾（移植上游用例）。
- T6 协议对象形状冒烟：`AssetSummary`（含 gameVersion/gameVersionSource 附加字段，移植上游用例）与 `NikkiAsset` 最小合法对象赋值。

**异常（T7–T8）**

- T7 `isProtocolVersionSupported(2)`、`('1')`、`(null)` → false。
- T8 `isAssetType('movie')` → false；`isResourceRole('source')` → false。

**边界（T9–T10）**

- T9 特殊字符编码：assetId 含 `/`（`asset%2Fa`，上游用例）、空格（`resource%20b`）、`?`；`buildPairingUri` 特殊字符 token。
- T10 `buildAssetsRoute({})` 空 query 对象；`limit: 0` 的数字字符串化。

## 8. 可判定的验收标准

- [ ] 本计划文件已写入 `docs/sync-integration/`
- [ ] `npx vitest run src/shared/sync` 全绿，红灯→绿灯流程已执行并留痕
- [ ] `npm run typecheck` 通过、0 错误（无新增）
- [ ] `npm run lint` 0 errors 且 warnings ≤ 11（无新增）
- [ ] `protocol.ts` 导出符号与上游一致（常量表、`API_ROUTES` 12 项、8 个函数、全部类型 re-export 逐项核对）
- [ ] 未修改任何现有文件（`git status` 仅新增）；未新增 npm 依赖
- [ ] NikkiSync 仓库工作区无新改动（仅阶段0已有的 `.mimosa/`、`.zcode/` 未跟踪目录）
- [ ] WXNN 侧改动已 commit 到 `feature/sync-integration-01-protocol-port`，commitlint 通过
- [ ] 未解决问题已记录于 §10 并评估是否阻塞下一阶段

## 9. 分支与提交

- WXNN 侧：自 `feature/sync-integration-00-audit`（`e26ebe2`）切出 `feature/sync-integration-01-protocol-port`，阶段结束 commit：`feat(shared): 移植 NikkiSync Protocol v1 至内部模块`。不 push（除非用户要求）。
- NikkiSync 侧：本阶段零改动，不建分支。后续若需改其源码，独立分支提 PR（阶段0既定纪律）。

## 10. 已识别风险与未解决问题

| 风险/问题                                                                                              | 对策/评估                                                          |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| WXNN 未开 `exactOptionalPropertyTypes`/`noUncheckedIndexedAccess`，比上游宽松                          | 编译方向安全；序列化行为由测试锚定。不阻塞                         |
| 测试文件不被 `npm run typecheck` 覆盖（main tsconfig exclude `*.test.ts`，项目现状）                   | 实现文件被 tsc 完整检查；测试质量靠 vitest 运行时 + eslint。不阻塞 |
| `src/shared/sync` 不在 vitest coverage 豁免清单，全量 `test:coverage` 阈值（branches 80%）会计入本模块 | 本模块测试覆盖全部分支路径；全量 coverage 由 CI 兜底。不阻塞       |
| 行尾 CRLF（`core.autocrlf=true`）                                                                      | 新增文件以 LF 写入，pre-commit prettier（`endOfLine: lf`）兜底     |

## 11. 执行记录

（2026-10-11 回填，全部实测）

| 步骤         | 结果                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------- |
| 分支         | 自 `feature/sync-integration-00-audit`（`e26ebe2`）切出 `feature/sync-integration-01-protocol-port` |
| 红灯         | `npx vitest run src/shared/sync` → `Cannot find module './protocol'`，退出码 1 ✅                   |
| 绿灯         | 移植后 24 个用例全部通过，退出码 0 ✅                                                               |
| typecheck    | `npm run typecheck` 通过、0 错误（无新增）✅                                                        |
| lint         | 0 errors、11 warnings（全部为存量 BOM 基线，无新增）✅                                              |
| 导出符号核对 | 与上游 `protocol/src/index.ts` 逐符号比对：61/61 一致，零缺失零多余 ✅                              |
| 改动面       | WXNN 仅新增 5 个文件；package.json 无 diff；NikkiSync 工作区零改动 ✅                               |

**执行中的最小适配（1 处，已记录）**：上游 `AssetListResponse` 为空接口
`interface AssetListResponse extends CursorPage<AssetSummary> {}`，触发 WXNN ESLint
`@typescript-eslint/no-empty-object-type`（上游无此规则）。按 §6 预案等价改写为类型别名
`type AssetListResponse = CursorPage<AssetSummary>`，符号名与类型形状不变，文件内已加注释，
README 已同步登记。无其他偏差。

**遗留问题评估**：无阻塞项。§10 三项非阻塞风险维持原判；全量 `npm test`（5356 用例）由
CI 分片兜底，本阶段按纪律执行类型检查 + 相关测试子集。
