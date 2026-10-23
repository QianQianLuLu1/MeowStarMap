# 阶段 5 执行记录：运行时落盘名称更名（喵星图 / Meow Star Map）

> **日期**：2026-10-23
> **范围**：程序自己在磁盘上创建、以及在局域网配对里发给其他设备的名称。即阶段 1 计划的 **N2**（诊断目录与
> 启动/崩溃日志）与 **N4**（同步面可见名称）的全部站点，外加本阶段任务清单里的桌面快捷方式一项——
> 该项经查已在阶段 3 交付，本轮不重复做。
> **不含**：N3（数据库与备份文件名前缀链，13 处源码 + 约 56 处断言）、N5（导出文件名/窗口标题/分享页）、
> N6（语包值，已随阶段 2/3 完成）、N8（生效文档与人工搬迁清单）。
> 取值以本文 §一 为准；本文 §一 与阶段 1 §1.1/N4 存在三处有意偏离，订正正文见阶段 1 记录末的
> 「阶段 5 对本文 §1.1/N2/N4 的订正」。

---

## 一、取值与偏离（用户逐条裁定）

| 站点                                                                          | 旧值                         | 新值                    | 依据与取证                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------- | ---------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRODUCT_DIAG_DIRNAME`（`src/main/utils/user-diag-path.ts:12`）               | `'NikkiGallery'`             | `'喵星图'`              | 用户裁定：「面向用户的文件夹与快捷方式名用喵星图」。**偏离阶段 1 §1.1 行 165**（该行把 `PRODUCT_DIAG_DIRNAME` 划入 Pascal 形）。CJK 安全性取证：`ipc/validator.ts`、`utils/ipc-validate.ts`、`ipc/media-read-guard.ts`、`nikkisync/resource-allowlist.ts` 四道路径闸门的判据都是盘符/UNC 前缀正则 + `toLowerCase()` 折叠，对 CJK 是恒等、且无一处比较 `NikkiGallery`；装置侧 `tests/mocks/ci-linux-fs.ts:45-47` 的 `rest()` 只按 `/` 切分、无字符集过滤；仓内已有 CJK 落盘先例（`productName: 喵星图` ⇒ `release/win-unpacked/喵星图.exe`、`喵星图.lnk`） |
| `%TEMP%` 应急日志（`startup-diagnostic.ts:38,57`、`early-crash-guard.ts:64`） | `'NikkiGallery-*'`           | `'MeowStarMap-*'`       | 与 §1.1 行 165 一致：技术前缀取无空格形                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SYNC_SERVER_DEFAULT_NAME`（`src/main/nikkisync/sync-server-view.ts:34`）     | `'NikkiGallery'`             | `'Meow Star Map'`       | 用户裁定：配对时其他设备看到的名字用英文品牌形（中文会被上游清洗）。**偏离阶段 1 N4 行 366「两处均 `MeowStarMap`」**。空格取证：上游 `NikkiSync/apps/pc-companion/src/server/MdnsAdvertiser.ts:52` 清洗正则 `[^a-zA-Z0-9 _-]` **放行空格**；`dnsName()` 按 `.` 切标签、空格不干扰；13 字节 < 63 标签上限。该值纯展示——不进 `serverId`、不进 QR `NS1\|` 七段、不作哈希或去重键，`resolveSyncServerConfig` 只 `trim()` 首尾                                                                                                                                 |
| `DEFAULT_SERVER_NAME`（`src/main/database/sync-metadata-repository.ts:84`）   | `'WXNN XiangCe'`             | `'Meow Star Map'`       | 同上，用户选「同批改」。**偏离** 同上                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| TLS 证书 CN（`src/main/sync/identity-service.ts:51`）                         | `'WXNN Photo Manager Local'` | `'Meow Star Map Local'` | 用户裁定本阶段一起改。取证推翻阶段 4 记录 §九.3 的顾虑：`readTlsIdentity`（`:102-135`）只校验可解析 + 公私钥 SPKI 相等，**不比对 subject** ⇒ 已装机 `server.crt` 原样复用、不会重签；客户端信任锚是叶子指纹（`docs/sync-integration/06-e2e-report.md:13`）而非 subject。CN 经 `cert-der.ts:50,134` 的 UTF8String 编码，空格合法                                                                                                                                                                                                                           |

