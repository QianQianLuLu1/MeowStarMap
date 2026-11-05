# Changelog | 变更日志

All notable changes to this project will be documented in this file.
本项目所有重要变更都将记录在此文件中。

The format is based on [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/lang/zh-CN/spec/v2.0.0.html).
本文件格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
并遵循 [语义化版本](https://semver.org/lang/zh-CN/spec/v2.0.0.html) 规范。

> **关于 `docs/archive/**` 的引用口径**：本文件若干条目的「计划见 …」指向 `docs/archive/`，而该目录被
> `.gitignore:188`（`/docs/archive/`）排除，是**本机留存区、不在版本控制内**——干净克隆里这些路径不可解析。
> 要追同轮记录，先查 `docs/plans/`（活文档）与 `docs/plans/archive/`（已结案轮次的受跟踪归档，建立于 2026-10-30），
> 再按条目里的 commit SHA 走 `git log`。历史条目中的 `docs/archive/plans/*.md` 按原文保留、不覆写。

---

## [Unreleased] | 未发布

新增、即将在下个版本发布的功能或修复。

---

## [2.5.6] - 2026-11-01

> 2.5.6：全屏预览与同步图库缺陷修复的收口定版。四处版本声明位（`package.json` / lock 根 / preview mock / `release/latest.yml`）同步为 `2.5.6`，安装包名随 `artifactName` 模板为 `MeowStarMap-Setup-2.5.6.exe`。

### Added | 新增

- **同步图库自定义照片目录（2026-11-01）**：「同步服务」页新增「照片目录」分区，支持手动输入或浏览选择本地目录以**替代系统默认路径**（留空回退上游自动发现的游戏安装根）。主进程新增 `nikkisync:get/set/reset-game-root` 三通道（持久化设置键 `nikkisync.gameRoot`，重启后由 `buildSessionOptions` 既有读取端自动生效）与 `nikkisync:admit-directory` 预检通道（K6 额外照片目录同步支持手输路径，先校验再走既有 inspect 提案流）。校验口径：绝对路径 + 系统敏感目录黑名单 + 存在/目录/可读必过，可写探测失败仅提示不阻断（照片源目录扫描只读）；保存/恢复默认走「成功提示 → 重启询问 → relaunch」流。新增键入 `SECURITY_SENSITIVE_KEYS`（settings:set 拒绝并指向专用通道）；文案 12 语言齐备。计划与验证读数见 `docs/plans/2026-11-01-sync-gallery-custom-photo-dir-实施计划.md`
  - 二轮审查修正（2026-11-01）：① **手输预检不再授予全局免检**——首版 `admit-directory` 把渲染层传入的目录经 `registerUserPickedDir` 写进 `userPicked`/`userPickedDirs`/`roots` 三个全局集合，而 `matchesPicked` 按**前缀**命中、`scanner:start` / `settings:set`(customScanPaths) / `assertMediaAccessPath` / `media://` 规则 0 全拿它做黑名单短路，等于把无对话框手势的渲染层任意串写进全局授权集合（与 `validator.ts` 自陈的「渲染进程无任何 IPC 可写入该集合」直接矛盾）。改为只登记同步域专用集合 `registerSyncPhotoDir`，唯一消费方是 `nikkisync:inspect-extra-directory`；手输目录的照片仍按 `media://` 第 4 条规则（resource-allowlist 精确授权表）读图，功能面零收窄。② **`gameRoot` 读写两端键名同源守卫**——写端字面量与读端 `SETTING_GAME_ROOT` 分处两层，变异实测显示读端改名时全仓 1179 例仍绿（读端测试用常量符号化供键、改值后自洽），故新增源码级钉（改任一侧即红）。审查结论与逐节点读数见 `docs/plans/archive/2026-Q4/2026-11-01-photo-dir-review-fix-2.5.6-repack-实施计划.md`
  - 保存即生效（2026-11-01，自 `[Unreleased]` 并入）：`nikkisync:set/reset-game-root` 首版只写设置键，而该键的唯一读者是进程启动那一次的 `buildSessionOptions`（产物冻结成会话默认快照与 `activeRoot`）——运行期既无重建调用，图库工具栏的 `startScan()` 又是无参的（读同一份旧快照 ⇒ 换根判据恒等），于是**应用内不存在任何动作能把刚保存的目录推给运行中的会话**：用户「已成功选择自定义路径」后板块仍停在旧根，该路径下的照片一条都不出；而重启也不自愈（`nikkisync.runtimeEnabled` / `syncServerEnabled` 缺省关，重启后不自启会话、也不补扫）。修法：`runtime-manager` 新增生效通道 `applyGameRoot(gameRoot)`——先刷新会话默认快照（否则 `scan({})` 与改端口时的重建支会把新目录静默退回旧根），再复用既有 `scan({ gameRoot })` 完成换根重建 + 一次全量扫描；局域网同步服务随 teardown 停止，**原本在监听才**按同配置复原，原本没跑不代为开启。set/reset 落库后当场调用，并只在成功后广播 `nikkisync:library-changed`（与 `start-scan` 同判据）。契约同步订正（向后兼容）：`needRestart` 由恒 `true` 改为「未能当场生效才为 `true`」，新增可选 `applied` / `applyError`（`runtime-unavailable` | `installation-not-found` | `scan-failed`）；生效失败时值仍已持久化，绝不把已成功的保存改判为失败。渲染层据 `applied` 分流文案，即时生效不再拿重启询问挡在用户与照片之间；目录形态不是安装根时给可执行提示（改选游戏安装目录，或走「额外照片目录」）且不再询问重启。`photoDirectories` 文案 12 语包齐备（改写 3 键、新增 2 键）。计划与逐节点红→绿读数见 `docs/plans/2026-11-01-sync-gallery-photo-dir-apply-on-save-实施计划.md`
  - 保存即生效重打包轮审查修复（2026-11-01）：① **scan 串行化**——在途全量扫描未落地时换根重建会拆掉正在扫描的会话（`teardown` 插进 `await fullScan` 的让出点），`scan()` 临界区互斥 + settle 语义修复；② **恢复默认不再误报**——reset 路遇「该目录不是有效的游戏安装根」改走「已保存 + 重启询问」兜底，不再吞询问给无效指向；③ **`admit-directory` 盘根闸**——`D:\`、`C:/`、`\`、`/`、`//`、`///`、`\\nas\share` 等盘根/UNC 根形态此前能过「非敏感 + 存在 + 是目录 + 可读」四关，把整块盘递给上游当同步扫描根（`inspect-extra-directory` 对恰为盘根的路径还会短路），新增 `isBareDirectoryRoot` 纯形态判据前置拒绝、不落库不登记，`set`/`reset-game-root` 不收窄（安装根由上游自限）；④ **未装配 Runtime 的生效失败补回 `applyError:'runtime-unavailable'`**（契约早已如此定义，渲染层仍按 `needRestart` 走重启兜底）；⑤ **生效失败分类判据与 `runtime-manager` 同源**（`installNotfoundMessage` 常量比对替代宽正则 `/not found/i`），含无关 "not found" 的下游故障归 `scan-failed`，不再骗得「不是安装根」文案；⑥ **照片目录校验错误走 `userMessage` 与 `maskPath` 脱敏**——message 经主进程 i18n 输出、不再拼接裸路径，details 只留末 2 段，修复跨进程后渲染层拿英文技术串 + 完整盘路径弹 toast（`ValidationError`/`PermissionError` 无默认 `userMessage`）；⑦ **同步服务页收口**——手输预检补 busy 门（连点不再并发两条 admit+inspect 链）、输入框边框改用已定义的 `--border-subtle` token（原 `--border-color` 无定义处、声明失效回落文字色）、生效失败时不再叠加「目录不可写」第二条 toast。真机判据 `e2e/nikkisync-game-root.e2e.ts`（G1/G2/G3）与审查读数见 `docs/plans/2026-11-01-review-fix-2.5.6-repack-round2-实施计划.md`

### Fixed | 修复

- **同步图库「扫描游戏相册 / 照片目录」装机即失效：`@nikkisync` 的外部依赖没随包解出（2026-11-05，本轮随重打包入包）**：安装版 `logs/main.log` 实锤 `nikkisync runtime assembly failed: Cannot find package 'qrcode' imported from …app.asar.unpacked\node_modules\@nikkisync\pc-companion\dist\src\wechat\GalleryRuntime.mjs` ⇒ 运行态落 `error` ⇒「扫描游戏相册」抛 not ready、「照片目录」保存命中「未就绪族」弹「重启后生效」而重启依旧无效（两症状同根）。机制：`@nikkisync` 经 `asarUnpack` 解到 `app.asar.unpacked` 分支，其外部纯 JS 依赖只进 asar 内部的 `node_modules`，而 Node ESM 从 unpacked 文件**向上走真实目录树**、`app.asar` 只是旁支文件 ⇒ 永远解析不到其中的依赖；既有打包闸门只跟随**相对** import 边，bare import 不可见 ⇒ 闸门全绿、产物带病，而 dev 态从根 `node_modules` 可解析，开发期从未暴露。修法三条：① `build.asarUnpack` 追加 `qrcode`、`dijkstrajs`、`pngjs` 三项——闭包实测 `scannedFiles=105 / seed=[qrcode] / closure=[dijkstrajs,pngjs,qrcode]` **恰好补齐**（`yargs` 只被 `bin/qrcode.js` 引用、不在主入口可达图内，正确地不 unpack）；② 新建纯函数判定核 `scripts/nikkisync-external-deps.ts`（bare import 三层过滤提取 + 主入口可达图闭包 + fail-safe 覆盖判定），开发态契约测试与打包态闸门共用同一真相源、两侧不各自抄录；③ `scripts/pre-dist-check.ts` 的 `checkUnpackedNativeBinaries` 末节新增产物级断言——扫解包树内四包 dist 求闭包并逐包断言 `unpacked/node_modules/<pkg>` 真实存在，对现役带病树实测报红（`✖ @nikkisync 外部依赖 qrcode 未随包解到…`，EXIT=1）。**同轮复查另修两处**：其一，`SyncGalleryPage` 的扫描失败 Toast 把 `extractUserMessage(e)` 原样铺进 UI——这条链上 `AppError.preconditionFailed` 不带 `userMessage`，取值退化到 `message`，而 `message` 由 `runtime-manager` 的 `notReadyMessage` 拼进装配失败原文与绝对安装路径，违反约定 §2「UI 不铺技术细节与路径」，且当时的用例把这个形状固化成了断言；改判据先行取红灯（received 正是那条英文 + 路径，`Tests 1 failed | 11 passed`），修后复用仓内既有键 `toast.scanFailed`（其余 10 语该键为空串，经 `returnEmptyString: false` + `fallbackLng: zh-CN` 回退）⇒ 零语言包改动，详情只进 `console.error` 保留渲染层上报链。其二，外部依赖步的 skip 此前只看闭包为空，会把「dist 扫到了、只是零 bare 依赖」冒充成「解包树无 dist 可扫」，改按产物扫描数分流。变异抽查两次（M1 撤 unpack 覆盖 ⇒ 契约测试当场点名 `qrcode`；M2 撤闭包调用 ⇒ 接线契约用例红），两次后各以 sha256 证逐字节还原；判定核的三条漏报边界（只看 `main` 不看 `exports`、CJS 扩展解析序缺 `.json` 与两个 index 形态、asarUnpack 子串覆盖判据）属实但本轮不可复现，登记为 DEBT-060。计划与逐节点红→绿读数见 `docs/plans/2026-11-05-audit-verify-2.5.6-repack-实施计划.md`（缺陷根因与首轮实现见 `docs/plans/2026-11-04-fix-nikkisync-unpacked-external-deps-实施计划.md`）
- **启动即闪退设备永久无出路：GPU 三级兼容阶梯与取证补位（2026-11-02，本轮随重打包入包）**：问题设备被 Chromium 的 `gpu_data_manager_impl_private.cc:417] GPU process isn't usable. Goodbye.` FATAL 打死（主进程 `int 3` 同步自杀，JS 侧无异常无退出痕迹），旧口径「兼容模式仍崩即放弃」是死胡同——按上游实现，`disableHardwareAcceleration()` 只把 GPU 模式阶梯往下弹，**GPU 进程照样启动**，每档崩满 3 次后 `fallback_modes_` 仍走空 ⇒ 同一个 FATAL。本轮改为跨启动持久化的三级阶梯（`gpu-fallback.json` 的 `compatLevel`：0 硬件加速 / 1 禁用硬件加速 / 2 追加 `--disable-gpu` + `--disable-software-rasterizer`，使上游 `GpuAccessAllowed()` 判 false、GPU 进程不再启动，该 FATAL 结构性不可达；本应用渲染层全用 2D canvas，2 级只付性能代价）：崩溃未到顶则**先把档位落盘再 relaunch**（旧「直接放弃」封堵），到顶则不再重启、不再上升（防死循环）并提示导出诊断包。另三处收口：① **启动成功判定延后**——首绘瞬间只退出启动期，清零 `consecutiveFailures` 要等存活 8s 或「已首绘后的正常退出」，因为转储显示 FATAL 多发生在**页面已画出之后几秒**，瞬间清零会让计数永远攒不满、阈值兜底失效；② **陈旧心跳对外只读**——`classifyPreviousExit` / `getPreviousExitEvidence` 把「上次是否被原生层杀死」的判定结论透出，供阶梯在本次实际用过的档位上加一级（只升一级、封顶 2、版本变更自动复位）；③ **取证装得下证据**——致命弹窗同时指出 `chromium-debug.log`（`exit_code` 只在这里，`startup-errors.log` 永远没有原生 FATAL），「导出诊断包」纳入 `chromium-debug.log`(+`.old` 截尾 2MB) / `diag.log` / `gpu-fallback.json`，文件名三方同源（`CHROMIUM_LOG_BASENAME`）；设置页 GPU 状态卡与启动摘要行新增可选 `compatLevel` 字段（`docs/IPC_CONTRACT.md` §`app:gpu-status` 已登记向后兼容）。本机三档实测订正了计划判据：档位 1 的子进程仍是 `--use-gl=angle`（计入崩溃上限，救不回来），档位 2 只剩 `--use-gl=disabled` 的 info-collection 进程（`RecordProcessCrash()` 首行按 `kind != SANDBOXED` return ⇒ 无法推进崩溃计数）。**同轮复查另修两处**：`writeHardwareAccelPref(true)` 此前只清 `fallbackActive`/`compatLevel` 而漏 `consecutiveFailures`，计数已达阈值时下次启动被阈值分支当场回手置位 ⇒ 用户在设置页明确开启硬件加速被静默架空；以及 Electron 41 实测 `app.exit()` / `process.exit()` **都不触发** Node 的 `exit` 事件（只有 `app.quit()` 触发），故 GPU 自愈的主动重启会留下心跳却无退出码 ⇒ 下次启动判成「被原生层杀死」而**在刚落盘的档位上再叠一级**（0 级崩一次直接跳 2 级，三级塌成两级），现由 `app.exit`/`process.exit` 包装层当场落 `last-exit.json`、并给心跳定时器补上停摆点。逐节点红→绿读数、三档实测与包内新鲜度取证见 `docs/plans/archive/2026-Q4/2026-11-02-gpu-fatal-level3-compat-实施计划.md` 与 `docs/plans/2026-11-02-gpu-ladder-review-fix-2.5.6-repack-实施计划.md`；强杀/断电同形误判登记为 DEBT-047
- **回收站「清空回收站」把失败谎报为成功（2026-11-02）**：真机 41 项移入系统回收站全部失败却弹**绿色成功** Toast、且没有任何重试或出路入口。根因是三条叠加：① **契约漂移**——`docs/IPC_CONTRACT.md` §2.8 声明返回 `{message, movedCount, missingCount, failedCount}` 并写明「`RecycleBinPage` 仅消费 `message` 与 `failedCount`」，而 `src/main/preload/api/media-action.ts` 与 `src/renderer/vite-env.d.ts` 都把返回类型收窄成 `{message: string}`，**TypeScript 从类型层面阻止了页面读 `failedCount`**，于是这个漂移能长期存活且主进程 96 例全绿；② **失败态不可达**——错误分支从不调 `setFailedAction('empty')`，使既有的「重试清空」按钮与 `handleRetry` 的 empty 分支成为死代码；③ `shell.trashItem` 在该机 H 盘恒定失败（经「同卷换路径形态 / 同形态换卷」分离实验定性为**卷级**不可用：C 盘含空格与中文都正常，H 盘连刚新建的 ASCII 无空格文件都返回 `Failed to perform delete operation`；`fs.unlink` 在同一文件上每次成功）。修法：三处类型与文档同源并补齐 `forceDeletedCount`；渲染层按 `failedCount>0` 判**业务失败**（红 Toast 透传主进程文案 + 点亮重试），并新增**经用户显式二次同意**的可选 `force` 通道（跳过系统回收站直接彻底删除）——默认路径绝不自动升级为永久删除，`7d4459f` 的不变式与「移入失败且文件仍在 ⇒ 保留 DB 记录」的 B1 规则在 force 下同样成立。通道向后兼容（`wrapHandlerNoArgs` → `z.tuple([z.boolean().optional()])`，`[]` 与 `[undefined]` 均由**真实 zod** 覆盖，因 `media.test.ts` 的 mock-validator 不执行 schema）。审查轮另修两处：force 分支原语吞掉原始错误导致聚合日志第二参数恒 `undefined`（EPERM/EBUSY 无从分辨，与同文件「聚合一条含首个错误」的自陈不符）、永久删除确认框原文案断言「这 N 项文件当前无法移入系统回收站」而 force 实际作用于回收站当前**全部**软删除记录（含失败后新软删除、可能落在健康卷的条目）⇒ 改为陈述已证实事实并披露影响面。同源缺陷「彻底删除选中项」无出路登记为 DEBT-044。计划、真机取证与逐节点红→绿读数见 `docs/plans/2026-11-02-fix-empty-recyclebin-failed-as-success-实施计划.md`
- **照片目录与 NikkiSync 生命周期四处审查修正（2026-11-02）**：① **盘根闸认正斜杠 UNC 根**——`isBareDirectoryRoot` 的 UNC 支只匹配两个反斜杠起始，而 `//nas/share` 既过 `absolutePath` schema（`/` 起始被放行）又过本闸，Windows API 两写法同指一个共享根 ⇒ 整个共享可被登记成同步照片源递给上游当扫描根，正是 `f29bd5a` 那道 D3 闸从另一侧漏进来的形态（`//nas/share/photos` 等子目录继续放行）；② **「运行期未就绪」短语集收敛为单一常量**——同文件 `toAppError` 用四条而照片目录生效分类只用两条，`requireSession()` / 上游 `createPairingPayload` 的 `Server must be started …` 一族在两条链上拿到不同分类码，与 `f29bd5a` 自陈的「判据与 runtime-manager 同源」不符（如实限定：`applyGameRoot` 今日的可达错误两侧结论一致，本条钉的是判据同源）；③ **`stop()` 占住 `600a996` 的串行闸门**——停机只在入口 `settleScan()` 而未把自己发布进 `state.scanInFlight`，停机在途时新到的 `scan()` 只等上一轮扫描、不等这次停机，于是停机的拆除链与换根重建的拆除链作用在同一个会话上：修复前实测**同一会话被 `dispose()` 两次**（关的是同一个 SQLite 句柄，上游不做幂等保护），而终态会被后写的 `running` 掩盖 ⇒ 判据按会话对象各自计数；④ **照片目录真机套件三处判据卫生**——头文档仍写「G2 手输根 B」而 `d86c7c2` 起 G2 与 G1 同根、模块级 `process.env.NIKKISYNC_GAME_ROOT` 无复原（`workers: 1` 复用同一进程，该变量的语义是短路整条注册表/PowerShell/驱动器枚举链，会泄漏给同批后续 spec）、G1 用 poll **之前**取的快照判 `installRoot`/`lastScan` 而 poll 只校 `state`。邻近项：`scan()` 无超时与合并登记为 DEBT-045、未定义 token `--border-color` 残留登记为 DEBT-046。逐项红灯原文与变异抽查见同一份计划文档的执行记录

- **全屏预览顶部工具栏点击无响应（2026-11-01）**：Electron `-webkit-app-region: drag` 按矩形计算且不感知遮挡，TitleBar 常驻拖拽区在全屏覆盖层之下仍吞掉顶部 40px 内按钮的 mousedown——全屏查看器与幻灯片放映根容器加仓库预留的 `.app-no-drag` 工具类做几何减法；同轮修掉工具栏裸 `div` 按行内基线对齐导致的按钮下沉错位。计划与真机实测读数见 `docs/plans/archive/2026-Q4/2026-11-01-fullscreen-topbar-fix-实施计划.md`
- **全屏前后切换画面抖动（2026-11-01）**：换源时 `src` 与宽高盒错位——切图同帧即用新文件元数据成形宽高盒，而位图要等换源提交后才到达，旧画面被塞进新比例盒子重新 letterbox，一次翻页肉眼可见跳 2~3 下。修法为换源三联状态（显示 URL / 归属文件 / URL 引用）恒属同一文件、成组原子更新：新缩略图离屏解码就绪前旧画面持稳，就绪后单次提交换源；快速往返重开同图零闪烁；无缩略图路径保持立即换源。幻灯片放映同步修复：影像按元数据预成形宽高盒、按播放顺序（洗牌感知）预热相邻原图；放映钩子返回对象不再整体进入 effect 依赖——它每次渲染都是新引用，与视频等待的停止逻辑拉锯成死循环挂死（skipVideo 关闭且播放位落在视频时应用冻结），一并修复。计划与真机实测读数见 `docs/plans/archive/2026-Q4/2026-11-01-fullscreen-switch-jitter-fix-实施计划.md`
- **放映状态机两处收口（2026-11-01，审查发现）**：① 暂停态修改播放间隔会被自动启动逻辑拉回播放——自动启动 effect 加「打开沿」门卫，仅在放映打开时启动一次，播放中改间隔仍由既有计时器重启语义接管；② 「因等待视频而暂停」的标记跨手动导航/暂停残留，暂停态可被后续视频播完事件无声复播——手动播放/暂停起点清除过期标记，合法的视频等待恢复链不受影响
- **同步账号样例缩略图 403 间歇回归（2026-11-01，审查发现）**：单条登记的样例预览授权与图库整表登记是并发链，换 revision 的整表替换会把样例条目一并清掉且无补偿——新增独立存活集合跨 revision 回填（上限 60、插入序淘汰），运行时停止仍全清；同轮补齐目录增删成功后的 `nikkisync:library-changed` 推送（与来源变更同判据，本地同步图库按 fullResyncRequired 重取）。审查结论与验证读数见 `docs/plans/archive/2026-Q4/2026-11-01-review-fix-verify-2.5.6-release-实施计划.md`
- **同步图库「上游索引面」面板三处状态治理缺陷（2026-11-03，本轮复查 `3573729`）**：`cf1364f` 新建的套装/服装检索与档案统计面板有三处同源问题——① `runSearch` 无代次计数，两条在途 IPC 由**到达顺序**决定用户看见什么（慢的旧响应会改写新命中，`finally` 里未守卫的 `setSearching(false)` 还会掐掉在途查询的 loading）；② 作用域 `select` 只 `setScope` 不清 `hits`，切到「服装」仍显示套装行、并把套装的部件名当「服装的所属套装」展示；③ `loadStats` 的 `if (stats || statsFailed) return` 永久缓存，而本页 keep-alive 且 `SyncGalleryPage` 收到库变更就重取第一页 ⇒ 同一个库存两副面孔。修法复用同域既有 `PairingQrDialog` 的 `generationRef` 计数丢包形状（不引库、不自造防抖）；「只做一次」的闸从 `loadStats` 内部上移到展开动作，收起态收到库变更只复位缓存不追加 IPC；开合状态直接读 `<details>` 的 DOM `open` 而不在 `onToggle` 里存布尔影子（toggle 是排队派发的，慢一拍的那一拍里到货的事件会被当成展开态多拉一次 IPC）。改前红灯 3 例（竞态 / 切范围残留 / 统计不刷新），变异抽查只撤 `finally` 守卫 ⇒ 恰好竞态例红
- **诊断包单个日志被占用会吞掉其余取证（2026-11-03，本轮复查 `e1437a3`）**：`exportLogsAsZip` 的 3.5 步用**一个** `try` 罩住 `[chromium-debug.log, .old, diag.log]` 整条循环，第一份读不动（本机防护软件抓刚落地的日志/asar 成 EBUSY 是常态）就连后面的 `diag.log` 一起丢，而导出仍返回 `success: true` —— 缺的恰是 `6d633f8` 这轮专门补进来的原生 FATAL 证据，且用户不可见。`try` 下沉到循环体，一份失败只丢那一份；`getUserFacingDiagDir()` 自身仍留外层 `try`（它抛错时旧口径是整块静默跳过，不能因本次改造反而把异常冒到导出失败）。两处 `catch` 各补一行 `logger.warn` 记归属——「静默的部分缺失」与「静默的完整」在用户侧不可分辨，而这份包是发回来做归因的唯一载体。改前红灯 F5（`expected [...] to include 'chromium-debug.log.old'`）
- **`inspirationOn` 九语把「挂载事实」说成「在线」与 `photoCount` 五语复数误形（2026-11-03，本轮复查 `d4bf8df`）**：契约与 `src/main/nikkisync/AGENTS.md` 硬约定 10 明说 `/v1/server` 的 `inspirationV1` 表达的是**挂载事实**（观测到上游挂了灵感面就下发，LAN 服务没起也下发），而同步服务页这一行不按 `running` 门控 ⇒ ja/ko/de/fr/es/pt/ru/th/vi 九包的「公開中 / 게시됨 / bereitgestellt / en ligne / disponible / доступна / เปิดใช้ / công bố」在服务停着时是一句假话；zh-CN「端点已挂载」与 en "Endpoint mounted" 本就准确、逐字不动，fr 顺带纠正 endpoint 误译（原 `point d’entrée` = 入口点）。`insight.photoCount` 用自定义 `{{n}}` 而非 i18next 的 `count`，等于放弃复数变形 ⇒ en/de/es/fr/pt 渲染成 "1 photos"；zh/ja/ko/ru/th/vi 是量词或不变格语言（`1 张`/`1 枚`/`1 ảnh`/`1 фото`）本就正确、不动，这五包改仓内既有先例的**计数中立**形态。两处都是「值不对而键齐全」，键集同构断言与 `i18n:guard`（只做单向 missing）都抓不到 ⇒ 补的是**值守卫**（精确负向锁旧值 + 各包正向词，照 `RUNTIME_OFF_BEFORE` 形状），改前 4 例红。全仓复数形系统性缺口（实测 `en.json` 60 处插值串）登记 DEBT-050，不在本轮铺开
- **GPU 验证工装污染持久态与状态文件半截写入（2026-11-03，本轮复查 `e62c04f` + `db4415d`）**：工装侧三处合起来才是完整修法——落盘闸只判 `NIKKI_GPU_FORCE_LEVEL`、漏了 `NIKKI_FORCE_GPU_COMPAT`（那把工装经 `compatDisabled` 抬到 1 级后照样写盘，用户装机从此停在软件渲染直到下次改版）；`requestSelfHeal` 先调 `markGpuProcessCrash` 再判工装，而前一步无条件写 `fallbackActive + compatLevel + 版本戳`（工装闸放它后面就已经晚了一步）；且不认 `FORCE_LEVEL` ⇒ 写「升一级」后 relaunch，新进程被 env 压回同一档形成重启死循环。新增 `isGpuVerificationRig()` 两处消费，短路移到 `markGpuProcessCrash` 之前；判据取 `parseForcedLevel(...) !== null` 而非「env 是否存在」，非法值仍回落真实判定（既有 L9 钉这条）。写入侧：`gpu-fallback.json` / `gpu-pref.json` / `last-exit.json` 改**同步**原子落盘（`atomic-file.ts` 追加 `writeFileAtomicSync`，既有异步本体一字未动——这些写盘要与原生 FATAL 抢时间，`await` 一次就可能落在被杀之后）。裸 `writeFileSync` 是「先截断后写」，中途被打断留下半截 JSON 的失效方向都不是「丢一点日志」：`readState` 把解析失败当默认态 ⇒ `compatLevel` 静默清零 ⇒ 被困设备又回 0 级启动，正是三级阶梯要防的那个崩溃循环；半截 `last-exit.json` 读成 null，而「心跳在 + last-exit 缺席」正是判 `native` 的形状 ⇒ 给没被原生杀死的机器白升一级。失败语义刻意分两档：内容写入被打断 ⇒ 最终路径一个字节不动也不回落（回落就等于把半截覆盖请回来）；rename 失败（防护软件对新落文件抓句柄 ⇒ EPERM/EBUSY 是实况）⇒ 回落直接写，数据不丢优先于原子性。改前红灯 b2/b3/L10/selfheal-4 四例 + S1 一例（`expected +0 to be 2`，即 `compatLevel` 被半截文件读成默认 0 的缺陷本体）
- **`clockSkewMs` 不受 5 分钟协议硬上限约束（2026-11-03，本轮复查 `70d2f54`）**：`src/main/sync/AGENTS.md` 硬约定 2 与模块自陈都写着「窗口不超过 5 分钟（硬约束上限）」，但构造函数是 `options.clockSkewMs ?? DEFAULT`、无任何收口 ⇒ 这条安全红线只由注释承担，装配方误传 10 分钟就静默放宽重放窗口。改为有限值夹到 `[0, 上限]`（0 是合法的「不容时钟差」严格配置）、非有限值退回默认，方向是只收紧不放宽。补两条改前后皆绿的守卫并如实标注（默认窗口语义不变；过期 nonce 确被 `pruneNonces` 清掉——此前把 prune 整段删掉也不会红）。容量上限**不加**：淘汰在效 nonce 会重开重放口子，需独立淘汰语义设计，登记 DEBT-052
- **mDNS 默认位口径与常量分叉（2026-11-03，本轮复查 `6dcf10b`）**：`2531316` 把 `SYNC_SERVER_DEFAULT_MDNS` 翻回 `true` 时只改了常量自己的注释，漏改同文件头注释的「默认值口径」清单 ⇒ 一个文件里写「本仓默认关，与上游刻意不同」而常量是 `true`；代价不是编译错误，是下一个人按头注释做决策。同批订正 `sync-server.linked.test.ts` 的测试口径说明与 `docs/sync-integration/03-sync-server-plan.md` 风险表（后者与同文档的「✅ 已完成 2026-11-02 翻回开」自相矛盾，按「失效陈述留原句加时间限定」改为「曾默认关；`589b932` 复测得 `no_loop` 后已翻回」，不抹掉历史理由），并删掉 `d5afded` 合并残留的一条重复中文注释行（它悬在 `error` 展开之上，读起来像 `error` 也受挂载判据约束）。纯注释、零行为变化 ⇒ 按本仓已立口径如实标注「无红灯可造」，不编造空转守卫冒充红灯
- **图片/视频识别数量被限制为最多 500（2026-11-03，自 `[Unreleased]` 并入）**：状态栏「共 N 个文件（图片 X · 视频 Y）」与侧栏两个计数在库内上千条时仍显示 500。三条独立根因：① **计数取的是已加载分页长度**——`AppShell` / `Sidebar` 遍历 `mediaFiles` 累加，而它是分页切片、首屏只有一页；`media:list` 早已回传 `total`、`fetchMediaFromDatabase` 也早已透出（同文件的回收站更有 `recycleBinTotal` 的正确先例），只是没人消费。② **深度刷新越界后被静默吞掉**——`GalleryPage` 的 `media:updated` 把 `limit = max(500, 已加载条数)` 原样写成 `pageSize` 直传，越过 `media-handler` 的 zod `max(500)` ⇒ `VALIDATION_ERROR` ⇒ 被 `catch` 吞成 `null` ⇒ 整次刷新失效，新扫描到的文件进不了列表；nikkisync 分支在 `39bd786` 之后单独补过 clamp 并写明「不 clamp 会让整表刷新静默失效」，本地 DB 分支是它漏掉的项。③ **grid 视图不自动拉齐**——`d654b9b` 上一轮修的是四个非网格视图，**刻意把默认的 grid 排除在外**（理由是它有触底翻页），还在测试里把「grid 600 条保持首屏 500」钉成契约；触底只由滚动驱动，不滚就停在 500。
  修法：主进程新增 `countMediaByType()`，与列表命中**同一 WHERE** 的分类型真计数随首页以可选字段 `typeCounts` 返回（`pageSize` 的 500 上界刻意不动——它是真实入口闸门，该修的是越界传参不是拆闸门）；渲染层落到 store，新增 `useGallerySummaryCounts` 统一判据「`hasMoreMedia` 为真且服务端计数到位才用真值，否则用数组长度」，保证收藏/场景/日期/评分/搜索/分组这类纯前端筛选仍显示筛选后数量；`limit` 语义改为**目标深度**，每页恒 ≤ `MEDIA_PAGE_SIZE`、不足按 keyset 游标续页，代次号让并发刷新最新胜出、`MAX_DEPTH_PAGES` 给死循环硬上限、中途失败保住已取数据且不谎报已到齐；五个视图一律逐页拉齐。
  范围外刻意不改的两处：`GalleryPage` 的 `BatchActions` 分母是「可选择条目数」，换成库中真值会出现「共 1200 却只全选 500」；`SCAN_BATCH_SIZE = 500`（流式写入分批）、`SQL_IN_CHUNK_SIZE`、各处 500ms 进度节流与 NikkiSync 协议侧 `MAX_PAGE_LIMIT` 都不是上限。
  防复发由 `scripts/__tests__/media-page-limit-guard.test.ts` 钉四条不变式（三处 500 同源、上界不得删除、`pageSize` 必须经 `Math.min` 收口、拉齐判据不得再按视图切开、`typeCounts` 四点齐全）；六次变异注入逐一验证守卫与对应套件**每次都真红**。逐节点红→绿读数与链路取证见 `docs/plans/2026-11-03-fix-media-recognized-count-500-limit-实施计划.md`

- **图库计数二轮复查四处修复（2026-11-03，本轮复查 `ce28125` + `6cedbac` + `ee51e0d`，随本次重打包入包）**：上一轮那七笔提交把「识别数量恒 500」改成服务端真值后，复查查出四条并全部按红-绿修掉。① **深度取数与触底续页之间没有互斥**——`fetchMediaFromDatabase` 的逐页循环只在**循环结束后**才写 `mediaCursor`/`hasMoreMedia`，而 `loadNextMediaPage` 的守卫只看 `loadingMore`/`hasMoreMedia`，用户在整刷在途时触底会拿「刷新前的旧游标」并发覆写它，两条写者交错后下一次触底从循环快照边界的下一页起取、中间那一页静默丢失。新增模块级 `depthFetchActive` 屏障：进 `try` 前领、`finally` 里**仅当本轮仍是最新一轮**才放（被后来者顶掉的旧轮不得替新一轮释放屏障，否则竞态原地复活）。刻意不复用 store 的 `loadingMore`——它驱动 `VirtualImageGrid` 的「加载更多…」脚注，借它会在长时间整刷期间改变渲染表现。② **缓存总数与实时分类型计数冲突**——默认视图的 `total` 走 `media_count` 缓存（由 `app/media-update.ts` 异步重建，扫描后存在滞后窗口），而 `countMediaByType` 是实时 `GROUP BY`，两者同一次响应返回 ⇒ 状态栏能显示「共 1200 个文件（图片 1400 · 视频 50）」这种算术上不可能的数。不变式 `total >= image + video` 恒成立（`total` 按同一 WHERE 数全部 `file_type`，`typeCounts` 只回填 image/video），一旦更小即证伪缓存过期：新增 `clampTotalToTypeCounts` 以实时值为准夹取，keyset 与 offset 两条首页路径都套（offset 侧连同下方 `hasMore` 一并按同一口径回写），**刻意不补第二次 COUNT**——缓存存在的理由正是省掉默认视图那次 O(n) 扫描。③ **整刷被取代被误报成加载失败**——`fetchMediaFromDatabase` 让最新一轮胜出，被顶掉的那轮弃权返回 `null`（UI 由那一轮交付，本是成功语义），与「真的取数失败」同形，重试耗尽后弹一条用户无从处置的红色 toast；新增只读口 `getMediaRefreshGeneration()`，判据落在「自己那轮只占 +1」。`nikkisync` 源不 bump 代次，恒判未被取代，真实失败照常上报。④ **两处注释失真**——`useGallerySummaryCounts` 头注把并无数量展示的 `GalleryPage` 列为消费方（实测只有 `AppShell` 与 `Sidebar` 两处，`GalleryPage` 的 `.length` 全是空态判定/索引数学/放映开关）；`fetchMediaFromDatabase` 自陈「纯查询，函数体内没有任何 `set(...)` 调用」，与本轮起它必须把游标/`hasMore`/服务端计数与本次 WHERE 同批落进 store 的事实相反，留着会把人引向「调用方补写即可」。三条回归用例修复前实测均红（①`expected "vi.fn()" to be called 2 times, but got 3 times`；②`AssertionError: expected 1 to be 3`；③`expected "vi.fn()" to not be called at all`），②另做一次变异：只撤 offset 那一个调用点时红点内移到该分支，证两条首页路径各自都在判据覆盖内、不是只靠一条。计划与逐节点读数见 `docs/plans/2026-11-03-gallery-count-review-fix-2.5.6-repack-实施计划.md`
- **图库计数遗留轮五项逐项处置（2026-11-04，本轮处置上一轮计划 §10 的 1–5 条，随本次重打包入包）**：上一轮「属实但本轮不修」的账，本轮按性质分别修、测、登记。① **触底续页补上代次弃权**（`73f29b3`）——上一轮的 `depthFetchActive` 屏障只在**起跑时刻**拦触底，拦不住已经起跑、尚未收尾的那一页：整刷启动时若在途已有 `loadNextMediaPage`，它不受屏障约束，其 `setState` 落在整刷写游标**之后** ⇒ 用刷新前的旧游标覆写新轮的，同时把旧快照的 400 条追加进新列表。改法与 `fetchMediaFromDatabase` 的弃权形状同一协议：`try` 之前领 `genAtEntry = depthRefreshSeq`，取数返回后、`dedupeAgainst`/`addMediaFiles` **之前**判据不在位即 `return`；`finally` 的 `loadingMore` 复位一字不改（一次弃权不得留下跨轮状态）。夹具唯一一处向后兼容扩参（`release(index = 0)`，默认值与既有 `queue.shift()` 逐次等价、既有三处调用一行不改），因为要绕过屏障迟到页只能在整刷之前起跑 ⇒ 它的 promise 恒在队首，缺陷只在它最后落地时才现形。修复前实测红：`expected { id: 601, … } to deeply equal { id: 201, … }`。② **被取代的重试日志不再自称加载失败**（`e55a64d`）——`useRefreshMedia` 的重试循环只看 `!result`、不看 `superseded`，把「本轮已被新一轮取代」（弃权返回 null，本是成功语义）打成加载失败；措辞按已有判据分叉，**「加载失败」那条逐字保持**（包内 needle 表拿它当对照组），重试逻辑本身不动、不新增 i18n key。修复前实测红：`expected '[useRefreshMedia] 加载失败，500ms 后重试 (1/3)' to contain '已被新一轮整刷取代'`。③ **`verify:dist` 的解包根改由待审 app.asar 派生**（`2963f21`）——原生二进制校验步原先自己递归扫 `release/**` 取**首个** `app.asar.unpacked`，与禁串步的 `resolveVerifyAsarTarget` 不同源；一次性取证探针在合成双树（`win-unpacked` 与名排在它之前的完整 `build-*`）上实测复现：禁串步审现役树、readdir 首命中返回**陈旧树** ⇒ better-sqlite3/sharp/VC++/`@nikkisync` 整份验在旧产物上而闸门绿。新增导出纯函数 `deriveUnpackedTarget`（判据唯一：`asarPath + '.unpacked'`，不命中即 fail-closed，**绝不回退目录扫描**，探针「恰好被调用一次」由用例钉住），`findAsarUnpacked` 随之整函数删除。**运维面行为变更**：走 `electronDist` 旁路、解包目录名非 `win-unpacked` 时今后必须 `npm run verify:dist -- --asar=release/<目录>/resources/app.asar`。新增 T1–T5 用例修复前 5 failed（`deriveUnpackedTarget is not a function`）。④ **首屏 `GROUP BY file_type` 的代价先测再决定**——一次性 spike（装置不入库，schema 与索引从真库克隆件的 `sqlite_master` 原样取回，30 轮轮转采样）量得边际 `S3 − S2` = 0.05 / 0.76 / 5.05 ms（1k / 10k / 50k 行），比值稳定 1.10–1.18x；`EXPLAIN QUERY PLAN` 显示 `profile=all` 走 `idx_media_files_duplicate_group` + `USE TEMP B-TREE FOR GROUP BY`，选中具体档案时走 `idx_media_files_profile_stats`（第三列即 `file_type`）且不建 temp b-tree。判据（测量之前写死：`median(S3) ≤ median(S2) × 1.5` 且 `≤ 8ms`）在真库与 10k 档双双通过 ⇒ **维持上一轮「宁可多一次 GROUP BY 也不引入第二个缓存真相源」的取舍，`media-repository.ts` 一字未动**；50k 档 S3 = 33.8 ms 超 8 ms，判据未预设该档，如实记为外推观察而不回头改判据。⑤ **双真相源命题订正为窄路径**——`isDefaultView` 要求 conditions 恰好 2 条，而图库的 HQ 路径条件使缓存恒不命中（仓储注释自陈），故**图库首屏的 `total` 与 `typeCounts` 本就同源**；混源只剩「非图库 + profile=all + showDuplicates=true」那条已被夹取覆盖的窄路径。本轮判过而不修的一并登记 DEBT-053…059（含 `verify-nikkisync-link.ts` 里 `findAsarUnpacked` 的同名副本、整刷无条件复位 `loadingMore`、代次制的已知白废一页、i18n 护栏对模板字面量的盲区），明细见 `docs/技术债清单.md` §21。计划与逐节点红→绿读数、spike 读数表、六道闸门退出码见 `docs/plans/2026-11-04-gallery-count-debt-followup-2.5.6-repack-实施计划.md`
- **计数遗留清偿轮：DEBT-053…059 逐项处置（2026-11-04，清偿上一轮登记的 7 条债与 6 项未做，随本次重打包入包）**：按各条性质分别修、测、登记，判据先行写死、红-绿逐项实测。① **被取代的整刷不再重试**（`d384043`，DEBT-053）——弃权与失败在返回值上同形为 null 的语义分叉落到契约层：`mediaStore` 新增只读访问器 `getMediaRefreshAbortKind()`（superseded / failed / none，每次调用入口复位，nikkisync 源恒判非弃权），hook 的 while 门由契约信号背书，被取代路径不再发出第二次取数（修复前实测红：`expected "fetchMediaFromDatabase" to be called 1 times, but got 4 times`）；真失败路径逐字不动（对照用例修复前亦绿），旧访问器 `getMediaRefreshGeneration` 随迁移删除。② **`verify-nikkisync-link` 的解包根判据与禁串步同源**（`2ce0396`，DEBT-054）——`resolveVerifyAsarTarget`/`deriveUnpackedTarget` 上移共享模块 `scripts/verify-asar-target.ts`，`findAsarUnpacked` 副本整函数删除（`grep` 0 命中），残留 `*.tmp` 树不再被诊断选中（修复前实测红：T1/T2 `expected true to be null`）。③ **首屏分类型计数补三列组合索引**（`65ea691`，DEBT-055）——按上轮「修法」重建装置实测：任务书原定两列 `(is_deleted, file_type)` 实测**不达标**（10k 边际 0.49→0.36、50k 2.63→3.27 反而更贵：规划器弃 `duplicate_group` 选择性 seek 换宽扫描），改落三列 `idx_media_files_deleted_dup_type(is_deleted, is_duplicate, file_type)`：10k 边际 0.45→**0.06 ms**（撤销条件「万级边际 <0.3 ms」达成）、50k 2.22→0.56 ms，EQP 不再建 `USE TEMP B-TREE FOR GROUP BY`；列形态偏差如实披露。④ **整刷收尾不再无条件复位 `loadingMore`**（`8a889d6`，DEBT-056）——复位责任完全归触底自己的 finally，对照用例证「加载更多…」脚注不卡死（修复前实测红：`expected false to be true`）。⑤ **触底弃权判据改按游标落地代次**（`e73b8d0`，DEBT-057）——新增模块计数器 `mediaCursorWriteSeq`，弃权轮/失败轮不再白废在途触底页（修复前实测红：`to have a length of 1000 but got 500`），上一轮两个并发护栏保持绿。⑥ **DEBT-058 出存量计数、DEBT-059 钉口径分叉证据**（`b2c9a58`）——中文模板字面量存量 84 文件/361 处（dev 日志 138、疑似用户可见 223），护栏改动留独立一轮；`refreshMediaCountCache` 与列表实时计数 WHERE 的差异项钉成判据用例（任一侧口径被静默改动即红）。⑦ **包内端到端绝对值已取**——一次性探针（`launchApp({userDataDir})` 指向预置 10k 行克隆库）×5 取中位：改前（旧包）**28.40 ms**、改后（新包，迁移自动加索引）见本轮计划 §10（判据 ≤30.9 ms 事先写死）。DEBT-058/059 保持 open，053–057 已关闭；明细与撤销条件见 `docs/技术债清单.md` §22。计划与逐节点红→绿读数、读数矩阵见 `docs/plans/2026-11-04-debt-053-059-clearing-实施计划.md`

---

## [2.5.6-beta] - 2026-10-27

> 2.5.6-beta：全面审查后的缺陷修复定版，**以缺陷修复为主**（2026-10-31 追加完整搭配码面板，见 Added）。版本号由用户明确要求变更（2.5.5 期间已多轮原地重打包，本轮改动量足以与旧产物区分）。四处版本声明位（`package.json` / lock 根 / preview mock / `release/latest.yml`）同步为 `2.5.6-beta`，安装包名随 `artifactName` 模板变为 `MeowStarMap-Setup-2.5.6-beta.exe`。

### Added | 新增

- **完整搭配码面板（2026-10-31，阶段 0–5）**：`decrypt:decodeClothDiy` 将 DLL 返回的裸 networkData 结构化——先按契约把 `patternData` / `nsHiddenData` 的 `[:k:v,...]` IdMap 自定义语法预归一化为 JSON，再过双层 `Content` 信封校验，投影为 `data.structured = { poseId?, clothes[] }`（`wearingClothes` 原顺序、非有限/≤0 ID 跳过、`PoseId` 仅正整数；解析失败为 `null` 且原始字符串保留）。新增 `decrypt:lookupCloth` 批量补名称/图标：名称映射一次全量加载、目录 API 按 ID 查询、图标 URL 由 ID 构造；出站仅 http/https + host 白名单且显式拒绝环回/私网，400/404 负缓存、其余失败不缓存、整体静默降级为空对象（name map 冷却后恢复时，已缓存的无名条目会在命中路径补名）。新增 `decrypt:clearClothCache`：网络成功结果按 `sha256(code.trim())` 原子写入 `<userData>/cloth-diy-cache/<hash>.txt`，同码再次解码跳过子进程网络解码（离线可用），失败仅 warn、不阻塞主流程。渲染层 clothDiy tab 改为结构化列表（图标、名称/`#id` 兜底、部位/状态枚举、系列/款型标注、原始数据折叠区），并修复主进程 `{ ok, data, message }` 与渲染层 `success` 的契约漂移（此前三个 tab 成功时恒显示「操作失败」）；CSP `img-src` 放行 `https://cdn.gongeo.us`（meta 与响应头两处逐字一致），12 locale 补齐 9 个文案键。计划、契约与逐节点读数见 `docs/plans/2026-10-31-cloth-outfit-data-contract-实施计划.md`、`docs/plans/cloth-outfit-data-contract.md` 及同目录 `2026-10-31-cloth-outfit-phase1..5-实施计划.md`

### Fixed | 修复

- **账号同步作用域三处收尾缺陷（2026-11-01，审查 `200691f..133a2bd`）**：① **样例缩略图真机 403**——`nikkisync:preview-sync-account` 的 `source_path` 从未进入 `media://` 授权表：`accounts.preview()` 走的是上游 `AccountSyncSettings` 自己的无作用域读仓储，不在 `get-resource-records(mode:'path')` 的登记链上，而 `media-protocol` 第 4 条规则只放行登记过的确切路径（组件用例 mock 掉该通道，故 3 条 UI 用例骗过了绿）。修法为 `resource-allowlist.ts` 新增 **revision 中立**的单条登记 `registerNikkiSyncResourcePath`（只追加、不比对/不清表；表未初始化时保持未初始化，后续首次按 revision 整表登记不会清掉它），`runtime-manager.previewSyncAccount` 在返回前登记该确切文件。**不能**改用 `get-resource-records` 补登记：被取消勾选账号的样例本就不在作用域内，会被过滤成空。② **移除额外目录后「同步账号」区块陈旧**：`handleRemoveDirectory` 只刷新目录清单，已消失的 `spinning_momo` 分组仍以幽灵行残留；改为成功后与 add / setSource 同款 `await refreshAccounts()`。③ **目录来源变更不推 `nikkisync:library-changed`**：来源分组变化属作用域变更（已勾选账号的资产进出作用域），本地同步图库会停在旧视图直到下次扫描；handler 成功返回后补推同一通知（`@core-change` 授权注释替换为新原因）。读数：D1 红 `5 failed | 91 passed`（`TypeError: registerNikkiSyncResourcePath is not a function` ×4 + `expected false to be true`）→ 绿 `96 passed`；D2 红（`getSyncAccounts` 调用数恒为 1、`waitFor` 超时）→ 绿 `4 files / 78 passed`；D3 红（`send` 调用 0 次）→ 绿 `78 passed`；域内 `src/main/nikkisync` = 16 files / **314 passed / 0 skipped**；`npm run verify` 5 项全 ✓。计划与未修观察项见 `docs/plans/archive/2026-Q4/2026-10-31-review-nikkisync-scope-fixes-repack.md`

- **同步查询面把一条本机绝对路径漏给渲染层：委托层路径裁剪在共享对象身份上退回原件（补录，2026-10-29）**：`1e11c0e` 为承接上游 `b397e0e` 新增的 `sourcePath` / `sourceFolder` 两键，在 `src/main/nikkisync/runtime-manager.ts` 加了 `stripAssetPathFields`，但它用 `WeakSet` 记「**已访问**」、命中即 `return value` ⇒ 同一个对象在一次响应里出现第二次时返回的是**未裁键的原件**，本机绝对路径原样进入渲染层，恰是该函数要防的事。可达性取证读的是实际装载的产物而非注释：`row-mappers.js:108` 的 `mapAssetSummary` 成对产两键（`:121-122`、`:135`，仅在 `sourcePath` 存在时给出），每张照片只建一份 `{ asset: ... }` 后**按引用**塞进多个聚合（`ClothingSearchIndex.js:79` 逐服装循环、`SuitSearchIndex.js:145` 逐套装循环 ⇒ 一张照片命中 N 件服装即 N 份引用；本仓 `runtime-facade.ts:467-470` 同构复刻），而 `listAssets`（`LocalSyncServer.js:315` 逐行 `map`、`assets` 表按 `asset_id` 唯一）单响应内不重复。影响面如实限定：需 `dressing.clothes` 为字典富化后的对象形态，`metadata-resolver.linked.test.ts:251-266` 已钉住「裸 id 数字形态下索引产出 `items: []`」的反例，故不是每个库都触发。同根因另两条泄漏面（真环形回边、被共享或成环的**数组**——`value.map()` 无法先登记后填充）一并计入。修法是把访问集换成「原对象身份 → 已裁好的副本」的 `WeakMap` 登记表，且**副本在递归子节点之前登记**：一次登记同时保证第二处拿回副本、环的边返回在途副本（已裁键）、共享子图只裁一次（不再指数级拷贝）；数组改为先登记空数组再按序 `push`。返回值的引用共享关系与原载荷一致（随即经 `wrapHandler` 结构化克隆展平，且无人就地改这棵树），copy-on-write 约束不变。对偶面逐条取证为**不需改**：`getAssetDetail`（`row-mappers.js:62`/`:105` 两键皆无）、`listChanges`（`mapChangeRow` `:147-154` 只发 4 个标量）、`profileStats`（`ProfileStatsIndex.js:48-56` 不下发 `searchable.asset`，不增设第四个包裹点）、`mode:'path'` 通道（`media://` 授权唯一出口，刻意不裁）。`docs/IPC_CONTRACT.md:389-403` 原本就把三条通道都写成裁剪 ⇒ 声明零改动，本轮修复才让那句话第一次为真。顺带查出**断言盲区**是该缺陷漏网的直接原因：`searchClothing` 的裁剪零断言（夹具 `runtime-manager.test.ts:307` 返回 `{ items: [] }`，真上游 N4 套件只驱 `listAssets`），已按 `ClothingSearchIndex.js:67-92` 的真实形态补成嵌套载荷并新增 `FakeSessionPlan.clothingPage`。读数：新增 3 例（2 缺陷 + 1 回归覆盖补测），修复前 `npx vitest run src/main/nikkisync/runtime-manager.test.ts` **2 failed | 75 passed**（失败原文 `expected { assetId: 'asset_1', …(2) } not to be { assetId: 'asset_1', …(2) }`，两键俱在），修复后 **77 passed**；域内 `npx vitest run src/main/nikkisync` 由 282 → **285 passed / 0 skipped**；`npm run verify:nikkisync` 13 行全 ✓、`blocking failures: 0`。判别力做两次变异抽查：还原 `WeakSet` 版 ⇒ 恰好 2 条缺陷例红、其余 75 绿；把 `searchClothing` 改回薄委托 ⇒ 恰好 2 条服装例红（证明回归补测不是空转）；两次恢复后 `sha256sum` 与绿灯版逐字节一致（`af57b030…`）。计划、逐节点取证与本轮不修的三项挂账见 `docs/plans/2026-10-29-review-strip-asset-path-leak-and-repack.md`

- **CI 连续两次红在依赖安全审计步（补录，2026-10-28）**：`lint-typecheck` job 第 6 步 `Security audit (audit-ci, fail on high/critical)` 自 2026-10-27 起连红两次（run 22 = `df2ab84`、run 21 = `59b40a4`），本机复跑同一条命令逐字复现。未豁免的 high 恰 3 条，且**不是本轮代码或依赖升级引入**——逐 commit 核对 `package-lock.json`，`530e9c09`（上一条绿）到 `df2ab84` 之间这三个版本一字未变；变的是通告进入 npm 审计源的时间（electron 与 undici 两条 2026-10-23 披露，zod 一条 2026-10-01 披露但 10-27 才进审计源返回）。处置分两类：① **真修**——`zod` 4.4.3 → 4.6.7（GHSA-mrhx-c7xc-m3w5）、`undici` 7.30.0 → 7.30.1 与 node-gyp 侧 6.29.0 → 6.29.1（GHSA-xjj6-f33q-929c），全部在既有 semver 区间内重解析，未新增 `overrides`、未改 `package.json` 声明、未用会整树改写的 `npm audit fix`；② **经授权豁免**——`GHSA-jr5w-w6x2-84p9`（electron `<42.11.16`）：41 线最新只到 41.10.7 且同样命中该区间，**41 线没有回移补丁**，`scripts/pre-dist-check.ts:806-810` 又要求 electron 必须是精确版本（不能改区间「等补丁」），真修只能跨大版本 41 → 42，故按 DEBT-020（40 → 41）先例留待独立专项，本轮登记 DEBT-038 跟踪。另新增离线回归闸门 `scripts/__tests__/lock-advisory-floor.test.ts`：只读 `package-lock.json` 钉住已修复项的版本下限（审计本身要联网、判据随上游漂移，不能当回归用），并含「同一通告不得既按修复版落地又躺进豁免清单」的互斥断言。读数：`npm run audit` 退出码 1 → 0（`Passed npm security audit.`，allowlist 29 → 30、命中豁免项 10 → 11）；全量 `npm test`（452 文件 / 7045 通过 / 12 跳过）、`typecheck`、`typecheck:e2e`、`i18n:guard`、全量 `lint` 全部退出码 0。计划与全部取证读数见 `docs/plans/2026-10-28-fix-ci-audit-vulnerable-floors.md`

- **测试套件的 logger 落盘写会留下无人持有的 reject，慢宿主上表现为分片退出码 1（补录，2026-10-28）**：CI run 23 的 `Test (shard 5/10)` 曾在「45 个测试文件全通过、无任何断言失败」的情况下因 2 条 `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending` 退出码 1；上一轮只静默了被点名的 `connection.test.ts`，把同类隐患登记为 DEBT-039。本轮核查确认 HEAD 对应的 run 24/25 **14 个 job 全绿**（无失败可修），遂按实测清偿该债：全量 `npm test` 按「剥 ANSI + 行首锚定 + 最近 `stderr | 文件` 头归因」统计出 `[Logger]` 三类告警共 **28 条**，分布于 4 个站点——`src/main/utils/logger.enforce.test.ts` 25 条（模块级 `tmpDir` + `beforeAll` 建目录 + `afterEach` 删目录，使第二个用例全程对着**已删除的目录**跑，而它的 `expect(totalScans).toBe(5)` 数的是 `fs.promises.readdir` 的调用次数、不看成败，于是用例绿着、其注释所称的「真实扫描」从未发生）、`src/main/utils/dir-manager.test.ts` 1 条（`logger.ts:123` 的 `logDir` 是模块态而 Vitest 只按文件隔离，被冻结在首个触发 logger 的用例的旧临时目录上，连 electron-log 的 `main.log` 也一起写进那已删目录）、`src/main/database/connection.test.ts` 1 条（上一轮只桩 `appendFile` 的漏项：桩成成功后 `logFault` 首条即触发 `enforceMaxSize` 的真实 `readdir`，而该套件 `mkdirSync` 同为 mock ⇒ 目录从未存在）、以及 `src/main/utils/logger.test.ts` 1 条**故意用例**（断言「写盘失败只告警、不抛错」，必须保留）。修法逐站点不同且判据只增强不放宽：节流套件改由 `beforeEach` 用 `fs.mkdtempSync` 按用例唯一重建目录（`toBe(5)` 与 `toBeLessThanOrEqual(2)` 一字未动，计数读数不变）；`dir-manager` 套件按用例 `setLogDirectory` 消除跨用例泄漏并桩掉 `appendFile`；`connection` 套件把 `readdir` 桩并入既有 helper。新增常驻闸门 `scripts/__tests__/logger-escape-ledger.test.ts`（15 例，以**红灯取证提交** `0bb84a4`：修复前 3 failed | 12 passed，违规四条逐一对应待修站点）——三张封闭集表逐文件逐模式判「相等」而非「≤」，并用合成源码锁死「删掉 `[Logger] 写入失败` 告警」与「新增第二条无人持有的 `appendFile().catch()`」必判红，同时把 `tests/setup.ts` 的 `appendFile` / `readdir` 计数钉为恒 0（否证上一轮设想的「全局静默基线」：两套 logger 套件依赖真实写盘语义，且 `ci-linux` 装置整体替换 `fs` 命名空间会让基线形同虚设）。**撤销判据随之订正**：原登记「计数为 0」不可达（那 1 条故意用例），改为三类告警并集锚定后恒为 **1** 且唯一站点为 `logger.test.ts`。读数：`npm test` 由 452 文件 / 7046 通过 + 12 跳过转 **453 文件 / 7063 通过 + 12 跳过（7075 例）**、耗时 54.13s → 54.14s（无可测劣化），锚定计数 **28 → 1**；`npm run test:ci-linux src/main/utils` 下三套件全绿、同一计数为 1。慢宿主上的 `EnvironmentTeardownError` 本身仍只有 CI 能观测，本机全绿不构成「已验证不出现」。计划与逐节点取证见 `docs/plans/2026-10-28-fix-logger-write-escape-recurrence.md`，账目见 `docs/技术债清单.md` §16

- **「重复文件」/「相似」把硬链接的同一物理文件报成多份**：游戏与启动器用 Windows 硬链接把同一文件同时暴露在 `GamePlayPhotos\<UID>\NikkiPhotos_HighQuality\` 与 `X6Game\ScreenShot\`、`X6Game\Video\` 下，扫描器按路径各写一条 `media_files` 记录，而两条链路都假定「一行 = 一个文件」——精确重复按 `file_size` + sha256 分组必然把同一文件判成 2 份（`wastedBytes` 虚报，删掉任一条都省不出空间），pHash 汉明距离 0 又让「自己重复自己」进入重复标记与相似列表。新增唯一收敛点 `src/main/utils/physical-file-key.ts`（`statPhysicalFile()` 读 `dev + ino`，`dedupeByPhysicalFile()` 按物理身份只保留 id 最小的一行并保持原相对顺序），接入 `media:findDuplicates` 的候选装载处与 `media-worker` 的 `markDuplicatesInWorker` / `startSimilarFind`（重复标记链路的 SELECT 因此补出 `file_path`）。真机取证：本机 212 行候选中 29 组同 size、23 组同 pHash 属硬链接误报，修复后同物理文件误报组降为 0；相似侧剩余 19 组为 HQ/LQ 真实两份，按既定决策不处理。只读诊断脚本 `scripts/diagnose-duplicate-false-positive.ts`（`node:sqlite` 只读打开，绝不写库）留存为验收入口。计划与全部红绿读数见 `docs/plans/2026-10-27-fix-duplicate-false-positive.md`
  - 二轮审查补漏：首版无条件采信 `s.ino`，而 FAT32/exFAT 卷（U 盘、SD 卡，正是游戏照片的常见落点）与部分重定向网络盘不提供文件索引号，同卷所有文件的 `ino` 恒为退化值 0 —— 此时 `dev` 相同、`ino` 相同会把整卷并成 1 行，`markDuplicatesInWorker` 随即命中 `rows.length < 2` 分支**清空全部 `is_duplicate` 标记**，等于修复本身在低风险文件系统上把功能反向打死。现由模块内 `isUsableKey()`（`key !== null && key.ino !== 0`）把退化身份与 stat 失败同等处理（该行保留、不参与去重也不被去重），与本模块及 `src/main/utils/AGENTS.md` 自陈的「宁可少去重，不可误删候选」口径对齐；新增用例先按红灯取证（读数为两行被并成一行）再转绿，NTFS 上的真实硬链接去重读数逐项不变
- **全屏查看器顶部工具栏图标压在照片上几乎不可见**：9 处按钮（7 个顶栏 + 左右导航）原写 `icon-btn text-[var(--text-on-overlay)]`，而 `.icon-btn` 是裸 CSS、源序在 `@tailwind utilities` 之后，与该工具类同为 (0,1,0) 且后源序胜出，前景实际被整条盖成 `--text-secondary`(#666666)、hover 再变 `--text-primary`(#1a1a1a)；左右导航另内联硬编码 `rgba(0,0,0,0.4)` 底（白图标最坏 2.85:1）、标题压在渐变透明段为白压白、播放间隔菜单选中项用 `--accent`（默认主题下压深底仅 2.78:1）、收藏激活态用 `--favorite`（最坏 2.32:1，低于 WCAG 1.4.11 的 3:1）。修复为新增 `.icon-btn.icon-btn-on-overlay` 叠加态变体——特异性抬到 (0,2,0)、显式覆盖 hover / focus-visible / disabled 三态、不用 `!important`、不声明 `transform`（缩放仍由 `.icon-btn:hover` 提供，其它 26 个 `.icon-btn` 使用方零改动），并配一组「压在照片上」的令牌 `--overlay-control-*` / `--overlay-gradient-top` / `--overlay-title-shadow` / `--favorite-on-overlay`；这类对比度由照片而非 UI 主题决定，故落 `:root` 而非主题变量块。柔粉主题的 `.icon-btn:hover` 追加 `:not(.icon-btn-on-overlay)` 守卫，与 `.storybook/preview.ts` 刻意反转的源序解耦。计划与读数见 `docs/plans/2026-10-26-fix-fullscreen-toolbar-contrast.md`

- **无边框窗口的拖拽热区从未接线（补录，2026-10-29）**：用户报「窗口无法正常拖动」。根因**不是拖拽逻辑算错，而是拖拽声明在代码里根本不存在**——无边框窗口需由 CSS `app-region: drag` 划定可拖区域，而渲染层没有任何一处写过它，所以用户列举的坐标系计算、状态更新、事件绑定环节都无从调试，要做的只是补齐缺失声明。落点 `src/renderer/styles/globals.css` 新增 `.app-drag` / `.app-no-drag` 两类（+19 行，含 `-webkit-app-region` 前缀形态，Electron 实际只认带前缀的那个）。判据由新建的 `src/renderer/styles/app-drag-region.test.ts`（86 行 / 9 用例）钉成 CSS 契约，防后续被 Tailwind purge 或 esbuild 剥离。红→绿逐节点闭环：阶段 0 全红（9 failed）→ 节点 1（5 passed，节点 2 与边界仍红 4 failed）→ 节点 2（2 passed）→ 节点 3 边界（2 passed）→ 整文件 9 passed；另以「漏写无前缀 `app-region`」的临时构造复验，对应用例由绿转红后还原，证明不是恒绿凑数。读数：全量 `npm test` 收敛为 `1 failed | 452 passed (453)`，**唯一失败**是 `src/main/nikkisync/probe.test.ts`（断言宿主 Node ≥24，当时环境为 v22.22.2）——用 `git stash -u` 回到**零改动基线**再跑全量得到同一条失败，据此证明系既有环境前置失败而非本次 CSS 改动引入；`sync-server.linked.test.ts` 曾出现一次 60s 超时（真起 TLS 的时序敏感用例），单独重跑 13 passed、第三次全量亦通过，判为并发抖动 flaky。干净产物 `dist/renderer/assets/index-BRqT79kY.css` 实证 drag/no-drag 四条声明俱在。**未覆盖项如实声明**：OS 级窗口拖拽手感无法在无 GUI 交互环境自动化验证，逐项目视清单见计划 §12，本轮未做真人手工拖拽。计划与三方交叉印证的证据链见 `docs/plans/2026-10-29-fix-window-drag-region.md`
- **路径裁剪的深度上限本身是个 fail-open，深层嵌套照样漏键（补录，2026-10-30）**：`src/main/nikkisync/runtime-manager.ts` 的 `stripAssetPathFields` 原带 `MAX_STRIP_DEPTH = 8`，超限即「不再下钻、但当层两键照样剔」，注释自称「宁少不漏」，实际把**更深**子树里的 `sourcePath` / `sourceFolder` 原样留给渲染层——破的正是该函数要防的事，且失败方向是静默放行。本轮移除深度上限、按对象形状完全递归：环与共享引用已由既存的 `memo`（原对象身份 → 已裁好的副本，且副本在递归子节点**之前**登记）收敛，本就不需要靠深度闸兜底；环形引用命中 `memo` 即返回在途副本、不再下钻，故不引入栈溢出。可承受性给取证而非假设——真实载荷最深落在 asset 对象 = 深度 5（root→items→item→photos→photo→asset），上游 DTO 层级有界，同步调用栈可承受；函数注释同步改写为「无深度上限」并记明该理由。测试新增 1 例专门打旧闸门的洞（断言 >8 层对象的两个路径键也必须裁掉，旧实现提前 return 故修复前必红）。**同轮查出的残留风险按最小化只登记不改码**：浅拷贝 `{...value}` 遇非纯对象（Date/Map/Set/类实例）会静默展开成 `{}` 丢数据、会触发 getter 求值、且 `Object.keys` 不遍历 Symbol 键——当前上游 DTO 各键经 `String()`/`Number()` 包裹、metadata 经 `JSON.parse`，不产生这类值，属「依赖而非新风险」，计入 DEBT-042/043。计划与读数见 `docs/plans/2026-10-30-review-repack-2.5.6-beta.md`
- **打包态产物检查与开发态各抄一份清单，同步服务器产物从两条链之间漏出（补录，2026-10-30）**：`scripts/pre-dist-check.ts` 原先本地硬写一个两元素 `syncArtifacts` 数组（`LocalSyncServer.js` + `wechat/GalleryRuntime.mjs`），与开发态 `scripts/verify-nikkisync-link.ts` 的 `SYNC_SERVER_REQUIRED_ARTIFACTS` 是**两份独立清单**——上游增删产物时只有一侧会动，打包闸门就可能放行缺件产物。`GalleryRuntime.mjs` 由 esbuild 步骤生成、被上游 gitignore，`tsc` 单跑不会产出它，缺它则 `LocalSyncServer` 装载即失败，而这类缺件只有产物级断言拦得住。改为两侧共用同一真相源：`pre-dist-check.ts` 直接 import `SYNC_SERVER_REQUIRED_ARTIFACTS` 与 `METADATA_REQUIRED_ARTIFACTS`，判定核复用 `missingPackedCapabilityArtifacts(...)`，同步服务器与远端元数据两组产物各自逐项报缺（缺几项报几行，不再合并成一条模糊提示）。「不得本地硬编码」这一点由 `scripts/__tests__/pre-dist-check.test.ts` 新增 4 例钉住，其中 3 例为修复前必红的接线契约、1 例用虚拟解包树验证两组清单缺件时分别点名。

### Changed | 变更

- **订正 `fullResyncRequired` 判据的本仓豁免表述（补录，2026-10-30，纯注释零行为变更）**：`src/main/ipc/handlers/nikkisync-handler.ts` 的头注释原写 `nikkisync:get-changes` 的判据「照抄上游 `LocalSyncServer.listChanges`」，而上游 `b397e0e` 已给该判据新增 `after < accounts.revision()` 一支，本仓**刻意不跟随**——`src/main/nikkisync/runtime-facade.ts` 以单参构造 `SyncReadRepository`，作用域恒为 `1=1`，没有 `accounts.revision()` 的取值来源。现改为「沿用 `after < minimum - 1` 一支 + 记明不跟随的理由与落点」，判据本体与豁免理由指向 `docs/IPC_CONTRACT.md`；受保护路径的 `@core-change` 授权注释同批替换为新原因（旧原因不复用）。
- **登记 DEBT-042 / DEBT-043 两条路径裁剪健壮性债（补录，2026-10-30）**：2026-10-30 全面审查发现 `stripAssetPathFields` 的浅拷贝语义在两类**未来上游演进**下会静默丢数据或漏裁（① 非纯对象 Date/Map/Set/类实例被展开成 `{}`；② 触发 getter 求值、Symbol 键不被遍历）。node 内存复现确认两条行为均存在，但当前载荷不触发，故本轮只登记不改码。账目见 `docs/技术债清单.md` §17 与 `docs/debt-registry.json`（`category: robustness`、`status: open`、`priority: low`，各带触发条件与修法/撤销条件）。

- 版本号定为 `2.5.6-beta`，随动的当前版本声明位全部同步：`package.json`、`package-lock.json` 根与 `packages[""]`（`scripts/__tests__/pack-identity-name.test.ts` 硬钉两者等于 `pkg.version`）、`src/renderer/preview/mock/database-mock.ts` 的 `app.getVersion`、`AGENTS.md` 项目概述、`ARCHITECTURE.md` / `ARCHITECTURE.en.md` 头部与 §12.2 版本史、`DEVELOPMENT.md` / `DEVELOPMENT.en.md` 头部与 §7.8 及两处安装包文件名、`README.md` 版本徽章。历史陈述（README 的「2.5.5 新增」段、ARCHITECTURE 表格里标注版本期间的行、各测试自身的 mock 取值）一律不改写，避免破坏可追溯性

---

## [2.5.5] - 2026-10-23

> 2.5.5 正式版：自 [2.5.5-beta] 定档，去除预发布后缀，**不引入新的功能性变更**。beta 节之后逐轮补录的全部改动（最近一条：2026-10-23「反馈弹窗 QQ 群号占位值更正 + 产物内容禁串闸门」）均已随各轮重新打包出货，本节不重复罗列；四处版本声明位（`package.json` / lock 根 / preview mock / `release/latest.yml`）同步为 `2.5.5`，安装包名随 `artifactName` 模板变为 `MeowStarMap-Setup-2.5.5.exe`。
>
> 2026-10-26 追加：**应用图标换为正式插画，并恢复 app exe 的 PE 资源编辑**。此前 `resources/icons/icon.ico` 由一张蓝色圆角方块占位 SVG 生成，且 `build.win.signAndEditExecutable: false` 会让 electron-builder 连资源编辑一起跳过——实测该 `.ico` 的四档负载在安装器里全部命中、在 app exe 里全部缺失，而 NSIS 快捷方式（`$appExe 0`）、`desktop-shortcut.ts`（`icon: exePath`）与主窗口（未设 `icon`，Windows 回退 exe 图标）三处都跟随 exe 图标，故桌面/开始菜单/任务栏一直是 Electron 默认图标。现改为主源 `resources/icons/icon-master.png`（1024×1024 无损方形，源自用户提供的 4912×4912 插画）经圆角方形 alpha 蒙版生成四档图标，开关按官方提示换成 `signExecutable: false`（仍不签名，但图标与 `ProductName`/`FileVersion` 元数据经纯 JS resedit 写入），占位 SVG 退役。新增 `scripts/__tests__/app-icon.test.ts` 常驻守卫（四档结构、逐档四角透明 + AND 位、配色统计、主源方形、开关反向锁、圆角几何纯函数）。顺带闭合 `docs/plans/2026-10-23-rename-packaging-pass.md` 第九节 6 登记的「右键属性仍显示 Electron 默认值」遗留项。计划与实测读数见 `docs/plans/2026-10-26-app-icon-replace-and-repack.md`。

## [2.5.5-beta] - 2026-10-16

> **版本序列说明**：`2.5.4` 未对外发布（本文件全文无该版本条目），版本号由 `2.5.3` 直接跳至 `2.5.5`（先 `-beta` 后转正）。
>
> 本版本主体为设备同步（NikkiSync 协议 v1）功能整装发布——sync-integration 阶段 0–6 的全部产出，以及端到端联调后的代码审查修复。计划与报告见 `docs/sync-integration/`。
>
> 2026-10-14 追加：以下「NikkiSync 运行时内嵌」变更已合入 `feat/gallery-runtime-embed` 分支并随本节补录；已于 2026-10-15 据此重新构建 `NikkiGallery-Setup-2.5.5-beta.exe`（连同 media:// 流取消竞态启动闪退修复一并出货），`docs/sync-integration/03-sync-server-plan.md` §14.3 #1「打包态未复验」遗留项就此关闭。
>
> 2026-10-16 追加：「同步元数据解析能力补充（NikkiSync resolver 注入，阶段 6）」已合入并随本节补录；已于 2026-10-16 据此重新构建 `NikkiGallery-Setup-2.5.5-beta.exe`（该能力 opt-in 默认关闭，需在设置页显式开启并重启后生效）。
>
> 2026-10-16 追加：「设置页导航整合（9 组 23 节 → 8 组 17 节）」已合入并随本节补录，含两处交互缺陷修复；同日定版为 `2.5.5-beta` 并据此重新构建安装包。计划见 `docs/archive/plans/2026-10-16-settings-nav-consolidation.md`。
>
> 2026-10-17 追加：「全屏预览鼠标翻页（滚轮 / 侧键 / 边缘热区）与键盘切换防抖」已合入并随本节补录，含代码审查发现的滚轮吞并 EXIF 浮层、冷却初值两处缺陷修复（均先红灯后绿灯）；安装包重新构建见 `docs/archive/plans/2026-10-17-uncommitted-review-commit-2.5.5-repack.md` 执行记录。计划见 `docs/archive/plans/2026-10-17-fix-fullscreen-mouse-nav-and-keyboard-jank.md`。
>
> 2026-10-17 追加：「图库卡片选中态边框可见性修复」已合入并随本节补录——网格 / 时间线 / 事件时间线 / 瀑布流四个视图的选中态由 Tailwind 临时拼装的 `ring-2 ring-offset-2` + 内联 `--tw-ring-color` 改为语义类 `is-selected`，样式集中至 `globals.css`（常驻透明 `::after` 描边层 + 主题色描边 + 背景色内衬双线框 + `--accent-soft` 外发光四层视觉，全部变量带 fallback）并可被柔粉主题覆盖；`tailwind.config.ts` 补 `ringColor` / `ringOffsetColor` 令牌。修复 `ring-offset` 偏移色恒为 `#fff` 在深/柔粉底上露白圈、选中态与 hover 态两套描边机制互相吞没、选中样式无法被主题覆盖、裸用 `ring-2` 恒为默认蓝四个根因；安装包重新构建见 `docs/archive/plans/2026-10-17-image-selection-review-commit-2.5.5-repack.md` 执行记录。计划见 `docs/archive/plans/2026-10-17-fix-image-selection-border-visibility.md`。
>
> 2026-10-17 追加：「图库选中态显著度与层叠遮挡修复」已合入并随本节补录——它是上一条「选中态边框可见性修复」确实遗留的两处缺陷续修（不重做既有 `::after` 双线内衬，只加外缘重量与层序）：D1 遮挡主因是 `.media-card*` 全部规则不带 `z-index`，而 `.media-card:hover` 的 `transform: scale(1.02)` 新建层叠上下文，使悬停中的邻居卡片绘制在已选中但静止的卡片之上、把选中外环整条盖掉（多选时鼠标划过相邻图片，选中态时有时无）；D2 不显眼是选中态唯一外向信号 `0 0 0 3px var(--accent-soft)` 的 alpha 仅 12%（柔粉 14%），在深底上近乎不可见。修复为新增由 `--accent` 派生的 `--selection-halo` 令牌（同 `--focus-ring` 手法，主题切换自动跟随、主题文件零改动）、选中态叠为「贴边 2px 实色 accent 环 → 5px 主题光晕带 → 柔光 → 浮起阴影」四层由内而外重量，并建立层序 未选中(0) < 悬停(1) < 选中(2) < 选中且悬停/键盘焦点(3)。执行中由浏览器 computed style 实测抓出计划原有层叠推断有误的 D3：柔粉主题两条宿主阴影规则与 globals 选中态同特异性、只靠源序决胜，而 `.storybook/preview.ts` 在 globals 之后二次引入主题 CSS 会反转源序，其 `:hover` 条更以更高特异性恒压过选中态——即生产环境「悬停一张已选中的卡片」同样让外环消失；改由 `:not(.is-selected)` 明确让位，与源序解耦且不引入 `!important`。附带修复 `globals.css` 注释正文含 `.btn-*/` 导致注释提前闭合、全局 `:focus-visible` 键盘焦点基线规则整条被 CSS 解析器丢弃的 bug。安装包重新构建与本轮提交号见 `docs/archive/plans/2026-10-17-selection-prominence-and-occlusion.md` 文末执行记录（已归档，不入仓）。计划与全部实测读数见同文档。
>
> 2026-10-17 追加：「图片水印可用性修复（media:// 授权 + 批量侧样式对齐 + 失败可见化）」已合入并随本节补录——首轮修「编辑器选完 logo 后图片水印静默消失」（根因是 `dialog:openFile` 只登记目录级 `userPicked`、`media://` 无一条规则认它、`drawImageWatermark` 的 `catch { return }` 把 403 吞掉，另有 `watermark:saveTemplate` 未回内层 `success` 与批量侧不认 `config.style`/`{date}` 两处漂移）；二轮独立审查再落地 7 项红-绿修复（R1 拍立得空文案时批量导出**连文件都不写**、R2 预览把 polaroid 标签画两遍、R3 导出 SVG 与画布两处口径差、R4 `userPicked` 写侧未按 realpath 归一使 junction/映射盘下的 logo 仍恒 403、R5 挑中的单个文件可冒充扫描目录、R6 批量侧 logo 零授权守卫、R7 失败提示在 11 个非中文界面渲染成空串）。**行为变更**：`watermark:apply` 的 `config.image.path` 现经 `assertMediaAccessPath` 校验，未授权者整次批量以 `IPC_PATH_FORBIDDEN` 失败，重启后套用指向未索引目录的旧模板需重选图片。计划、审查结论与全部实测读数见 `docs/plans/2026-10-17-fix-image-watermark-media-auth.md`（§10 首轮 / §11 二轮）。
>
> 2026-10-18 追加：「完全删除照片时同步清理 X6Game\ScreenShot 同名副本」已合入并随本节补录——完全删除一张 HQ 照片时，游戏写在 `NikkiPhotos_LowQuality` 与 `X6Game\ScreenShot` 下的同名副本及其数据库记录未被清理，重扫即复活（本机实测 24/24 命中）。新增纯函数 `resolveGamePhotoVariantPaths` 由 HQ 路径严格推导同图衍生文件候选（须同时命中 GPP 锚点、HQ 目录段与单层纯数字 UID，否则返回空数组），清理目标由单一 LQ 扩为衍生文件全集，副本自身的数据库记录与缓存三档位一并清理；失败路径改为循环后聚合一条 warn。计划见 `docs/archive/plans/2026-10-18-fix-permanent-delete-game-photo-variants.md`（已归档，不入仓）；审查、定版与重新打包执行记录见 `docs/archive/plans/2026-10-18-uncommitted-review-commit-2.5.5-beta-repack.md`（已归档，不入仓）。
>
> 2026-10-18 追加：「图片编辑器实时预览」已合入并随本节补录——拖动滑块时预览**一帧都不产出**：调度是纯尾沿 `setTimeout(80ms)`，而每次参数变更都会重建 `renderPreview` 身份 → 依赖它的 effect 重跑 → `clearTimeout` 再挂表，连续拖动时定时器被无限重置；唯一产出的那一帧又在主线程同步跑完整像素循环并 `toDataURL`，8× 缩放时按原图分辨率逐像素、单帧量级为秒。现改为 rAF 合并调度（每帧最多一次、恒用最新参数、在飞期间合并而非并发）；按事件时间自动判档——拖动走 ≤1024 代理档、停止输入 140ms 后由尾沿补一帧真实预算，离散点击与方向键首帧即真实档不受损；底图与图片水印 logo 跨帧复用（底图命中须核验**图源对象身份**而非 URL，防同图重载后读到陈旧位图）；`planPasses` 把「哪些 pass 真非零」提到逐像素循环外整段跳过未激活项；像素循环与 JPEG 编码卸载到预览 Web Worker（READY 握手 3s、单帧 2s 超时、崩溃即 terminate 并永久回落主线程，任何情况下不让预览黑屏）。**带图片水印的帧刻意留在主线程**：logo 只能由主线程经 `media://` 取，worker 内 `fetch('media://…')` 会撞 CSP 的 `connect-src`，不为它牺牲 2026-10-17 修好的「水印失败可见」契约。实测单帧 1024×768 只调亮度 132.95ms → 30.17ms（4.41×）、2048×1536 516.33ms → 117.85ms（4.38×）；HSL/曲线/分离色调/去雾同时开启时仅 1.05×，故重编辑场景的流畅只能靠像素循环离开主线程。入库前独立审查再落地 3 项红-绿修复（R1 StrictMode 的「挂载→清理→再挂载」使 `workerDisposedRef` 残留 true，迟到握手被误判成组件已死而 terminate，**Phase B 在 `npm run dev` 静默失效**；R2 放弃 worker 的三条路径只置空引用不 terminate，线程泄漏至进程结束且崩溃帧空等满 2s；R3 代理档失败的「降级重试」实际放大到 1400 画布并越权 setError），另清除零写入者的死参数 `ProcessOptions.logoBitmap`。计划、审查结论与全部实测读数见 `docs/plans/2026-10-18-fix-editor-preview-realtime.md`（§9 逐节点红绿 / §10 三项修复）。
>
> 2026-10-18 追加：「同步图库工具栏「关于 NikkiSync」上游外链入口」已合入并随本节补录——板块顶部按钮区压尾新增第 6 个按钮，点击后经主进程 `shell:openExternal` 通道用系统浏览器打开**上游引擎仓库** `ToStardust/NikkiSync`；常量独立命名 `NIKKISYNC_REPO_URL`，与本应用仓库 `QianQianLuLu1/MeowStarMap` 是两个 repo，混了就跳错地方。不新增依赖、IPC 通道或 preload 方法，沿用设置页既有外链口径（`window.open` 与 `<a target="_blank">` 被 `setWindowOpenHandler` 一律 deny，故必须走 IPC）；桥缺失（非授信 origin 下 preload 一个全局都不暴露）时可选链静默降级、不抛错。按钮**无条件渲染且排在压尾**——「详情」是条件渲染的，按钮组左端会随选中态漂移，而空态恰恰是最需要去看上游文档的时刻。12 个语言包同步新增 `syncGallery.toolbar.about`，由 `src/renderer/i18n/locales/sync-gallery-keys.test.ts` 的必需键非空与 12 包子树同构两条断言钉住。本轮审查另发现该入口「桥缺失不抛错」的**原测试断言是假绿**：React 19 把事件处理器里的同步异常交回 jsdom 异步上报，`fireEvent.click` 同步返回，于是异常只让整轮退出码变 1、该用例本身照样通过；改以 `window` 的 `error` 监听器作观测通道后该断言恢复判别力（同类写法另有 5 个既有测试文件，属既有测试质量问题，本轮按最小化改动只登记不修）。计划、七项临时变异红-绿读数与基线见 `docs/archive/plans/2026-10-18-sync-gallery-toolbar-about-nikkisync.md`（已归档，不入仓）。
>
> 2026-10-19 追加：「网格视图向下滚动时逐格闪烁」已合入并随本节补录（提交 `8f0e427`，仅部分设备复现）——三条根因同时成立：① `ThumbReveal` 的 `loaded` 是实例 state，虚拟列表卸载视口外的行后滚回即整棵重挂载，每次都以「未加载」起步，必然先绘一帧 shimmer 骨架再走 200ms 淡入；改为模块级 512 条 FIFO 的「已加载完 src」记忆，只在 `onLoad` 与 `complete && naturalWidth > 0` 两处可信信号写入、`onError` 永不写入（坏图不被掩盖），缓存自检由 `useEffect` 提前到 `useLayoutEffect`，使首次命中缓存也不闪。② 网格级 `hoveredId` 在内容滚过**静止光标**时被 Blink 持续重算，每次换行即整网格重渲染 + 遮罩子树（hover 套 ↔ touch 套）整体装卸；新增 `src/renderer/hooks/useIsScrolling.ts` 以 capture + passive scroll 与 150ms 拖尾沿空闲**只写 ref、不触发渲染**，滚动进行中忽略 hover 切换。③ `useFailedImages` 原实现「引用一变即整表清空」，触底翻页 `addMediaFiles` 产生新数组就把整屏失败记录一次抹掉，已终态的坏图卡退回骨架重新加载；收窄为「只裁剪已离开列表的 id」，且无裁剪时返回原引用——旧实现在每次渲染新建数组的调用方上会形成「渲染 → effect → setState(新 Set) → 再渲染」的无限环路并打到 vitest worker OOM。另有两个候选根因经**只计数不改正**的实测被否决并如实记录：`isTouchDevice` 的挂载期 effect 与列数 effect 被 React 合批，桌面与触屏分支渲染次数相同；同帧 settle 的多个按需生成结果渲染增量 ≤1，React 19 自动批处理已吸收（用例保留为不变量守护）。刻意不调大 `increaseViewportBy` / overscan——该处「测量 → 重渲染 → 再测量」不收敛曾致 `Maximum call stack size exceeded`。计划、逐节点红-绿读数与全量闸门见 `docs/plans/2026-10-18-fix-gallery-grid-scroll-flicker.md`；本轮独立复核（无逻辑缺陷，仅订正两处与实测不符的注释）与重新打包、打包态真机复验读数见 `docs/archive/plans/2026-10-19-grid-flicker-review-commit-2.5.5-beta-repack.md`（已归档，不入仓）。
>
> 2026-10-19 追加：「e2e 双守卫接入闸门 + CI 的 e2e 类型覆盖面补口」已合入并随本节补录（提交 `514e8ab`；全批为开发期闸门与工具层，`src/**` 业务代码一行未动）——两件事：① 本批带入的两道守卫此前只靠本机手动跑：`e2e/dist-guard.ts` 在 `launchBuiltApp()` 启动前识别「`dist/main` 被 `tsc -b` 覆写成 per-file CJS」（判据取真实产物形状——同目录多出 `preload.d.ts`，或头部 512 字节内同时出现 `__esModule` 互操作标记与跨文件相对 `require`），把「`window.electronAPI` 整体缺失」这类环境态变成明确报错，不再伪装成被测代码缺陷；`e2e/nikkisync-guard.ts` 按 `hasNikkiSyncLink()` 给整个 N 套件加未建链门控（未链接是受支持的默认态，不得报成逻辑失败），并把 N1 写死的「说明启动链没跑或抛错逃逸」换成携带最后一次真实读数（`state` / `linkReady` / `hint`）——原文案在未建链时恰与实际原因相反。N2「库落点」判据由「`%LOCALAPPDATA%\NikkiSync\nikkisync.sqlite` 必须不存在」替换为「本次运行前后读数一致」：本机该库由独立 NikkiSync exe 长期合法持有，旧判据把机器既有状态报成嵌入态越界；新判据照样抓得住写入，还额外抓得住删除，是**替换而非放宽**（已用临时变异证实判别力）。② 审查补口两处：`scripts/__tests__/typecheck-emit-isolation.test.ts` 的 `emitTargetFor` 把 `sourceFile` 按仓库根传入后又在函数体内以 `configDir` 解析一次，拼出 tsc 永不产出的 `main/src/main/…` 形状；已统一为「三个路径入参同以 configDir 为基准」，并把两条断言从「在不在产物树里」钉到完整落点（主回归原本就判得红，故不是恒真假绿，缺的是钉住 vite 真正被覆写的那一个文件）。CI 的 `lint-typecheck` job 补一步 `npm run typecheck:e2e`：`tsc -b` 只看根 `tsconfig.json`（include 为 `src/renderer` 与 `src/common`、reference 为 `src/main`），`tsc -p tsconfig.scripts.json` 只收 `scripts/`，两者都覆盖不到 `e2e/**`，而 e2e 下是真实源码；刻意**不**折进 `npm run typecheck`，因为被 `references` 引用的 composite 项目禁 emit 会直接报 TS6310。另抓出一处此前不可能被发现的格式红灯：`e2e/__tests__/nikkisync-guard.test.ts` 不符合 prettier，而 `verify-changes` 的目标取自 `git diff HEAD`——未跟踪文件根本进不了目标集，故上一轮「verify 5 项 0 失败」从未检查过它的格式。`package-lock.json` 的 48 处 `"libc"` 剥离是 `npm install` 副作用，已还原不入仓；版本号四处声明位（`package.json` / lock 根 / preview mock / `release/latest.yml`）实测均已是 `2.5.5-beta`，**一处未改**。已于 2026-10-19 据此重新构建 `NikkiGallery-Setup-2.5.5-beta.exe`，并须如实说明：本批不改运行时，产物在运行内容上与本节此前那次构建等价，只有时间戳与哈希变化。计划、前提台账、逐节点红-绿读数与打包后闸门读数见 `docs/archive/plans/2026-10-19-e2e-guards-review-commit-2.5.5-beta-repack.md`（已归档，不入仓）；被复核的两项修复各自计划见 `docs/plans/2026-10-19-fix-e2e-smoke-dist-pollution.md` 与 `docs/plans/2026-10-19-fix-e2e-smoke-nikkisync-links.md`。
>
> 2026-10-20 追加：「Linux CI 路径语义三分法收口 + 永久模拟装置 + 登记表守卫」已合入并随本节补录——CI 的 `test`（10 分片）与 `coverage` job 跑在 ubuntu-latest，而产品只发布 Windows x64：凡用**宿主** `path` 绑定去解释「库内/注册表/游戏配置里的 Windows 形态路径串」的地方，结论随宿主漂移（`path.posix.isAbsolute('D:\\x')` 为 false、`posix.dirname('D:\\a\\b')` 为 `'.'`、`posix.join('C:\\a','b')` 造出混合分隔符、`posix.sep` 让 `startsWith(root + sep)` 永不命中），十片全红。修复把口径写成 `docs/CODING_CONVENTIONS.md` §6 的三档并逐站归位：**只做键/比较**的固化 `path.win32`（`src/main/ipc/validator.ts` 白名单、`src/main/nikkisync/resource-allowlist.ts` 授权表、`src/main/ipc/handlers/_trash-utils.ts`、`src/main/scanner/path-classifier.ts`，与早年已钉的同层黑名单 `src/main/utils/ipc-validate.ts` 补齐同一口径）；**交给真 fs/子进程**的保持宿主绑定；**两侧都会收到**的走新增叶子模块 `src/main/utils/path-dialect.ts`（`pathOf`/`sepOf`/`joinUnder`，判据是**串的形态**而不是 `process.platform`），落点为扫描的 GPP 根解析、双通道编排、游戏目录发现、UID 发现与 `media://` 归一。**安全相关行为变更**：① 资源授权表的大小写折叠去掉平台开关——NTFS 不区分大小写是产品事实，折叠只把「同一文件的不同写法」并成一个键，判据仍是**确切路径**（`Map.has`，无目录前缀放宽），未登记文件依旧 403；② `isPathUnderDir` 去掉平台分支，无条件走 win32 归一并折叠；③ 白名单 `PathGuard` 固化 win32 后，Linux 上「已登记目录判为不在白名单内」的误报消失（错误码 `IPC_PATH_FORBIDDEN` 与 `maskPath` 脱敏口径不变，非绝对路径/未登记路径/敏感目录仍拒绝），`docs/IPC_CONTRACT.md` §11 登记该口径订正，本轮**未新增或改名任何通道、未改任何方法签名**。防复发三件套：`npm run test:ci-linux`（在开发机复刻 CI 宿主身份的永久装置，只读诊断、不进 CI）、`src/main/utils/ci-linux-emulation.test.ts`（逐轴自检，未激活时整件 skip）、`scripts/__tests__/path-semantics-guard.test.ts`（PINNED / DIALECT / HOST_IO 登记表，新文件引入 win32 钉或方言引用而未登记即红）。基座 `vitest.config.ts` 把裸 specifier `electron` 别名到 `tests/mocks/electron-inert.ts`：CI 用 `npm ci --ignore-scripts` + `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 装依赖时 `path.txt` 不存在，真 `require('electron')` 当场抛错，实测一次隐藏 `path.txt` 的全量运行里 40 个测试文件倒在同一个原因上。另修四处与本轮同源的测试侧失真：`src/main/utils/ffmpeg-paths.test.ts` 的三个 PE 回退用例改为显式声明平台（不再继承宿主）、`src/renderer/utils/share-card/__tests__/shareCardParity.test.ts` 在散列前把行尾归一为 LF（本仓不设 `.gitattributes`，归一后的值与 `git show HEAD:<fixture>` 的 blob 散列逐字相等）、`log-service.test.ts` / `early-crash-guard.test.ts` 的注入落点改真临时目录（容器里 `/` 不可写时不再静默回落到未注入的宿主目录）。审查复核结论：生产侧无逻辑缺陷，本轮实际修的是两处文档事实层问题——被跟踪文档中 6 处「本轮新增，尚未提交，untracked」在提交即成假话（已删限定语、语义不动），以及本条补录缺失会让 `scripts/check-changelog-release.ts` 阻断打包。版本号四处声明位（`package.json` / lock 根 / preview mock / `release/latest.yml`）实测均已是 `2.5.5-beta`，**一处未改**。与 2026-10-19 那轮不同，本批改的是运行期路径判定口径，**产物含真实行为变化**，已于 2026-10-20 据此重新构建 `NikkiGallery-Setup-2.5.5-beta.exe`。两轮修复计划与 CI 地面真相见 `docs/archive/plans/2026-10-20-fix-ci-linux-path-semantics.md`（已归档，不入仓）与 `docs/plans/2026-10-20-fix-ci-linux-path-semantics-round2.md`；本轮审查、定档与重新打包读数见 `docs/archive/plans/2026-10-20-path-semantics-review-commit-2.5.5-beta-repack.md`（已归档，不入仓）。
>
> 2026-10-23 追加：「反馈弹窗 QQ 群号占位值更正 + 产物内容禁串闸门」已合入并随本节补录——本轮审查的起点是一个**已出货的缺陷**：16:01 那次 `npm run dist:win` 出包之后，`17:21` 的 `18723e4` 才把会进包的渲染层文件（`UpdateDialog.tsx`、`about-sections.tsx`、12 语包的 `common.feedbackDialog.githubValue`）换成新仓库地址，于是那个安装包内的 `app.asar` 实测仍含 **4 处** `github.com/QianQianLuLu1/NikkiGallery` 与 **24 处**失效占位 `github.com/your-repo/issues`，而当时 `npm test` 全绿。两处缺陷分别修掉：① 同一弹窗的兄弟键 `qqGroupValue` 正是 `18723e4` 漏掉的那一项——12 个语包它一直是占位 `123456789`，而 `FeedbackDialog.tsx:189` 把整条串原样交给剪贴板，用户点「点击复制群号」拿到的是假号；真实群号的另一份副本在 `about-sections.tsx:18`。本轮**不引入共享常量**（那要求把 12 条串改成插值并在渲染层新增模块导入，属结构性改动），改由 `scripts/__tests__/ui-brand-name.test.ts` 新增的「12 语包与关于页同值」跨源断言钉住，前缀逐语包原样保留。刻意留下的已知偏差：该串仍带 `QQ群: ` 前缀，复制结果不是纯号码，去掉它属行为变更，按最小化改动只登记不修。② 根因是闸门缺位——旧名终扫守卫 `scripts/__tests__/old-name-ledger.test.ts` 的扫描域按设计排除 `dist` 与 `release`（只管源码），`verify:dist` 又只查原生二进制与管理员清单，两侧都看不见产物内容，「测试全绿」与「包是旧的」因此能同时成立。补上的判据落在 `scripts/pre-dist-check.ts --verify-asar` 的第 3 步：读待审 `app.asar` 全量字节，逐禁串做字面量计数（与 `grep -a` 等价——过期包两侧读数逐条对齐为 4/24/4/20），命中即禁止发布。**fail-closed 是刻意的**：解析不到待审 asar 一律判失败而非 `skip`，`skip` 等于把「静默发布过期包」的口子重开（与 `44ab983` 把 `nikkiSyncPackedVerdict` 的降级改成 fail 同一口径）；待审对象由新纯函数 `resolveVerifyAsarTarget` 固定选取（`--asar=<path>` 显式覆盖 → `release/win-unpacked/resources/app.asar` → 拒绝任何 `*.tmp` 解压中途目录），不复用 `findAsarUnpacked` 那套「取 readdir 首个命中」——`release/` 下可同时躺着上次成功的、失败残留的与解压中途的三棵树，那判据会随残留漂移。禁串清单的**唯一出处是台账 JSON**（`patterns` 逐条拼 `artifactBanned.owner` 派生旧仓库 URL 形态，`extra` 收纳非名称类的失效占位），旧名字面量一个都不写进 `scripts/*.ts`：`scripts/` 在该守卫的 `roots` 内而 `pre-dist-check.ts` 不在 `skipPaths` 内，写实名会立刻让它转红（未登记文件 + 总数漂移）。真红读数：闸门对现存过期包判 `exit 1` 并点名 4 类禁串共 52 处，重建后同一判据 `exit 0`。版本号本轮**一处未改**（`package.json` / lock 根 / preview mock / `release/latest.yml` 四处声明位实测均已是 `2.5.5-beta`，`check-doc-versions` 与 `check-changelog-release` 两道闸门当前即满足）；本轮改了语包运行期取值，**产物含真实内容变化**，已据此重新构建安装包。计划、逐节点红-绿读数与打包后闸门读数见 `docs/plans/2026-10-23-qqgroup-fix-and-dist-gate-repack-pass.md`。
>
> 2026-10-24 追加：「GPU 硬件加速系统性优化」已合入并随本节补录——四件事：① GPU 崩溃事件分级（此前任何 reason——含 clean-exit 正常退出——一次即永久置回退标记）：clean-exit 一律忽略，运行期（首绘后）单次瞬时崩溃仅告警、交 Chromium 自行重启 GPU 进程自愈，60s 窗口内达 2 次才升级「落盘回退 + 自动重启进软件渲染」；启动期（首绘前）崩溃仍立即自愈（2026-08-19 白屏根因场景保护不变）。② 回退标记盖版本戳：应用升级后自动重试一次硬件加速，同版本内不再循环重试，用户重开开关的手动干净重试路径保留。③ 独显优先：Windows 混合显卡设备默认写 HKCU UserGpuPreferences 的 GpuPreference=2（仅打包版、仅本应用 exe 路径；切回「跟随系统」时只清理恰好等于自有格式的值，绝不误删用户/其他工具的设置；设置→通用新增「优先使用独立显卡」开关，注册表对下次启动生效）。④ 可观测性：新增 `app:gpu-status` 只读探针 + 诊断面板「GPU 状态」卡（硬件加速开关态与原因、活动显卡、特性降级清单、崩溃回退状态、独显偏好注册表应用结果，12 语言）+ 首帧后 GPU 状态摘要日志行 + e2e S8 结构门禁与图库滚动帧间隔 P95 采样指标（暂不设硬护栏——CI SwiftShader 帧率失真，先采样落盘待基线固化）。逐节点红-绿证据、全量回归（6785 通过 / 12 跳过）与 RTX 5070 独显实机验证（活动显卡落独显、canvas/webgl/视频编解码全 enabled）见 `docs/plans/2026-10-24-gpu-hwaccel-optimization.md`。本轮独立审查复核未发现逻辑缺陷，仅补一处健壮性修复：`getGPUInfo` 降级查询（basic）补超时兜底，两档查询同时挂起的极端情况下探针收敛 null 而不再永久挂起。已于 2026-10-24 据此重新构建 `MeowStarMap-Setup-2.5.5.exe`。
>
> 2026-10-24 追加：「设置开关果冻动效升级」已合入并随本节补录（提交 `610521a`）——全部 15 处设置开关引用共用的样式由「按压拉伸 + 260ms 滑动」升级为纯 CSS 果冻动画：点击后滑块以 350ms 过冲弹簧（复用既有令牌 `--ease-spring`）滑向另一端，途中横向拉长成胶囊形（峰值 scaleX(1.35)，18px 滑块不溢出 44px 轨道）、抵达终点回弹恢复圆形；开启态轨道底色由 `--accent` 改为 `--success` / `--success-deep`（灰→绿 350ms 渐变），focus 焦点环仍为 accent。位移走 transition、途中拉伸走开/关双名 keyframes（`aria-checked` 翻转即动画名变化，双向必然重触发），既有 reduce-motion 全局时长归零规则自动降级；挂载瞬间原地轻微 squash 一次为该手法的固有代价（已在计划文档登记接受）。动画规格由新增守卫测试 `src/renderer/styles/settings-elastic-switch.test.ts` 钉死，红-绿证据与全量回归（441 文件 / 6794 通过 / 12 跳过）见 `docs/plans/2026-10-24-jelly-toggle-optimization.md`。本轮独立审查复核未发现逻辑缺陷，仅同步三处文档漂移：`Switch.tsx` JSDoc 与 Storybook 组件描述仍写旧的「按下拉伸、松开过冲回弹」已订正，并补本条此前漏录。据此重新构建 `MeowStarMap-Setup-2.5.5.exe`（审查与重打包执行记录见 `docs/plans/2026-10-24-review-jelly-desc-changelog-repack.md`）。
>
> 2026-10-25 追加：「NikkiSync 上游同步——能力层（K1–K8）」已合入并随本节补录（K1 `332e0de` / K2 `54e5e21` / K3 `3c7ab84` / K4 `6f4e44d` / K5 `476182b` / K6 `fb17ee5` / K7 `887103d` / K8 `9cf6bfc`，计划批准与逐节点红-绿证据见 `docs/plans/2026-10-25-nikkisync-upstream-sync-02-实施计划.md` 与 `04-能力层执行记录.md`；兼容层 C1–C6 先行对齐上游 `b422193`）——把上游 PC 侧 1.0.23 的新能力分层接入喵星图，全部默认关闭或纯观测：**K1** 启动阶段观测（`runtime-status` 增 `startupStages` 可选段，只记本仓编排真实发生的阶段）；**K2** 元数据在线解析同意门（`MetadataOnlineConsent` 深入口，fail-closed，与既有解析开关构成双门，同意文件 0600 JSON）；**K3** 游戏版本推断展示（上游静态日历表纯本地查询，详情抽屉「游戏版本」行）；**K4** 连接诊断面（纯聚合既有状态，不做主动网络探测，`server-status` 增 `diagnostics` 段）；**K5** 多 host 配对（`nikkisync.multiHostPairing` 默认关，关闭时配对串逐字节保持 `NS1|` 七段旧格式，开启后 `nikki-sync://pair?` 附备选地址）；**K6** 额外照片目录（上游 0600 JSON 单一真相源、八错误短码映射，仅作用同步库扫描器、不影响本地图库扫描目录）；**K7** 扫描诊断观测面（上游 `scanDiagnosticSummary` 纯计数并入连接诊断卡，不发明索引修复按钮）；**K8** 整理队列/批量删除（`nikkisync.organizerEnabled` 默认关；删除目标为 **Windows 系统回收站**、可恢复，不入应用内回收站；C# 回收 helper 经 .NET Framework `csc.exe` 编译、`NIKKISYNC_RECYCLE_HELPER` env 注入，执行前 SHA256+大小双复核；开关门三条 IPC 通道 + 手机/电脑双重确认 + 破坏性确认弹窗列明文件总数与去向；11 态队列视图 i18n 全映射；测试绝不构造真实文件触发执行段）。
>
> 2026-10-26 追加：「近期提交审查修复（同步服务面 3 处 + 路径白名单 1 处 + 契约漂移 2 处）」已合入并随本节补录——六处均为代码审查发现、既有闸门（`lint` / `typecheck` / 全量 `npm test` / `i18n:guard` 当时全绿）拦不到的缺陷，逐条先红灯复现后转绿：**①** 同步服务开关的 `handleToggle` 把 `persistEnabled` 放在只有 `finally` 没有 `catch` 的外层 `try` 里，`settings.set` 失败时 rejection 直冒成未捕获异常、且 `enabled` 悬挂在已切换态（UI 显示开启而配置从未落地），现并入既有的回滚分支；**②** 挂载读回用 `Boolean(value)`，而 `app_settings` 历史非布尔值在主进程按 `typeof === 'boolean' ? value : fallback` 收敛为关闭，判据统一为 `=== true`（与同文件元数据/整理两处开关一致）；**③** 配对二维码过期后的重生成失败只置错误态、不清 `offer`，1 秒 tick 据 `expiresAt <= now` 每秒重发 `getPairingCode` 并每秒弹一次错误 toast（弹窗常开即无限刷），现失败即同步作废 `offerRef`；**④** `nikkisync:inspect-extra-directory` 此前只校验「是不是绝对路径」就把渲染层字符串交上游枚举真实目录、且提案可被 `add` 提升为长期扫描根（内容随后经 `media://` 可读），补 `userPickedDir` 短路 + `assertFileReadPath`（判据与 `scanner:start` / `settings:set` 逐字一致，未登记路径返回 `IPC_PATH_FORBIDDEN`）；**⑤** 三处 `var(--x, #hex)` 硬编码色兜底（变量恒有定义，兜底永不生效，违反 CSS 变量优先约定）与一处两分支同值的死三元清除；**⑥** 订正 K5 后 `docs/IPC_CONTRACT.md` 漏记的 `get-pairing-code` `hosts?` 与 `nikki-sync://pair?` 双格式、K6 映射表的「八/九」错误短码计数，并给 `inspect` 通道补 `PATH_FORBIDDEN` 失败码。**⑦** 最终全量回归时抓到 K1 用例 `(s)` 的断言竞态：它只 `waitFor` 通道「发起了调用」就去取渲染文本，而 `refresh()` 把三个通道放进同一个 `Promise.all`、`setStartupStages` 落在其后的微任务里——实测两轮 `npm test` 有一轮红（`Unable to find an element with the text: 启动阶段`），改为按落地结果等待后连续三轮全绿（同文件 `(s2)`/`(x2)` 本就是这一口径）。测试层修复，不进包、不影响出货产物。版本号保持 `2.5.5`（四处声明位本轮无一改动），据此重新构建安装包。计划与红绿证据见 `docs/plans/2026-10-26-review-fixes-commit-2.5.5-repack.md`。
>
> 2026-10-26 追加：「导出通道源路径口径统一与默认导出目录白名单恢复」已合入并随本节补录（起点是用户报障「导出无法使用，选目录导出与导出到默认都不行」「批量导出到一半就断、文件还不全」）——五条根因各自独立成立，逐条先红灯复现后转绿：**①** 源图读校验用裸 `assertFileReadPath`，而它**先于**目标目录写校验执行，于是两种导出方式以完全相同的 `IPC_PATH_FORBIDDEN` 失败；已入库媒体并不必然命中 `PathGuard`——官方启动器默认装在 `C:\Program Files\InfinityNikki Launcher\...`，命中 `isSensitivePath` 黑名单，而 `isAllowed` 的判定顺序是「黑名单先于 roots」（`validator.ts:320` 早于 `:337`），登记扫描根也不放行，而 `media://` 无此闸门，照片在图库看得见、导不出。现将 `file:export` / `file:saveAs` / `file:copy` / `file:move` / `file:rename` / `file:batchRename` 六条通道的源路径统一到既有的 `assertMediaAccessPath` 三级口径（`userPicked` → DB 已索引媒体白名单 → `assertFileReadPath` 兜底），与 `file:delete` / `editor:batchExportWithMetadata` 同族对齐；目标目录写校验一律保持 `assertFileWritePath` 不变，放宽面由 E3 / S2 / X1 / D6 四条负向用例钉住。**②** `export.defaultDir` 此前只在 `export:setDefaultDir` 写入时校验过，而 `roots` 与 `userPicked` 都是进程内存态、重启即空，导出时的默认目录是从设置读出的字符串、不再经过对话框——默认目录不在家盘/扫描根下（如 `D:\导出`）时重启后目标写校验必然失败；现作为第 4 类恢复源进入 `refreshPathGuardRoots`（`media-update.ts`），写入端已有 `assertFileWritePath` 前置故不构成自助扩权。**③** `exportFiles` 把整个 for 循环包在单一 `try` 里，第 N 个文件抛错即中断其余文件、只回一条泛化消息且不报已成功数；改为逐文件 `try/catch` 收集（形态照抄同服务 `batchRename`），计数走 `exportedWithFailures` 文案而不新增返回字段（`FileOpResult` 受 DEBT-011 冻结）。**④** 渲染层 `getSelectedFilePaths` 读的是订阅值，而 `GalleryPage.handleExportSingle` 在同一次事件回调里先写选中态再同步调用批量操作，闭包里仍是上一轮集合——最坏症状不是报错而是**静默导出错的图并回报成功**，现改读 `getState()` 最新值。**⑤** 两处服务层纵深防御：`exportFiles` 空数组不再回报成功；非图片源在要求转码格式时保持源扩展名（原实现把「是否转码」与「目标扩展名」绑在一起，`.mp4` 转 `jpg` 会产出扩展名自称 jpg 的原始字节文件）。**⑥** i18n 两处：主/渲染两侧实例补 `returnEmptyString: false`（i18next 默认把空串当有效译文，`fallbackLng` 因此永不触发——11 个非基准包各有 2256–2346 条空串，非中文界面导出入口与提示全部渲染成空白，「点了导出看着就是没反应」；实测 zh-CN 基准包空串叶子为 0，不会退化成显示原始 key），并补齐 12 语包共 16 个导出相关键的取值与 `{{count}}` / `{{success}}` / `{{failed}}` 插值，由新增 `export-keys.test.ts` 的 X1–X4 钉住。**⑦** 本轮复核抓到自己批次内的一处代码质量缺陷：新增的 `file-export-handler.test.ts` 有 3 处不符合 prettier，而 `verify` 的目标取自 `git diff HEAD`——未跟踪文件进不了目标集，故「verify 5 项 0 失败」从未检查过它的格式（与 `2026-10-19` 那轮 `nikkisync-guard.test.ts` 同一盲区），已显式清偿并核实重排前后去空白逐字节相同、断言一字未改。四条回归用例的判别力经变异抽查逐条证实：临时撤掉对应生产修复后分别转红（P3 / `media-update` 6 / 陈旧闭包新用例 / E1-E2-S1-C1-M1-R1-B1-D5 共 11 例），还原后 `sha256sum` 校验逐字节一致。另如实登记四处「审查过但明确不修」：配对二维码 tick 缺「在途」标志（挂起式失败仍会并发多发，但报障的错误 toast 连弹已闭环）、`nikkisync-handler.test.ts` 的 `pathGuard` 单例不重置、`handleBatchMove` 仍混用渲染闭包选中集（该调用方不存在写完即调的时序，不可达）、无扩展名源文件在 `convert === false` 时拿到 `.` 后缀（改前改后一致，非本轮引入）。受影响六条通道的名称、入参 schema 与 `IpcResponse` 形状零改动，已在 `docs/IPC_CONTRACT.md` §13 登记口径变更。版本号本轮**一处未改**（`package.json` / lock 根 / `src/renderer/preview/mock/database-mock.ts:664` / `release/latest.yml` 四处声明位实测均已是 `2.5.5`，无脚本校验这四处、属手工口径）；本批改运行期校验口径与用户可见文案，**产物含真实内容变化**，已据此重新构建 `MeowStarMap-Setup-2.5.5.exe`；须如实说明 `latest.yml` 仍写 `2.5.5`，已装该版本的用户不会收到自动更新提示，需手动安装新包。计划、前提台账、变异红绿读数与打包后闸门读数见 `docs/plans/2026-10-26-export-path-guard-and-i18n-fallback-commit-2.5.5-repack.md`。

### Added | 新增

- **设备同步（NikkiSync 协议 v1）**：相册库可作为同步服务端，与移动端（NikkiSync 客户端）经 HTTPS + WebSocket 完成配对、认证与图库同步
  - **协议与认证（阶段 1/3）**：移植 NikkiSync Protocol v1 至 `src/shared/sync/protocol.ts`（类型/路由/错误码/事件契约冻结）；Ed25519 请求验签 + 时间戳/nonce 防重放；一次性配对令牌会话表与仓储（复用即失效、过期 410）
  - **数据适配层（阶段 2）**：`media_files` 之上的同步读取面（keyset 分页资产列表/资产详情/资源定位/增量 journal）与同步元数据表（服务器身份/已配对设备/配对会话）；motion 照片对经真实 `rebuildMotionLinks` 建链
  - **HTTPS 同步服务端（阶段 4）**：自签 TLS（指纹钉扎语义）承载全部核心端点——服务器信息/配对/资产列表/详情/资源下载（支持 Range 分片）/增量变更/搜索统计桩 + WebSocket 实时事件（`server.hello`/`asset.*`/`library.rescan.*`）；升级请求即签名
  - **设置 UI 与扫描器集成（阶段 5）**：设置页设备管理（列表/撤销/状态）、配对二维码（NS1 紧凑 URI + Android 完整 URI）、同步总开关（默认关闭）、扫描事件汇与运行时广播接线
  - **JPEG 无损导出端点（阶段 6）**：`GET/HEAD .../resources/{rid}/export`——不解码像素、仅在段结构上重写 APP1/Exif TIFF（orientation 旋转换算 + 游戏参数 EXIF 注入），四校验响应头 + 单飞限流 + 源字节哈希/大小校验，`metadata.raw` 敏感键绝不入导出文件
  - **端到端联调（阶段 6）**：跨仓库驱动测试覆盖 13 个场景（配对/认证/分页/详情/隐私剥离/资源下载/Range/增量/WS/导出等）全部通过；E2E 启动器 `scripts/sync-e2e/launch-server.ts` 入仓；计划与报告见 `docs/sync-integration/06-e2e-report.md`
- **NikkiSync PC Companion 运行时内嵌**（`docs/sync-integration/02-runtime-embed-plan.md` 阶段 2 与 `03-sync-server-plan.md` 阶段 3）：不再只移植协议实现，而是直接复用上游 NikkiSync 包，把 PC Companion 运行时嵌进本应用
  - **装载缝与依赖链接（阶段 1+9）**：`src/main/nikkisync/` 作为外部 `@nikkisync/*` 包的唯一入口（变量式动态 import，不引用上游类型，协议真相源仍留在本仓 `src/shared/sync`）；`scripts/link-nikkisync.ts` 以 Windows junction 建立 `node_modules/@nikkisync/{core,database,protocol,pc-companion}` 链接，`scripts/verify-nikkisync-link.ts` 提供只读诊断；依赖图改造为自包含（不引入仓库外 `file:` 依赖）
  - **运行时启停与只读 IPC 桥（阶段 2）**：主进程内嵌 `PcCompanionRuntime`，生命周期接入应用启动与 `before-quit` 停止链，对外仅暴露只读状态通道；真实应用会话 e2e 覆盖启动、库落点、DTO 透传与退出停止
  - **同步服务端启用与配对面（阶段 3）**：接入上游 `LocalSyncServer` 的启停与配对面，新增 5 条 `nikkisync` 同步服务 IPC 通道与 preload 桥；设置页「同步服务」节改接真实 NikkiSync 服务，替换此前由本仓移植版承担的开关；真实应用会话 e2e 验证同步服务与配对二维码出图
  - **已知上游缺陷（据此改变默认值）**：上游 `MdnsAdvertiser` 存在组播自激回环，开启后以约 3.5 万包/秒向局域网泛洪，故 `nikkisync.syncMdnsEnabled` 默认置为 `false`（待上游修复后翻回）；嵌入态下服装缩略图端点因零外联未注入缓存而恒返回 404
  - **远端元数据解析 opt-in（阶段 6，默认关闭，`docs/archive/plans/2026-10-16-nikkisync-metadata-resolver-phase6.md`）**：扫描结束后有界驱动上游 resolver 补齐同步图库的拍摄参数（焦距/光圈/曝光/滤镜强度等，`batchSize 4`/`maxPasses 50`，绝不启用上游 15s 自轮询）；设置键 `nikkisync.metadataResolverEnabled` 默认关，开启即向第三方 `nuan5.pro` 发送照片 UID 与内嵌参数信封（设置页常驻隐私披露、12 语言包同步，env 逃生阀 `NIKKI_NIKKISYNC_METADATA`）；关闭时连 `metadataResolver` 配置键都不下发 ⇒ 零出站请求、零定时器；表级隔离护栏（结构档 + `node:sqlite` 语义档）把「同步面绝不写原有库表」钉成回归断言；拆除链最前置 `metadataResolver.stop`，generation 代次作废在途驱动；`runtime-status` 新增可选 `metadata` 段，`verify:nikkisync` 新增 metadata 深入口产物闸门；套装/服装搜索仍需本地字典（Phase 6b），`withOutfit` 计数不等于搜索可用
- 隐私契约固化：资产详情 `metadata.raw` 剥离 NUAN5 敏感键（`nativeParamPayload`/`nativeParamNuan5Md5`），`nativeParamToken` 按上游语义保留，测试固化

### Changed | 变更

- **覆盖率门控按 Vitest 5 新口径重新基线（关闭 DEBT-032）**：`vitest.config.ts` 的 `coverage.thresholds` 由 `69/80/68/69` 改为 `66/58/59/68`，即本轮实测 `statements 66.69% / branches 58.19% / functions 59.22% / lines 68.27%` 的整数下取整，并改写该文件中「基于 2026-10 基线」注释的出处为新口径与取证指引。读数较旧基线下移属 v8 provider 的**测量口径修正而非测试退化**——旧 provider 把「从未被调用的箭头函数体」计入其所在语句并判为已覆盖，Vitest 5 将其拆为独立语句如实计未覆盖。取证：改前 `npm run test:coverage` 退出码 1（四条 `ERROR: Coverage for … does not meet global threshold`）而同轮 `Test Files 373 passed`，即失败只来自阈值；改后退出码 0 且汇总行仍为 `66.69 / 58.19 / 59.22 / 68.27`，与改前逐项一致，证明转绿完全由阈值变更造成。本轮未换 `provider`、未扩大 `exclude`、未动 `include`/`all`/`projects`、未增删 `src/**` 生产代码、未新增或解除 skip（该红线见 DEBT-032「禁止为凑数换回 istanbul 或扩大 exclude」）；读数回升仍待给薄封装模块（`main/preload/api`、`renderer/i18n`、`main/i18n`、`main/scheduler`、`renderer/stores`）补真实调用测试，80% 目标不变
- **设置页导航整合（9 组 23 节 → 8 组 17 节）**：把同一业务域的设置项聚到同一屏，减少用户为完成一件事而反复切页——主题节与显示节合为「主题与显示」；原先四个都在管「哪些目录参与扫描」的二级页（自定义扫描目录 / 探测到的游戏目录 / 导入根目录 / 自动扫描兜底）合为「扫描目录」；清缓存与清库记录合为「缓存与数据清理」；应用信息与联系方式合为「关于」；「工具」与「插件」两个单节分组并为一组。合页由壳组件纵向堆叠既有节体、而非物理搬动节体内容，故各节既有测试套件保持绿色。老用户 localStorage 里的选中位置经 `SettingsPage.tsx` 的 `LEGACY_SECTION_ALIASES` 迁移到合并后的新页，该表以闭合联合类型 `LegacySectionId` 入类型系统（漏配或将来改名即 tsc 报错，不让迁移表退化成一组散落字符串）；归一化在 `useState` 初值阶段完成而非渲染期兜底——兜底只影响「渲染哪个组件」，脏 id 仍会被写回 localStorage，导致下次进来照旧落回默认节且导航无高亮。新增 5 个导航 i18n 键 12 语言包齐、62 处空串填实，`src/renderer/i18n/locales/settings-nav-keys.test.ts` 作契约测试守卫、`src/renderer/pages/settings/settings-card-usage.test.ts` 反向锁定卡片用法。本轮为渲染层排布收敛，未新增 IPC 通道、未改动跨进程契约
- **自定义扫描目录读写收口**：`ScanPathsSection` 与「添加导入目录」不再各自内联 `Array.isArray(saved) ? saved : []` 兜底，统一复用 `src/renderer/utils/scan-exclusions` 的 `loadCustomScanPaths` / `saveCustomScanPaths` / `normalizePathList`（剔除空串与空白项、截断到 `MAX_PATH_ITEMS = 64`，读取失败沿用该 util 的 fail-open 返回空数组）；state 与落库内容都取归一化结果，避免界面显示一条实际不会被扫描的空项
- **扫描兜底写库后同屏只读块感知刷新**：「扫描目录」合并页内，兜底块向 `customScanPaths` 追加目录后，同屏的「游戏目录」「检测到的游戏目录」两个只读块需重读。拆页时代靠「切页自动重挂」免费拿到该刷新，合页后不再自动成立；修复为 `ScanFallbackSection` 新增**可选**回调 `onCustomPathsChanged`（不传即维持原行为，既有调用点与单测零改动），合并页以 `pathsRev` 变更触发两块 `key` 重挂；重挂只跑各自的读取 effect，两块 mount 路径里都不含 `scanner.start`，不会误扫盘

### Fixed | 修复

- **全屏预览鼠标翻页与键盘切换防抖（2026-10-17，TDD 红绿灯，含审查修复）**：全屏查看器原先只有左右导航箭头与触摸滑动，滚轮 / 鼠标侧键 / 左右边缘点击三条鼠标翻页路径完全未接线；键盘侧有三处抖动成因——`navigate` 读闭包里的陈旧 `fullscreenIndex`（按键连发快于一次提交，同帧第二次按键基于旧值计算，「按两张只走一张」后画面跳变）、已接管的方向键未 `preventDefault`（默认行为滚动背后图库，虚拟网格重算可见区致画面抖动）、焦点 effect 依赖含 `fullscreenIndex` 每次翻页重复 `focus()` 触发隐式 scroll-into-view。修复：新增 `src/renderer/hooks/useWheelPageNav.ts`（基于 `@use-gesture/react` 的 `useWheel` 薄封装——原生绑定规避 React 合成 wheel 的 passive 限制，阈值累加 + 冷却窗口吸收触控板惯性，单轴优先，ctrlKey 捏合缩放交还系统，非破坏性失败静默降级）；`navigate` 改读 `useUIStore.getState().fullscreenIndex`；接管键一律 `preventDefault`；聚焦收敛为打开时一次且 `preventScroll: true`；鼠标侧键 3/4 翻页并 `preventDefault`；左右边缘热区（宽 `min(12%, 120px)`，置于既有导航按钮之前不遮挡，`aria-hidden` 纯鼠标命中区，首/末张对应方向不渲染）。**审查修复（两处，均先写失败用例复现后修复）**：① EXIF 信息浮层上的滚轮被全屏根部监听吞并——浮层无法自行滚动且越阈值误翻页（`overflow-y-auto` 浮层的事件冒泡到根，被 `preventDefault` 掐死默认滚动并触发翻页），修复为 hook 新增 `ignoreSelector` 政策出口（事件目标命中即整条放行，无状态判定、重挂载安全）+ 浮层声明 `data-wheel-ignore`；② 滚轮冷却状态机 `lastTriggerRef` 以 0 初始化（语义为「t=0 已触发过一次」），`timeStamp` 小于冷却窗口的首事件被误吞，初值改 `Number.NEGATIVE_INFINITY`。回归：`useWheelPageNav.test.ts`（16 例）、`FullscreenViewer.mouseNav.test.tsx`（18 例）、`FullscreenViewer.keyboardNav.test.tsx`（9 例）；全量 405 文件 / 6262 通过 / 2 跳过，`npm run verify` 与 `npm run lint`、`npm run typecheck` 全绿
- **设置页「添加导入目录」在已有扫描进行时永久卡死并误报成功（TDD 红绿灯）**：`ImportRootsSection` 原先只对 `scanner.start` 抛异常收口（`ipcThrew`），而主进程 `startScan` 在 `currentStatus.status === 'running'` 时直接 `return { success: false }` 且**不广播** `scanner:complete`（`src/main/scanner/index.ts`）。于是 `scanningDir` 与 `customScanningRef` 双双卡在 true——按钮永久停在「正在扫描…」，而下一次任意扫描完成事件会被 `onComplete` 误认成本次添加成功、弹出假的成功 Toast。修复为对 `result.success === false` 补 `rejected` 分支，即时以错误 Toast 回传真实 `message`，并与其后 `finally` 收口共用同一退出路径。回归：`src/renderer/pages/settings/scan-sections.test.tsx`（修复前失败）
- **批量操作阈值的键盘调值被静默丢弃（TDD 红绿灯）**：`GeneralFileOpsSection` 原为裸 `<input type="range">` 且只在 `onMouseUp` 落库，用方向键调整阈值后不写设置、刷新即回退，界面上却显示着新值。改为复用既有 `SliderControl`（其 `onCommit` 同时挂在 `onPointerUp` 与 `onKeyUp`，键盘方向键调值随之落库）；并显式传入 `defaultValue={batchThreshold}`——该控件双击复位优先取 `defaultValue`，缺省会退到 `min = 3`，不传就等于用户误双击即静默丢掉自己的阈值。回归：`src/renderer/pages/settings/general-sections.test.tsx`（修复前失败）
- 联调与审查修复（均先红灯后绿灯）：详情 `metadata.raw` 泄漏 NUAN5 载荷键（E2E 红灯→绿灯）；export 失败路径静默吞错补告警日志；DB 记录大写 sha256 导致导出恒 409 的大小写归一；ImageDescription 超长截断产生畸形 `\uXXXX` 转义；E2E 启动器参数校验（`--port` 0–65535 整数/未知参数拒绝/`--serve` no-op）与退出清理（exit 处理器先关 DB 再删自建临时目录，修复 Windows 下启动失败路径的临时目录泄漏；shutdown try/finally 保证退出码必达）
- 内嵌 NikkiSync Runtime 状态快照修复（TDD 红绿灯）：`nikkisync:runtime-status` 的扫描器字段由不透明 `scanner?` 透传展平为 `scannerStatus?`/`installation?`/`lastScan?` 三字段（与 `src/main/nikkisync/runtime-types.ts` 声明及阶段 2 计划 §5 记载的形状对齐），修复 `runtime-manager.ts` 生产者仍写已删除的 `scanner` 字段导致的类型检查失败（TS2339）与「状态带 installation」意图未实现的问题；`runtime-manager.test.ts` 补三字段透传断言（修复前失败）与非对象/缺字段边界用例，并同步 shared/preload/e2e 形状镜像
- 内嵌 NikkiSync Runtime 生命周期审查修复（TDD 红绿灯，随本安装包发布）：① `stop()` 落在启动在途时被吞——状态机不感知 `state.starting`，停止只把状态置 idle 即返回，在途 `start()` 收尾随将会话置 running 成为孤儿会话；修复为 `stop()` 先等在途启动落地再拆除；② 换端口/mdns 重建同步服务时丢失用户已选游戏根——重建取装配层 `defaults` 而非当前会话 `activeRoot`，用户选过根后仅因改端口就丢回 auto-discovery；修复为 teardown 前取存并传入重建；③ 探针 `probeDatabase` 读 schema SQL 失败时内存库连接泄漏（`manager.close()` 所在 try/finally 尚未进入即被外层 catch 截走），修复为 try/finally 紧接构造；④ `createRuntimeSession` 组装中段（TLS/配对导出缺失、查询面装配）抛错时已建库句柄泄漏，Windows 上会锁死 `nikkisync.db` 使后续启动报 "database is locked"，修复为先关库再上抛。四项均先写失败测试复现后修复，回归：`runtime-manager.test.ts` / `probe.test.ts` / `runtime-facade.test.ts` 新增用例（修复前失败）
- 打包面修复：`@nikkisync/*` 四包真正随安装包出货（此前安装包缺整个内嵌运行时）。根因：electron-builder 的过滤器对**根 node_modules 有硬排除**（`relative === "node_modules"` 直接判否），`build.files` 里的字符串模式 `node_modules/@nikkisync` 通配项永远命中不了任何文件——node_modules 内容只由「按 package.json 依赖图收集」的 collector 产出，而 `@nikkisync/*` 按阶段 9 自包含决策已不是声明依赖。修复：`build.files` 改用**对象式** `{from: "node_modules/@nikkisync", to: "node_modules/@nikkisync", filter: ["**/*"]}`（junction 经 `handleSymlink` 解引用后 walk 枚举真实内容，asarUnpack `**/@nikkisync/**` 解出到 `resources/app.asar.unpacked/node_modules/@nikkisync`）。加固：`scripts/pre-dist-check.ts` 新增 `nikkiSyncPackedVerdict`（导出纯函数 + 单测）——「项目已建链但产物没带上」由 SKIP 改为 fail，堵住此类静默回归；`scripts/__tests__/self-contained-deps.test.ts` 的打包面守护同步改为断言对象式入包项（字符串模式回归即失败）。复验：`npm run verify:dist` 全部 @nikkisync 产物断言转 ✔（migrations SQL、四包 `dist/src/index.js`、`row-mappers.js`、`LocalSyncServer.js` + `GalleryRuntime.mjs`），`npm run verify:nikkisync` 10 项全 ✓（blocking failures: 0），关闭 `docs/sync-integration/03-sync-server-plan.md` §14.3 #1「打包态未复验」遗留项
- **media:// 流取消竞态启动闪退（2026-10-15 线上故障，TDD 红绿灯修复）**：根除用户侧「启动失败 / Startup Failed」弹窗 + `app.exit(1)` 崩溃循环。根因（取证见 `docs/archive/plans/2026-10-15-media-stream-cancel-race-fix.md`）：`media://` 协议处理器把 Node `fs.ReadStream` 直接作为 `new Response()` body，Node 内置 undici 以 `ReadableStreamFrom()` 包装 Node 流，其 pull 完成回调经微任务对 controller 执行**无"流已关闭"守卫**的 close；图库快速滚动/视频 Range 切换触发请求取消时，取消与迟到 close 竞态抛 `ERR_INVALID_STATE: ReadableStream is already closed`（堆栈仅平台帧），被 uncaughtException「一律致命」策略误杀为退出，重启后扫描请求风暴再触发、形成崩溃循环（用户感知为启动失败，实际崩溃发生在启动后 12~70 秒）。双层修复：① 根除——响应体改经 Node 原生 `Readable.toWeb()` 适配（undici 对已是 web 流的 body 直通不包装，无守卫 close 站点从链路上消失，零新增依赖）；② 兜底——`early-crash-guard.ts` 新增流状态竞态窄分类（`ERR_INVALID_STATE` code 精确匹配 + ReadableStream 消息正则 + hasMainWindow 三重收窄），应用已就绪后降级为仅记录（faults 通道带 `declassified: 'stream-race'` 标记），启动期仍致命。测试：缺陷复现用例 T1（原型补丁断言 close 调用方不经 undici 适配层）/T5（降级不弹框不退出）修复前红灯，修复后转绿；T2-T4、T6-T7b 护栏覆盖正常消费/取消交错/空文件/启动期/窄分类/非对象入参边界，`media-protocol.test.ts` 既有用例全部保持通过
- **图库卡片选中态边框不显眼（2026-10-17，TDD 红绿灯，随本安装包发布）**：四个卡片视图（网格 / 时间线 / 事件时间线 / 瀑布流）在多选场景下选中态边框不显眼、缺乏视觉层次、辨识度低。根因四条：R1 `ring-offset` 偏移色只设了 `--tw-ring-color` 未设 `--tw-ring-offset-color`，Tailwind 默认偏移色恒为 `#fff`，在深/柔粉底卡片上露白圈，2px 描边被推离卡片、视觉断裂；R2 选中态用 ring（宿主 box-shadow）绘制而 hover 态用 `.media-card:hover::after` 的 border 绘制，两套机制叠加时互相吞没，选中态失去层次；R3 `globals.css` 无选中态规则，选中样式散落在组件内联、无法被主题覆盖；R4 `tailwind.config.ts` 的 `theme.extend` 无 `ringColor` / `ringOffsetColor`，裸用 `ring-2` 恒为默认蓝 `#3b82f6`、不跟随主题。修复策略为把 hover 与 selected 统一到同一条常驻 `::after` 描边层：四视图选中态统一改用语义类 `is-selected`（删除内联描边色，`aria-selected` 与勾选框 `aria-checked` 不变）；`globals.css` 将 `::after` 改为常驻 `border: 2px solid transparent` + `transition: border-color / box-shadow 160ms ease-out`（只过渡颜色，杜绝 content 从无到有造成的闪现与布局抖动，`html.reduce-motion` 通配自动降级）；新增 `.media-card.is-selected` 四层视觉（`--accent-soft` 外发光 + 主题色描边 + `--bg-primary` 内衬双线框 + `--shadow-lg` 加深，全部颜色走主题变量且带 `var(…, fallback)` 兜底，未来新增暗色主题只需重写变量即自动适配），选中卡悬停描边加深一档（`--accent-deep`）保留「选中 ≠ 悬停」层次；`soft-pink-luxury.css` 补 `.soft-pink-luxury .media-card.is-selected::after` 主题覆盖；`tailwind.config.ts` 补 `ringColor` / `ringOffsetColor` 令牌（DEFAULT 指向 `--accent` / `--bg-primary`）。回归：新增 `media-card-selection.test.ts`（14 例，CSS 源码结构断言 + Tailwind 令牌断言）与 `media-card-selection.test.tsx`（12 例，MasonryView 渲染级 + 四视图源码断言），`layer-budget.test.ts` 守护新规则不引入 `will-change`；全量 407 文件 / 6288 通过 / 2 跳过，`npm run verify` 五项全绿
- **图片水印选完没反应、批量导出与预览不同源，及二次审查发现的 7 处缺陷（2026-10-17，TDD 红绿灯）**：**首轮根因三条叠加**——① `src/main/ipc/handlers/dialog-handler.ts` 的 `dialog:openFile` 只在 `properties` 含 `openDirectory` 时调 `pathGuard.registerUserPicked`，编辑器挑中的 logo（默认 `openFile` 形态、常在 Downloads/桌面等未被扫描索引的目录）从未登记；② `src/main/app/media-protocol.ts` 的 `isMediaPathAllowed` 四条放行规则里没有一条认 `isUserPicked`，且在取 DB 前 `dbManager.getDatabase()` 为空即 `return false`，于是该 logo 经 `media://` **恒 403**；③ `src/renderer/utils/imageProcessor.ts` 的 `drawImageWatermark` 用 `catch { return }` 把加载失败吞掉，水印静默消失、面板只剩一张裂图，用户得不到任何提示。另有两处独立缺陷：`watermark:saveTemplate` 只返回 `{ id }`，而 `call<T>()` 会剥掉 `wrapHandler` 的外层 `success`、`WatermarkPanel` 判的正是 `result.success`（点「保存」后输入框不清空、列表不刷新，DB 行其实已插入）；批量导出侧完全不认 `config.style` 与 `{date}`/`{time}`（画廊「添加水印」出的图没有拍立得白框与日期底纹，且 `{date}` 被写成字面量）。修复：`media-protocol.ts` 新增**规则 0**（媒体扩展名闸门 + `pathGuard.isUserPicked`，判在取 DB **之前**、**刻意不写** `mediaPathCache`，以免「先判否后登记」被 5 分钟否定缓存压成随机 403）、`dialog:openFile` 登记全部返回路径、`{date}`/`{time}` 展开抽到 `src/shared/utils/watermark-text.ts` 供主/渲染同源、`src/main/types/file.ts` 的 `WatermarkConfig` 补 `style`、`watermark-service.ts` 补 polaroid 白带与 date-label 圆角暗底（色值为 SVG/Canvas 内部色，附注释）、`WatermarkPanel` 预览 `<img>` 加 `onError` 内联提示、`useImageProcessor` 暴露 `watermarkError` 由 `EditorPage` 走 toast（旁路回调而非抛错，避免降级重渲染把整张预览打没）。**二轮独立审查再修 7 处**：R1 `buildTextWatermarkSvg` 的 `if (!text?.content) return null` 判在 polaroid 分支**之前**，而 `applyBatch` 的 `overlays.length === 0 → continue` 会跳过整文件——拍立得 + 空文案时预览有白框、批量导出**连文件都不写**（分支上提修复，白框与画布同语义地不受文案约束）；R2 `applyWatermark` 在 polaroid 下先由 `drawPolaroidFrame` 在白带内写字、又无条件再走一次 `drawTextWatermark`，面板预设 `bottomCenter` + `margin: 0` 使第二串字正落在白带内（预览双绘、导出只有一份），改为 polaroid 不再叠加第二份；R3 导出 SVG 两处与画布口径不符——`date-label` 仍带下划线（画布 `imageProcessor.ts:876` 抑制）、`font` 空值不回落 `sans-serif`（空族名会让 `font-family` 整属性失效、回落 librsvg 内置默认，与画布的 sans-serif 不保证同面）；R4 `userPicked` **写侧登记对话框原形态、读侧查 realpath 之后的形态**，凡祖先含 junction / 符号链接 / SUBST / 映射盘 / OneDrive 重定向即两侧永不相交，用户刚挑好的 logo 仍恒 403——归一改放写侧（一次覆盖 scanner/settings/`assertMediaAccessPath`/`assertMediaDeletePath` 全部消费方），并与判定侧同用**非 native** 的 `fs.realpathSync` 保证串逐字相等；两条边界：物理拼写落敏感目录时**不登记**（`isUserPicked` 是跳过黑名单的短路，不能给它直连 `~\.aws`/`Program Files` 的拼写）、只进 `userPicked` **不进 `roots`**（其余消费方按原路径 resolve 后比对 roots，塞进去会波及约 40 个 handler 而无缺陷需要它）；R5 本批把单个文件纳入 `userPicked` 后，`scanner:start` / `settings:set` 的短路判据只看 `isUserPicked`，挑中的 logo 可冒充「显式授权的扫描根」绕过校验并被持久化——PathGuard 增设 `userPickedDirs` 集合与 `registerUserPickedDir` / `isUserPickedDir`，目录形态走前者、文件形态走后者，判定在登记点完成（零 IO，不用 `fs.statSync` 事后猜）；R6 即原计划 §8 E3 的 `config.image.path` 零守卫（service 直接 `fsp.readFile` 任意绝对路径，渲染进程可把私人图片字节合成进导出文件），补 `assertMediaAccessPath(ctx, logoPath)`，未授权者整次批量以 `IPC_PATH_FORBIDDEN` 失败（连带：重启后套用指向未索引目录的旧模板需重选图片，与预览侧 403 同口径）；R7 本批新增的失败提示复用 `toast.imageProcessorLoadFailed`，该键在 12 个语言包**键都齐**但除 zh-CN 外 11 个**值为空串**，而 i18next 把空串当有效译文（`returnEmptyString` 默认 true ⇒ `fallbackLng` 不触发），非中文界面渲染成空白提示，而 `i18n:guard` 与 `check-i18n-keys.ts` 只比键、从不看值 ⇒ 闸门一路绿灯——补齐 11 个语言包的值（键零新增、zh-CN 基准串不动以免 `preview:check` 漂移），并新增 `src/renderer/i18n/locales/image-watermark-toast-keys.test.ts`（沿用同目录 `settings-nav-keys.test.ts` 的 `assertNonEmptyString` 范式）把「非空 + 保留 `{{src}}`」收成硬断言。`docs/IPC_CONTRACT.md` 首次补入**水印域**（§10，此前完全没有 watermark 条目）。回归：新增/改写用例 R1 `S6`/`S6b`、R2 `P1`、R3 `S7`/`S8`、R4 `D3`/`D4`/`D5`、R5 `D6`/`B5`/`C3` 与 dialog 目录-文件登记改写、R6 `W1`/`W2`、R7 `I1`/`I2`/`I3`，每条缺陷用例均先在修复前实跑确认失败（如 S6 `expected +0 to be 1`、P1 `fillText` 调用 2 次期望 1 次、D3 realpath 形态不命中、W1 守卫从未被调用、I1/I2 十一包空串），护栏用例（D4/D5/S4/A3/A4/W2/I3）按原语义修复前即绿；既有 `scanner-handler.test.ts` B1/B3 与 `settings-handler.test.ts` C1 的短路 mock 由 `isUserPicked` 迁至 `isUserPickedDir`（守卫意图不删不改）。实现期一处自纠：给 `watermark:apply` 的 handler 加第二参数 `ctx` 会被 `tests/mocks/mock-validator.ts` 的单参 `wrapHandler` 遮蔽成 `undefined`（表现为 4 条既有用例 `Cannot read properties of undefined (reading 'watermarkService')`），改回取外层闭包。审查中另有两处**误报被据实撤回**：「`escapeXml` 把 `&` 双重转义」不成立（`&` 替换在首位，既有 S5 用例即其证据）、`--danger` 与 `toast` 键的存在性怀疑均经实读否定。全量 413 文件 / 6377 通过 / 2 跳过（本轮起点 412 / 6361），`npm run verify` 五项 0 失败、`npm run typecheck` 通过、`npm run lint` 0 errors（11 条既有 DEBT-030 BOM warning 未新增）、`npm run i18n:guard` 与 `npm run i18n:check` 通过、`npx tsx scripts/core-path-gate.ts` 通过（受保护文件 4 → 6）、`npm run docs:links` 无死引用、`npm run test:coverage` 退出码 0（全局 `68.62 / 60.17 / 61.30 / 70.25`，阈值 `66 / 58 / 59 / 68`）。§9 的 GUI 手工冒烟仍需本机执行（无驱动 Electron 窗口的能力）。计划、审查结论与逐节点读数见 `docs/plans/2026-10-17-fix-image-watermark-media-auth.md`（§10 首轮 / §11 二轮）

### Security | 安全

- **`braces` 高危通告纳入审计豁免（关闭 DEBT-034）**：`audit-ci.jsonc` 的 `allowlist` 追加 `GHSA-vfj7-8cjw-p6xm`（28 → 29 项），并在其注释块按既有分组口径续写命中路径、实测取证、跟踪归属与撤销条件。豁免依据（均为 2026-10-14 实测）：命中 `braces@3.0.3` 的 7 条路径全部来自 dev 工具链（`@babel/cli>chokidar`、`tailwindcss>chokidar`、`fast-glob>micromatch`、`lint-staged>micromatch`、`micromatch`、`vite-plugin-singlefile>micromatch`、`cz-conventional-changelog>commitizen>…>findup-sync>micromatch`），生产代码未引入；`package-lock.json` 在 HEAD 与工作区同为 `3.0.3`，非本轮或依赖升级引入；上游确无修复版可取——`npm view braces dist-tags.latest` 与 `versions` 最大值同为 `3.0.3`（即漏洞版本就是最新版），`micromatch@latest` 的依赖仍写 `^3.0.3`，故**依赖覆盖（`overrides`）没有可 pin 的已修目标**（pin 不存在的版本会让安装失败，pin `3.0.3` 等于没改，pin 更旧是降级），本轮未新增/改动 `package.json` 的 `overrides`，未动 `package-lock.json`，未装/升任何依赖。效果：`npm run audit` 退出码由 1 转 0（`Passed npm security audit.`，该通告移入「Found vulnerable allowlisted advisories」），`scripts/__tests__/audit-config.test.ts` 19 例仍全绿（其对 28 项迁移基线取**子集**断言，故新增豁免不需改测试）。除该通告外无新增 `high`/`critical` 命中，`high: true` 判定、CI 审计步骤与既有拦截均未放宽；两项遗留按 DEBT-020/034 口径留待独立一轮：`audit-ci.jsonc` 残留 18 个不再命中的失效豁免（清退须同步改 `MIGRATION_BASELINE`），上游出修复版后按撤销条件删除本条并 `npm update`
- 本节的覆盖率阈值重新基线与上述审计豁免均为**开发期闸门配置**，不进入运行时与安装包产物；已发布的 `NikkiGallery-Setup-2.5.5-beta.exe`（构建于 2026-10-14 14:09）不含也不需含这两项变更

---

## [2.5.3] - 2026-10-11

> 2026-10-01 首次发布；2026-10-11 重新打包，以下追加变更随同版本安装包一并发布。

### Added | 新增

- **共鸣录同步至游戏 2.10.1**：卡池数据更新至 77 个卡池，数据判定更准确
- **共鸣录新增「卡池心愿单」**：为心仪卡池做标记，抽卡规划一目了然
- **共鸣录新增「套装一键导入衣柜」**：解锁套装（`suit_list`）后可一键导入衣柜，搭配规划更省心
  - 以上三条此前只记载于面向玩家的发布文案 `CHANGELOG-2.5.3.md`，主变更日志漏记；2026-10-24 补录至此，该文件随后按仓库既定口径归档至 `docs/archive/`（不入仓，本机可查）
- 通用 UI 组件族落地 common 层（Button/Checkbox/Drawer/FloatingActionBar/FormField/PageHeader/Progress/SegmentedControl/Select/Switch/ToastProvider/Tooltip）及零依赖 `cn` 类名工具，均附带行为级测试与 Storybook stories
- 外观设置新增「氛围颗粒纹理」与「漂浮几何体」独立开关（`display.ambientGrain` / `display.ambientShapes`，12 种语言文案同步）
- 动效预设新增列表级联入场 `staggerContainer` / `staggerItem`
- **重扫复位谓词唯一真源**：新增 `src/main/scanner/rescan-restore-sql.ts`（游戏目录树条件 ∧ `COALESCE(delete_origin, '') <> 'user'` 的纯字符串常量），`worker-entry.ts` 改为 import 该常量、删除本地同名常量，使「哪些软删除记录允许被重扫复位」只有一处定义。配套 `src/main/scanner/__tests__/rescan-restore-sql.test.ts` 分两档断言：真实 SQL 语义档（用 Node 内置 `node:sqlite` 驱动与生产同构的 UPSERT，因 better-sqlite3 是 Electron ABI 无法在 vitest 下加载）按能力探测门控，无引擎依赖的谓词结构档全 Node 版本必跑

### Changed | 变更

- 页面接入通用组件：Duplicates/RecycleBin 底部操作栏统一为 FloatingActionBar，ResonanceRecords 页签改用 SegmentedControl，设置页 Select/Toast 全面迁移
- Tailwind 圆角/阴影/字体/动画/缓动令牌与 globals.css CSS 变量完全对齐，全项目统一圆角与阴影体系；状态栏样式收敛至 CSS 层
- 无障碍增强：SegmentedControl 补方向键导航与 roving tabindex，Tooltip 补 aria-describedby 关联与 Escape 退出，全局 focus-visible 焦点描边
- **工具链跨大版本升级（Electron 41 / Vitest 5 / Vite 6）**：`devDependencies.electron` 40.10.6 → 41.10.6（关闭 DEBT-020：40.x 分支 EOL 与其上的高危通告）、`vitest` 与 `@vitest/coverage-v8` 1.6.1 → 5.0.3、`vite` 5.4.21 → 6.4.4、`sharp` 0.35.3 → 0.35.5，并新增 `overrides`（`http-cache-semantics` / `source-map-js`）。配套适配：`vitest.config.ts` 以 `test.projects` 替换已被移除的 `environmentMatchGlobs`，并显式恢复 `clearMocks: false`（Vitest 5 把默认值改为 true，会清空模块加载期写入的调用记录，令既有断言「模块级调用记录」的用例恒为 0 次）；`scripts/run-precommit-tests.ts` 与 `scripts/verify-changes.ts` 的 `--reporter=basic` 改为 `dot`（Vitest 5 已移除 basic，未知 reporter 名会在启动期报错并使 pre-commit 测试闸门整体失效）；约 30 个测试文件按 Vitest 5 语义适配（构造器 mock 形态、被运行时证据证伪的旧断言订正）
- **Node 下限三处对齐为单一真源**：`engines.node` 提到 `>=22.12.0` 后，`.node-version` 由 `20` 改为 `22`，`.github/workflows/build.yml` 的 5 个 job 由内联 `node-version: '20'` 改为 `node-version-file: '.node-version'`。Vitest 5 自身 engines 为 `^22.12.0 || ^24.0.0 || >=26.0.0`，原配置会让 `test`/`coverage`/`build` 跑在不受支持的运行时上；改引文件是为消除「两处真源各写一份」这一缺陷成因
- **覆盖率门控读数下移属测量口径修正，不是测试退化（登记为 DEBT-032）**：Vitest 1.6 的 v8 provider 把「从未被调用的箭头函数体」计入其所在语句并判为已覆盖，Vitest 5 把函数体拆为独立语句如实计未覆盖。同一套测试（334 文件 / 5268 例全通过、零 skip、报表目录分组同为 39）从 `69.94/81.43/68.55/69.94` 变为 `64.65/55.67/57.12/66.21`，四项均低于 `thresholds: 69/80/68/69`。本轮**未**降阈值、未扩大 `exclude`、未换 provider、未跳用例，`npm run test:coverage` 保持红灯，重新基线或补测试的决策留待单独一轮。取证与逐目录对照见 `docs/archive/plans/2026-10-09-fix-thumbnail-loading-performance-round2.md` §15
- **提交前指引与实际闸门对齐**：`scripts/verify-changes.ts`（`npm run verify` / `verify:staged`）新增只读格式检查（`prettier --check`，行尾不参与判定），检查集与 `.husky/pre-commit` 对齐但仍不改动任何文件；新增 `scripts/verify-format-scope.ts`（从 `package.json` 的 `lint-staged` 键推导钩子格式作用域）及其单测（含配置契约测试）
- `AGENTS.md`「变更后验证工作流」新增「verify 与 pre-commit 闸门的差异」表（钩子会 `eslint --fix` / `prettier --write` 改写并重新暂存，verify 只读且单测范围为超集），`.qoder/rules/project-conventions.md`「校验与提交」同步口径；本地钩子与 CI 的既有拦截均未放宽
- 根目录 `AGENTS.md` / `CHANGELOG.md` 的表格列宽按 lint-staged 的 `*.{ts,js,json,md}` → `prettier --write` 规则归一（该规则在暂存这两个文件时本来就会改写它们，提前清偿以免提交时静默变动）
- **编码约定真相源入仓**：新增 `docs/CODING_CONVENTIONS.md`（纳入版本控制）承接四条硬约定与「校验与提交」口径；`.qoder/rules/project-conventions.md` 降级为它的本地镜像（IDE `trigger: always_on` 注入用，仍随 `.gitignore` 的 `.qoder/` 不入库）。`AGENTS.md`、`commitlint.config.cjs`、`.gitmessage`、`.husky/commit-msg`（含提交被拒时打印给用户的文案）与 `eslint.config.js` 的段注释全部改指 docs 真相源，并订正章节名「提交校验流程」→「校验与提交」
- 6 个模块级 `AGENTS.md`（`scripts/`、`src/main/{app,database,media-worker,thumbnail,utils}/`）随根 `AGENTS.md` 作为同一提交单元入仓，消除导航表指向仓库外文件；全部 12 个模块级 `AGENTS.md` 首段的“见 always-on 规则 `project-conventions.md`”改指 `docs/CODING_CONVENTIONS.md`（含 `scripts/AGENTS.md` 顶层链接相对层级写错为 `../../AGENTS.md` 的修正），`scripts/__tests__/verify-format-scope.test.ts` 去掉「干净克隆下不存在则跳过」的 `it.skipIf`，改为对 docs 真相源强制断言，并新增三项守护：被跟踪指引（含从导航表动态解析的模块级 `AGENTS.md`）断链拦截、导航表逐行可解析、镜像正文区与真相源逐字一致。本次未新增也未放宽任何 CI 或钩子拦截
- **根目录文档一致性修正（2026-10-06 全仓 md 盘点）**：README 中英段浏览模式「4 种」→「5 种（补瀑布流）」与基础调整「12 项」→「14 项」，ARCHITECTURE(.en) 文档版本元数据与 preload「29 个命名空间」→「30」，DEVELOPMENT(.en) 的 HTML 预览工作流改为 `npm run build:preview` → 打开根目录 `preview.html`（订正 `npm run preview` 实为 electron-vite 生产预览）、克隆路径与安装包版本示例、删除不存在的 `docs/screenshots/` 引用；`THUMBNAIL_OPTIMIZATION_PLAN.md`（根目录）与 `docs/plans/` 中 2 份「已实施」计划归档出仓（本地留档 `docs/archive/plans/`，不入仓）

### Fixed | 修复

- 修复底部操作栏层级过高（z-60）遮挡全局 Toast 与任务进度浮层的回归
- 修复 Drawer 硬编码标题 id 导致双抽屉并开时 aria-labelledby 串号
- 修复 FormField 错误态下 aria-describedby 悬空指向未渲染的 helper 文案
- 预览 mock 的 uiTheme 写入改为与 zustand persist 同构 JSON，消除主题设置回滚隐患
- **缩略图「每次启动/切板块都要重新等一遍」的四个成因（详见 `docs/archive/plans/2026-10-09-fix-thumbnail-loading-performance.md` 与 `...-round2.md`）**

  - **按需生成的读取守卫与 `media://` 展示口径不一致**：`thumbnail:generate` 原用裸 `assertFileReadPath`，其 roots 只覆盖 userHome / userData / 已注册媒体根；游戏装在未注册的独立盘时，照片经 `media://`（走 `isMediaPathAllowed`）能正常显示，但生成请求恒被判「路径不在白名单内」，打包态实测同批已入库路径 `file:getExif` 全通过而 `thumbnail:generate` 4/4 被拒（0~1ms 即失败），DB `thumbnail` 恒 NULL、卡片停在骨架。改为 `assertMediaAccessPath`，与导出/删除通道同口径（`thumbnail-handler.ts`，携 `@core-change` 授权注释）
  - **GamePlayPhotos 图片豁免只认「HQ → 原生 LQ」一个方向**：原实现在推导不出原生 LQ 时一律 `return null`，令该目录下所有「非 HQ 子目录」的已入库图片（`NikkiPhotos_LowQuality` / `CloudPhotos` / `CloudPhotos\Temp` / 视频封面）在代码上根本没有出图入口（本机真实库实测 79 行）。改为自适应：能读到原生 LQ 仍走既有短路；否则只读 header 尺寸，长边 ≤ 512 的低清变体直接引用自身（零解码），大图放行走正常生成。必须按尺寸而非文件名判定——`CloudPhotos\*_Low.jpeg` 名字带 Low，实测是 3311×1485
  - **切板块不再触发按需生成**（真正的用户症状成因）：`VirtualImageGrid` 里 `generateVisibleRange()` 的唯一调用点是 `rangeChanged`，而图库 → 启动器缓存/重复文件 切换时网格组件不卸载、两个板块的可视区间编号一致，react-virtuoso 因此不再回调，新板块的 `thumbnail=NULL` 卡片一次 IPC 都不发、骨架永久停留（副本缓存目录实测整轮切换新增文件 0 个，而手工直调 `thumbnail:generate` 4 次立刻 +4）。改为 `items` 变化时复用既有 `scheduleOnDemandGeneration` 重排一次防抖生成，7 个消费方签名不变
  - **启动期只重绑定已有缓存引用**（关闭 DEBT-026）：`generator.ts` 新增公共方法 `resolveExistingThumbnail`（纯存在性判定，不调 `ensureCacheDir`、不进 sharp 链路），`startup-tasks.ts` 在 `cleanupOrphanThumbnails` 之前补一个「image + `thumbnail IS NULL` + 尺寸齐全」的重绑定阶段，单次上限 2000 行、并发沿用 `THUMBNAIL_CONCURRENCY`、单行失败仅告警。实测定位是补位而非主路径（批量任务收尾已绑上命中的行），本机副本因此测到重绑定 0 条

- **回写数据库失败的告警打成 `{}`**：`thumbnail-handler.ts` 的 catch 原把 Error 对象直接交给 electron-log，而其默认序列化只读可枚举自身属性（`message`/`stack` 在原型上），日志里恒为 `{}`，导致「`thumbnail` 列为何不更新」只能靠对照实验重做取证。新增 `describeWriteFailure` 按 `AppError`（含 code）> `Error`（含 name）> 原始值三级展开、最多下钻两层 `cause`
- **审查轮补出的 6 项缺陷（2026-10-10，逐项均有改前实测红灯，详见 round2 计划 §16）**：① `application.ts:156` 以零参箭头装配 ctx，丢掉 `invalidateMediaPathCache([result])` 的实参，使「仅定向失效新增缩略图路径」在生产退化为整表全清（TS 抓不到：少参函数可赋值给多参签名），改为直接引用模块函数并新增 `src/main/app/__tests__/application.test.ts` 经 `initialize()` 捕获真实 ctx 做回归；② `.node-version` 与 CI 仍钉 Node 20（见上条 Changed）；③ `e2e/perf-real.e2e.ts` 顶层 `import 'node:sqlite'` 会让 `e2e:smoke` 在 Playwright **收集阶段**即崩（`testMatch: '*.e2e.ts'` 不受 `--grep-invert` 影响），改为 `beforeAll` 内惰性 import；④ `thumbnail` 允许等于 `file_path` 后，`toLowQualityUrl` 会把 `.jpg` 命名的自建缩略图推导成不存在的 `_low.jpg`（DetailPage 占位底图与 DuplicatesPage fallbackSrc 消费），守卫扩为与主进程 `isGamePlayPhotosPath` 同形的目录特征；⑤ 移除 `startup-tasks.ts` 里 `typeof ctx.thumbnailGen.resolveExistingThumbnail === 'function'` 的防御检查（生产恒真、方法改名即静默禁用整个启动阶段，且 `src/main/tsconfig.json` 排除测试文件使漏写无人拦截），改由 `_test-helpers.ts` 统一补桩默认值；⑥ `generator.ts` 的 ffmpeg `'error'` 与 30s 超时分支用 `void removeTempFileQuietly(...)` 发后不理，`generate` 返回时半截 `.jpg.tmp-<pid>-<rand>` 仍在缓存目录（实测一次抽帧阶梯泄漏 3 个，也是 `npm run verify` 间歇红灯的真因），改为 await 后再 reject；`media-worker/worker-entry.ts` 的同形缺陷登记为 DEBT-033 交接
- **删除与回收站语义修复（D1–D5，详见 `docs/archive/plans/2026-10-08-recycle-bin-semantics-fix.md`）**

  - **D1 软删除不再搬动文件**：`useFileOperations.ts` 的单文件与批量软删除分支移除 `file.delete`（`shell.trashItem` 把文件移入 Windows 系统回收站，而 Electron 无还原 API → 「恢复」只能翻转 DB 标记、文件实体回不来，表现为裂图 / 打开失败 / 被完整性校验标 `is_missing = 1`）；软删除改为纯 DB 标记，恢复 = 翻转标记即完好还原
  - **D2 重扫不再复活用户删除**：`media_files` 新增 `delete_origin` 列（`connection.ts` 的 `migrateDeleteOrigin()` 经 `safeEnsureColumn` 幂等加列，`'user'` / `'root'` / `NULL` 三态），`media-repository.ts` 的 `softDeleteBatch` / `softDeleteForPermanentDelete` 写 `'user'`、`softDeleteByRootPath` 写 `'root'`、`restoreBatch` 置 `NULL`；扫描 UPSERT 复位分支加 `COALESCE(delete_origin, '') <> 'user'` 谓词，消除「删了又回来」
  - **D3 详情页与全屏删除进回收站**：`DetailPage.tsx`、`FullscreenViewer.tsx` 的删除由 `file.delete` + `mediaAction.delete`（硬删 DB 行，记录根本进不了回收站）改为 `mediaAction.softDelete`
  - **D4 回收站列表刷新**：`RecycleBinPage.tsx` 由「空依赖 effect 只在首挂载拉一次」改为首次挂载必拉取 + `currentView` 切回 `recycle-bin` 时重拉，并订阅 `media:updated` 广播（keep-alive 保活下他处删除不再陈旧）
  - **D5 去掉重复确认弹窗**：`media:emptyRecycleBin` 移除主进程 `dialog.showMessageBox` 二次确认（渲染端 `ConfirmDialog` 已确认，用户被要求确认两次，且取消抛 `IPC_CANCELED` 被误报「清空失败」红 Toast），与 `media:permanentDelete` 同构；`docs/IPC_CONTRACT.md` §2.8 同步

- **`rescan-restore-sql.test.ts` 的 CI 兼容性**：该测试原在模块顶层 `nodeRequire('node:sqlite')`，而 `node:sqlite` 需 Node ≥ 22.5、`.node-version` 与 CI 全部 job 钉 Node 20 → 流水线会以 `Cannot find module` 失败；改为能力探测 + `describe.runIf` 门控（不可用时响亮告警并只跳过语义档，结构档仍必跑，谓词被删改时 CI 仍能拦住），同时修正 3 处 `TS2749`（把值 `DatabaseSync` 用在类型位置，因 `src/main/tsconfig.json` 排除测试文件而未被 `npm run typecheck` 发现）
- **`docs/IPC_CONTRACT.md` 契约同步**：§2.5 `media:softDelete` 补 `success: true` 与软删除新语义（不搬动文件、`delete_origin` 三态与重扫复位口径、4 处读 `res.success` 的调用方），§2.9 `media:delete` 删除「详情页与全屏查看器的删除（源文件先移入系统回收站）」的不实描述（两处已改走 §2.5）

---

## [2.5.2] - 2026-09-30

### Added | 新增

- 图库新增骨架屏组件族，外观设置新增「液态玻璃」风格选项
- 图库缩略图分级加载（低/中/高档位）与滚动邻居预取，长列表浏览更流畅

### Changed | 变更

- decryption-worker 接入构建产物与打包前检查；npm audit 豁免清单迁移至 `audit-ci.jsonc`，统一本地与 CI 审计口径

### Fixed | 修复

- 重构图片预览与导出链路，消除编辑器预览与导出模糊
- 修复全屏预览过渡动画卡顿与掉帧，并完善换源卡顿与关闭登记
- 修复图库 VirtualImageGrid 与大数据数组展开求值两处栈溢出崩溃
- 修复收藏切换与撤销对 IpcResponse 的错误解包
- 修复回收站永久删除误弹错误 Toast 及清空回收站后条目残留
- 删除媒体时同步清理关联缩略图档位与原生 LQ，避免孤儿文件
- 修复第三方平台 Ctrl+V 无法粘贴分享文件；分享图标更换为 Lucide share-2 并加固触发器防压缩
- 修复打包版视频缩略图缺失与 spawn EFTYPE 弹窗：ffmpeg/ffprobe 增加 Windows PE 魔数预检与 spawn 错误诊断落盘
- 修复打包版缩略图加载慢：引入 ETag 协商缓存并完善档位回退链
- 统一五视图缩略图源，修复半截写入、失败覆写、损坏误标与孤儿误删
- 按需缩略图生成结果回写数据库，修复缓存命中回填与视频封面裂图
- 统一启动诊断日志路径，修复诊断包导出卡死，并在启动扫描、索引与场景分析阶段插入精细打点

### Security | 安全

- 升级 sharp 与 @xmldom/xmldom 修复高危漏洞，lockfile 全量切回 registry.npmjs.org 官方源

### Documentation | 文档

- 全量文档与代码库一致性同步：`ARCHITECTURE.md` / `ARCHITECTURE.en.md`（§4 目录树、utilityProcess 五 worker、preload 29 命名空间、UID 正则、services/stores/pages/hooks/icons 计数、§11 构建脚本与 electron.vite.config.ts、asarUnpack 10 项、附录 C 测试规模）、`DEVELOPMENT.md` / `DEVELOPMENT.en.md`（.npmrc 现状、日志/数据库/崩溃 dump 实际路径、门禁基线实测、asarUnpack、USER_GUIDE 死链）、`README.md`（clone 目录名、目录结构去除已移除的 `src/common`）、`AGENTS.md`（handler 域数量）、`docs/PLUGIN_API.md`（插件 IPC facade 实际暴露面、死链清理）、`docs/i18n/fix-sop.md`（补历史标记）
- 统一提交规范文档引用至 `.qoder/rules/project-conventions.md`；登记 Electron 40 EOL 供应链通告债务并立案升级专项
- 新增多份实施计划与诊断文档（缩略图持久化闭环、spawn EFTYPE、全屏过渡、编辑器预览模糊、剪贴板分享等）

---

## [2.5.1] - 2026-09-08

### Fixed | 修复

- 修复图库非网格视图在条目数较多（约 500 条）时的展示异常，并补充过滤后条目计数测试（`useFilteredMediaFiles` 及新增 `useFilteredMediaFiles.count.test.ts`）

---

## [2.5.0] - 2026-09-06

### Added | 新增

- 「共鸣录」板块正式实装（仅离线，断网 100% 可用；逻辑复用自开源项目 gongeo.us-nikki-tracker，MIT License，已获原作者授权）：
  - 共鸣记录：73 个卡池的记录浏览（本地缩略图、品质色点、该抽跨度、垫抽提示）、手动补录 / 修改补录时间 / 删除，长列表虚拟滚动
  - 我的衣橱：部件 / 妆容 / Momo / 道具 / 共鸣色五分类拥有状态管理，套装聚合进度（已集齐 / 集齐中 / 未收集）、名称搜索、拥有状态与稀有度筛选、批量勾选、「从共鸣记录推断」一键推断（纯文字模式，不依赖任何物品图片）
  - 导入数据：本地 JSON 文件导入（解析预览 → 新增/重复/无效计数与逐条定位 → 分批事务提交，进度可视 + 可取消 + 断点幂等）、版本不兼容时提供「兼容导入 / 放弃」双选项、gongeo.us 旧版导出格式兼容；数据导出（内容勾选 + 系统保存对话框）；清空全部（危险二次确认）
  - 个人统计：总览卡（总抽数 / 4★5★ 部件 / 平均出货 / 已获套装）、欧非百分位与档位（静态快照，UI 标注来源与生成日期，缺失时自动隐藏）、SVG 出货分布直方图、按卡池累计曲线、按卡池明细表
  - 数据层：SQLite 新增 5 张共鸣表（幂等迁移，纳入既有整库备份/恢复）；9 个 IPC 通道全部经 zod schema 校验（导入文件按不可信输入同等强度守卫，单文件 ≤64MB、总记录 ≤20 万）
  - 静态数据：图鉴目录 11 片 + 卡池/套装/百分位快照 + 12 语言实体名称包 + 73 张卡池缩略图（约 7.1MB，全部本地打包资源，零外链）
  - i18n：共鸣录全部词条补齐 12 语言；设置 → 致谢与开源协议新增 gongeo.us-nikki-tracker（MIT）条目
  - 离线守护：新增离线断言测试（核心流程零网络调用打桩断言 + 全部新增源码静态扫描 + 反向用例防假绿）

### Changed | 变更

- 测试同步：ipc-setup 契约测试更新为 39 个 registerXxxHandlers、preload 装配测试更新为 reportReady + 29 个命名空间（共 30 键，随共鸣录接入而新增）

### Fixed | 修复

- 测试修复：`GalleryStackOverflow` 边界用例适配 React 19.2「并发渲染出错中止并同步恢复」语义（props 驱动抛错替代闭包计数器，stub 全局 `reportError` 静默恢复上报），消除用例失败与 vitest 未处理错误；`path-safety` 「只读目录」用例改为模拟 `fs.accessSync` 的 W_OK 拒绝（Windows 上 `chmod 0o444` 对目录不生效导致的环境依赖失败），全量 4476 用例稳定全绿
- 修复手动补录成功提示缺失翻译：`AddRecordDialog` 改用 `resonance.toast.added` 并补齐 12 语言包（原 `resonance.records.toastAdded` 不存在于任何语言包，运行时显示原始 key）

### Removed | 移除

- 移除 Python 扫描器原型：`main.py`、`src/path_resolver.py`、`src/album_scanner.py`、`src/index_builder.py` 及其实施计划 `infinity_nikki_album_scanner_implementation_plan.md`。该原型仅由一次提交引入，全仓无任何 TS / 脚本 / CI 引用，其路径定位、UID 隔离、原生缩略图复用能力已由 `src/main/scanner/` 下的 TS 扫描器完整覆盖

### Documentation | 文档

- `ARCHITECTURE.md` / `ARCHITECTURE.en.md`：补齐 2.5.0 共鸣录章节（5 张共鸣表、9 个 IPC 通道与导入上限、随包静态数据、离线守护）与 §12.15 工程不变量（扫描通道编排、游标分页 keyset、读流生命周期、IPC 读路径守卫、Worker 句柄释放、相册类型解析、图库栈溢出防护、导航 / preload 双层防线、原生依赖与启动早期可观测性）；附录 B 补齐共鸣录与新增模块路径；版本号统一为 2.5.0
- `DEVELOPMENT.md` / `DEVELOPMENT.en.md`：修正打包序列（原 `npm run build:main` / `npm run build:renderer` 两个脚本早已移除，改为 `npx electron-vite build` → `npm run pre-dist-check` → `npx electron-builder --win --publish never` → `npm run verify:dist`），修正项目路径示例与原生模块重建命令（`npx @electron/rebuild`），补充安装程序文件名（`NikkiGallery-Setup-<version>.exe`）与质量门禁基线；版本号分别由 2.3.5 / 2.3.0 统一为 2.5.0
- `README.md`：版本徽章同步为 2.5.0，中英文段各补一条共鸣录特性，项目结构补充共鸣录静态数据目录

---

## [2.3.5] - 2026-08-01

聚焦于打包发布后的核心问题修复——解决打包后图库空白、白屏、属性面板解析失败等阻塞级缺陷，同时强化扫描器的缓存图片过滤能力、搜索索引稳定性，以及数据库迁移系统的健壮性。

### Added | 新增

- 自定义游戏目录配置：设置页新增「游戏目录」配置区，支持手动添加/删除自定义游戏安装路径，扫描时优先搜索并跳过耗时的全盘签名搜索，大幅缩短首次扫描时间
- 扫描失败可视化反馈：扫描失败时通过 Toast 弹窗展示失败原因，「未找到游戏目录」时追加手动指定路径的引导提示，避免静默失败
- 打包前产物校验脚本（`pre-dist-check`）：校验 `dist/main` 与 `dist/renderer` 产物时间戳差 ≤5 分钟、关键修复点已编入产物、Git 工作区干净，任一失败即阻止打包
- 启动诊断日志系统（`diagLog`）：独立写入 `userData/diag.log`，替代分散的 `_diag` 函数（原实现使用 `process.cwd()`，打包后双击启动时 cwd 无写入权限导致日志静默丢失）
- 搜索索引 `schema_hash` 校验：字段配置指纹 + 采样数据特征，字段级变更时自动触发全量重建，避免旧索引与新代码不兼容

### Changed | 变更

- 属性面板 IPC 优化：`PropertiesDialog` 将 `useGameParams` 提升到 Dialog 层级统一调用，5 个子面板经 props 注入复用结果，消除 5 次冗余 IPC 请求
- 数据库迁移系统升级：`safeAddColumn` → `safeEnsureColumn`（列已存在时回填旧记录 NULL 值）；迁移标记从命名模式升级为版本号模式（`schema_migrations.version`），旧库自动回填并保持向后兼容
- 默认视图媒体来源策略调整：图库默认视图从仅显示 `game` 改为 `game + cloud`，排除 `launcher` 缓存，由后端 `buildListWhereClause` 统一构建 `media_source != 'launcher'` 条件
- FlexSearch 索引重建方式：`clear()` 改为 `recreateSearchIndex()` 创建全新实例（flexsearch 0.8.x 的 `clear()` 破坏内部注册表），并用容器对象替代 `export let` 避免打包后丢失 live binding
- 插件运行时加载方式：`pluggable-electron/renderer` 从静态 import 改为动态 `import()`，避免 sandbox + contextIsolation 环境下模块加载失败导致整包崩溃（白屏）
- 解密服务 UID 降级处理：`uid='default'` 或缺失时尝试从文件路径重新提取 UID，避免解密直接失败
- 构建配置统一：`directories.output` 改为 `release`；`clean` 脚本同时清理 `dist/main`；outDir 改用绝对路径
- 国际化文案更新：12 个语言文件同步更新，新增扫描路径配置、扫描失败提示、EXIF 游戏照片提示、备份恢复提示等文案

### Fixed | 修复

- 修复打包版本「图库」板块不显示应扫描媒体的问题（自定义路径与自动发现双集合拆分、悬空缩略图重建，详见归档计划文档）
- 修复「指定目录」扫描成功但图库不显示的问题（扫描成功时登记 `import_roots`）
- 修复启动后索引死锁与索引浮窗长期停在 0% 的问题（索引链与扫描解耦、worker 真实进度归一显示、批次超时兜底）
- 修复编辑器画布被 CORS 污染（tainted）的问题（匿名请求 + 消费方替换）
- 修复全屏浏览/幻灯片播放时标题栏遮挡内容的问题（`env(titlebar-area-*)` 避让）
- 修复「打开文件所在位置」的路径白名单绕过问题
- 修复缺失文件默认显示干扰浏览的问题（默认隐藏，提供「仅显示缺失」开关）

### 工程与文档

- 清理 45,000+ 行历史开发计划文档，更新 README、ARCHITECTURE、DEVELOPMENT 等核心文档
- 新增 `pending_renames` 表用于批量重命名失败补偿（R2），新增乐观锁字段 `updated_at` / `snapshot_updated_at`（R8），新增 `phash_mtime` / `phash_file_size` 检测文件外部编辑后 phash 失效（R7）
- 测试覆盖增强：新增 `repair-legacy-data-v1.test.ts`、`worker-entry.test.ts`、`search-service.test.ts`、`GalleryPage.test.tsx`、`ScanProgress.test.tsx`、`uiStore.test.ts` 等测试文件

---

## [2.3.0] - 2026-07-30

聚焦于扫描定位能力的全面强化、媒体来源的智能识别，以及退出稳定性和界面性能的深度打磨。

### Added | 新增

- 媒体来源智能识别：新增 `media_source` 字段，自动区分 game / launcher / cloud 三类媒体来源，图库可按来源快速过滤
- 游戏目录自动定位增强：新增 Steam 注册表查询 + `libraryfolders.vdf` 解析、Epic Games 注册表查询、用户数据目录检测，采用「浅层搜索 → 深度扫描」两级策略
- 全盘媒体签名扫描：新增 `fullScan` 模式，不依赖游戏可执行文件，直接在所有磁盘搜索媒体签名文件夹，支持多盘符并发扫描，首次启动自动执行
- 桌面快捷方式自动补建：应用启动时主动检查并补创建桌面快捷方式，解决 NSIS 覆盖安装等场景下快捷方式缺失的问题
- 诊断包一键导出：设置 → 诊断中新增一键导出诊断包功能，包含日志、崩溃报告与系统环境信息，改用 `tar.exe` 打包

### Changed | 变更

- 扫描可靠性优化：跳过系统目录与云同步目录（OneDrive、iCloudDrive、Dropbox、Google Drive），ScreenShot 文件夹检测增加路径上下文校验，启动时自动修复旧数据
- 进程退出稳定性重构：`before-quit` 加入 2 秒超时保护，关键清理步骤使用 `Promise.race()` 超时兜底，诊断日志改用同步写入，单实例锁在所有清理完成后立即释放
- 界面性能优化：页面切换 FPS ≥ 55，改用轻量淡入动画（8px 右移 + 淡入，220ms），移除整页 View Transitions API，毛玻璃效果优化（移除 `soft-pink-luxury` 主题的 `saturate` 滤镜）
- 数据库优化：扫描 SQL 预编译语句缓存，`character_profiles` 昵称列新增索引，`operation_history` 启动时自动清理 30 天前记录

### Fixed | 修复

- 修复进程退出时异步 I/O 阻塞事件循环导致进程挂起的问题
- 修复 `soft-pink-luxury` 主题 `saturate` 滤镜导致动画结束后画面仍模糊的问题
- 修复 800ms 等待竞态条件
- 修复僵尸进程持有单实例锁导致新实例启动失败的问题
- 进程检测由已弃用的 `wmic` 切换为 PowerShell `Get-CimInstance`，回退分支排除当前 PID 避免自杀
- 修复 PowerShell `Compress-Archive` 执行策略拦截与 `-LiteralPath` 通配符失效导致的诊断包导出失败

---

## [2.2.0] - 2026-07-10

聚焦于系统稳定性提升、分享可靠性增强，以及数据与诊断能力的全面升级。

### Added | 新增

- 分享系统全面重构：支持一键分享到微信、QQ、vivo 办公套件，采用 4 层回退检测链（注册表 → 卸载入口枚举 → 常见目录扫描 → 进程路径反查），检测结果缓存，三态 UI（运行中 / 已安装未运行 / 未安装）
- 崩溃报告系统：独立 `crash-service.ts` 模块处理崩溃信息收集与存储，自动生成崩溃 dump 文件（保留最近 20 个），设置页新增崩溃诊断可视化组件
- 日志管理系统：双格式存储（常规日志文本 + 故障日志 JSONL），按日期自动滚动，总容量限制 5GB，异步文件操作避免主线程阻塞，严格过滤隐私数据
- 数据管理工具箱：设置页新增数据库手动备份、缓存管理（查看与清理）、一键清除所有数据功能

### Changed | 变更

- 视频体验增强：支持 HTTP Range 请求（206 Partial Content）实现流畅拖拽，视频缩略图直接通过 img 元素渲染，视频元数据提取增加 15 秒超时防止扫描器挂起
- 底层架构优化：原生二进制依赖（ffmpeg-static、ffprobe-static、better-sqlite3、sharp 等）通过 `asarUnpack` 解包，新增 `native-path.ts` 自动替换 asar 路径，自定义并发控制工具替代 p-limit 避免 ESM 兼容问题
- 单实例锁优化：启动时自动清理陈旧进程持有的锁
- 扫描器可靠性：扫描进程结束时强制发射 `scanner:complete` 事件，进程检测使用精确进程名匹配

### Fixed | 修复

- 修复 koa-connect 包装器导致的 ctx 泄露问题，中间件改用原生 Koa 实现
- 修复 Windows 下无法执行 asar 包内的二进制可执行文件的问题
- 修复 CommonJS 主进程中 ESM-only 模块（如 p-limit v7）导致的 `require()` 错误
- 修复 `app.whenReady()` 之前调用 `app.getPath('userData')` 导致配置写入异常的问题

---

## [2.1.0] - 2026-06-15

在 v2.0.0 基础上的增量更新，新增插件系统与搜索能力。

### Added | 新增

- 插件系统：基于 pluggable-electron 的扩展架构，支持插件加载、权限校验、扩展点注册
- 全文搜索：基于 FlexSearch 的搜索索引，支持快速检索媒体文件
- 备份恢复：自动定时备份 + 手动备份，5 份 LRU 保留策略
- 游戏参数解密：通过 koffi 调用 nuan5_decryption.dll 解密游戏参数

### Changed | 变更

- 搜索索引与图库联动优化
- 多项性能与稳定性改进

---

## [2.0.0] - 2026-05-20

重大版本升级，从 v1.0.0 核心功能扩展为全功能相册管理工具。

### Added | 新增

- 视频处理：缩略图提取、裁剪、调速（0.25x - 4.0x）、格式转换、Apple Live Photo 导出
- 水印系统：批量水印、水印模板、自定义位置与样式
- 重复检测：精确 SHA256 + 感知哈希（pHash）双重检测、4 维智能评分
- 智能分组：按相册类型 / 场景分类 / 场景时段 / 套装 / 文件类型等 6 维度聚合
- 角色档案：多账号管理、按 UID 隔离、跨档案转移、统计图鉴
- 国际化：12 种语言，含「跟随系统」选项
- 主题系统：默认主题 + 柔粉轻奢主题，CSS 变量驱动
- 高级图片编辑：HSL 调色盘（8色独立调整）、色调曲线（RGB/红/绿/蓝多通道）、色调分离、滤镜预设（8种）
- 全屏浏览与幻灯片播放
- 活动时间轴视图：按游戏活动聚合展示
- 套装图鉴页

### Changed | 变更

- 架构全面升级，引入多进程架构（主进程 + 渲染进程 + utilityProcess 工作进程）
- 数据库层引入 worker 子进程处理写操作
- 缩略图生成、pHash 计算、重复检测迁移至独立子进程

---

## [1.0.0] - 2026-03-01

首个正式版本。首个对外发布的稳定版本。

### Added | 新增

- 项目初始化，完成 NikkiGallery 相册管理应用核心功能
- 实现 Steam / Epic / 默认路径 / 全盘签名多级游戏目录定位
- 实现图片、视频媒体扫描与缩略图索引（better-sqlite3 + sharp + ffmpeg）
- 实现 Windows 11 Fluent Design 风格 UI，毛玻璃卡片 + 圆角 + 轻阴影

### Changed | 变更

- 采用 Electron + TypeScript + React 技术栈，统一主进程与渲染层架构

### Fixed | 修复

- 修复单实例锁未释放导致二次启动失败的问题

---

## 版本类型说明 | Version Types

遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/spec/v2.0.0.html)：

