# 搭配码面板阶段 4：clothDiy tab 结果区结构化重构 — 实施计划

> 状态：已批准（2026-10-31）。前置：阶段 1（结构化解析）/ 2（cloth-data-service + lookupCloth IPC）/ 3（cloth-diy-cache）已完成且改动在工作区。
> 执行记录见文末「执行记录」节，随实施回写。

## 背景（Context）

搭配码面板阶段 1–3 已交付：`decodeClothDiy` 主进程返回结构化服饰投影 `structured`（`poseId` + `clothes[]`，每件 `id/clothType/state/species/outfitFeature`），并提供了批量服饰查询 IPC `decrypt:lookupCloth`（返回 `Record<string, ClothDataInfo>`，含 `name`/`iconUrl`，单条失败静默降级空对象）。但渲染层 `ShareCodeDecoderDialog` 的 clothDiy tab 仍只展示 timestamp/uidBytes/截断 500 字符的原始 `networkData`，`structured` 完全未消费。

探索中确认的两个**现存问题**（已与用户确认处理方案）：

1. **ok/success 契约漂移（P0，阻断性 bug）**：三个 handler（`decrypt-handler.ts:94/72/122`）实际返回 `{ ok, data, message }`，而 `vite-env.d.ts:289/292/304` 声明为 `success`，组件 `handleDecode` 也读 `res.success` → **三个 tab 解码成功时永远落入失败分支显示「操作失败」**（现有测试因 mock 了错误形状而假绿）。→ 共享修复：三 tab 都对齐 `ok`。
2. **CSP 拦截外链图标**：`index.html:11` meta 与 `window-manager.ts:15-17` 的 CSP `img-src 'self' media: data:`（注释要求两处逐字一致）会拦掉 `https://cdn.gongeo.us` 图标。→ img-src 追加 `https://cdn.gongeo.us`（单主机放行；script-src 仍锁 `'self'`）。

列表组织已确认：**保持 `wearingClothes` 投影原顺序平铺**，行内标注部位/状态/系列/款型（复用 `src/renderer/utils/enum-mappings.ts` 的 `getClothTypeName`/`getClothStateName`，照片参数面板同款映射）。

## 依赖声明

**无新增 npm 依赖**。全部复用仓库既有能力：i18next、enum-mappings、现有 Tailwind/CSS 变量体系、既有测试栈（Vitest + Testing Library + fireEvent）。i18n 其余 10 语言填充按仓库既定配方用 `.cache/`（gitignored）下一次性 cjs 脚本完成，用后即删。

## 启动与验证方式

- 环境就绪：阶段 1–3 改动已在工作区（未提交），不执行 `npm install`（会抹掉 @nikkisync 链接）。
- 单测：`npx vitest run src/renderer/components/common/ShareCodeDecoderDialog.test.tsx`
- 变更后只读验证：`npm run verify`
- i18n：`npm run i18n:check` + `npm run i18n:guard`（guard 强制 12 locale 键对齐，故不能"留空兜底"，须按配方填齐）
- 全量回归：`npm test`、`npm run typecheck`、`npm run lint`
- 手动：`npm run dev` 验证四场景（dev 下 meta CSP 同样生效，可直接看到图标是否放行）

## 错误处理（统一口径）

| 场景                                                        | 处理                                                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `decodeClothDiy` reject（IPC 异常）                         | 现有 catch → 失败分支显示 message（不变）                                                                                             |
| `ok: false`（码无效）                                       | 失败分支 + message（不变）                                                                                                            |
| `ok: true` + `message`（网络降级）+ `structured: undefined` | 显示既有 `result.networkUnavailable` 文案，不报错                                                                                     |
| `structured: null`（解析失败）                              | 友好提示 `parseFailed` + `<details>` 折叠区看原始 networkData                                                                         |
| `structured.clothes: []`                                    | 显示 `clothesEmpty` 空态文案                                                                                                          |
| `lookupCloth` reject（仅入参校验会走到）                    | catch → 降级为空映射，列表照常渲染、名称显示 `#id`，不阻塞、不报错                                                                    |
| 单条查询结果 `{}`（未收录/失败）                            | 该条无名称无图标 → 名称显示 `#id`                                                                                                     |
| `<img>` onError                                             | 隐藏图标框（名称在旁，不占位报错）                                                                                                    |
| 查询请求序号守卫                                            | handleDecode 用 useRef 请求序号，异步回来时若已发起新请求/切 tab 则丢弃 setState（防止 lookup 第二次 await 放大既有"旧结果闪回"问题） |

