# 阶段 7：仓库链接更新与旧名残留终扫

日期：2026-10-23　|　前置：阶段 1–6（见 `docs/plans/2026-10-23-project-rename-meow-star-map.md` 与 `2026-10-23-rename-final-pass.md`）
状态：**已交付**（全部门闸与产物面复验实测通过）

---

## 一、为什么要做这一阶段

阶段 1–6 有一条硬规则「任何 URL 不动」，后果是指向**本应用自己仓库**的地址仍全部是旧名 `QianQianLuLu1/NikkiGallery`，而远端早已改名（`git remote -v` 实测 `https://github.com/QianQianLuLu1/MeowStarMap`），`package.json` 的 repository/homepage/bugs 三条 URL 也在新阶段 4 前就订正过。于是形成「外部标识新、界面展示旧」的分裂态：设置页关于区、更新弹窗里用户**看得见、点得进**的仍是旧仓库地址。

本阶段按新指令推翻旧规则，把「URL 类残留」这一整类清零，并做一次全仓旧名终扫。本文件显式**推翻**阶段 1 §1.2 的「URL 禁改」判据与阶段 6 残余偏差第 4 条（`docs/plans/2026-10-23-rename-final-pass.md:129`）；两份计划里的原文按记录面口径逐字保留，不改写历史。

顺带纠正一处用户可见的坏链接：反馈弹窗（`src/renderer/components/common/FeedbackDialog.tsx:209` 把 `common.feedbackDialog.githubValue` 当复制内容）在 12 个语包里全是占位符 `https://github.com/your-repo/issues`，经用户确认一并落到真实 issues 地址。

### 用户确认的四项范围决策

| 决策点                    | 结论                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| CHANGELOG 改到哪一层      | 12 条链接定义（`:426–437`）+ 叙述里反引号的仓库标识（`:41`）都改；历史安装包名 `NikkiGallery-Setup-*.exe` 属已发布产物事实，不改 |
| 终扫白名单口径            | 沿用现有台账豁免类别，本阶段只把「URL 类」清零，其余类别逐条沿档 `reason`                                                        |
| 失效注释与用例标题        | 原句保留 + 追加阶段 7 时间限定语；断言逻辑、覆盖面与用例数一律不变                                                               |
| 语包 `githubValue` 占位符 | 一并改为 `https://github.com/QianQianLuLu1/MeowStarMap/issues`                                                                   |

---

## 二、修改清单（21 个文件，46 增 / 73 删）

替换规则：仅把 URL 路径段 `QianQianLuLu1/NikkiGallery` → `QianQianLuLu1/MeowStarMap`，协议、`/releases`、`/compare`、`/issues`、`.git` 等其余部分逐字保留。

| 类别 | 文件与行                                                                                                            | 改动                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 源码 | `src/renderer/pages/settings/about-sections.tsx:17` `:395` `:399`                                                   | `GITHUB_URL` 常量、`openUrl()` 字面量、`<button>` 可见文字三处；:44/:72/:139/:141/:147 由常量派生 |
| 源码 | `src/renderer/components/common/UpdateDialog.tsx:18`                                                                | `GITHUB_URL` 常量（:93 引用）                                                                     |
| 测试 | `src/renderer/components/common/UpdateDialog.test.tsx:65–68`                                                        | 逐字嗅探的源码串换成新 URL；prettier 把三行断言折叠为一行（100 列内），属钩子既定行为             |
| 测试 | `scripts/__tests__/ui-brand-name.test.ts:36–38` `:102` `:115–116` `:196`                                            | `REPO_URL` 常量值、`:113` 计数 needle → 新 slug；四处失效说明保留原句 + 追加阶段 7 限定语         |
| 测试 | `src/renderer/pages/sync-gallery/SyncGalleryToolbar.test.tsx:147`                                                   | 注释里指代本应用仓库的旧 slug；`:148` 对 `ToStardust/NikkiSync` 的断言不动                        |
| 文档 | `README.md:60` `:173`                                                                                               | 中英两处 Releases 链接                                                                            |
| 文档 | `CHANGELOG.md:426–437`                                                                                              | 12 条版本锚点链接定义                                                                             |
| 文档 | `CHANGELOG.md:41`                                                                                                   | 叙述中反引号包裹的仓库标识                                                                        |
| 语包 | `src/renderer/i18n/locales/{de,en,es,fr,ja,ko,pt,ru,th,vi,zh-CN,zh-TW}.json` 的 `common.feedbackDialog.githubValue` | 占位符 → 真实 issues 地址（逐文件先断言旧值恰好出现 1 次再写回，UTF-8 无 BOM）                    |
| 台账 | `scripts/__tests__/old-name-ledger.json`                                                                            | 删除 5 条目、`ui-brand-name` 的 `NikkiGallery` 11→9、`expectedTotal` 180→170                      |
| 台账 | `scripts/__tests__/old-name-ledger.test.ts:13–17`                                                                   | 头部注释把「URL（用户规定不动）」从在册理由改为历史限定                                           |

