# 阶段 3 执行记录：界面文字与多语言资源更名（喵星图 / Meow Star Map）

> **状态**：已交付。打包身份、数据库与备份名、诊断目录名、同步面标识、CI 宿主装置（阶段 1 计划的
> N1–N4 与 N7）**未在本轮执行**；其中 **N1 与 N7 已由阶段 4 交付**，N2/N3/N4 仍待放行。
> **日期**：2026-10-23
> **上游计划**：[`2026-10-23-project-rename-meow-star-map.md`](./2026-10-23-project-rename-meow-star-map.md)
> （§1.1 名称映射表为唯一取值依据，§1.2 为禁改清单）
> **前置记录**：[`2026-10-23-rename-docs-pass.md`](./2026-10-23-rename-docs-pass.md)（阶段 2 文档与署名层）

本轮范围 = 用户能看见的软件名称：窗口标题、启动页/关于页、应急启动弹窗、局域网分享页、默认水印
文本、示例插件署名，以及 12 个语包的软件名称条目。执行约束沿用阶段 1：只改名称值，不动键名、
URL、类型名与任何逻辑；一节点一提交；绿灯判据取「残留逐字等于台账」而非命中数上限。

## 一、本轮边界（用户逐项确认）

| #   | 决策点                                                    | 结论                                                                                                        |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | 桌面 `.lnk` 文件名（阶段 1 归 N1）                        | **并入阶段 3**（可见图标名），`nsis.shortcutName` 仍留 N1 → 分叉入档                                        |
| 2   | 同步面用户可见标识（mDNS 实例名 / `DEFAULT_SERVER_NAME`） | **全部留后续**（N4）                                                                                        |
| 3   | 关于页「仓库」行可见文字                                  | 改为 `Meow Star Map`，同文件三处 URL 逐字不动                                                               |
| 4   | 默认水印与示例插件署名的新值                              | 统一带空格英文品牌形 `Meow Star Map`                                                                        |
| —   | TLS 证书 CN `WXNN Photo Manager Local`                    | **未并入**：改名会重签证书、已配对手机需重连，属功能影响面。阶段 1 计划未盘点到这一处，本轮登记后留后续评估 |
| —   | 诊断目录名与 `%TEMP%` 日志名                              | **未并入**（N2，牵动 11 条断言），因此弹窗文字新、弹窗内展示的路径旧                                        |

## 二、一个必须先说清的事实：语包在本轮没有红期

阶段 2 的第 5 个提交 `48522f3`（"12 语包 27 值"）已经改完 `settings.about.appValue`、
`titleBar.appTitle`（12 包）与 zh-CN 的 `main.app.name`、`main.dialog.cleanupFailed.detail`、
`main.dialog.startupFailed.title`。本轮实测 `src/renderer/i18n/locales/*.json` 对全部旧名模式
**0 命中**。因此范围第 1 条在本轮是**验证 + 加回归锁**，不是改值——把它伪装成红灯会是假交付。

## 三、红绿读数

| 阶段                               | 命令                                                                                                       | 读数                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 红基线（改动前）                   | `git grep -n -F -f .cache/rename-scan/old-names-stage3.txt -- src plugins-samples`                         | **196 行 / 73 文件**（`.cache/rename-scan/red-stage3.txt`）                                                                       |
| 绿灯（6 提交后，同一命令）         | 同上                                                                                                       | **178 行 / 61 文件**，Δ = −18 行 −12 文件 = 本轮改动站点全消                                                                      |
| 界面形态三条例外归零               | `git grep -c` 分别取 `无限暖暖相册管理工具` / `无限暖暖相册分享` / `My Nikki Gallery`                      | **0 / 0 / 0**                                                                                                                     |
| 守卫测试逐节点                     | `npx vitest run scripts/__tests__/ui-brand-name.test.ts`                                                   | 2✗17✓ → 2✗19✓ → 2✗21✓ → 1✗24✓ → 3✗25✓ → 2✗28✓ → **30 passed**                                                                     |
| 拆锁取证（S3-6）                   | 只改 `desktop-shortcut.ts` 不改测试常量 → `npx vitest run src/main/app/__tests__/desktop-shortcut.test.ts` | **3 failed**（用例 3/5/7）→ 同批改常量后 12 passed                                                                                |
| 禁改项证明（必须全程绿，一次未红） | `UpdateDialog.test.tsx` + `src/renderer/i18n` + `SyncGalleryToolbar.test.tsx`                              | 7 files / 50 tests passed                                                                                                         |
| 闸门有效性取证（S3-2）             | 补授权注释前与后各跑一次 `npx tsx scripts/core-path-gate.ts`                                               | `✗ 实质改动缺少授权`（exit 1）→ `✓ 通过（1 个受保护文件）`                                                                        |
| 全量                               | `npm test`                                                                                                 | **431 files passed / 3 skipped，6595 passed / 51 skipped**（阶段 2 末为 430 files / 6565 tests，差值即新增守卫的 1 文件 30 用例） |