### 不动项（逐条判过语境，非漏改）

| 保持项                                                                     | 位置                                                                                     | 理由                                                                                                                            |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| SAN dNSName `wxnn.local`                                                   | `identity-service.ts:52`                                                                 | Android 侧 PinnedTls 用它做主机名校验（`06-e2e-report.md:67`）                                                                  |
| `http://wxnn.local`                                                        | `sync/server/sync-server.ts:188`、`sync/server/api-router.ts:82`                         | 属 URL，且是请求签名基串的 host，改即打断已配对客户端                                                                           |
| `wxnn-${16hex}` serverId 生成式                                            | `sync-metadata-repository.ts:330`                                                        | 已落库配对身份                                                                                                                  |
| `in WXNN XiangCe` 提示语                                                   | `nikkisync/embedding-paths.ts:212,219`、`runtime-loader.ts:111`、`runtime-manager.ts:56` | 说的是开发者本机仓库目录名，不是产品名                                                                                          |
| `NikkiSync Local` 断言                                                     | `nikkisync/sync-server.linked.test.ts:374`                                               | 锁的是上游包的 CN                                                                                                               |
| `src/main/sync/**` 与 `sync-read-repository.test.ts:156` 的 `WXNN XiangCe` | 各 `*.test.ts` 自投 fixture                                                              | 阶段 1 N4 行 367 明确不改；由 `:591/:753` 自行种入并自行断言，与默认常量无关                                                    |
| 历史叙述注释里的 `NikkiGallery/Diagnostics`                                | `startup-diagnostic.ts:24-25`、`early-crash-guard.ts:45-46`                              | 逐字记录修复前的真实落盘位置，改成新名会让注释描述一个从未存在过的状态（`startup-diagnostic.ts:24` 已加「（当时常量值）」限定） |
| 两份事故报告                                                               | `docs/packaged-scan-crash-report.md:84,85`、`docs/troubleshooting-spawn-eftype.md:30,31` | 阶段 1 决策 4 冻结                                                                                                              |
| `D:\NikkiGallery缓存`                                                      | `e2e/perf-real.e2e.ts:342`                                                               | 本机真实存在的缩略图缓存目录名，非产品引用                                                                                      |

---

## 二、注释口径（本阶段新立的一条规则）

阶段 1 §D 表末行写的是「注释类……跟随改动」，一刀切。本阶段按**这句注释此刻是否为真**分档，避免注释撒谎：

- **描述当前行为** ⇒ 跟随新名：`user-diag-path.ts:5,26,49-51`、`startup-diagnostic.ts:34,49`、
  `dir-manager.ts:37`、`crash-service.ts:38`、`log-service.ts:189` 的「与真实落盘（…）不一致」子句、
  `index.ts:53,251`、`sync-server-view.ts:33`（改写为可复核的清洗口径）。
- **描述修复前实况 / 历史缺陷** ⇒ 保留旧名 + 时态限定：`startup-diagnostic.ts:24-25`、
  `early-crash-guard.ts:45-46`。
- 新守卫把这两档都锁成逐字断言：正向锁新名注释四站，反向**必须**锁历史叙述里的旧名仍在——
  谁把它们"顺手改干净"，守卫即红。

---

## 三、提交与红绿读数

