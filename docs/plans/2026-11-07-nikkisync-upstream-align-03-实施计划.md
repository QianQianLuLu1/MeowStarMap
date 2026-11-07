# 2026-11-07 NikkiSync PC 端对齐 v1.0.31（4cb71e2）实施计划

> 状态：执行中（批准于 2026-11-07）。核对范围：上游 `ToStardust/NikkiSync` main，基准提交 `4cb71e2`（tag `v1.0.31-public-beta.1`，2026-11-06，"feat: release 1.0.31 WeChat integration and client editions"，110 文件 +3020/−459），其父提交即上一轮锚点 `589b932`（v1.0.30-public-beta.1）。本轮差异 = 这一个提交；`packages/protocol` 未变，vendored 协议（`src/shared/sync/`）保持对齐。

## 一、Context（背景与目标）

当前项目「同步图库」内嵌面（`src/main/nikkisync/` 经 junction 消费同级检出 `../NikkiSync` 的 `@nikkisync/*` 四包）上次对齐锚点为上游 `589b932`（提交 e1aca94 完成，fb57596 / 21a4803 / 69343e3 后续加固）。目标：以 4cb71e2 为基准，把 PC 端（`apps/pc-companion` + `packages/database`）功能完整搭载进内嵌面，修复宿主组装层与上游契约不符的既有缺陷（D1–D5），并按用户裁决**一并补齐本机控制页四个面板**（灵感库/整理队列/扫描目录/账号）。移动端 / 小程序 / windows-shell 不在范围。

## 二、差异与待同步清单

### A. 上游侧（junction 消费，更新检出 + 重建即自动生效）

| 改动                                                        | 说明                                                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `apps/pc-companion/src/wechat/WeChatDeletion.ts`（新增）    | 小程序批量删除：意图 → PC 确认 → 回收站（`withWeChatDeletion` 包装源；`deletionConnected/Disconnected` 会话钩子） |
| `apps/pc-companion/src/wechat/WeChatInspiration.ts`（新增） | 小程序灵感库：列表/保存/删除/参考图上传下载（`withWeChatInspiration`）                                            |
| `apps/pc-companion/src/wechat/WeChatGalleryService.ts`      | 配置新增 `hosts`（多网卡 QR）、payload 增 `deletion:1`、生命周期错误自愈（server error → disconnected + stop）    |
| `apps/pc-companion/src/wechat/GalleryRuntime.d.mts`         | GallerySource 面扩展（deletion 钩子等）                                                                           |
| `apps/pc-companion/src/desktop/DesktopControlServer.ts`     | 新增 `/wechat-entry.png` 路由 + `wechatEntryImage` 配置                                                           |
| `apps/pc-companion/src/desktop/DesktopPage.ts` 及各面板     | 微信入口码面板、首次使用引导重构、app-only 网格、四面板                                                           |
| `apps/pc-companion/src/metadata/MetadataOnlineConsent.ts`   | 干净安装默认改为不同意（本仓 K2 已 fail-closed 更严，行为不变）                                                   |
| `apps/pc-companion/src/organizer/DeletionQueue.ts`          | `cancelTransientSession` 等（+8）                                                                                 |
| `apps/pc-companion/src/scanner/*`（4 文件）                 | pendingup 临时缩略图排除、云端照片日期/版本判定改善                                                               |
| `packages/database/src/models.ts` / `asset-repository.ts`   | 小改（junction 自动生效）                                                                                         |

### B. 项目侧待改（宿主组装层）

1. **2 个新深入口**：`wechat/WeChatDeletion.js`、`wechat/WeChatInspiration.js`（facade 常量 + 装载 + verify 清单双侧同步）。
2. **微信画廊组装对齐新版 windows-app.ts**：`withWeChatDeletion(withWeChatInspiration(createIndexedPreviewSource(...), inspirations, resize), deletions)`、`hosts`、`wechatEntryImage`、scanRoots 逐个 `realpath`。
3. **控制页面板**：向 dashboard 透传 `inspirations / accounts / deletions / scanDirectories`（会话同一实例），目录变更联动 `wechat.stop`。
4. **既有缺陷修复（D1–D5，均经源码核实）**：
   - D1 `resize` 传脚本路径而非字节变换函数（上游契约 `resize(bytes) → Promise<Uint8Array>`）；
   - D2 `rotatePng` 同上；
   - D3 `exportLive` 返回 options 对象而非调用上游 `exportLive()`；
   - D4 `WeChatIconProvider` 无参构造（上游要求 `(cache, resize)` 必填 ⇒ 图标恒不可用）；
   - D5 dashboard `getStatus` 传 dashboard 自身端口而非 LAN 同步服务端口。
