# 完整搭配码面板 · 阶段 0 实施计划（技术调研与数据契约冻结）

> 生成日期：2026-10-31 · 本仓 `main` @ `9d25c73`（`meow-star-map 2.5.6-beta`）
> 状态：已经用户批准（计划模式评审通过），落盘后经二次确认进入执行
> 交付物：`docs/plans/cloth-outfit-data-contract.md`（数据契约文档，本阶段的唯一入仓产物之一）
> 硬约束：本阶段**不改任何 `src/` 运行时代码**（临时调试/采集工具除外，用后即删）；不接入第三方数据源；不动 UI

---

## 1. 背景与目标

搭配码（cloth diy share code，形如 `1zQakg0a5lc#`）的底层解码管道已通：主进程经 utilityProcess 子进程调 `nuan5_decryption.dll` 的 `cloth_diy_decode_network` 联网拉取搭配数据，结果在 `ShareCodeDecoderDialog` 里以原始字符串截断展示。三个缺口：networkData 是裸 JSON 字符串未结构化、服饰 ID 无中文名/图标映射、无网络结果缓存。

阶段 0 在写任何业务代码之前钉死两件事：

1. DLL 实际返回的 networkData JSON 长什么样（字段名、嵌套、数组元素、空值形态）；
2. 第三方服饰数据源选哪个（URL、字段覆盖、频率限制、版权、降级方案）。

产出一份可执行的数据契约文档，作为后续阶段（结构化解析、名称/图标映射、缓存）的类型与行为真相源。

## 2. 已核事实（探索结论，作为文档底料）

以下事实已经过代码阅读 + 上游仓库取证 + 网络调研三方印证，执行阶段不再重复调研：

### 2.1 本仓管道逐跳类型链（networkData 全程为 string，零 JSON.parse）

```
DLL cloth_diy_decode_network（CBytes 原始字节）
  → src/main/decryption-worker/worker-entry.ts:147-151  readCBytesToUtf8 → UTF-8 字符串
  → src/main/decryption-worker/worker-protocol.ts:37    NETWORK_DECODE_RESULT payload.networkData?: string
  → src/main/decryption-worker/bridge.ts:235-240        透传（8s 硬超时在主进程侧）
  → src/main/services/decryption-service.ts:277-306     decodeNetworkGraceful（优雅降级：网络失败不置 success=false）
  → src/main/services/decryption-service.ts:1195-1247   decodeClothDiyShareCode → ClothDiyDecodeResult.networkData?: string
  → src/main/ipc/handlers/decrypt-handler.ts:79-103     decrypt:decodeClothDiy 原样透传（uidBytes 在此 Buffer→hex）
  → src/main/preload/api/decrypt.ts                     call<T>() 解包 IpcResponse
  → src/renderer/components/common/ShareCodeDecoderDialog.tsx:226-233  String(d.networkData).slice(0, 500) 截断展示
```

本地提取（`from_code_str` → `timestamp` → `uid_bytes`）在主进程 mutex 内完成；无效码返回 `{ success:false, error }`（DLL 返回 null，对应 status 8）；网络失败走优雅降级（`success:true` + error 文案 + networkData 缺省）。

### 2.2 上游结构真相（RanAxro/nikki_albums，main 分支）

- networkData 是双层 `"Content"` 包裹的裸 JSON：`{ "Content": { "Content": { ... } } }`；官方接口的剥包/解密全在闭源 DLL 内部，上游源码无 URL 常量。
- 内层字段（键名大小写混杂，需严格照抄）：`PoseId`（可选）、`patternData`（cloth_id→int，可 null）、`wearingClothes`（i64 数组，必需）、`wearingDIYInfos`（三态：数组/单对象/空对象）、`nsHiddenData`（cloth_id→0/1，可 null）。
- `wearingDIYInfos` 元素：`TargetGroupID` / `CoreData`（untagged 五选一：Hair/General/SpecialEffect/PatternCreation/PatternCreationExt）/ `FeatureTag` / `TargetClothID`。
- 上游无 networkData 样例 JSON；`cloth_diy_decode_network` 返回的原始字节即真相源，需本机实采。
- DLL 状态码：0=Success、8=InvalidClothDiyShareCode、10=NetworkError、12=DeserializationFailed 等（`decryption-service.ts:91-105` 的 `STATUS_MESSAGES` 与上游 `decrypt.rs` 一致）。

### 2.3 服饰 ID 拆解公式（本地与上游完全一致）

`parseDressingParams`（`decryption-service.ts:546-630`，注释声明对齐上游 `cloth_parser.rs`）：