| 提交              | 内容                                                                                                                     | 红灯读数（改前实跑）                                                                             | 绿灯读数（改后实跑）                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `0465f06`         | 诊断目录常量 + 当前行为注释 + 11 条断言 + 6 处标题/注释 + `pack-identity-name` N2 锁翻转 + 新守卫                        | 守卫 **9 failed \| 1 passed (10)**                                                               | 11 套件 **284 passed**；`npm run verify` 五项全过                                     |
| `593b142`         | `%TEMP%` 三站点前缀 + `early-crash-guard.test.ts:229` fixture + `error-handlers` 两条断言重锚 + `ui-brand-name` 批注作废 | 守卫 **4 failed \| 10 passed (14)**                                                              | 7 套件 **176 passed**；`verify` 全过                                                  |
| `a01312e`         | 两处服务名默认值 + `sync-server-view.ts:33` 注释 + `sync-server-view.test.ts:80`                                         | 守卫 **5 failed \| 16 passed (21)**（其中 2 项是「须保持绿」的禁改锁，当场即绿）                 | 4 套件 **101 passed**；守卫 21 用例在默认 / posix-host / ci-linux 三 profile 下同判据 |
| `582ffc0`（补齐） | `sync-read-repository.test.ts:739` 断言 + 守卫新增该锁点                                                                 | 全量 `npm test` 里 **1 条真红**：`AssertionError: expected 'Meow Star Map' to be 'WXNN XiangCe'` | `src/main/database` + 守卫 **13 套件 519 passed**                                     |
| `3a9244b`         | TLS CN + `identity-service.test.ts:59` + SAN/签名基串禁改锁                                                              | 守卫 **3 failed \| 22 passed (25)**                                                              | `src/main/sync` **136 passed \| 2 skipped**；守卫 25 用例三 profile 全绿              |

### 唯一一项「不需要做」的范围项

桌面快捷方式：`desktop-shortcut.ts:27,69` 早就是 `'喵星图.lnk'`（阶段 3 提交 `fed8e57`），
`desktop-shortcut.test.ts` 实跑 **12 passed**。按「别把已做完的东西宣称成红灯」的口径，本阶段
**不制造假红**，只把它纳入新守卫的防回归锁（`'喵星图.lnk'` 计数恰为 2 + 测试常量同值），
所以 C1 的红灯读数里那唯一一条绿就是它。

### 受保护路径闸门取证（C1）

`crash-service.ts:38`、`log-service.ts:189` 落在 `src/main/services/**`。本仓库 `core-path-gate.ts:162-176`
把**注释级**增删也判为实质改动（与 `AGENTS.md:60` 的「纯注释增删不触发」不符，阶段 1 §九 行 439 已记下这条偏差），
所以两处都随批带了 `// @core-change:` 行。红绿双向都验过：

```
删掉授权行 → [CORE-GATE] ✗ src/main/services/crash-service.ts — 实质改动缺少本次授权
补回授权行 → [CORE-GATE] ✓ 核心路径授权闸门通过（2 个受保护文件）
```

### 中文常量与 i18n 护栏

`i18nGuardSelectors` 的 `Literal[value=/[\u4e00-\u9fa5]/]` 是 error，所以
`PRODUCT_DIAG_DIRNAME = '喵星图'` 必须带行内豁免；沿用 `desktop-shortcut.ts:27` 的先例，
但用 `eslint-disable-next-line`（放上一行）而非 `disable-line`，以免撞 `printWidth: 100`。

---

## 四、真实落盘取证

跑 C1 套件（`crash-service.test.ts:86`、`dir-manager.test.ts:148` 调的是真实 `getUserFacingDiagDir()` +
真实 `os.homedir()`）后，本机目录实测：