5. **资源暂存**：`assets/branding/wechat-mini-entry.png` 入暂存清单。

### C. 明确不同步（记录理由）

- `apps/mobile/**`、`apps/wechat-mini-program/**`、`tools/wechat-gallery/**`（非 PC 宿主；所需 PS 脚本已在暂存清单）。
- `apps/windows-shell/**`（上游 C# 托盘壳；本仓以 Electron 承载同等生命周期）。
- 上游发版脚本（build-wechat-candidate.mjs、package-client-editions.ps1、根 package.json 发版段；均位于**上游仓**，非本仓路径）与 README / 上游 docs/releases 文档。
- 控制页 `metadataPrivacy` 面板：继续走应用内 K2 同意块（e1aca94 口径；上游页面在该配置缺席时整节省略，非破相）。本轮只补用户裁决的四面板。
- `NIKKISYNC_APP_ONLY` 分版构建：嵌入态恒双能力（wechatEnabled=true），不适用。
- 4 份 legal 文档上游有更新：由 `stage:nikkisync-pc --apply` 重跑自动刷新，无代码改动。

## 三、实施节点（TDD：先红灯测试，再实现，再转绿）

### 节点 0：更新上游检出 + 重建 + 基线

- 操作：`git -C ../NikkiSync fetch origin && git -C ../NikkiSync checkout 4cb71e2…`（沿用现有 detached 工作流）→ 检出内 `npm install && npm run build` → 本仓 `npm run link:nikkisync`（幂等）+ `npm run verify:nikkisync`。
- 验收：`verify:nikkisync` 全绿；链接态基线 `npx vitest run src/main/nikkisync/protocol-drift.test.ts src/main/nikkisync/runtime-facade.linked.test.ts src/main/nikkisync/sync-server.linked.test.ts` 全绿（作为后续回归基准）。

### 节点 1：暂存 wechat-mini-entry.png

- 文件：`scripts/stage-nikkisync-pc-assets.ts`（`PC_ASSET_SPECS` 增 `{from: 'assets/branding/wechat-mini-entry.png', to: 'wechat-mini-entry.png'}`）。
- 输入/输出：上游检出资源 → `resources/nikkisync/pc/wechat-mini-entry.png`。
- TDD：先在 `src/main/nikkisync/pc-companion-services.test.ts` 的 stage 断言区新增「PC_ASSET_SPECS 含 wechat-mini-entry.png 且目标落在根内」（红）→ 实现（绿）。
- 验收：测试绿 + `npx tsx scripts/stage-nikkisync-pc-assets.ts --apply` 落地文件存在。

### 节点 2：深入口常量 + verify 清单（双侧必须同批改）

- 文件：`src/main/nikkisync/runtime-facade.ts`（新增 `WECHAT_DELETION_DEEP_ENTRY`、`WECHAT_INSPIRATION_DEEP_ENTRY` 并在 `loadRuntimeSurface` 装载）、`scripts/verify-nikkisync-link.ts`（`NIKKISYNC_CAPABILITY_ARTIFACTS` 与 `LOAD_CHAIN_ROOTS` 各增 2 项）。
- 约束：`scripts/__tests__/verify-nikkisync-link.test.ts` 从 facade 源码抽取 `*_DEEP_ENTRY` 字面量与 `LOAD_CHAIN_ROOTS` 逐项比对，只改一侧必红（天然红灯）；`scripts/pre-dist-check.ts` 复用能力清单自动覆盖新入口。
- 验收：`npx vitest run scripts/__tests__/verify-nikkisync-link.test.ts` 绿 + `npm run verify:nikkisync` 绿。