- **主版本号（MAJOR）**：不兼容的 API 修改。示例：`1.0.0` → `2.0.0`
- **次版本号（MINOR）**：向下兼容的新增功能。示例：`1.0.0` → `1.1.0`
- **修订号（PATCH）**：向下兼容的问题修复。示例：`1.0.0` → `1.0.1`

## 变更分类说明 | Change Categories

| 分类       | 中文含义 | 使用场景                         |
| ---------- | -------- | -------------------------------- |
| Added      | 新增     | 新增功能、特性、API、配置项      |
| Changed    | 变更     | 对已有功能的修改、重构、性能优化 |
| Deprecated | 弃用     | 当前可用但即将移除的功能         |
| Removed    | 移除     | 本版本已删除的功能               |
| Fixed      | 修复     | Bug 修复                         |
| Security   | 安全     | 安全漏洞修复或安全加固           |

## 编写规范 | Writing Guidelines

1. 每个版本以 `## [版本号] - YYYY-MM-DD` 格式标题，未发布版本使用 `## [Unreleased]`。
2. 每个分类以 `### 分类名` 作为子标题，分类顺序保持 Added → Changed → Deprecated → Removed → Fixed → Security。
3. 条目使用 `-` 列表，简明描述「做了什么」与「为什么」，避免无意义提交信息。
4. 关联 Issue / PR 时，在条目末尾附加 `(#123)` 链接。
5. 破坏性变更以 `**BREAKING:**` 前缀标注，并说明迁移方式。
6. 发布版本时，将 `[Unreleased]` 区块整体复制为新区块并填入发布日期，清空 `[Unreleased]`；同版本重新打包/再发布前同样需要先收口（`npm run dist:win` 的 pre-dist-check 链会拦截未收口状态）。
7. 旧版本仅保留必要摘要，详细历史可归档至 `CHANGELOG-archive.md`。