| 路径                                                         | 最后写入                         | 判定                                                                    |
| ------------------------------------------------------------ | -------------------------------- | ----------------------------------------------------------------------- |
| `C:\Users\45001\喵星图\Diagnostics`                          | 10-23 13:41 创建、13:59 再次触达 | **新名生效**，由阶段 5 的套件真实创建                                   |
| `C:\Users\45001\NikkiGallery\Diagnostics`                    | 10-23 12:47（阶段 5 之前）       | 自此成孤儿，无代码再写入                                                |
| `C:\Users\45001\MeowStarMap\Diagnostics`                     | 10-23 10:13                      | 更早一轮试跑（当时按 Pascal 取值）留下的孤儿                            |
| `C:\Users\45001\Documents\NikkiGallery`、`\Documents\喵星图` | —                                | 本机都不存在 ⇒ 候选链在这里是 **homedir 候选胜出**，不是 documents 候选 |
| `%TEMP%\MeowStarMap-startup-errors.log`                      | 10-23 13:45 / 13:59              | 新前缀由 `early-crash-guard.test.ts:237` 真实写出                       |
| `%TEMP%\NikkiGallery-startup-errors.log`                     | 10-23 13:43                      | 旧名最后一次由改前的套件写出，此后成孤儿                                |

TLS CN 用反证法确认断言真的在校验生成的证书，而不是空跑：把期望值多打两个字符后用例即红，
报错读数是 **`expected 'CN=Meow Star Map Local' to contain 'Meow Star Map LocalXX'`**
——带空格的新 CN 确实被 DER 编码并被 `X509Certificate` 解析出来。

---

## 五、全局回归读数

- `npm run lint` / `npm run typecheck` / `npm run typecheck:e2e` / `npm run i18n:guard`：四条 **exit 0**。
- `npm test`（全量）：见 §五.1。
- `npm run test:ci-linux`（CI 宿主装置，按设计**不进 CI**、只作只读诊断）：
  vitest 汇总 **29 files / 46 tests 红**。把两次读数的 `FAIL` 行去重后与阶段 4 台账
  `cilinux-stage4-full.txt` 逐字比对：**本轮 66 条 = 阶段 4 的 45 条（逐字命中，且无一条本轮不复现）
  - 新增 21 条 `src/main/nikkisync/*.linked.test.ts`**。
    那 21 条是修复同级仓库链接后**第一次真正进入装置环境**才暴露的——上游 `DatabaseManager` 在模拟的
    Linux 宿主下报 `Error: unable to open database file`
    （`../NikkiSync/packages/database/src/database-manager.ts:24`），这类套件需要真实可写宿主与端口，装置本就不适用。
    ⇒ **46 条失败读数里 `Meow Star Map` / `喵星图` / `MeowStarMap` 出现 0 次**，本阶段更名与这些红无关。
    阶段 4 台账里 nikkisync 条数为 0，说明当时这些套件在装载期就 abort、从未进入装置判定。
    「装置对 `*.linked.test.ts` 不适用」是既有的工装边界问题，登记不修（不在更名范围）。
