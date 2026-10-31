# 完整搭配码面板 · 阶段 2 实施计划（第三方服饰数据接入 service）

> 生成日期：2026-10-31 · 基线：本仓 `main` @ `9d25c73`（`meow-star-map 2.5.6-beta`）
> 状态：已经用户批准（计划模式评审通过），落盘后进入执行
> 数据契约：[cloth-outfit-data-contract.md](cloth-outfit-data-contract.md)（阶段 0 冻结产物，§6 三接入口与 §6.2 降级链为本阶段数据源真相源）
> 上游：阶段 0（契约冻结）· 阶段 1（structured 解析，`9d25c73` 后工作区未提交改动）· **本阶段：阶段 2** · 后续：阶段 3 磁盘缓存 / 阶段 4 UI

---

## 一、背景（Context）

阶段 1 后 `decrypt:decodeClothDiy` 已能返回 structured 服饰 ID 列表（`ClothDiyStructuredOutfit`）。本阶段在主进程新建服饰数据 service，把数字 ID 映射为可读信息（名称/图标 URL/标签）。数据源按契约 §6 选定 **gongeo.us**（无认证、直接 GET）：

1. **中文名**：GitHub 仓库静态 JSON `app/locales/zh/{item,outfit}.json`（键 `item.{id}.name`；item 约 9000+ 条，一次性拉取后内存查表）
2. **标签/属性**：`GET https://data.gongeo.us/v1/items/{10位ID}`（`/v1/outfits/{5位ID}` 同构；**不含中文名/图标/稀有度**）
3. **图标 URL**：`https://cdn.gongeo.us/images/items/icons/{10位ID}.png`（套装 `outfits/{5位ID}.png`）——纯 URL 构造，无需网络

关键现状（已核实）：仓库**无任何出站 HTTP 客户端**（无 axios/got/node-fetch），需基于 Node 22 全局 `fetch` 新建并自备超时/SSRF 校验；无现成 LRU 工具（复用 `src/main/app/media-protocol.ts:329-390` 的 Map-LRU 模式）；`validator.ts` 已有 `schemas.positiveIntId` 可复用；`docs/IPC_CONTRACT.md` 未收录 decrypt 域（存量缺口，本阶段不顺带补齐）。

## 二、关键决策（依据契约与任务，可否决）

1. **零新增依赖**：Node ≥22.12（Electron 41 主进程）全局 `fetch` + `AbortController`；LRU 手写 ~15 行（Map delete+set 移末尾模式，照 media-protocol 既有注释口径）。
2. **名称源**：gongeo zh locale JSON（契约接入口 1）一次拉取 ≈1-2MB，会话内内存缓存；失败后冷却期（默认 5 分钟）内不重试，避免离线时每次查询重复拉大文件。与契约 §6.2 降级链不冲突：阶段 4 UI 本地 `cloth-names.json` 优先，本服务补「本地缺失的新版本条目」。
3. **styleScore 恒缺省**：gongeo 无风格分数据；字段按任务要求保留（全字段可选），`tags` 取 data API 的 `category`/`subcategory`/`metadata` 值（英文原样），`props` 数字数组仅入 `raw`。
4. **ID 路由**：10 位→item、5 位→outfit（契约 §6.1 双 URL 模式）；其他长度直接空对象、零网络。`outfitFeature→套装 ID` 的上游 `get_outfit(outfit_feature, state)` 映射**不在本阶段**（契约 §5 点名的独立补齐点）。
5. **失败语义分级**：400/404（确认不在库）→ 空对象**负缓存**（防重试风暴，契约 §6.3）；超时/网络错误/5xx/解析失败 → 空对象**不缓存**（网络恢复后可重试）。所有分支 resolve 不 reject。
6. **SSRF 防护**：所有出站请求前统一过 `assertSafeRemoteUrl`——仅 http/https + host 精确白名单 + 显式拒绝 localhost/环回/私网/保留地址 IP 字面量 + `redirect: 'error'`（防重定向逃逸白名单）。
7. **IPC 通道** `decrypt:lookupCloth`（任务书示例命名），入参 `number[]`（zod：正整数、min 1、max 50，校验文案走 i18n），出参 `Record<string, ClothDataInfo>`（键为 ID 十进制字符串）；service 内部去重，结果对每个入参 ID 都有条目（查不到为 `{}`）。
8. **IPC_CONTRACT.md**：新增 §14 仅登记新通道；旧 4 通道缺口注明、不顺带补（最小改动）。
9. **数据获取全部在主进程**（任务约束）；渲染层只经 preload 桥调用；不改 UI 渲染、不做磁盘缓存、不接 homeBuild、第三方数据不进源码/安装包。

## 三、依赖声明

- **运行时依赖：零新增**。HTTP 用 Node 全局 `fetch`/`AbortController`（Node ≥22.12 与 Electron 41 均内置；`src/main/tsconfig.json` lib 含 DOM，类型齐备）；LRU 无第三方库。
- **devDependencies：零变化**。不执行 `npm install`。