**未动**：标识符 / 类名 / 常量名 / 私有配置键、目录结构、依赖清单、功能逻辑（只改字符串值）；`.github/workflows` 的 electron 镜像、`ToStardust/NikkiSync`、`dastrokes/gongeo.us-nikki-tracker`、zustand / better-sqlite3 / ffmpeg / ffprobe-static / fluent-ffmpeg / exifr / lucide 等第三方 URL、`http://wxnn.qianlu.com/xmp/1.0/`；`build.publish`（`provider: github` 由 repository 字段推导，已是新名）。

---

## 三、判据机理（为何必须同批改台账）

`scripts/__tests__/old-name-ledger.test.ts` + `old-name-ledger.json` 是常驻终扫守卫：扫描域固定，**逐文件逐模式命中数必须与台账相等**（不是 ≤），并断言总命中数 == `expectedTotal`。所以清零一处旧名 ⇒ 该条目必须删除（否则报「台账登记了 X 但域内已无命中」），命中数变化 ⇒ 必须改计数（否则报「实际 n ≠ 台账 n」）。台账数值不手算，一律取守卫自己的读数。

---

## 四、逐步红绿读数（全部实测）

| 节点 | 动作                                                                         | 读数                                                                                                                                                                                                                                                      |
| ---- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CP0  | 基线：`npx vitest run` 四份相关用例                                          | **56 passed**（4 文件全绿）——旧锁用例本就绿，因为它们钉的正是旧地址                                                                                                                                                                                       |
| CP0  | 残留扫描 `git grep -F 'QianQianLuLu1/NikkiGallery'`                          | **30 行命中**（CHANGELOG 13 / about-sections 3 / README 2 / ui-brand-name 2 / UpdateDialog.tsx 1 / UpdateDialog.test 1 / SyncGalleryToolbar.test 1 / docs-plans 记录面 7）⇒ 这是真实的红灯证据                                                            |
| CP1  | 只改源值（源码 + README + CHANGELOG + 12 语包）后重跑                        | **5 failed / 51 passed**：`UpdateDialog.test.tsx` 逐字锁红；`ui-brand-name:113` 红在 `expected +0 to be 3`；`ui-brand-name:194` 红在常量锁；守卫红在 3 条 stale 条目 + `expected 174 to be 180`。`SyncGalleryToolbar` 保持绿 ⇒ 证明上游 repo 断言未受波及 |
| CP2  | 同步测试 needle + 时间限定语                                                 | 三份用例转绿（30 + 9 + 12）；守卫仍红，给出权威读数 `实际 9 ≠ 台账 11`、`expected 170 to be 180`                                                                                                                                                          |
| CP3  | 按读数核账台账                                                               | 四份文件 **56 passed** 全绿                                                                                                                                                                                                                               |
| CP4  | `prettier --check --end-of-line auto` 命中文件集                             | 仅 `UpdateDialog.test.tsx` 需折叠，`--write` 后全清                                                                                                                                                                                                       |
| CP5  | `npm run lint` / `typecheck` / `typecheck:e2e` / `i18n:guard` / `docs:links` | 五项**全部 ✓ PASS**                                                                                                                                                                                                                                       |
| CP5  | `npm test` 全量                                                              | **437 files passed / 6707 passed，12 skipped**，exit 0                                                                                                                                                                                                    |
| CP5  | `npm run verify`                                                             | **总计 5 项，0 失败**（typecheck / lint / core-gate / format 20 文件 / 相关单测 4 文件）                                                                                                                                                                  |
| CP6  | `npm run build` 产物面复验                                                   | 构建前 `dist/` 有 **2 个 renderer bundle**（`index-*.js`、`SettingsPage-*.js`）带旧地址 ⇒ 构建后旧地址 **0 命中**、新地址 **26 文件命中**、`github.com/your-repo` **0 命中**                                                                              |
| CP7  | 终扫                                                                         | 非记录面旧仓库地址 **0 命中**；大小写不敏感变体（含 `%2F` 形态）**0 命中**；`old-names-stage3.txt` 全模式扫描命中 **35 文件** == 台账 **35 条目**，**双向差为空**；`expectedTotal` 170 为守卫读数真值                                                     |

---

## 五、白名单残留（本阶段后仍存，逐类归属）