- 残留扫描（域 `src tests scripts e2e .storybook`，模式沿用 `.cache/rename-scan/old-names-stage3.txt` 29 条）：
  **改前 218 行 → 改后 175 行（Δ −43）**，基线取自改前的树 `7ffd696`（阶段 4 收尾）与本轮工作区各跑一次同一套模式。
  台账：`.cache/rename-scan/red-stage5-scan.txt` / `green-stage5-scan.txt`。
  **按文件核账**（只有这 22 个文件有增减，其余零漂移）：

  | 文件                                                                             | 改前 → 改后        | 归属                                                                          |
  | -------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------- |
  | `src/main/utils/user-diag-path.ts`                                               | 6 → **0**          | 常量 + 四行注释，全清                                                         |
  | `src/main/utils/startup-diagnostic.test.ts`                                      | 8 → **0**          | 5 条正则/等值 + 3 处标题注释                                                  |
  | `src/main/utils/early-crash-guard.test.ts`                                       | 6 → **0**          | 4 条诊断目录 + 1 条 `%TEMP%` fixture + 1 标题                                 |
  | `src/main/app/__tests__/error-handlers.test.ts`                                  | 4 → **0**          | mock 路径 + 两条重锚断言 + 注释                                               |
  | `src/main/services/crash-service.test.ts`、`dir-manager.test.ts`                 | 2→0、4→2           | 后者余 2 为 N3 的 `wxnn_photo_manager_*` 迁移模式                             |
  | `src/main/index.ts`、`crash-service.ts`、`log-service.ts`、`dir-manager.ts`      | 2→0、1→0、1→0、2→1 | `dir-manager.ts:146` 余 1 属 N3                                               |
  | `src/main/utils/startup-diagnostic.ts`                                           | 6 → **2**          | 只剩 `:24-25` 修复前实况叙述（有意保留，守卫反向锁定）                        |
  | `src/main/utils/early-crash-guard.ts`                                            | 3 → **2**          | 只剩 `:45-46` 修复前实况叙述（同上）                                          |
  | `sync-server-view.ts`、`sync-server-view.test.ts`、`sync-metadata-repository.ts` | 各 1 → **0**       | N4 两常量 + 一条断言                                                          |
  | `sync-read-repository.test.ts`                                                   | 2 → **1**          | 余 1 是 `seedServiceState()` 的自投种子值（`:591/:753` 自用，按 N4 口径不动） |
  | `identity-service.ts`、`identity-service.test.ts`                                | 各 1 → **0**       | CN 与断言                                                                     |
  | `src/main/app/__tests__/lifecycle.test.ts`                                       | 5 → 3              | 诊断两站已清，余 3 属 N3 的 DB 名 mock                                        |
  | `scripts/__tests__/pack-identity-name.test.ts`、`ui-brand-name.test.ts`          | 24→23、25→24       | N2 锁翻转为新值锁、批注订正，各减 1                                           |
  | `scripts/__tests__/runtime-disk-name.test.ts`                                    | 0 → **5**          | 新守卫自身的反向锁与禁改逐字锁                                                |

  未列入上表的文件本轮零增减，其残留按 token 命中数如下（**一行可同时命中多个模式，故各 token 计数之和
  大于总行数 175，不能当分区用**）：`wxnn_photo_manager` 71（**N3，未做**）、`NikkiGallery` 43、
  `nikkiGallery` 20、`WXNN XiangCe` 16、`wxnn-photo-manager` 9（含 `eslint.config.js` 指向本机遗留目录的
  ignore 项）、`nikkigallery` 8（共鸣导入信封线格式 + 文档正文）。
  **`NikkiGallery` 的 43 行全部可点名归属**：守卫自身 24（`pack-identity` 11 + `ui-brand` 11 + 新守卫 2）、
  插件面 8、URL 6、历史叙述 4、`SyncGalleryToolbar.test.tsx` 上游仓名 1、`perf-real.e2e.ts` 本机缓存目录 1、
  其余 0。⇒ 阶段 5 的 15 个改动文件里，除 N3 前缀外**全部归零**。

### 五.1 全量 `npm test` 与覆盖率

修复同级仓库的 `@nikkisync` 空壳链接之后（过程见 §八），本机第一次拿到**零失败**的全量读数：