### 残留台账（绿灯 178 行按 token 分类，全部属计划 §1.2 或后续节点）

| token                | 行数 | 归属                                                                                                                                                                                             |
| -------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NikkiGallery`       | 67   | GitHub URL（禁改）、诊断目录与 `%TEMP%` 日志名（N2）、`NikkiGallery.exe` 与 `/home/runner/work/NikkiGallery` 自投 fixture（N1/N7）、mDNS 实例名（N4）、`NikkiGalleryManifest` 类型名与其同行注释 |
| `wxnn_photo_manager` | 65   | DB 与备份文件名及其 zod/迁移正则、约 56 条断言（N3）                                                                                                                                             |
| `WXNN XiangCe`       | 16   | 同步默认服务器名（N4）、`npm run link:nikkisync` 开发提示里的本机目录名（禁改）                                                                                                                  |
| `nikkiGallery`       | 15   | 插件清单磁盘键（禁改，改了全部插件失效）                                                                                                                                                         |
| `nikkigallery`       | 8    | 共鸣导入信封线格式 `app: 'nikkigallery'`（禁改）                                                                                                                                                 |
| `wxnn-photo-manager` | 6    | `%APPDATA%` 手工拼装与预览 mock 里的 userData 目录（N1）                                                                                                                                         |
| `WXNN Photo`         | 2    | TLS 证书 CN `WXNN Photo Manager Local` 与其断言（本轮判为不并入）                                                                                                                                |

分类合计 179 = 178 + 1（`preview/mock/database-mock.ts:67` 同行含 `wxnn-photo-manager` 与路径形态），
逐行清单在 `.cache/rename-scan/green-stage3.txt`（不入仓，与阶段 2 的 `green-final.txt` 同机制）。

## 四、提交清单

| #   | SHA       | 内容                                                                                      | 站点数 |
| --- | --------- | ----------------------------------------------------------------------------------------- | ------ |
| 1   | `4da8f62` | `refactor(ui-title)`：`index.html:13`、`preview/index.html:7` + 新增守卫（首建 3 组用例） | 2 改   |
| 2   | `3931ee7` | `refactor(share)`：`share-wifi-service.ts:420/:438` + 第 1 行 `@core-change` 授权注释     | 2 改   |
| 3   | `9ffe7ed` | `refactor(crash-guard)`：`early-crash-guard.ts:126/:127` 双语弹窗文案                     | 2 改   |
| 4   | `acff028` | `refactor(about)`：`about-sections.tsx:75` 仓库标签，三处 URL 落点未动                    | 1 改   |
| 5   | `d9717ad` | `refactor(watermark)`：两处默认水印 + 示例插件签名/README/festival.svg + 两处自投 fixture | 8 改   |
| 6   | `fed8e57` | `refactor(desktop-shortcut)`：`.lnk` 两处文件名 + 测试常量                                | 3 改   |
| 7   | 本次      | `docs(plans)`：本执行记录 + 阶段 1/2 记录的指向更新                                       | —      |

改动面：**15 个文件、18 行值改动 + 1 行授权注释 + 1 个新守卫测试**（18 = 计划盘点的 N5/N6 界面站点
加上两处新发现的默认内容形态）。逐行改动经 `.cache/rename-scan/apply.mjs` 锚定落地
（`edits-stage3-c2..c6-*.json`），未使用任何全局替换。

## 五、闸门读数

| 命令                                              | 结果                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run i18n:check`                              | ✅ 12 语包 3939 键全对齐                                                                                                                                                                                                                                               |
| `npm run i18n:guard`                              | ✅ 白名单只减不增、清零必移除、key 已同步                                                                                                                                                                                                                              |
| `npm run lint`                                    | 0 error                                                                                                                                                                                                                                                                |
| `npm run typecheck` / `npm run typecheck:e2e`     | 通过                                                                                                                                                                                                                                                                   |
| `npm run verify`（逐节点）                        | 每节点 5 项全 ✓（typecheck / lint / core-gate / format / test）                                                                                                                                                                                                        |
| `npx tsx scripts/core-path-gate.ts`               | ⊘ 工作区无受保护文件；受保护改动已在提交前经暂存区判定 ✓                                                                                                                                                                                                               |
| `npm run docs:links`                              | ✅ 无死引用（153 处提醒，与阶段 1/2 基线同值）                                                                                                                                                                                                                         |
| `npm run build:preview` + `npm run preview:check` | 标题已随源码更新；10 项 PASS=5 WARN=5 **FAIL=0**（WARN 全是「preview.html 为压缩 bundle，此项不适用」的既有形态）                                                                                                                                                      |
| `npm run test:ci-linux`                           | **本轮新增守卫在该装置下 ✓ 30 passed**；另有 26 文件失败，逐条归因于本机缺少 Linux 原生绑定（报错指向 `sharp` 46 处、`better-sqlite3` 4 处、`koffi` 1 处）与装置伪造 cwd 下的 `git` 依赖型守卫，失败集与本轮改动文件**交集为空**，且这些套件在常规配置下 45 tests 全绿 |
| 编码（15 个改动文件逐一取首 3 字节）              | 全部无 BOM；行尾保持工作区 CRLF / 提交 LF，未混入单行 CRLF                                                                                                                                                                                                             |