### 节点 3：会话上下文扩展

- 文件：`src/main/nikkisync/runtime-types.ts`（`PcCompanionSessionContext` 增 `inspirations? / deletions? / extraDirectories? / accounts? / thumbnailCache? / syncPort?`；`NikkiSyncRuntimeSession` 增 `thumbnailCache?: unknown`）、`src/main/nikkisync/runtime-facade.ts`（`createRuntimeSession` 挂出 thumbnailCache——仅 `metadataThumbnailCacheDir` 给出且构造成功时存在）、`src/main/nikkisync/runtime-manager.ts`（`pcCompanionContext()` 透传；`syncPort: () => state.syncAddress?.port`）。
- 输入/输出：会话内部引用 → 只读上下文（同一引用，不复制不包装）。
- TDD（`src/main/nikkisync/runtime-manager.test.ts`）三例：正常（假会话带四实例 + 缩略图缓存 ⇒ 上下文逐字段同引用透传）；异常（会话未建 ⇒ undefined，不伪造）；边界（字段缺席 ⇒ 上下文不挂键）。
- 验收：`npx vitest run src/main/nikkisync/runtime-manager.test.ts src/main/nikkisync/runtime-facade.test.ts` 绿。

### 节点 4：pc-companion-services 组装对齐（核心节点）

- 文件：`src/main/nikkisync/pc-companion-services.ts`。
- 改动面：
  1. `PcCompanionSurface` 增可选成员：`withWeChatDeletion / withWeChatInspiration / resizeForWeChat / resizeWeChatIcon / rotatePng / exportLive / listLanIpv4`（老链接缺件 ⇒ 降级不包装，不抛）。
  2. `loadPcCompanionSurface` 增载 2 个新深入口 + 复用 `LAN_ADDRESS_DEEP_ENTRY`，并从已装载模块补取上述导出。
  3. `createPcCompanionServices`：snapshot 组装逐字对齐新版 windows-app.ts——scanRoots 逐个 `realpath` 过滤 → `createIndexedPreviewSource` → `withWeChatInspiration(source, inspirations, resize 回调)` → `withWeChatDeletion(source, deletions)`；修复 D1–D4（resize/rotatePng/exportLive 委托上游函数，`WeChatIconProvider(cache, resizeWeChatIcon 回调)` 构造）；`WeChatGalleryService` config 增 `hosts`（`listLanIpv4` 装载失败则不传，降级单 host）；dashboard config 增 `wechatEntryImage`（暂存资源存在时）与 `inspirations/accounts/deletions/scanDirectories`。
  4. scanDirectories 传**会话同一实例**，外层薄包装 add/remove/rescan：委托后 `await wechat.stop()`（对齐上游 onScopeChanged 联动，不改 facade 回调）。
  5. 修复 D5：`getStatus` 端口改取 `syncPort()`（LAN 同步服务实际端口，未运行回落配置端口）。
- TDD（`src/main/nikkisync/pc-companion-services.test.ts`）：
  - 正常：snapshot 产物依次经两层包装（记录调用顺序与参数）；WeChatGalleryService 收到 hosts 函数；dashboard 收到 wechatEntryImage（资源在位）与四实例（同引用）；resize/rotatePng 为字节变换函数且 exportLive 委托上游；WeChatIconProvider 以 (cache, resizeFn) 构造；getStatus 端口来自 syncPort。
  - 异常：withWeChat* 深入口缺席 ⇒ 不包装、组装不抛；wechatEntryImage 缺失 ⇒ 不挂键；listLanIpv4 缺席 ⇒ 不传 hosts；包装方法抛错照原样上抛。
  - 边界：scanRoots 含不存在/别名路径 ⇒ realpath 过滤后不伪造；inspirations/deletions 缺席 ⇒ 对应包装整段跳过；目录变更联动在 add/remove/rescan 后各停一次 wechat。
- 验收：`npx vitest run src/main/nikkisync/pc-companion-services.test.ts` 全绿（既有 B1/B2/B3/F1/F5/C1 回归不红）。

### 节点 5：装配层接线

