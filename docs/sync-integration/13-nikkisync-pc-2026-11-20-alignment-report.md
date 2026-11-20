# NikkiSync PC 端「同步图库」上游对齐与功能补齐报告（2026-11-20）

## 1. 核对范围

- **上游唯一基准**：`NikkiSync` 仓库 `main` HEAD `6bdab4b4b29b0af5103aafb2d3223e7903c6306c`，tag `v1.0.41-public-beta.2`，提交时间 2026-11-15 13:24:52 +0800，父提交 `860ff0f7ed06cecab42a6fe4f8a46b0e3f9472c1`。
- **基准未推进**：GitHub refs API 与 `git ls-remote` 双次确认 `main == tag == 6bdab4b`，核对期间无新 PC 端提交。
- **对比锚点**：上一锚点 `a49764bbf98fcb26a84f2356b78d48c459d3da2e`；区间 `12 files changed, +106/−16`。
- **本仓基线**：HEAD `8e02afc4c1c7707669f6891c8587401db4201047`，branch `main`，工作树起始干净；版本钉 `1.0.41-beta.2`，应用包版本 `2.5.7-beta`。
- **范围限定**：仅「同步图库」与 PC 端控制台；排除移动端正文、微信小程序运行时页、Windows Shell（WPF/EXE 自更新/签名源）、RemoteBridge `/api/remote/*`、Bun 单文件 EXE。
- **审计对象**：上游 93 个 PC 源文件逐项映射到本仓；前端按 `DesktopPage.ts` 的 CSS/DOM/文案逐块核对，后端按协议、DB migration、LocalSyncServer、资源装载逐项核验。
- **参考证据**：用户提供的 7 张上游 PC 控制页截图（连接页、同步设置、网络权限/目录、最近删除、灵感库、关于/底栏）。

## 2. 差异清单

### 2.1 分类汇总

| 分类           | 数量 | 代表项                                                                               |
| -------------- | ---: | ------------------------------------------------------------------------------------ |
| 必须补齐       |    3 | D1 品牌壳层、D2 页头/状态 chip、D4 微信入口                                          |
| 需要宿主适配   |    5 | D3 Connect IA、D5 底栏、D6 Settings 节奏、D7 卡片视觉、D8 三视图                     |
| 已同步无需修改 |   18 | 协议契约、DB migration、LocalSyncServer、配对/鉴权、资源诊断、目录扫描、灵感同步面等 |
| 零变化         |    2 | `packages/protocol`、`0001_initial.sql`（区间内无变更）                              |
| 明确不搬       |    5 | 移动端正文、小程序运行时页、Windows Shell、RemoteBridge、Bun EXE                     |

### 2.2 前端结构性差异（修复前）

| #   | 修复前本仓                                              | 上游基准                                                          | 影响                               |
| --- | ------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------- |
| D1  | `PageHeader` + 160px 文字导航，无品牌图/页脚/图标       | 188px 品牌侧栏 + 42×42 头像 + 图标导航 + 双行页脚                 | 首屏观感与截图不一致               |
| D2  | 固定页标题，各视图再渲染 h3，无全局状态 chip            | 页面级 h1/h2 随视图切换 + 右上三态 chip                           | 标题层级重复、服务状态不可见       |
| D3  | 资产/首跑/服务/配对/设备/Android/微信/引导/自查纵向堆叠 | 资产 → 连接标题 → 双通道 → 引导 → 自查 → 隐私                     | 信息架构倒置，首屏不是“连接到手机” |
| D4  | 微信入口是折叠 `details`，只有按钮/状态/二维码          | 与 Android 对等的 `connection-card`，含 tag、三步、入口码、入口图 | 微信入口弱、缺产品化说明           |
| D5  | 圆角小卡底栏，无恢复提示                                | 全宽底栏、双版本、右侧重启/导出                                   | 恢复入口不显著                     |
| D6  | `SectionShell` 纵向堆叠，账号独立大节                   | 连接（含账号）→ 启动 → 网络 → 目录 → 热点 → 解析                  | 页面节奏不一致                     |
| D7  | `bg-tertiary` 子卡 + 宿主 glass-card                    | `#FFFCF7` surface、23px 圆角、分隔行                              | 卡片密度/层级不同                  |
| D8  | 三视图各自标题与宿主卡片                                | 上游 panel 卡片语言 + 统一页头                                    | 页头重复、视觉不统一               |

### 2.3 后端核验结论

- 协议 `protocol-contract.test.ts` / `protocol-drift.test.ts` 基线绿；区间无 `packages/protocol` 变更。
- 数据库 `0001_initial.sql` 未变，宿主沿用上游 runtime 建库。
- `sync-server.linked.test.ts` 覆盖真实 LAN server start/stop、配对、鉴权；无基线差异。
- `resources/nikkisync/pc` 已含 `momo-camera.png`、`wechat-mini-entry.png` 等资源；`verify:nikkisync` 校验链接与产物闭包。
- **本轮无后端“必须补齐”项，未重写后端。**

## 3. 已完成修改

### 3.1 设计系统与壳层（N2/N3）

- 新增 `sync-console.css`：局部 token 映射宿主变量；188px `.sc-shell` 侧栏；`sc-page-header` 28px 标题；`sc-chip` 三态；`sc-card` 23px 圆角；`sc-setting-row` 分隔行；`connection-grid` 双列；`sc-status-bar` 全宽；全部选择器限定 `.sync-console`，不改全局 `:root/body/*`。
- 新增 `console-ui.tsx`（`ConsoleSection/ConsoleCard/ConsoleRow/ConsoleBadge/ConsoleHint`）、`ConsoleIcons.tsx`（移植上游 12 个 SVG path）、`brand-assets.ts`（品牌图与微信入口图导入）。
- `SyncConsoleLayout.tsx` 改为品牌侧栏 + 五入口图标导航 + 页脚 + 页面级 h2 + 状态 chip + 底栏；品牌图失败回退 camera 图标；chip 文案与 `data-state` 同源。
- `SyncStatusBar.tsx` 改为 `sc-status-bar`，含双版本、恢复提示、重启/导出。