## 参数校验

- 传给 `lookupCloth` 前：`structured.clothes` 的 id 过滤 `Number.isInteger(id) && id > 0`，`Set` 去重，按 50 分块（IPC 上限 zod `max(50)`），空数组不调用（避免 IPC_VALIDATION_ERROR reject）。
- 结果 `Record<string, ClothDataInfo>` 按需以 `String(id)` 取用，取不到即按无数据处理。

## 实施节点（每节点先红后绿，逐步验证）

### 节点 0：落盘实施计划文档

- 新建本文件（延续阶段 1–3 命名惯例）。
- **验收**：文件存在、内容与批准计划一致。

### 节点 1（TDD）：ok/success 对齐

- **需修改文件**：
  - `src/renderer/components/common/ShareCodeDecoderDialog.test.tsx`：既有 19 用例中所有 mock 返回值 `success:` → `ok:`（修正错误测试前提），并新增用例「mock 运行时真实形状 `ok:true` 时渲染解码成功」。
  - `src/renderer/vite-env.d.ts`（289/292/304 三处）：`success: boolean` → `ok: boolean`（decodeClothDiy/decodeHomeBuild/encodeCameraParams；decodeFile 本就正确）。
  - `src/shared/types/electron-api.ts`：`DecodeClothDiyResponse.data` 补 `structured` 字段（注释指向真相源 `src/main/types/decryption.ts:322-342`；该文件不在受保护路径）。
  - `src/renderer/components/common/ShareCodeDecoderDialog.tsx`：`handleDecode` 改读 `res.ok` → `setResult({ success: res.ok, data: res.data, message: res.message })`（组件内部 `DecodeResult.success` 命名不动，最小 diff）。
- **红**：先改测试再跑 → 全部解码成功路径用例失败（复现 bug）；**绿**：改类型与组件后 → 全绿。
- **验收**：`npx vitest run src/renderer/components/common/ShareCodeDecoderDialog.test.tsx` 通过。

### 节点 2（TDD）：structured 服饰列表 + 查询编排 + i18n + CSP

- **需修改文件**：
  - `ShareCodeDecoderDialog.test.tsx`：先新增用例（见测试清单）确认红。
  - `ShareCodeDecoderDialog.tsx`：
    - `handleDecode` clothDiy 分支：decode 成功且 `structured` 存在时，批量 `lookupCloth`（过滤/去重/分块/`Promise.all`/catch→空映射），把结果以 `clothData` 键并入 `result.data`（组件内部状态，无新 state 字段）。
    - `ResultDisplay` clothDiy 分支重构：保留 timestamp 行；`uidBytes` 行改用新键 `result.uidHex`（消除硬编码 "UID (Hex)"）；`poseId` 存在时显示 `result.poseId` 行；structured 三态渲染：
      - 有 structured：小节标题 `result.outfitTitle` + 原顺序 `<ul>` 列表，每件：图标（40×40 rounded，`iconUrl` 存在才渲染，onError 隐藏）→ 名称（`name` 或 `#id` 兜底）+ `#id` mono 小字 + 标注行（部位 `t(getClothTypeName(clothType))`、状态 `t(getClothStateName(state))` 未命中时 `result.stateRaw` 兜底、`result.speciesRaw`、`result.featureRaw`）。全部走 `var(--*)` CSS 变量与 `cn()`，不硬编码色值。
      - `structured === null`：`result.parseFailed` 提示。
      - `structured === undefined`：保持既有 `networkUnavailable`。
      - `networkData` 从截断 500 字符行改为 `<details><summary>result.rawDataSummary</summary>` 完整折叠展示（仅 clothDiy；homeBuild 的行不动）。
    - 仅 clothDiy 分支变化；homeBuild/mediaEncrypt 渲染逻辑零改动。
  - `src/renderer/i18n/locales/zh-CN.json` + `en.json`：`common.shareCodeDecoder.result` 下新增 9 键（保持字母序插入）：`clothesEmpty`、`featureRaw`（"款型 {{value}}"）、`outfitTitle`（"身着服饰"）、`parseFailed`、`poseId`（"动作 ID"）、`rawDataSummary`（"原始网络数据"）、`speciesRaw`（"系列 {{value}}"）、`stateRaw`（"状态 {{value}}"）、`uidHex`（"UID (十六进制)"）。
  - 其余 10 locale：`npx tsx scripts/sync-i18n-keys.ts` 补键后，`.cache/` 一次性 cjs 脚本填翻译（ja/ko/de/es/fr/pt/ru/th/vi/zh-TW），`npm run i18n:check` + `npm run i18n:guard` 验证。
  - `src/renderer/index.html` + `src/main/app/window-manager.ts`：`img-src 'self' media: data:` → `img-src 'self' media: data: https://cdn.gongeo.us`，两处逐字一致（window-manager.ts 非受保护路径，无需 @core-change）。
  - `docs/IPC_CONTRACT.md`：核对 decrypt:decodeClothDiy 响应段是否已含 `structured`，缺则补一行。