- 文件：`src/main/app/nikkisync-runtime-setup.ts`（`assemblePcCompanionServices` 把 `liveContext` 新字段与 `syncPort` 传给 `startPcCompanionServices`；`StartPcCompanionOptions` 同步扩字段）。
- 验收：`npm run verify` 相关子集绿；`npx vitest run src/main/nikkisync` 全绿。

### 节点 6：文档回写（最小）

- 本计划文件（执行记录区随节点回写）。
- `src/main/nikkisync/AGENTS.md`：对齐锚点行更新为「4cb71e2（v1.0.31）；协议层仍 589b932（未变）」。

### 节点 7：全量回归

- `npm run verify`（typecheck + eslint 只读 + prettier --check + 相关单测）；`npm test`（全量）；`npm run verify:nikkisync`；链接态终验 `npx vitest run src/main/nikkisync`。
- 改动保留在工作区不自行提交；`git status --porcelain` 复核无意外文件。

## 四、依赖声明

- 无新增 npm 依赖（`qrcode`、`ffmpeg-static`、`ffprobe-static` 均既有）。上游四包仍走 junction（`npm run link:nikkisync`），继续不出现在 package.json 依赖声明（自包含铁律）。
- 上游检出从 589b932 前进到 4cb71e2（`git fetch + checkout`，非 npm 安装）。

## 五、启动说明

1. 前置：Node ≥ 24（上游 engines）、上游检出可写、本仓依赖已装（junction 若被 `npm install` 剪掉先重跑 `npm run link:nikkisync`）。
2. 上游重建：`cd ../NikkiSync && npm install && npm run build`（core/protocol/database/pc 四段 + esbuild GalleryRuntime）。
3. 本仓验证：`npm run verify:nikkisync` → `npm run dev` 手动验收集成态（同步服务页 → PC 控制页 → 微信画廊出码）。
4. 打包验证（可选）：`npm run dist:win`（含 `stage:nikkisync-pc --apply` 与 pre-dist-check，自动校验新深入口与暂存资源）。

## 六、错误处理

- 装载缝：2 个新深入口按「可选能力」口径——缺件（老链接/未重建）时跳过对应包装与 hosts，仅 warn 日志（`[pc-companion] …`），绝不让整段 PC 服务装配失败（沿 `metadataOnlineConsent?` 先例）。
- realpath 失败（目录不存在/权限）：该根剔除，不伪造资产（对齐上游 `catch { return undefined }`）。
- dashboard 包装的 add/remove/rescan：上游错误原样上抛；wechat.stop 失败仅落日志不掩盖原结果。
- snapshot 组装失败：沿既有 B1 回滚口径（start 失败 ⇒ 回滚后台服务 + 关 dashboard）。
- 一切新日志走 `runtimeLog`（diagLog + electron-log 双通道），不写用户可见文本。

## 七、参数校验

- `scanRoots`：只收字符串数组（既有 C1 口径）+ realpath 过滤非目录/不存在项。
- `wechatEntryImage`：仅 `fs.readFileSync` 成功的 Buffer 才挂键；缺件不挂路由。
- `syncPort`：`() => number | undefined`，只透传 `state.syncAddress?.port`，无值回落 0（与上游「服务未启动」展示语义一致）。
- 包装器对上游实例不做任何字段改写（同一引用透传，控制页 UI 由上游页面自行校验输入）。

## 八、基础测试用例总表

正常/异常/边界三类全覆盖：见节点 3/4 的 TDD 清单；新增用例全部先红后绿，既有 pc-companion-services（B1/B2/B3/F1/F5/C1）与 runtime-manager 用例作为回归锚不得转红。

## 九、剩余风险与阻塞项

1. `MetadataOnlineConsent` 的 +7 行具体 diff 与 `GalleryRuntime.d.mts` 新签名在节点 0 更新检出后以本地 diff 终审（不影响项目代码结构，已按行为语义纳入计划）。
2. K2 同意文件 policyVersion 若随上游变化，已同意用户需在 UI 重新确认一次（上游设计如此，自动生效）。
3. 控制页隐私面板仍不在控制页（按裁决走应用内 K2）；上游 setEnabled 还会写 metadata-resolver.json 并启停 resolver 服务——本仓该文件由设置键 + 会话能力位主控，语义偏差已记录为已知项。
4. 节点 0 需要网络访问 GitHub（git fetch）；若环境网络受限将阻塞在检出更新，届时回退方案为用户提供 4cb71e2 补丁文件。