| 命令                    | 读数                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm test`              | **Test Files 436 passed (436) / Tests 6696 passed \| 12 skipped (6708)**，exit 0                                                                             |
| `npm run test:coverage` | 同上全绿，`All files` 覆盖率 **69.32 / 60.57 / 61.81 / 70.92**，高于 `vitest.config.ts` 门控 `statements 66 / branches 58 / functions 59 / lines 68`，exit 0 |
| `npm run build`         | exit 0                                                                                                                                                       |
| `npm run e2e:smoke`     | **15 passed (21.5s)**，含 `nikkisync-runtime.e2e.ts` 的 N1–N4 真实应用会话用例，exit 0                                                                       |

对照：修复前同一条 `npm test` 是 `6 failed files / 30 failed tests`，全部为
`Cannot find package '@nikkisync/database' / '@nikkisync/core'`；把 C3 四处改动回退到 HEAD 跑同一批
套件得到**完全相同的 30 条**，故可判定与本阶段更名无关。

真实应用落盘（`npm run e2e:smoke` 起的打包前构建产物，非单测装置）：

```
C:\Users\45001\喵星图\Diagnostics\diag.log          1485 B  14:05
C:\Users\45001\喵星图\Diagnostics\startup-errors.log 244 B  14:05
```

⇒ `喵星图` 这个中文目录名在**真实 Electron 主进程**里由 `setDocumentsPathProvider` +
`getUserFacingDiagDir()` 创建并写入成功，`app.setPath('crashDumps', …)`（`index.ts:55`）与
`crashReporter.start` 在同一 CJK 目录下没有阻断启动，15 条冒烟（含退出链）全过。

---

## 六、已知偏差

1. **旧目录不会被自动迁移**：`Documents|<homedir>\NikkiGallery\Diagnostics`、`%TEMP%\NikkiGallery-*.log`
   与 `MeowStarMap\Diagnostics` 都留在盘上；本阶段不写迁移代码，人工搬迁清单属 N8/`DEVELOPMENT.md`。
   ⚠ 清理时不可整体删 `%USERPROFILE%\NikkiGallery\`：该目录还住着**另一个无关第三方应用**的
   `config.json`、`logs/`、`thumb_cache/`、`classify_thumb_cache/` 等（本仓库代码零写入点）。
2. **已设过自定义 crashDir 的库不跟随**：`app/custom-dirs.ts:104` 会把绝对诊断路径写进
   `app_settings['crashDir']`，`dir-manager.ts:34` 优先返回自定义值 ⇒ 老用户升级后 crashDir 仍指旧目录，
   直到用户重设。属既有行为，本阶段不改逻辑。
3. **`DEFAULT_SERVER_NAME` 只对新建库生效**：`SQL_SERVER_IDENTITY_UPDATE`（`sync-metadata-repository.ts:59`）
   的 WHERE 守卫在 `server_id` 上、`:327` 保留既有值 ⇒ 搬迁/既有库存的仍是 `WXNN XiangCe`
   （阶段 1 §十 行 451 已接受，设置面板可自改）。
4. **TLS CN 新旧长期并存**：已装机沿用旧 `server.crt`，只有全新安装或自愈重签才拿到新 CN。
5. **`startup-diagnostic.ts:38,57` 两条 `%TEMP%` 分支零运行时覆盖**：`getUserFacingDiagDir()`
   吞掉全部候选异常、必返字符串 ⇒ `catch` 不可达，且 `startupLogPath`/`diagLogPath` 是模块级 memo、无注入缝。
   本阶段不为此改函数签名（属逻辑变更），改由守卫逐字锁定源码字面量。**这是既有的覆盖缺口，不是本阶段引入的。**
6. **`runtime-manager.ts:489-491` 的重建判据 `portChanged` 不比较 `name`**：若将来把服务名做成用户可编辑，
   改名单不会重建会话。当前无该入口（`nikkisync:start-server` 的 zod 只收 `{port, mdnsEnabled}`），仅登记不修。

## 七、未验证项（如实记录）

- **真机 Android 客户端上显示的服务名**：`SYNC_SERVER_DEFAULT_MDNS = false`（上游组播自激缺陷，
  `sync-server-view.ts:35-46`），手机发现走 QR `NS1|` 第 3/4 段的 host:port，mDNS 实例名这条路径
  在本仓默认根本不开。已验到的层面：`sync-server.linked.test.ts` 在真实上游 `LocalSyncServer` +
  `PairingService` 上跑通 `PairResponse.serverName` 的逐字透传（`:439/:445`，本轮修复环境后可跑且绿），
  以及 `MdnsAdvertiser.ts:52` 的清洗白名单含空格 ⇒ **名字不会被上游改写**；
  但「手机上肉眼看到 `Meow Star Map`」需要真机配对，本轮未做。
- **Crashpad 真写崩溃转储到 CJK 目录**：`npm run e2e:smoke` 证明真实主进程能以
  `…\喵星图\Diagnostics` 作为 `crashDumps` 正常启动、运行、走完退出链，但没有制造真实崩溃，
  因此「Crashpad 落 `.dmp` 到中文目录」这一步仍未取证（需要 `scripts/simulate-gpu-crash.cjs` 一类主动引爆，
  属另一轮取证）。
- **打包安装态（NSIS 装完）的诊断目录**：本轮只跑到 `npm run build` + 构建产物 e2e，未重装安装包；
  阶段 4 已验过 `win-unpacked/喵星图.exe`，两者对 CJK 的处理一致，故记为「同类风险已被先行取证覆盖」而非空白。

## 八、取证过程失误 vs 仓库/环境缺陷（分开写）

### 我的失误

- 阶段 5 规划时把 `sync-read-repository.test.ts:739` 判成「自投 fixture、恒绿」，依据是该文件
  `:156` 的 `seedServiceState()` 种了 `server_name: 'WXNN XiangCe'`。C3 的验证子集又只跑了常量同名套件
  （`sync-server-view` / `sync-metadata-repository` / `nikkisync-runtime-setup`），于是这条真红一路漏到
  全量 `npm test` 才被抓出。实情是 S6c 用例**不**调用 `seedServiceState()`（只有 `:591/:753` 调用），
  走的是 `ensureServerIdentity()` 的新建分支，因此它锁的正是 `DEFAULT_SERVER_NAME` 的字面值。
  ⇒ 教训：**「文件里有同名种子数据」不等于「该用例用了它」**；改默认常量必须跑遍所有读该列的套件。
  已由提交 `582ffc0` 补齐，并把这条锁写进守卫、在注释里记下判错原因。
- C2 的守卫段刚建好时留了一行未使用的 `BRAND` 常量，`npm run verify` 的 lint 步骤当场报
  `no-unused-vars`——是我把 C3 才用的常量提前写进去了。当场删除，C3 落地时再加回。
- 收尾文档时先写了「阶段 1 记录 → 新记录」的链接、后 `git add`，被仓库自带的
  `scripts/__tests__/check-md-links.test.ts`（真实仓库契约：被跟踪文档不留死引用）当场判红：
  `docs/plans/2026-10-23-project-rename-meow-star-map.md:515 markdown-link ./2026-10-23-rename-runtime-pass.md`。
  该闸门只承认**已跟踪**文件为合法目标 ⇒ 新文档必须与其入链同批暂存。两文件一起 `git add` 后 24 用例转绿。
  这不是仓库缺陷，是闸门按设计抓住了我的提交顺序。

### 环境缺陷（非本阶段引入，已修复并取证）

- `npm test` 里的 30 条红来自**同级仓库** `../NikkiSync`：`node_modules/@nikkisync/{core,database,protocol}`
  是 10-14 遗留的**空目录**（不是 workspace 符号链接），Node 解析到目录却没有 `package.json` ⇒
  报 `Cannot find package`。本仓四个顶层 `node_modules/@nikkisync/*` 链接与四个包的 dist 产物其实都在，
  缺的是 NikkiSync 自己 workspaces 内部的那一层。
  修复：在 `../NikkiSync` 里跑 `npm install --no-audit --no-fund`（该仓库工作树 git 干净、`node_modules` 不入库），
  233ms 换回 6 个包、空目录被正确符号链接替换；随后 `src/main/nikkisync` 16 套件 220 用例全绿。
- 由此暴露一个真缺陷：`npm run verify:nikkisync` 十条全 ✓，却对「linked 套件必红」毫无预警——
  它只验顶层四个链接在场与 dist 产物在场，**不验 NikkiSync 单仓内部的跨包解析**。
  本轮未动它（属工具面，不在更名范围），在此登记。

### 本地工装读数误导

- `.cache/rename-scan/audit.mjs` 对纯新增文件报「改动行 0 … URL漂移 ✗」：它的「改动行」取
  `min(增, 删)`，而守卫新增的 28 行里含 `http://wxnn.local` 逐字禁改锁 ⇒ 被当成 URL 漂移。
  已用 `git diff -U0` 直接复核（28 行纯新增、0 删除），**被改动的既有 URL 数为 0**。属工装表述误导，不是仓库问题。