## 四、启动说明

- 无新启动步骤：service 惰性初始化（首次查询才建网络请求），无需在 `app/` 启动链路注册。
- 验证链：`npx vitest run src/main/services/cloth-data-service.test.ts src/main/ipc/handlers/decrypt-handler.test.ts` → `npm run typecheck` → `npm run i18n:check && npm run i18n:guard` → `npm run verify` → `npm test` 全量。
- 真机联调（可选，验收非必需）：`npm run dev` 后在开发者工具 console 执行 `window.electronAPI.decrypt.lookupCloth([1020100001])`，联网时返回 `{ "1020100001": { name: "时光讯号", iconUrl: "…", tags: [...] } }` 形态，断网时返回 `{ "1020100001": {} }`。

## 五、错误处理（全分支表）

| 分支                                                         | 行为                                  | 缓存                               | 日志                         |
| ------------------------------------------------------------ | ------------------------------------- | ---------------------------------- | ---------------------------- |
| name map（locale JSON）拉取失败（超时/网络/非 2xx/解析失败） | 该批次 name 缺省，tags/iconUrl 照常   | name map 不缓存；冷却期内不再尝试  | warn（含失败原因，不含 URL） |
| data API 400/404                                             | 空对象 `{}`                           | **负缓存**（同 ID 本会话不再请求） | debug                        |
| data API 5xx / 网络错误 / 超时（默认 4s）                    | 空对象 `{}`                           | 不缓存（可重试）                   | warn（含状态码或错误类别）   |
| 响应体 JSON 解析失败 / 超过 10MB 上限                        | 空对象 `{}`                           | 不缓存                             | warn                         |
| ID 非 10 位且非 5 位（其他位数）                             | 空对象 `{}`                           | 负缓存                             | debug                        |
| 配置 URL host 非法（非白名单/localhost/私网/非 http(s)）     | 请求前拒绝，空对象 `{}`               | 不缓存                             | warn                         |
| 全部成功                                                     | name（zh）+ iconUrl + tags + raw 合并 | 合并结果入 LRU（默认 500 条）      | debug（计数，不含内容）      |

日志口径：中文明文（模板字符串，规避 `no-restricted-syntax` 字符串字面量拦截）；成功 debug、失败 warn；只记 host+路径+状态码/错误类别，**不打完整 URL query、不含 UID 与 networkData 内容**。

## 六、参数校验

- **IPC 层（zod，handler 内）**：`z.array(schemas.positiveIntId).min(1, t('main.decrypt.validation.idsRequired')).max(50, t('main.decrypt.validation.idsBatchMaxLength', { max: 50 }))`——正整数（0/负数/小数/字符串/非有限数均拒）、非空、单次 ≤ 50；包装于 `wrapHandler(ctx, z.tuple([...]))`，违规返回 `VALIDATION_ERROR`。
- **service 层（防御性，不抛错）**：内部 `Set` 去重（保持首次出现顺序）；`Number.isSafeInteger(id) && id > 0` 之外的一律过滤并输出空对象条目（承接万一直调场景）；ID 位数路由（10→item、5→outfit）。
- **URL 层（安全）**：`new URL` 解析失败、协议非 http/https、host 不在白名单、host 为 localhost/环回/私网/保留地址 IP 字面量——任一命中即拒绝发起请求。

## 七、基础测试用例（service 层 10 组，全部 mock fetch 注入，不写死第三方 URL）

1. **正常**：注入 item.json 最小 fixture + data API fixture → 断言 name/iconUrl（由注入 cdnBase 构造）/tags/raw；iconUrl 形如 `{cdnBase}/items/icons/{id}.png`。
2. **超时**：fake timers + 挂起 fetch（监听 abort 信号）→ resolve `{}` 且不缓存（第二次查询重新发起）。
3. **ID 不在库中**：data API 404 → `{}` 且负缓存（第二次 0 网络调用）。
4. **数据源不可达**：fetch reject → resolve 不 reject，不缓存（第二次重新请求）。
5. **批量含重复 ID**：`[A,A,B]` → data API 恰好 2 次。
6. **非法 ID**：`[0, -1, 1.5, 'x'(as unknown as number)]` → 全部 `{}` 且 0 网络调用。
7. **LRU**：同 ID 二次查询 0 fetch；注入小 `cacheMaxEntries` 验证淘汰后重新请求。
8. **host 安全**：注入 `http://127.0.0.1:8080`、`http://localhost/...`、`https://192.168.1.1/...`、`ftp://...` 基址 → 0 网络调用、resolve `{}`。
9. **5 位套装路由**：outfit ID → `{cdnBase}/outfits/{id}.png` + `/v1/outfits/{id}` + outfit.json 名称。
10. **name map 失败冷却**：首次 locale JSON 拉取失败 → tags 正常、name 缺省；冷却期内不重试，冷却后（fake timers）重试。

