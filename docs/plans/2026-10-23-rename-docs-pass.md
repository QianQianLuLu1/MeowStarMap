# 阶段 2 执行记录：文档与署名更名（喵星图 / Meow Star Map）

> **状态**：已交付。代码与打包配置的更名（阶段 1 计划的 N1–N7）**未在本轮执行**。
> **日期**：2026-10-23
> **上游计划**：[`docs/plans/2026-10-23-project-rename-meow-star-map.md`](./2026-10-23-project-rename-meow-star-map.md)（名称映射表 §1.1 / 禁改清单 §1.2 为唯一真相源）

## 一、本轮边界（用户确认三条）

1. **名称与事实分离**：作为项目名称使用的地方全改；逐字记录当时事实的文档整类保留。
2. **仅展示类 JSON**：12 个语包的应用名值 + 插件示例 `package.json` 的 `description` / `author`；`package.json` / `package-lock.json` / `docs/debt-registry.json` 不动。
3. **扫描域 = 本轮范围文件**：被跟踪的 `*.md` + 许可证/署名文本 + 上述 JSON。代码与配置里的 248 行旧名留待阶段 3。

改写方式：全部经**逐行锚定替换器**落地（`.cache/rename-scan/apply.mjs` + 编辑清单 JSON），
每条编辑必须命中指定行号且该行内旧串出现次数与预期相等，否则整批中止——不使用全局替换。

## 二、红绿读数

| 阶段             | 命令                                                                                                   | 读数                                                                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 红灯（改动前）   | `git grep -n -F -f .cache/rename-scan/old-names.txt -- "*.md" "*.json" LICENSE :(exclude)记录类`       | **166 行 / 27 文件**                                                                                                                                                                                                                                                           |
| 绿灯（5 提交后） | 同上                                                                                                   | **20 行 / 5 文件**，且逐行等于下表台账                                                                                                                                                                                                                                         |
| 记录类零改动     | `git grep -c` 逐路径对照                                                                               | `docs/plans` 31、`docs/sync-integration` 171、`CHANGELOG.md` 20、`CHANGELOG-2.5.3.md` 1、`docs/2.5.0` 16、`packaged-scan-crash-report` 7、`troubleshooting-spawn-eftype` 6、`debt-registry.json` 1、`package.json` 6、`package-lock.json` 2、`LICENSE` 0 —— **与红灯基线全等** |
| URL 零漂移       | 逐文件 `git show 530e9c0:<f>` 与工作区的 URL 集合 md5 对照                                             | 27 / 27 文件一致                                                                                                                                                                                                                                                               |
| 禁改项零命中     | `NikkiGalleryManifest` 7、`nikkiGallery` 25、`WXNN_RENDERER_DIR` 6、`app: 'nikkigallery'` 5、XMP URI 2 | 与基线全等                                                                                                                                                                                                                                                                     |
| 三种形式互斥     | `git grep -l` 分形计数                                                                                 | 带空格品牌形 17 文件、kebab 7、Pascal 11、下划线 6、喵星图 12、喵星圖 1；Pascal 形在 `*.md`/`*.json` 的非文件名用法仅出现在 docs/plans 的仓库名与 CI 目录语境                                                                                                                  |

### 保留台账（绿灯 20 行，逐行核对）

| 站点                                                        | 保留内容                                                          | 理由                                                                                                                         |
| ----------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `README.md:60`、`README.md:173`                             | `github.com/QianQianLuLu1/NikkiGallery/releases`                  | 用户规定任何 URL 不动                                                                                                        |
| `ARCHITECTURE.md:1199`、`ARCHITECTURE.en.md:1194`           | `NikkiGalleryManifest`                                            | 类型名，改名即插件类型面全失效（§1.2 禁改）                                                                                  |
| `docs/PLUGIN_API.md:45/102/104/126/510/564/703/718/719/720` | 小写磁盘键 `nikkiGallery`                                         | 第三方插件清单必须写的键，由 `src/main/plugins/plugin-host.ts:376` 读取；`:102`、`:719` 同行品牌叙述已改为喵星图，仅键名保留 |
| `docs/PLUGIN_API.md:3`                                      | 「对应 NikkiGallery v2.3.0+」                                     | 对已发布版本的兼容性陈述，改名即为虚假                                                                                       |
| `docs/PLUGIN_API.md:736`                                    | 《NikkiGallery 插件系统设计文档》                                 | 从未入仓的历史文件名，改名等于发明不存在的产物                                                                               |
| `docs/技术债清单.md:240/308/309`                            | `%APPDATA%\wxnn-photo-manager\thumbnails`、`…/WXNN XiangCe（jiu)` | 实测磁盘读数（DEBT-031 证据与 IDE 记忆目录真实名）                                                                           |
| `plugins-samples/custom-watermark-template/package.json:12` | `"nikkiGallery"` 键                                               | 同上磁盘键                                                                                                                   |

## 三、提交清单

| #   | SHA       | 内容                                                                                                                             | 站点数    |
| --- | --------- | -------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | `cff516b` | `docs(root)`：README / AGENTS / ARCHITECTURE 中英双份                                                                            | 39 条编辑 |
| 2   | `d3c656e` | `docs(development)`：DEVELOPMENT 中英双份，并消灭第三种英文名 `Infinity Nikki Photo Manager`                                     | 46 条     |
| 3   | `12cb231` | `docs(plugin-api)`：品牌叙述与插件目录路径                                                                                       | 21 条     |
| 4   | `67d0045` | `docs(tutorial/module)`：教程、技术债标题、perf-regression、database / nikkisync 模块 AGENTS、share-card README、插件示例 README | 13 条     |
| 5   | `48522f3` | `i18n(locale)`：12 语包 27 值 + 插件示例 package.json 2 值                                                                       | 29 条     |
| 6   | 本次      | `docs(plans)`：入库阶段 1 计划 + 本执行记录                                                                                      | —         |