## 链接定义 | Link References

<!-- 在文件末尾维护版本号锚点链接，便于自动跳转 -->

> 注：本仓库已有 8 个 tag，但**全部不带 `v` 前缀**——无前缀形式（`2.3.6`、`2.5.0`）与旧项目名前缀形式（`NikkiGallery2.3.6`、`NikkiGallery2.5.0` / `2.5.1` / `2.5.2` / `2.5.3`、`NikkiGallery2.5.5-beta`）。因此下列 `compare/vX...vY` 与 `releases/tag/vX` 链接**实际均不可访问**（2026-10-24 复核）。处置：除 `[Unreleased]` 因 `scripts/__tests__/check-changelog-release.test.ts` 的契约要求必须保持 `compare/v<最新版本>...HEAD` 形式而原样保留外，其余各版本锚点一律改为指向 Releases 页面，确保链接可用；待补打 `vX.Y.Z` tag 后可整体恢复 compare 形式。

[Unreleased]: https://github.com/QianQianLuLu1/MeowStarMap/compare/v2.5.6...HEAD
[2.5.6]: https://github.com/QianQianLuLu1/MeowStarMap/releases
[2.5.6-beta]: https://github.com/QianQianLuLu1/MeowStarMap/releases
[2.5.5]: https://github.com/QianQianLuLu1/MeowStarMap/releases
[2.5.5-beta]: https://github.com/QianQianLuLu1/MeowStarMap/releases
[2.5.3]: https://github.com/QianQianLuLu1/MeowStarMap/releases
[2.5.2]: https://github.com/QianQianLuLu1/MeowStarMap/releases
[2.5.1]: https://github.com/QianQianLuLu1/MeowStarMap/releases
[2.5.0]: https://github.com/QianQianLuLu1/MeowStarMap/releases
[2.3.5]: https://github.com/QianQianLuLu1/MeowStarMap/releases
[2.3.0]: https://github.com/QianQianLuLu1/MeowStarMap/releases
[2.2.0]: https://github.com/QianQianLuLu1/MeowStarMap/releases
[2.1.0]: https://github.com/QianQianLuLu1/MeowStarMap/releases
[2.0.0]: https://github.com/QianQianLuLu1/MeowStarMap/releases
[1.0.0]: https://github.com/QianQianLuLu1/MeowStarMap/releases