handler 层 4 组：注册断言 `toContain('decrypt:lookupCloth')`；合法 ids 透传为 Record（mock service）；51 个 id → VALIDATION_ERROR；`[0]`/`[-1]`/`[1.5]`/`[]` → VALIDATION_ERROR。

## 八、子任务（每步验证通过才进下一步；新增行为严格先红后绿）

### T0 计划文件入仓

- 新增 `docs/plans/2026-10-31-cloth-outfit-phase2-cloth-data-service-实施计划.md`（本文件）。验收：文件存在。

### T1 配置模块 + 数据服务（TDD）

- **文件**：`src/main/services/cloth-data-config.ts`（新，受保护路径→顶部 `// @core-change: 新增服饰数据源配置（阶段 2）`）：`ClothDataConfig`（dataApiBase/cdnBase/nameIndexBase/locale/allowedHosts/timeoutMs/batchConcurrency/cacheMaxEntries/nameMapRetryCooldownMs/maxResponseBytes）+ `DEFAULT_CLOTH_DATA_CONFIG`。`src/main/services/cloth-data-service.ts`（新，受保护→`// @core-change: 新增服饰数据查询服务（阶段 2）`）：函数模块（同 decryption-service 风格），导出 `lookupClothData(ids: number[]): Promise<Map<number, ClothDataInfo>>`、`ClothDataInfo { name?/iconUrl?/tags?/styleScore?/raw? }`、测试注入 setter `setClothDataConfig`/`setClothDataFetcher`（仿 `setDecryptionWorkerBridge`）。`src/main/services/cloth-data-service.test.ts`（新，测试豁免闸门，`@layer L2`）。
- **输入/输出**：`number[]`（≤50 由 IPC 层保证，service 另做防御）→ `Map<number, ClothDataInfo>`（每个入参 ID 均有条目）。
- **红灯口径**：测试 import 不存在的模块/导出即红；实现后转绿。
- **验收**：`npx vitest run src/main/services/cloth-data-service.test.ts` 全绿（第七节 10 组用例）。

### T2 IPC 通道（TDD）

- **文件**：`src/main/ipc/handlers/decrypt-handler.test.ts`（先加用例跑红）→ `src/main/ipc/handlers/decrypt-handler.ts`（**替换**第 1 行 @core-change 为 `// @core-change: 新增 decrypt:lookupCloth 服饰数据批量查询通道（阶段 2）`；追加 Group 5 通道，动态 import service，Map→Record，恒 `ok: true`）。
- **输入/输出**：IPC `number[]` → `{ ok: true, data: Record<string, ClothDataInfo> }`；非法入参 → `VALIDATION_ERROR`。
- **验收**：`npx vitest run src/main/ipc/handlers/decrypt-handler.test.ts` 全绿。

### T3 共享类型 + preload + 渲染层环境声明

- **文件**：`src/shared/types/electron-api.ts`（游戏参数解密段追加 `ClothDataInfo`/`LookupClothDataResponse`）；`src/main/preload/api/decrypt.ts`（前 5 行新增 `// @core-change: decrypt 命名空间新增 lookupCloth 方法（阶段 2）`；追加 `lookupCloth` 方法，`import type` 复用共享类型）；`src/renderer/vite-env.d.ts`（decrypt 段追加签名，内联 `import('../../shared/types/electron-api').ClothDataInfo` 引用，循 `scanner.status` 先例）。**不改 `preload.ts` 装配**（无新顶层键，34 键断言不动，origin 门禁链路零触碰）。
- **验收**：`npm run typecheck` 通过；`npx vitest run src/main/preload/__tests__/preload.test.ts` 全绿（若存在 decrypt 方法清单断言则同步补 lookupCloth）。

### T4 i18n（2 键 × 12 locale）

- **文件**：`src/renderer/i18n/locales/zh-CN.json`（手写 `main.decrypt.validation.idsRequired`、`idsBatchMaxLength`）→ `npx tsx scripts/sync-i18n-keys.ts`（11 locale 空串占位）→ `.cache/` 一次性 cjs 脚本填翻译（循已验证配方，运行后即删）。
- **验收**：`npm run i18n:check` 与 `npm run i18n:guard` 通过。

### T5 文档登记

- **文件**：`docs/IPC_CONTRACT.md`（新增 §14 游戏参数解密域：通道/注册位置/参数/返回类型真相源/容错契约/消费方；注明旧 4 通道未登记的存量缺口）。

### T6 全量回归

- `npm run verify`（typecheck+lint+core-gate+format+相关单测）→ `npm test` 全量 → `git status --porcelain` 复核仅预期文件。存在失败即修复重跑，未全绿任务不结束。

## 九、不做什么

UI 渲染（阶段 4）、磁盘缓存（阶段 3）、homeBuild（家园码）数据源、`outfitFeature→套装 ID` 映射、electron-api.ts §7.1 存量漂移修正、`ClothParams` 扩展、旧 4 个 decrypt 通道的契约补登记、版本号/CHANGELOG 变更。