| 字段          | 表达式                                | 取值范围 | 备注                                                          |
| ------------- | ------------------------------------- | -------- | ------------------------------------------------------------- |
| outfitFeature | `rawId % 10000`                       | 0–9999   | 本地未存入 ClothParams（仅 debug 日志），契约文档需记录此差异 |
| clothType     | `Math.floor(rawId / 10000) % 100`     | 0–99     |                                                               |
| state         | `Math.floor(rawId / 1000000) % 10`    | 0–9      | 0=原版/2-5=进化/9=特殊形态                                    |
| species       | `Math.floor(rawId / 10000000) % 1000` | 0–999    |                                                               |

上游额外由 `get_outfit(outfit_feature, state)` 派生套装 ID，本地无此步。Eureka（祝福闪光）拆解：`color=id%10`、`level=floor(id/10)%10`、`attachmentPoint=floor(id/100)%10`、`outfit=floor(id/1000)`。

### 2.4 既有本地资产与数据源结论

- **仓库已有名称映射**：`src/renderer/assets/cloth-names.json`（7369 条中文名，键=10 位服饰 ID）+ `outfit-names.json`（657 条套装名）+ `src/renderer/utils/cloth-name-lookup.ts`（`getClothName`/`getOutfitName`），来源上游 nikki_albums 语言文件。名称映射本地已部分解决，**真正缺口是图标与新版本覆盖度**。
- **数据源主选：gongeo.us（暖暖共鸣录）**，开源仓库 `dastrokes/gongeo.us-nikki-tracker`（代码 MIT，活跃维护）。三接入口：
  1. 仓库静态 locale JSON：`app/locales/zh/item.json`（9000+ 条，键形如 `item.1020100001.name`）等 7 类；
  2. 目录 API：`https://data.gongeo.us/v1/items/{id}`（返回 props/description/item_attributes，无列表端点、无中文名）；
  3. 图标 CDN：`https://cdn.gongeo.us/images/items/icons/{10位ID}.png`（实测 200）、套装 `https://cdn.gongeo.us/images/outfits/{5位ID}.png`。
- robots.txt：`search=yes, ai-train=no, use=reference`，`Allow: /`；代码 MIT；游戏素材版权归叠纸/Infold，未授权商用；无官方 SLA/频率限制（走 Cloudflare 缓存）。
- 备选：Fandom MediaWiki API（中文覆盖存疑、国内通常不可达）；mailauki/infinity-nikki-tracker（数据在私有 Supabase、无 LICENSE）。中文 BWIKI 全链路反爬不可脚本化。
- **降级链**：本地 JSON（离线底座）→ gongeo CDN/API → 显示裸 ID。

## 3. 执行步骤（每步验收通过才进下一步）

### T0 写实施计划文件入仓 → 用户确认

- 新增本文件；AskUserQuestion 请用户确认后才继续。

### T1 样本采集（三形态，零 src 改动）

- **文件**：新增 `.cache/tmp-cloth-diy-sample.ts`（`.cache/` 已 gitignore，不入仓）。
- **脚本要点**：`npx tsx` 运行于普通 node 进程（无 electron）；复用 `decryption-service.ts:58-89` 的 C 结构（`CBytes`/`ClothDiyDecryptionResult`）与 `:204-222` 的 koffi 函数注册形态、`worker-entry.ts:120-131` 的绑定模式（两进程各自独立注册是仓库既有先例）；加载 `<仓库根>/resources/nuan5_decryption.dll`（已确认存在）；`try/finally` 中 `freeClothDiyShareCode`/`freeCBytes` 防 C 内存泄漏。
- **输入/输出**：入参=码字符串数组（仅校验非空且 ≤64 字符后原样喂 DLL——无效形态本身是采集目标）；输出=每码落 `.cache/cloth-diy-samples/<code>-<形态>.txt`（status + 原始字节 UTF-8 原文 + 本地字段），**UID hex 掩码为前 4 后 2（唯一个人信息）**。
- **候选码**（B 站 av114464066113457 评论区，2025-06～2026-05 发布）：`1aOKp3A5MdA#` → `1L2rCD6dkNp#` → `14GLcevF0MG#` → `1gp9GLOI0gm#` 逐个试到 ≥1 个成功；全部失效则 AskUserQuestion 向用户要码。
- **断网形态**：管理员 PowerShell（UAC 弹窗用户点一次允许）加防火墙出站拦截规则，program 定向到运行脚本的 node.exe（`where node` 取路径，不波及其他进程）；重跑同码采得 status=10 NetworkError；**采完立即删除规则并 `firewall show rule` 确认不存在**。
- **错误处理**：DLL 加载失败→回退任务原文的「应用内临时日志 + UI 粘贴」路线（重新征求用户同意）；DLL 阻塞→外层 `timeout 60` 兜底；防火墙规则删除失败→重试并醒目提醒，绝不遗留。
- **验收**：`.cache/cloth-diy-samples/` 有 ≥3 类样本（有效/无效/断网）；`git status --porcelain` 确认 src/ 零改动；防火墙规则已删。