改动文件共 27 个（`git diff --name-only 530e9c0..HEAD` 与计划文件清单逐项一致，无越界路径）。
另同步本地未入仓镜像 `.qoder/rules/project-conventions.md` 的 frontmatter 描述（正文镜像区未动，
`scripts/__tests__/verify-format-scope.test.ts` 的字节守卫 36 项仍绿）。

## 四、闸门读数

| 命令                                                                                                                                        | 结果                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `npm run docs:links`                                                                                                                        | ✅ 无死引用，153 处提醒（与基线同值）                                                                                  |
| `npx vitest run scripts/__tests__/check-md-links.test.ts scripts/__tests__/verify-format-scope.test.ts`                                     | 60 passed                                                                                                              |
| `npm run i18n:guard`                                                                                                                        | ✅ 白名单只减不增、key 已同步                                                                                          |
| `npm run i18n:check`                                                                                                                        | ✅ 12 语包 3939 键全对齐                                                                                               |
| JSON 结构守卫（键路径 + 键序 + 非名称值逐字比对）                                                                                           | 13 / 13 文件：键路径与键序一致、非名称值未动、无 BOM、改动行数 = 命中站点数（11 文件 ×2、zh-CN ×5、示例 ×2）           |
| `npx prettier --check --end-of-line auto`                                                                                                   | 根 `*.md`、`src/**/*.json`、`docs/PLUGIN_API.md` 全部合规（其余 docs 文件不在闸门格式域，未跑 `--write`）              |
| `npm run lint` / `npm run typecheck` / `npm run typecheck:e2e`                                                                              | 0 error                                                                                                                |
| `npm run verify`                                                                                                                            | ✓（core-gate 与格式检查通过；本轮无 TS 变更故跳过 lint/type/test）                                                     |
| `npx vitest run src/renderer/i18n src/shared/types/resonance.test.ts src/renderer/components/common/UpdateDialog.test.tsx src/main/plugins` | 76 passed —— 其中 UpdateDialog 锁仓库 URL 源码串、resonance 锁 `app:'nikkigallery'` 线格式，两者仍绿即证明禁改项未被动 |
| `npx tsx scripts/check-doc-versions.ts`                                                                                                     | ✅ README Electron 41.10 与 package.json 一致                                                                          |
| `npm test`（全量）                                                                                                                          | **430 test files passed / 3 skipped，6565 tests passed / 51 skipped**，41.5s，exit 0；无 `it.skip` 新增、无断言放宽    |

## 五、已知偏差（本轮不修，逐项交代去向）

1. **文档先于代码**：本轮文档已写 `%APPDATA%\meow-star-map`、`meow_star_map.db`、
   `Documents\MeowStarMap\Diagnostics`、`MeowStarMap-Setup-*.exe`，而代码与**已发布的 2.5.5-beta**
   实际仍写 `wxnn-photo-manager` / `NikkiGallery` / 产出 `NikkiGallery-Setup-*.exe`。读者按新文档
   找目录会落空 ⇒ 由 N1（包身份）/ N2（诊断目录）/ N3（DB 与备份名）关闭。
2. **UI 新旧混用**：12 语包的 `appValue` / `appTitle` 已改新名，但
   `src/renderer/pages/settings/about-sections.tsx:75`、`:395` 的硬编码标签、
   `src/renderer/index.html:13` 与 `src/renderer/preview/index.html:7` 的 `<title>`、
   `src/main/services/share-wifi-service.ts:420`、`:438` 仍是旧名 ⇒ 由 N5 关闭。
3. **进程名指称**：zh-CN `main.dialog.cleanupFailed.detail` 现要求结束「喵星图」进程，
   而任务管理器里的进程名仍是 `无限暖暖相册管理工具.exe` ⇒ 由 N1 关闭。
4. **本地目录名**：文档树根与 `cd MeowStarMap` 反映已改名的远端；本机工作副本目录物理上仍叫
   `WXNN XiangCe`（`docs/技术债清单.md:308/309` 记录的正是这个名字）。
5. **术语并存**：docs/plans、docs/sync-integration、CHANGELOG、docs/2.5.0、两份事故报告保留旧名，
   与生效文档并存 —— 这是「记录当时事实」的代价，不是漏改。
6. **示例渲染资产未动**：`plugins-samples/custom-watermark-template/index.js:63`
   `'© My Nikki Gallery'` 与 `templates/festival.svg:12` `★ NikkiGallery ★` 属渲染内容，
   不在「.md + 展示 JSON」扫描域 ⇒ 阶段 3 与代码标识一并处理。

## 六、阶段 3 待办（本轮明确不做）

- 代码与配置旧名 **248 行 / 74 文件**：`src/**`（含 `user-diag-path.ts:12` 常量、
  `backup-service.ts` 前缀链、`connection.ts:156`、`validator.ts:150` zod 正则、
  `desktop-shortcut.ts` 的 `.lnk` 名、locale 之外的 `<title>` 与分享页标题）、
  `scripts/doctor.ts:161` 横幅、`scripts/simulate-gpu-crash.cjs`、`docs/sync-integration/verify-audit.mjs:39`、
  `.github/workflows/build.yml:248` 产物名、`tests/ci-linux.setup.ts` 等 CI 装置四站点。
- 打包身份五字段 `package.json:2/211/212/277/297` + `package-lock.json:2/8`（N1，锁 A）。
- 用户数据人工搬迁清单（阶段 1 计划第八节）随 N1 一并交付。
- 本轮**未发布 tag、未 push、未写 CHANGELOG 条目**（避免 `check-changelog-release.ts` 阻断 `dist:win`）。
