# `docs/sync-integration/` 索引

> 路径作用域：本索引与其列出的阶段计划混指本仓与上游 NikkiSync 仓的路径；属上游或当时设计未落地的项按原文保留，不在本仓解析范围内。

本目录是 NikkiSync 同步集成的**阶段计划与审计报告**，属已交付代码的设计真相源（design-of-record），
不是会被清理的一次性轮次快照。**共 16 份 md + 1 份校验脚本**。

阅读前需要先知道两件事，否则会误判编号与状态。

## 1. 编号 01–05 被两条并行轨道各用了一次

| 轨道                     | 目录归属                                                              | 文档                                                                                                                                                                                                                                                                                                        | LAN 服务真相                                        |
| ------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **移植面**（本仓自研）   | `src/shared/sync/` + `src/main/sync/` + `src/main/database/sync-*.ts` | `01-protocol-port-plan.md` → `02-sync-repository-plan.md` → `03-auth-pairing-plan.md` → `04-http-server-plan.md` → `05-ui-scanner-integration-plan.md`                                                                                                                                                      | `src/main/sync/server/sync-server.ts`               |
| **内嵌面**（复用上游包） | `src/main/nikkisync/`                                                 | `00-audit-plan.md` / `00-code-audit-plan.md` / `00-code-audit-report.md` / `00-nikkisync-pc-audit-report.md` → `01-dependency-link-plan.md` → `02-runtime-embed-plan.md` → `03-sync-server-plan.md` → `04-ui-bridge-plan.md` → `06-e2e-plan.md` / `06-e2e-report.md` → `09-legacy-debt-remediation-plan.md` | 上游 `@nikkisync/pc-companion` 的 `LocalSyncServer` |

移植面立项于 2026-10-11（`01-protocol-port-plan` / `02-sync-repository-plan` 均记「已批准
（2026-10-11）」），内嵌面重审立项于 2026-10-12（`00-audit-plan` / `01-dependency-link-plan`
记「已批准（2026-10-12）」），于是各自都用了一遍 01–05。**看到 `03-*.md` 时先确认是哪条轨道**：
`03-auth-pairing-plan.md` 属移植面，`03-sync-server-plan.md` 属内嵌面。

两条轨道**都落地了**，不是后者推翻前者：`sync:*`（移植面）与 `nikkisync:*`（内嵌面）两套通道当前并存。
但**默认生效的是内嵌面**——`src/main/app/sync-server-setup.ts` 的
`PORTED_SYNC_AUTOSTART_ENABLED = false` 使移植面服务不再自启。完整口径见
[`src/main/sync/AGENTS.md`](../../src/main/sync/AGENTS.md) 的「与 `src/main/nikkisync/` 的关系」一节，
该节同时澄清了 `src/main/nikkisync/AGENTS.md` 硬约束 3「不新建任何 HTTP/TLS/WS/mDNS 实现」
指的是**内嵌面不复用移植面代码**，而非移植面服务不存在。

## 2. 各文档状态一览（照抄各文件首部 `状态：` 行，未做推断）

| 文件                                 | 首部记载状态                                    | 复核提示                                                                                                                                                                                                                                                                                               |
| ------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `00-audit-plan.md`                   | 已批准（2026-10-12）                            | —                                                                                                                                                                                                                                                                                                      |
| `00-code-audit-plan.md`              | 已批准并执行                                    | 产出即 `00-code-audit-report.md`                                                                                                                                                                                                                                                                       |
| `00-code-audit-report.md`            | 报告体                                          | 其中 `docs/GPT_HANDOFF_2026-09-04.md` 属**上游 NikkiSync 仓**路径                                                                                                                                                                                                                                      |
| `00-nikkisync-pc-audit-report.md`    | 报告体                                          | 大量 `src/index.ts` 等路径指上游仓                                                                                                                                                                                                                                                                     |
| `01-dependency-link-plan.md`         | 已批准（2026-10-12）                            | 交付物 `scripts/link-nikkisync.ts`（计划写的是 `.mjs`，实现落 `.ts`）                                                                                                                                                                                                                                  |
| `01-protocol-port-plan.md`           | 已批准（2026-10-11）                            | 交付物 `src/shared/sync/`                                                                                                                                                                                                                                                                              |
| `02-runtime-embed-plan.md`           | 内嵌面阶段 2                                    | 交付物 `src/main/nikkisync/runtime-*`                                                                                                                                                                                                                                                                  |
| `02-sync-repository-plan.md`         | 已批准（2026-10-11）                            | 交付物 `src/main/database/sync-*.ts`                                                                                                                                                                                                                                                                   |
| `03-auth-pairing-plan.md`            | 移植面阶段 3                                    | 交付物 `src/main/sync/{auth,pairing,identity}-service.ts` + `cert-der.ts`                                                                                                                                                                                                                              |
| `03-sync-server-plan.md`             | 内嵌面阶段 3                                    | 交付物 `nikkisync:*` 服务面通道                                                                                                                                                                                                                                                                        |
| `04-http-server-plan.md`             | **执行中**                                      | 与 `05-ui-scanner-integration-plan.md` 首部「前置：阶段 4（HTTPS 同步服务器 + WS）已验收（commit 015150b）」矛盾——前者已验收、本文件仍写执行中。以代码为准：`src/main/sync/server/` 存在且由 `initSyncServer()` 装配，只是不再自启                                                                     |
| `04-ui-bridge-plan.md`               | 内嵌面阶段 4                                    | 交付物 `syncGalleryStore` 与 `src/renderer/utils/share-card/`                                                                                                                                                                                                                                          |
| `05-ui-scanner-integration-plan.md`  | **执行中**                                      | 文中 `src/main/sync/scan-journal.ts` 与 `src/renderer/pages/settings/sync-sections.tsx` 为当时规划路径；实际落地分别是 `src/main/scanner/scan-journal.ts`，以及 `src/renderer/pages/sync-gallery/`（设置页同步节后来改名，见 `docs/archive/plans/2026-10-16-sync-service-to-sync-gallery.md`，不入仓） |
| `06-e2e-plan.md`                     | 执行中                                          | 交付物 `scripts/sync-e2e/`；基线数字是当时快照                                                                                                                                                                                                                                                         |
| `06-e2e-report.md`                   | 已完成（S13 Android 真实客户端未覆盖，见其 §6） | —                                                                                                                                                                                                                                                                                                      |
| `09-legacy-debt-remediation-plan.md` | 已批准（2026-10-13）                            | 编号 07/08 **不存在**：`07-bidirectional-sync-plan.md` 从未提交，仅与 `protocol-extension.ts` 一起存于本机 `stash@{0}`（分支 `feature/sync-integration-07-bidirectional-sync`，标记 `phase7-wip-parked`）；08 从未启用                                                                                 |
| `verify-audit.mjs`                   | 审计取证脚本                                    | 非文档                                                                                                                                                                                                                                                                                                 |

## 3. 本目录的三条使用约定

1. **不要按本目录的规划路径去找文件**。阶段计划保留当时的设计命名是有意为之（改了就看不出
   决策过程），落点以 `src/main/sync/AGENTS.md`、`src/main/nikkisync/AGENTS.md` 与代码为准。
2. **每份文档首部的「路径作用域」声明是约定而非装饰**：这些文档混指本仓与上游 NikkiSync 仓的路径，
   `scripts/check-md-links.ts` 据此把无法在本仓解析的引用降级为提醒。新增本目录文档时照抄该声明行。
3. **不要把这些文档移入 `docs/archive/`**。它们是已交付代码的设计真相源；归档判定只适用于
   `docs/plans/` 那种「一轮会话一份执行记录」的轮次快照。