- **验收**：组件测试全绿；`npm run i18n:check`/`i18n:guard` 通过；两处 CSP 逐字 diff 一致。

### 节点 3：Storybook story 同步

- `ShareCodeDecoderDialog.stories.tsx`：`mockDecryptNamespace` 扩展为接受 partial decrypt 命名空间（补 `lookupCloth`）；既有 `DecodeSuccess`/`DecodeFailed` mock 改 `ok` 形状，`DecodeSuccess` 升级为含 `structured` + 名称/图标示例；新增 `StructuredParseFailed`、`OfflineDegraded` 两个 story（play 函数复用 `typeAndDecode`）。
- **验收**：stories 位于 `src/renderer` include 内，`npm run typecheck` + `npm run lint` 覆盖编译与规范。

### 节点 4：全量回归（任务收尾闸门）

- `npm run verify`（typecheck + eslint 只读 + core-gate + prettier --check + 相关单测）
- `npm test`（全量）+ `npm run typecheck` + `npm run lint` + `npm run i18n:check` + `npm run i18n:guard`
- `npm run dev` 手动四场景：有效码（列表+图标）/ 无效码（失败分支）/ 断网（networkUnavailable 降级）/ 数据源不可达（名称 `#id` 降级）——由 Agent 亲自启动验证；若 GUI 交互受限，如实说明并请用户复核。
- 硬性要求：节点 1/2 的每个修复类用例在修复前必须红（先跑确认失败再改代码）；`npm test` 全量不得出现新增失败项。

## 组件测试清单（ShareCodeDecoderDialog.test.tsx）

**正常**：

1. `ok:true` + structured 3 件 + lookup 返回 name/iconUrl → 渲染 3 行、名称与 `<img src>` 正确、`lookupCloth` 以去重后 ids 调用一次；
2. poseId 存在 → 动作 ID 行；
3. clothType/state 映射命中 → 出现 `enums.clothType.*`/`enums.clothState.*` 键文案（t 回显断言）。

**异常**：4. `ok:false` + message → 失败分支（既有保留）；5. lookupCloth reject → 列表仍渲染、名称为 `#id`；6. `structured:null` → parseFailed 文案 + details 内原始数据可见。

**边界**：7. `structured` 缺省 → networkUnavailable；8. `clothes:[]` → clothesEmpty；9. 51 件 → lookupCloth 调用 2 次（分块 ≤50）；10. 单条 `{}` → `#id`；11. loading 期间（pending promise）解码按钮 disabled、显示 decoding；12. img onError 不崩溃。

## 验收标准（对照任务书）

- [ ] `npm run verify` 通过
- [ ] `npm test` 全量无新增失败；新增用例修复前为红
- [ ] homeBuild / mediaEncrypt tab：既有用例全保留且通过，渲染逻辑零改动（仅随 ok 修复恢复本应正确的成功显示）
- [ ] i18n：zh-CN/en 补齐、12 locale 键对齐（guard 通过）、组件无硬编码用户可见文案（含顺手消除 "UID (Hex)"）
- [ ] Storybook story 同步更新
- [ ] `npm run dev` 四场景不白屏、无未捕获异常