### 3.2 Connect 视图（N4）

按上游 IA 重排：

1. **资产总览**：大数字素材数 + 已配对设备数；不可用时显示“资产总览不可用”，不伪造 0。
2. **“连接到手机”**：右侧同 Wi-Fi 提示。
3. **双通道卡**：
   - Android：`Momo Camera` tag、`Android App` 标题、三步、首配二维码、配对提示、新二维码、APK 下载、导出诊断。
   - 微信：与 Android 对等卡片，含入口码 `details`（键 `momo.wechat-entry.seen.v1`）、三步、启停、连接码、入口图、打开控制页。
4. **首次使用引导** → **连接自查** → **隐私脚注**。
5. **宿主增强区**：服务开关、配对入口、已配对设备管理（上游控制页不暴露的宿主能力，保留为独立卡片）。

### 3.3 Settings / 三视图（N5/N6）

- Settings 全部改为 `ConsoleSection`（h2）+ `ConsoleRow`；账号同步作用域并入“同步与连接”卡；网络权限/热点前移到照片目录之前；保留地址、相册更新、关闭窗口后三条上游静态说明。
- Organizer、About 统一为 `ConsoleSection` + `ConsoleRow`。
- `SyncInspirationPanel` 新增 `embedded`：控制台内嵌时隐藏折叠摘要、默认展开、挂载即拉首屏；独立灵感库页保持原折叠行为。

### 3.4 i18n 与测试（N7）

- `sync-console-keys.test.ts` 等集白名单补齐 23 个新叶子；12 个 locale 全部补齐并本地化（zh-CN/zh-TW/en/ja/ko/de/fr/es/pt/ru/th/vi）。
- 新增设计契约测试 `sync-console-design.test.ts`；Layout 新增 chip 三态、品牌图、五导航图标断言；Connect 微信入口码断言改为卡片内 `details`；页面级 h2 断言随迁。

## 4. 验证结果

| 验证项         | 命令                                                     | 结果                                        |
| -------------- | -------------------------------------------------------- | ------------------------------------------- |
| 控制台单测     | `npx vitest run src/renderer/pages/sync-gallery/console` | **9 files / 163 tests passed**              |
| 全量单测       | `npm test`                                               | **544 files / 8878 passed, 20 skipped**     |
| 类型检查       | `npm run typecheck`                                      | passed                                      |
| 静态检查       | `npm run lint`                                           | passed                                      |
| 构建           | `npm run build`                                          | passed（electron-vite 三端产物）            |
| i18n 对齐      | `npm run i18n:check`                                     | 12 locale / 4567 keys 全对齐                |
| i18n 守卫      | `npm run i18n:guard`                                     | passed                                      |
| 依赖链         | `npm run verify:nikkisync`                               | 0 blocking failures                         |
| 链接检查       | `npm run link:nikkisync:check`                           | 四链接均 ok                                 |
| 文档链接       | `npm run docs:links`                                     | 无死引用（200 处历史提醒）                  |
| 打包冒烟       | `npm run e2e:smoke`                                      | **not-run**：未启动打包后 Electron 实机会话 |
| 像素级视觉核对 | 实机截图比对                                             | **not-run**：未启动应用做逐像素比对         |

**TDD 记录**：设计契约测试先红（3 failed），落地 CSS/壳层后转绿；全量回归中 `sync-console-keys.test.ts` 两处红（新叶子未入白名单、Android 标题钉住旧文案），修复后转绿。

## 5. 剩余风险

1. **未做实机视觉核对**：本轮以源码 CSS/DOM 契约、上游 CSS/DOM 与用户截图事实对齐；字体渲染、窗口缩放、长文案换行只能启动 Electron 后人工确认。
2. **微信能力位缺失**：宿主 `NikkiSyncServerStatusInfo` 无 `wechat` 能力位，控制台按“有入口即展示”处理；未装载该能力的构建中卡片仍显示，操作失败会收敛为不可用提示，不伪造连接。上游按 `data-wechat-enabled` 隐藏整卡，这是已知差异。
3. **12 语言新文案**：本次按上游语义本地化，建议母语者复核用语；`i18n:check` 只保证键齐备与非空。
4. **E2E/打包冒烟未跑**：本轮验证止于构建产物；安装包行为、托盘/自启、真实手机配对未在打包态回归。
5. **上游若继续推进**：本轮基准固定在 `6bdab4b`，后续上游新增 PC 提交需重新审计，不应把本轮结论外推。

## 6. 结论

- **基准锁定成立**：`main == tag == 6bdab4b`，区间无新提交；本轮未越界改后端。
- **必须补齐 3 项已落地**：品牌壳层、页头/状态 chip、微信对等入口。
- **宿主适配 5 项已落地**：Connect IA、底栏、Settings 节奏、卡片视觉、三视图。
- **验证闭环成立**：控制台 163 项、全量 8878 项、lint/typecheck/build/i18n/依赖链全绿；E2E 与像素级视觉核对如实标注 `not-run`。
- **交付边界**：代码与文档已落在 `D:\项目\软件\MeowStarMap\MeowStarMap`；本报告为 `docs/sync-integration/13-nikkisync-pc-2026-11-20-alignment-report.md`，审计明细见同目录 `12-...audit.md`。
