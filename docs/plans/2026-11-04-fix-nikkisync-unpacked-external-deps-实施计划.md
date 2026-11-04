# 同步图库「扫描游戏相册 / 照片目录」失效修复——实施计划（2026-11-04）

> 症状：(1) 同步图库「扫描游戏相册」按钮完全失效；(2) 同步服务页「照片目录（自定义路径）」保存后无法扫描，弹窗提示重启且重启无效。
> 决策：路径语义按上游设计（照片目录=游戏安装根 / 额外照片目录=任意文件夹）；本次暂不重新打包；顺带把扫描失败从静默 console.error 改为可见提示。
>
> **执行状态（2026-11-05 复查轮订正）**：节点 1–3 已实施完毕并留在工作区，节点 4 的**实现口径与本计划原文不一致**（见该节订正），
> 节点 5 与「后续」一节的「本次不打包」已被 2026-11-05 复查轮推翻——本轮要出包，处置见
> `docs/plans/2026-11-05-audit-verify-2.5.6-repack-实施计划.md`。原文按本仓惯例逐字保留、不覆写。

## 一、根因（装机日志 + 产物解包双重实锤）

安装版（D:\AAA\meow-star-map，v2.5.6）`logs/main.log`：

```
[NIKKISYNC] nikkisync runtime assembly failed: Cannot find package 'qrcode' imported from
  ...\app.asar.unpacked\node_modules\@nikkisync\pc-companion\dist\src\wechat\GalleryRuntime.mjs
[sync-gallery] startScan failed NikkiSync runtime is not ready (Cannot find package 'qrcode' ...)
```

机制：

1. 打包配置把 `@nikkisync` 经对象式 from/to 入包，并由 `asarUnpack: ["**/@nikkisync/**", ...]` 解到 `app.asar.unpacked/node_modules/@nikkisync/` 分支。
2. 上游桶导出闭包含必经静态外部依赖边：`index.js → server/index.js → LocalSyncServer.js → ../wechat/GalleryRuntime.mjs → import QRCode from "qrcode"`（GalleryRuntime.mjs:595，row-mappers/LocalSyncServer 均引用，绕不开）。
3. `qrcode`（根 dependencies ^1.5.4）被 electron-builder 收集进 **asar 内部** node_modules（asar list 实证在包内）；但 Node ESM 解析从 unpacked 文件**向上走真实目录树**，`app.asar` 是旁支文件，永远解析不到其中的 node_modules ⇒ `Cannot find package 'qrcode'`。
4. 装配必抛 ⇒ runtime state='error' ⇒「扫描游戏相册」startScan 抛 not ready（渲染层仅 console.error，用户感知"点了没反应"）；「照片目录」applyGameRoot 失败命中 RUNTIME_UNREADY_RE → 'runtime-unavailable' → 弹"重启后生效"，重启后 qrcode 依旧缺失，死循环。两个症状同根。
5. dev 态 qrcode 从根 node_modules 可解析、装载正常（实测）——开发期从未暴露。
6. 既有打包闸门 `closureLoadChain` 只跟随**相对** import 边，bare import 不可见——闸门全绿但产物带病。

「弹窗提示重启」只是装配失败的兜底分支；代码本来就是保存后当场换根重建+全量扫描（applyGameRoot），修复根因后"立即生效"行为自动恢复，交互无需改动。

## 二、修复方案（最小改动：1 处打包配置 + 测试 + 闸门 + 渲染层小改进）

### 依赖声明

- 新增 npm 依赖：无。qrcode ^1.5.4 已在根 dependencies；dijkstrajs、pngjs 为其已安装传递依赖（零依赖）。无需 npm install。

### 节点 0：本计划落盘（本文件）

### 节点 1：红灯测试

- 新建 `scripts/nikkisync-external-deps.ts`（写本行时该文件只在工作区、**未入仓**，随 2026-11-05 复查轮节点 N2 提交）：`collectNikkiSyncExternalDeps(files)` 提取 bare import（排除相对/node:/@nikkisync）；`missingUnpackCoverage(externalDeps, asarUnpack)` 判覆盖（同 `unpackedCovers` 的 `pattern.includes(name)` 判据）。
- 新建 `scripts/__tests__/nikkisync-unpacked-external-deps.test.ts`（同上，当时**未入仓**）：真实仓库态断言（红灯所在，qrcode 未覆盖）+ 异常 + 边界用例。
- 验收：`npx vitest run scripts/__tests__/nikkisync-unpacked-external-deps.test.ts` 失败并点名 qrcode（该文件**未入仓**期间命令不可原样复跑，2026-11-05 N2 之后可以）。