## 十、执行记录

- **2026-11-07 节点 0**：上游检出 `git fetch + checkout 4cb71e2`（detached，沿用既有工作流）；
  检出内 `npm install && npm run build` 四包全过（`WeChatDeletion.js` / `WeChatInspiration.js`
  dist 产物在位）；本仓 `link:nikkisync` 幂等、`verify:nikkisync` 全绿（load chain 79 modules /
  24 roots）；链接态基线 `protocol-drift` / `runtime-facade.linked` / `sync-server.linked` /
  `metadata-resolver.linked` 共 45/45 绿（16 表闭集不变）。终审关键 diff：`MetadataOnlineConsent`
  改为「缺件/坏文件一律不同意」（本仓 K2 更严，行为不变）；`DeletionQueue` 增
  `cancelTransientSession`；`ResourceClassifier` 收紧 pendingup 排除；`GalleryRuntime.d.mts`
  增 deletion/inspiration 钩子与 `motionFfmpeg` 选项；`packages/database` 的 `capturedAt`
  支持 null 显式清除（无新表）。
- **2026-11-07 节点 1**：`PC_ASSET_SPECS` 增 `wechat-mini-entry.png`（先红后绿）；
  `pc-companion-services.test.ts` 14/14 绿；`stage:nikkisync-pc --apply` 落地 9 项资源（新增
  入口码 178225 字节）。
- **2026-11-07 节点 2**：facade 增 `WECHAT_DELETION_DEEP_ENTRY` / `WECHAT_INSPIRATION_DEEP_ENTRY`
  （先红：相等断言红）→ `verify-nikkisync-link.ts` 的 `NIKKISYNC_CAPABILITY_ARTIFACTS` 与
  `LOAD_CHAIN_ROOTS` 各 +2、计数测试 24→26 / 18→20 → `verify-nikkisync-link.test.ts` 53/53 绿、
  `verify:nikkisync` 全绿（load chain 81 modules / 26 roots）。
- **2026-11-07 节点 3**：`PcCompanionSessionContext` 增 `inspirations/deletions/extraDirectories/
accounts/thumbnailCache/syncPort`（metadataConsent 未纳入——隐私面板按裁决不走控制页）；
  `NikkiSyncRuntimeSession` 增 `thumbnailCache?`；facade 挂载；manager `pcCompanionContext()`
  透传。`runtime-manager.test.ts` +2 例（先红后绿）；两文件合计 158/158 绿。
- **2026-11-07 节点 4**：`pc-companion-services.ts` 组装对齐（先红 9 例后绿）：包装链
  withWeChatInspiration→withWeChatDeletion、D1–D4 修复、hosts、wechatEntryImage、四面板、
  scanDirectories 薄包装联动 wechat.stop、D5 getStatus 端口。25/25 绿。
- **2026-11-07 节点 5**：`nikkisync-runtime-setup.ts` 透传新上下文字段；`npm run typecheck` 全过；
  `npx vitest run src/main/nikkisync` 380/380 绿。
- **2026-11-07 节点 6**：本计划执行记录回写 + `src/main/nikkisync/AGENTS.md` 追加 2026-11-07 口径订正节。
- **2026-11-07 节点 7**：全量回归——`npm run verify` 5/5 绿（typecheck / lint / core-gate / format / test；
  首轮暴露 stage 专用测试的 8→9 计数钉死与格式问题，均已修复）；`npm test` 482 文件 /
  7794 用例全绿（20 skip 为既有环境门控；期间修掉 1 处新落盘文档的上游路径死引用并补
  `git add`）；`npm run typecheck:e2e` 过；`npm run verify:nikkisync` OK（blocking 0）。
  改动保留在工作区/暂存区（计划文档与新入口码资源已 `git add`，其余未暂存），未自行提交。