| 类别                   | 站点                                                                                                                                                                                                                                                                                 | 理由                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 类型名与插件 API 字段  | `src/shared/types/plugin.ts`(5+3)、`src/main/plugins/plugin-host.ts`(3+9)、`permission-guard.ts`(1)、`src/renderer/pages/settings/plugin-sections.tsx`(3)、`docs/PLUGIN_API.md`(2+10)、`plugins-samples/custom-watermark-template/package.json`(1)、`ARCHITECTURE.md`/`.en.md`(各 1) | 指令白名单第 1 类：`NikkiGalleryManifest` 是禁改类型名，磁盘键 `nikkiGallery` 由 `plugin-host.ts` 按字面读取，改则已发布插件清单全部失效 |
| 导入信封线格式         | `src/shared/types/resonance.ts`(2)、`src/renderer/utils/resonance/exportPayload.ts`(2)、`resonance.test.ts`(1)、`resonance-handler.test.ts`(1)                                                                                                                                       | `z.literal('nikkigallery')` 是已导出文件的数据格式，改则历史导出被拒                                                                     |
| 游戏与 wxnn 标识       | `http://wxnn.qianlu.com/xmp/1.0/`（XMP 命名空间）、`eslint.config.js` 的 `wxnn-photo-manager/**` ignore、`src/main/ipc/validator.test.ts`(1)                                                                                                                                         | 指令白名单第 2 类：XMP 是线格式；ignore 与反向锁指向磁盘真实遗留目录/老备份名拒绝判据                                                    |
| @nikkisync / NikkiSync | `ToStardust/NikkiSync` URL、`docs/sync-integration/09-legacy-debt-remediation-plan.md` 的 `QianQianLuLu1/NikkiSync` 取证记录、`embedding-paths.ts`/`runtime-loader.ts`/`runtime-manager.ts` 的本机 `WXNN XiangCe` 提示                                                               | 指令白名单第 3 类 + 规则 4「其他 URL 一律不动」                                                                                          |
| 计划与历史记录面       | `docs/plans/**`（7 处旧 URL 映射/决策记录，含阶段 1 §1.2 与阶段 6 残余偏差原文）、`docs/2.5.0/**`、`docs/packaged-scan-crash-report.md`、`docs/troubleshooting-spawn-eftype.md`、`CHANGELOG.md` 内 7 处 `NikkiGallery-Setup-*.exe`、`CHANGELOG-2.5.3.md:1` 中文旧名标题              | 指令白名单第 4 类：已发布产物名与事故报告的磁盘实况，改写即伪造历史                                                                      |
| 守卫反向锁             | `ui-brand-name`(9)、`pack-identity-name`(12+)、`runtime-disk-name`(2)、`old-name-ledger.test.ts`、`source-encoding` 等                                                                                                                                                               | 断言「旧名不得再出现」必须逐字写着旧名，属判据而非残留                                                                                   |
| 磁盘取证与人工搬迁     | `DEVELOPMENT.md`/`DEVELOPMENT.en.md` §九/§9、`docs/debt-registry.json` DEBT-031、`docs/技术债清单.md`、`tools/scripts/extract_js.ps1`、`e2e/perf-real.e2e.ts`、5 个测试自投 `WXNN XiangCe` fixture、`early-crash-guard.ts`/`startup-diagnostic.ts` 修复前实况注释                    | 搬迁清单必须逐字写出旧 userData 根与旧库名，用户才对得上磁盘实物；其余为取证读数                                                         |

---

## 六、验收标准与达成情况

- 非记录面 `git grep -F 'QianQianLuLu1/NikkiGallery'` 零命中 —— **达成**。
- 界面可见链接（`about-sections.tsx:141` 由常量渲染整条 URL、`:399` 省略协议的文字、更新弹窗「去官网」）全部为新地址 —— **达成**，并以 `dist/` 零旧命中 + 26 新命中为硬证据。
- 终扫守卫绿且文件集双向差为空 —— **达成**（35 == 35，total 170）。
- `npm test` / `lint` / `typecheck` / `typecheck:e2e` / `i18n:guard` / `docs:links` / `verify` 全绿 —— **达成**。
- 无「无法解释」的旧名或旧链接残留 —— **达成**（逐类归属见第五节）。

## 七、未验证 / 未覆盖项（如实登记）

1. `npm run dist:win`（NSIS 打包、就地升级、electron-updater 真机行为）：本阶段只换字符串值、不动 `build.publish` 与产物命名，未跑打包 ⇒ **未验证**。
2. CI 真宿主（ubuntu-latest 的 `test` 10 分片与 `coverage` job）：本机无法等价执行。本地已跑全量 `npm test` 与只读 `verify`；`npm run test:ci-linux` 属诊断件（常态大面积红、非闸门），本轮改动不涉及路径语义故未跑 ⇒ **未验证**。
3. `docs/plans/**` 记录面里的旧 URL 与「URL 禁改」原文按白名单逐字保留，不做订正——推翻关系由本文件承担。
4. 阶段 6 记的其他残余偏差（老用户首启新建空库、旧前缀备份静默不可见、既有库 `WXNN XiangCe` 服务名不跟随、本机工作副本目录名仍是 `WXNN XiangCe`）本阶段不触碰。
5. `githubValue` 之外的语包社交渠道文案（抖音 / B站 / 小红书 / CSDN / QQ 群）按规则 4 一律未动。