### T2 写契约文档

- **文件**：新增 `docs/plans/cloth-outfit-data-contract.md`（任务指定路径）。
- **结构**：① 背景与范围；② 管道逐跳类型链（带 file:line）；③ 三段真实样本（脱敏后原样附录）；④ TS interface 草案（含键名大小写对照表、三态/空值形态标注）；⑤ ID 拆解公式（复用 parseDressingParams + Eureka + 上游 get_outfit 差异说明）；⑥ 数据源选型结论（gongeo.us 主选 + URL/字段样例/调用方式/失败模式/频率与版权口径/三层降级链/本地 JSON 底座）；⑦ 遗留契约不一致清单（`electron-api.ts:503` `networkData?: unknown` vs `vite-env.d.ts:271` `networkData?: string`；`electron-api.ts:511` `server?: string` vs 实际 number）与缓存方案参考（上游 `<temp>/ClothDiyShareCode/<code>` 字节缓存、本地缩略图 LRU 模式），供阶段 1+ 使用。
- **验收**：文档存在且含 ≥1 段真实 JSON；全文无「待调研」「待定」字样。

### T3 TS interface 可编译验证

- **文件**：临时 `.cache/cloth-outfit-contract-verify.d.ts`（文档 interface 原样拷入）。
- **用例**（对象字面量断言，三类覆盖）：正常=全字段完整对象；异常=AdaptiveArray 单对象/空对象形态 + null map；边界=PoseId 缺省。
- **命令**：`npx tsc --noEmit --strict --target es2022 .cache/cloth-outfit-contract-verify.d.ts` → 0 error 后**删除该临时文件**。

### T4 回归与全局校验

- `npm run verify` 全绿（本阶段无 src 改动，预期通过）。
- `git status --porcelain` 复核：仅新增 docs/plans/ 两个 md；临时脚本/临时 .d.ts/样本目录均已清理；防火墙规则已删。
- 不自动 commit；如需入库由用户确认后按 Conventional Commits 提交（`docs(plans): ...`）。

## 4. 必备章节声明

- **依赖声明**：零新增依赖。复用仓库已有 koffi、tsx（scripts 工具链在用）、Node 内置模块。
- **启动说明**：无需 `npm run dev`；样本采集 `npx tsx .cache/tmp-cloth-diy-sample.ts <code...>`；断网采集经管理员 PowerShell 防火墙规则；验证 `npx tsc --noEmit --strict <临时.d.ts>` + `npm run verify`。
- **错误处理**：见 T1「错误处理」；所有失败分支均记录进契约文档「失败模式」节。
- **参数校验**：脚本仅校验非空 ≤64 字符（无效码形态是采集目标，不做格式预拒）；IPC 层既有 zod 校验（min1/max1024）不变，记入文档。
- **基础测试用例**：本阶段零运行时改动，无新增单测；可判定替代 = T3 三类 interface 用例（正常/异常/边界）+ T4 回归全绿 + git status 残留检查。

## 5. 关键文件清单

| 操作          | 路径                                                                                                                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增          | `docs/plans/2026-10-31-cloth-outfit-data-contract-实施计划.md`（本文件）                                                                                                                                                                                                      |
| 新增          | `docs/plans/cloth-outfit-data-contract.md`（最终交付物）                                                                                                                                                                                                                      |
| 临时建/用后删 | `.cache/tmp-cloth-diy-sample.ts`、`.cache/cloth-outfit-contract-verify.d.ts`、`.cache/cloth-diy-samples/*`                                                                                                                                                                    |
| 只读参考      | `src/main/services/decryption-service.ts`、`src/main/decryption-worker/{worker-protocol,worker-entry,bridge,dll-path}.ts`、`src/main/ipc/handlers/decrypt-handler.ts`、`src/renderer/components/common/ShareCodeDecoderDialog.tsx`、`src/renderer/utils/cloth-name-lookup.ts` |

不触碰任何受保护路径（`preload/api`、`ipc/handlers`、`services`、`shared/errors`）→ 无需 `@core-change` 注释。