### 节点 2：核心修复

- `package.json` `build.asarUnpack` 追加 `"**/qrcode/**"`、`"**/dijkstrajs/**"`、`"**/pngjs/**"`（yargs 为 qrcode bin CLI 专用，运行时不 require，不加）。
- 验收：节点 1 测试转绿；npm test 全量无新增失败。

### 节点 3：产物级回归闸门

- `scripts/pre-dist-check.ts` 的 `checkUnpackedNativeBinaries()` 增一节：扫解包产物 `@nikkisync/*/dist` 外部 bare import → 断言 `unpackedRoot/node_modules/<pkg>` 存在，缺失 fail（点名包名 + 指引追加 asarUnpack 条目）。
- 配套单测挂 `scripts/__tests__/pre-dist-check.test.ts`（虚拟化解包树：正常过/qrcode 缺红/空集过）。
- 零打包实测：`npx tsx scripts/pre-dist-check.ts --verify-asar --asar="D:/AAA/meow-star-map/resources/app.asar"` 对真实缺陷产物报红，证明闸门能拦住本次出厂缺陷。

### 节点 4：扫描失败可见化

- `src/renderer/pages/sync-gallery/SyncGalleryPage.tsx`：handleScan catch 里 `setScanError(extractUserMessage(e))`（保留 console.error），行内提示条复用本页续页错误同款样式；i18n 全 locale 新增 `syncGallery.scanFailed`。
- 测试先红：startScan reject → 页面出现失败提示；再扫描清除旧提示；成功无提示。

> **订正（2026-11-05 复查轮，预期与落地分叉要显式记账而不是改原文迁就实际）**：实现没有走「行内提示条 + 新增 `syncGallery.scanFailed`」，
> 而是复用全局 Toast 宿主（`useGlobalToast`，先例 `BannerWishButton.tsx` 同款）——这样不动 12 语言包、不给页面另挂 Toast 宿主。
> **但复查认定该实现引入了一处规范缺陷**：`extractUserMessage` 在这条链上拿不到 `userMessage`（`AppError.preconditionFailed` 不设该字段），
> 会退化到 `message`，而 `message` 由 `runtime-manager` 的 `notReadyMessage` 把装配失败原文（含绝对安装路径）拼了进去
> ⇒ 用户会看到未翻译英文 + 本地路径，违反约定 §2「userMessage 用于 UI 展示……不含技术细节、路径」。
> 且当时的配套用例把这一形状**固化成了断言**。修正口径与红绿读数见下一轮的 执行记录 与
> `docs/plans/2026-11-05-audit-verify-2.5.6-repack-实施计划.md` 节点 N1。

### 节点 5：全量回归

- `npm run typecheck && npm run lint && npm test` 全绿；`npm run verify` 通过。

## 三、错误处理与参数校验

- 闸门/测试对文件缺失、读取异常一律"事实不可得 ⇒ 不放行"，不静默吞。
- `missingUnpackCoverage`：asarUnpack 仅接受 string[]，非数组/非字符串元素判未覆盖（fail-safe）。
- 渲染层提示经 i18n 键守卫，不硬编码中文；无文案时回落通用键。
- 主进程侧不改（runtime-manager/handler 逻辑正确，失败已如实落日志与状态快照）。

## 四、后续（本次不做）

- `npm run dist:win` 重新打包并覆盖安装后，安装版两功能实际恢复（runtime-status 不再报 qrcode 缺失、扫描出结果、照片目录保存即时生效不弹重启）；届时 verify:dist 自动跑节点 3 新闸门。
- dev 态不受本 bug 影响，可用于体验功能语义。

## 五、风险与如实声明

- 本次不打包 ⇒ 修复对 D:\AAA 安装版暂不生效，效果在下次打包安装后兑现（节点 1/3 测试与闸门保证配置正确性）。
- asarUnpack glob 生效性由既有同款条目（better-sqlite3 等，实证已在 unpacked）背书；最终以节点 3 对真实产物的实测与下次 verify:dist 收口。