### 本轮顺带发现的一个工装缺陷（未修，登记）

`npm run build:preview` 会在工作区根落下 **`preview-worker-<hash>.js`**，而 `.gitignore:92-94` 只覆盖
`preview.html` 与 `/preview/`。该文件被 `eslint .` 收为源码，实测制造 **42 条 error**（全是压缩产物的
`no-unused-expressions`）。本轮做法：跑完 `build:preview` + `preview:check` 后手工删除该产物，复跑
`npm run lint` 归零。根治要动 `.gitignore` 或 `eslint.config.js` 的 ignores，属配置变更，**不在本轮授权范围**，
留待单独一轮（建议与 N1 打包身份同批，避免又一处「文档/配置分叉」）。

> **已由阶段 4 收口**（提交 `83652b3`）。且实测证明本轮那句「动 `.gitignore` 或 `eslint.config.js`」里的
> **或**字必须改成**且**：ESLint 9 的 flat config 不读 `.gitignore`，只补 `.gitignore` 一行消不掉那 42 条
> 假错误，两处都得加。取证见
> [`2026-10-23-rename-packaging-pass.md`](./2026-10-23-rename-packaging-pass.md) 第五节。

## 六、已知偏差（本轮不修，逐项交代去向）

1. **弹窗文字新、弹窗内路径旧**：`early-crash-guard.ts:126/:127` 已取新名，但同弹窗的
   `日志文件 / Log file:` 插值出的仍是 `Documents\NikkiGallery\Diagnostics\startup-errors.log`
   ⇒ 由 N2（诊断目录常量 + 11 条断言）关闭。
2. **快捷方式名与安装器分叉**：运行时写出的文件已是 `喵星图.lnk`，而 `package.json:297`
   `nsis.shortcutName` 仍是旧中文全名 ⇒ ~~由 N1 关闭~~ **已由阶段 4 关闭**
   （[`2026-10-23-rename-packaging-pass.md`](./2026-10-23-rename-packaging-pass.md) 提交 `d556a2a`，
   实测产物 `release/win-unpacked/喵星图.exe`）。
