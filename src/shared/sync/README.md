# src/shared/sync —— NikkiSync 同步协议模块

NikkiSync Protocol v1 的 WXNN 内部移植版。协议字段名、路由常量、错误码与上游
NikkiSync 逐字一致（客户端兼容硬约束，禁止变更）。

## 唯一真相源（阶段 9 决策）

本目录是 XiangCe 侧协议契约的**唯一真相源**：

- `protocol.ts` + `domain-types.ts` = 全部服务层、
  仓储层、IPC 与渲染进程消费的协议符号来源。
- `@nikkisync/protocol` **不再是契约来源**，也不在 `package.json` 依赖声明里（自包含方案，
  链接由 `npm run link:nikkisync` 建立）：上游包的 ESM 图含 top-level await，值面无法静态导入。
- 两侧不再靠人工 diff 防分叉：`src/main/nikkisync/protocol-contract.ts` 提供逐值快照与差异函数，
  `protocol-drift.test.ts` 在链接就绪时把上游 `API_ROUTES` / `API_ERROR_CODES` / 枚举表与本地快照
  做机械比对（未链接时整件 skip，纯函数行为由 `protocol-contract.test.ts` 长期覆盖）。

## 文件

| 文件               | 内容                                                                                                              | 上游对应（commit `b397e0e` = tag `v1.0.27-public-beta.1`） |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `protocol.ts`      | 协议契约：`PROTOCOL_VERSION`、`API_ROUTES`、`API_ERROR_CODES`、`CHANGE_TYPES`、消息类型、type guard、路由构建函数 | `NikkiSync/packages/protocol/src/index.ts`                 |
| `domain-types.ts`  | 领域类型：`NikkiAsset`、`MediaResource`、`InfinityPhotoMetadata`、资源角色/资产状态等常量                         | `NikkiSync/packages/core/src/types.ts`                     |
| `protocol.test.ts` | 逐值一致性 + 路由编码 + 配对 URI + type guard 测试                                                                | —                                                          |

与上游的代码差异（共两处，均已注释说明，类型形状与符号名不变）：

1. `protocol.ts` 对 `@nikkisync/core` 的 import / re-export 改为指向 `./domain-types`。
2. `AssetListResponse` 由上游的空接口 `interface ... extends CursorPage<AssetSummary> {}`
   等价改写为类型别名 `type ... = CursorPage<AssetSummary>`（WXNN ESLint
   `no-empty-object-type` 规则不允许空接口；符号名与类型形状不变）。

模块零运行时依赖（无 npm 包、无 Node 内置模块），满足 `src/shared` 禁
Node/Electron import 的约束。

## 消费方式

统一从 `protocol.ts` 导入（domain-types 由其原名 re-export，与上游
`@nikkisync/protocol` 的导出面一致）：

```ts
import { API_ROUTES, API_ERROR_CODES, PROTOCOL_VERSION } from '../../shared/sync/protocol'
import type { NikkiAsset, ServerInfoResponse } from '../../shared/sync/protocol'
```

不挂 `src/shared/types` barrel；相对路径直连导入，同 `errors/` 惯例。

## 维护规则

- **禁止就地修改协议语义**（字段名、路由、错误码、`buildPairingUri` 的 URI 结构等）。
- 上游演进时按文件 diff 重新移植（两个文件与上游 1:1 对应），并同步更新
  `protocol.test.ts` 的逐值断言；上游改动需经评审确认客户端兼容后再移植。
- 新增符号时要同步 `src/main/nikkisync/protocol-contract.ts` 的 `VENDORED_CONTRACT_SYMBOLS`
  与快照采集（否则该文件的键集断言即失败）；链接态漂移由 `protocol-drift.test.ts` 拦截。
- 接口型 DTO（如 `AssetSummary`）没有运行时值，其字段集由 `protocol-drift.test.ts` 的
  `extractInterfaceMembers` 用例直接比对上游 `dist/src/index.d.ts`；上游加字段而未补移植会转红。
- 本目录不在 core-path 保护清单内，无需 `@core-change` 注释；但协议内容本身的
  变更视同协议契约变更，需在提交说明中注明上游对应变更。