## 六、复查轮执行记录（2026-11-05，本轮实测取数）

复查对象 = 最后一次出包（`release/MeowStarMap-Setup-2.5.6.exe`，2026-11-04 07:04，源码树 `eb392ae`）之后的全部代码改动，
即节点 1–4 留在工作区的 8 个路径（`package.json` / `scripts/` 新纯函数层与两份测试 / `pre-dist-check.ts` 新段 / 同步图库页与其用例）。

| 项                       | 读数                                                                                                                                                                                                                                                                                                                                                                                          | 取证命令                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 外部依赖闭包的**完整性** | 扫 105 个 `@nikkisync/*/dist` 产物 ⇒ `seed=["qrcode"]`、`closure=["dijkstrajs","pngjs","qrcode"]`，与节点 2 追加的三条 unpack **一一对应，不多不少**（`yargs` 只被 `bin/qrcode.js` 引用，不在主入口可达图内，正确地没进闭包、正确地不 unpack）                                                                                                                                                | 以真实 junction 调 `nikkisync-external-deps` 的判定链跑通                        |
| 节点 3 闸门的**真红灯**  | 对现役带病树跑 `--verify-asar`，第 23 行输出 `✖ @nikkisync 外部依赖 qrcode 未随包解到 app.asar.unpacked/node_modules`，EXIT=1；`ls` 反查 `release/win-unpacked/resources/app.asar.unpacked/node_modules/` 确实没有 `qrcode`                                                                                                                                                                   | `npx tsx scripts/pre-dist-check.ts --verify-asar`                                |
| 节点 1 的「修复前红」    | **本轮未复现**，如实记账：unpack 配置与契约测试是同一批未提交改动同时落地的，没有留下可回放的红灯。改由变异抽查补证——M1 撤掉 `package.json` 的 `**/qrcode/**` ⇒ 开发态契约测试当场点名 `qrcode`（下一轮 N2 执行并回写读数）                                                                                                                                                                   | —                                                                                |
| 追加发现 ① 判据失真      | `pre-dist-check.ts` 新段的 skip 分支只看 `externalClosure.length === 0`，于是「dist 扫到了、只是零 bare 依赖」也会打出「解包树无 dist 可扫」——两件事混成一件，出货闸门的读数必须能对上事实 ⇒ 改按 `nikkisyncDistSources.length` 分流（下一轮 N2）                                                                                                                                             | —                                                                                |
| 追加发现 ② 打包垃圾风险  | `node_modules/@nikkisync` 里除四条 junction 外，还有 09:01 npm 中断留下的两个点号重复树（各含完整 `dist`/`migrations`）；`build.files` 的对象式整目录拷贝可能把它们带进包 ⇒ 出包前清掉（`node_modules` 不入 git、`npm run link:nikkisync` 可重建），并在包内断言 unpacked `@nikkisync` 恰为 core/database/protocol/pc-companion 四项。现役 07:04 包里正好只有四项，可反证它是本轮新出现的污染 | `ls -a release/win-unpacked/resources/app.asar.unpacked/node_modules/@nikkisync` |
| 判据边界三条 → DEBT-060  | `resolveMainEntry` 只读 `main` 不读 `exports`（未来 exports-only 的包会漏报，方向是假绿）；`relativeCandidates` 缺 `.json` 与 `/index.mjs`、`/index.cjs`；`missingUnpackCoverage` 的 `pattern.includes(dep)` 对短名有子串误覆盖风险（只服务开发态配置测试，出货闸门走 `existsSync`）。当前三包均有 `main`、实测闭包正确 ⇒ **属实不修**，登记 DEBT-060                                         | —                                                                                |
| 用例覆盖面如实说明       | 新增的 7 例里，「解包树无 dist ⇒ 三段皆空」一例对任何返回数组的实现恒绿，钉的是 skip 形状而非缺陷，**不计入回归红例**；行为两例手工摆 `sources`、绕过 `collectModuleTree`，故 dist 遍历/跳过规则只有正则接线覆盖、没有行为覆盖                                                                                                                                                                | —                                                                                |