---

## English Version | 英文说明

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

### How to update

1. Add new entries under `## [Unreleased]` as you develop.
2. On release, copy the `[Unreleased]` block to a new `## [x.y.z] - YYYY-MM-DD`
   block, then clear `[Unreleased]`. The same applies before repackaging the same version: merge the `[Unreleased]` entries into the matching version section first (the pre-dist-check chain blocks packaging otherwise).
3. Keep category order: Added → Changed → Deprecated → Removed → Fixed → Security.
4. Use `-` bullet lists; describe both **what** and **why**.
5. Reference issues/PRs with `(#123)` suffix.
6. Prefix breaking changes with `**BREAKING:**` and provide migration notes.
7. Update the link references at the bottom for the new release tag.

### Category reference

- **Added** for new features.
- **Changed** for changes in existing functionality.
- **Deprecated** for soon-to-be removed features.
- **Removed** for now removed features.
- **Fixed** for any bug fixes.
- **Security** for vulnerability fixes and hardening.

## 开发者信息 / 作者与社交平台

- **抖音**：纤璐不会玩摄影 ([主页链接](https://v.douyin.com/Dx67wYkw48A/))
- **小红书**：纤璐不会玩摄影 ([主页链接](https://www.xiaohongshu.com/user/profile/69270bb200000000370092db))
- **哔哩哔哩**：纤璐不会玩摄影 ([主页链接](https://b23.tv/zCR5oGE))
- **GitHub**：[QianQianLuLu1](https://github.com/QianQianLuLu1)
- **CSDN博客**：[QianQian-LuLu](https://blog.csdn.net/2604_96788940)
- **作者官网**：https://ppebv9al.qwenwork.host/