## 不做的事

- 不改 homeBuild / mediaEncrypt 的渲染结构与文案；不改 BaseDialog 与其它公共组件；不引入第三方 UI 库；不新增 npm 依赖；不动主进程 handler/service（受保护路径零改动，无需 @core-change）。

## 执行记录

- 2026-10-31：计划批准，开始执行。
- 节点 0：本计划落盘 `docs/plans/2026-10-31-cloth-outfit-phase4-ui-panel-实施计划.md`。
- 节点 1（红→绿）：测试 mock 由 `success` 修正为运行时真实形状 `ok` 并新增「运行时真实形状」复现用例
  → 2 个成功路径用例红（复现 ok/success 漂移 bug）；随后 `vite-env.d.ts`（三处）、
  `electron-api.ts`（`DecodeClothDiyResponse` 补 `structured`）、组件 `handleDecode` 对齐 `ok`
  → 22/22 绿。
- 节点 2（红→绿）：新增 12 个 structured 列表用例 → 8 个红（列表 UI 未实现）、2 个回归护栏用例绿；
  实现组件 `lookupClothSafe`（过滤/去重/50 分块/allSettled）、`ResultDisplay` clothDiy 分支重构
  （structured 三态 + `ClothList` 平铺列表 + 原始数据 `<details>` 折叠 + 请求序号守卫）。
  期间修正：图标 `alt=""` 导致 `getByRole('img')` 查不到（装饰性元素不进无障碍树）→ 改为
  `alt={name ?? #id}`；vite-env.d.ts 是模块文件、其顶层 interface 非全局可见 → 结构化类型改由
  shared `DecodeClothDiyResponse` 派生、decrypt 命名空间类型由 `Window['electronAPI']` 派生；
  homeBuild 分支恢复独立收窄避免波及。32/32 绿。
- 节点 2（i18n）：zh-CN/en 手写 9 键 → `sync-i18n-keys` 补 10 locale 空串 → `.cache` 一次性 cjs
  脚本填翻译（脚本用后即删）→ `i18n:check` / `i18n:guard` 通过。
- 节点 2（CSP/契约）：`index.html` meta 与 `window-manager.ts` `CSP_POLICY` 两处 img-src 逐字一致
  追加 `https://cdn.gongeo.us`；`IPC_CONTRACT.md` lookupCloth 消费方同步为「阶段 4 已接入」
  （decodeClothDiy 等四通道按文档既有备注维持暂不补录口径）。
- 节点 3：stories 更新——`mockDecryptNamespace` 改 partial 注入、`DecodeSuccess` 升级为
  structured + lookupCloth 示例、新增 `StructuredParseFailed` / `OfflineDegraded`。
- 节点 4：`npm run verify` 5/5 通过（⚠ 3 个源文件缺匹配套件为阶段 1-3 遗留的非阻断提示）；
  `npm test` 全量 459 文件 7197 通过 / 20 跳过（既有）；`npm run typecheck` / `npm run lint`
  / `i18n:check` / `i18n:guard` 全绿。
- 节点 4（实机验证）：`npm run dev` 实机走查——设置 → 工具与插件 → 分享码工具打开对话框；
  空输入解码按钮正确禁用；无效码解码后失败分支正确渲染「操作失败 + 无效的染色分享码」（截图存证），
  应用不白屏、无未捕获异常。有效码 / 断网 / 数据源不可达三场景需真实游戏内分享码才能触发
  （仓库无实采样本），其 UI 行为由 32 个组件用例（structured 三态 / lookup 降级 / #id 兜底）与
  Storybook story 覆盖，待用户持真实码复核。
- 节点 4（Storybook 实机渲染）：`storybook dev` + 浏览器实测 `DecodeSuccess`——解码成功 + 时间戳 /
  UID (十六进制) / 动作 ID 行、「身着服饰」列表三件（名称、`#id` 兜底、上衣/下装/袜子 + 原始/焕新/特殊
  枚举标注、系列/款型数字标注）、原始网络数据折叠区全部正确渲染；演示 CDN 图标 404 时 onError 兜底生效
  （占位框 + 内容不受影响）。`StructuredParseFailed` / `OfflineDegraded` story 已入侧栏（DOM 断言由
  组件测试覆盖）。