3. **进程名指称**（承接阶段 2 偏差 3，仍未闭合）：zh-CN `main.dialog.cleanupFailed.detail` 要求结束
   「喵星图」进程，任务管理器里的进程名仍是 `无限暖暖相册管理工具.exe` ⇒ ~~由 N1 关闭~~
   **已由阶段 4 关闭**（`productName` = `喵星图` ⇒ exe 文件名即进程名）。注意 exe 的 **PE 资源元数据**
   仍不随 `productName`（`win.signAndEditExecutable: false` 跳过资源编辑），右键属性看到的还是
   Electron 默认值，该剩余项登记在阶段 4 记录的第九节 6。
4. **手机端同步标识全为旧名**：`SYNC_SERVER_DEFAULT_NAME = 'NikkiGallery'`、
   `DEFAULT_SERVER_NAME = 'WXNN XiangCe'`、TLS CN `WXNN Photo Manager Local` ⇒ N4 / 单独评估。
5. **关于页标签与 URL 并存**：`:75` 现为 `Meow Star Map`，同文件 `:17/:395/:399` 三处仍是
   `github.com/QianQianLuLu1/NikkiGallery`（URL 禁改，`:399` 本身是把 URL 当文字渲染）⇒ 远端仓库改名后自然一致。
6. **标题类仍是硬编码中文**：`index.html` 的 `<title>` 与分享页标题不随 locale 变，非中文语种用户看到的
   仍是中文自称。改走 `t()` 属逻辑变更，本轮禁止 ⇒ 记录为后续可选项，不是缺陷。

## 七、阶段 3 之外的剩余

扫描域（`src` + `plugins-samples`）在阶段 3 末剩 178 行，全部落在第三节的台账分类里，对应：

- **N1** 打包身份五字段 + `package-lock.json:2/8` + `%APPDATA%` 手工拼装 + `.github/workflows/build.yml` 产物名
  ⇒ **已由阶段 4 交付**（`d556a2a` + `216c20c`）
- **N2** 诊断目录常量与 `%TEMP%` 日志名（67 行里的诊断相关部分 + 11 条断言）⇒ 待做
- **N3** 数据库与备份文件名前缀链（65 行，13 处源码 + 约 56 处断言，爆炸半径最大）⇒ 待做
- **N4** 同步面可见标识（16 + mDNS 实例名）⇒ 待做
- **N7** `scripts/doctor.ts` 横幅、CI 宿主装置四站点（须同 commit）、`docs/sync-integration/verify-audit.mjs:39`
  ⇒ **已由阶段 4 交付**（`7a460fa` + `7ce73d4`；装置实为 3 文件 / 7 处而非 4 处）
- **N8** 已随阶段 2 完成

阶段 4 的红绿读数、真实打包取证与新增偏差见
[`2026-10-23-rename-packaging-pass.md`](./2026-10-23-rename-packaging-pass.md)。

## 附：本轮工装（`.cache/rename-scan/`，被 gitignore，git 里查不到）

- `old-names-stage3.txt` — 在阶段 2 的 26 条模式之上补 `无限暖暖相册分享`、`WXNN Photo`、
  `My Nikki Gallery` 三条。**若不补这三条，分享页标题、两处默认水印文本与示例插件签名会被整套脚本漏掉**
  （前两处形态与旧模式不同串，第三处是两词带空格）。红绿两次跑同一套模式。
- `edits-stage3-c2.json` … `edits-stage3-c6-test.json` — 逐行锚定编辑清单；行号不符或该行命中数
  ≠ `expect` 即整批中止不落盘。S3-6 故意分两份（`-src` 与 `-test`）以取证「锁被拆半」必红。
- `red-stage3.txt` / `green-stage3.txt` / `record-now.txt` — 红基线、绿灯台账（逐字判据）、以及
  用阶段 2 的 26 条模式在排除记录类文档后的当前读数（224 行 / 72 文件，含 `docs/**` 与配置面，
  与阶段 2 报的 248 行不同域，不可直接相减）。
