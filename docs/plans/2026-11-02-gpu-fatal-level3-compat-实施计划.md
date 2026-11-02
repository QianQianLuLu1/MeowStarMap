# 启动即闪退（Chromium GPU FATAL）根因定位与三级降级出口 · 实施计划

> 状态：已确认（2026-11-02）｜触发物：问题设备上传的崩溃转储 `232ca58b-b15f-4e33-a615-6e8c05a09f8d.dmp`（非文本日志，是 MiniDump）
> 交付口径（用户确认）：**三级阶梯 + 陈旧心跳驱动升级**；第三档用 `--disable-gpu` + `--disable-software-rasterizer`；取证只做「弹窗补指 + 复用既有诊断包」，**不新增 IPC 通道**；本轮**落仓 + 分节点提交，不重打包、不发版**。

---

## 1. Context：这次改动为什么必须做

### 1.1 转储取证结论（全部来自 dmp 手工解析，非推测）

| 项                 | 值                                                                                                                                                         | 取证位置                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 转储类型           | MiniDump（`MDMP`，12 streams，33.5MB）                                                                                                                     | 文件头                                                           |
| 异常码             | `0x80000003 EXCEPTION_BREAKPOINT`（`int 3`）= Chromium `IMMEDIATE_CRASH()`                                                                                 | ExceptionStream `0x13cb4`                                        |
| 崩溃线程           | **`CrBrowserMain`**（tid 98352 = `0x18030`，主进程 UI 线程）                                                                                               | ThreadList + 线程名流 `0x43500001`                               |
| 崩溃地址           | RVA `0x7beea76`，宿主 `D:\InfinityNikki\meow-star-map\喵星图.exe`，PDB `electron.exe.pdb`                                                                  | ModuleList `0x142c0`                                             |
| FATAL 原文         | `gpu_data_manager_impl_private.cc:417] GPU process isn't usable. Goodbye.`                                                                                 | CrBrowserMain 栈 `0x5a500` + Crashpad `LOG_FATAL` 注解 `0x1ab40` |
| 直接前驱（同毫秒） | `ERROR:...6] GPU process exited unexpected(ly)`（`exit_code` 被 40 字节栈副本截断）                                                                        | 栈 `0x596f0`                                                     |
| 身份               | `_productName=meow-star-map`、`_version=2.5.6-beta`、`prod=Electron ver=41.10.6`、`ptype=browser`、`osarch=x86_64`                                         | 注解流                                                           |
| 设备               | Windows 11 24H2 `build 26200`、x64、20 逻辑核、ProductType=1（工作站）                                                                                     | SystemInfoStream                                                 |
| 注入模块           | `D:\SogouInput\Components\...`：`isgpet_bundle64.dll`、`systembeautify_bundle64.dll`、`ichat_bundle64.dll`、`PicFace64.dll` + `SogouPY.ime`/`SogouTSF.ime` | ModuleList                                                       |
| 依赖健康           | `better_sqlite3.node`/`koffi.node`/`sharp-*.node`/`libvips` 已加载；注解 `LocaleDataPakExists-found_path = ...\locales\zh-CN.pak`                          | ModuleList + 注解                                                |

**上游触发链**（已拉取 Chromium `main` 源文核对；行号与本机 Electron 41 略有偏移，函数一致）：

`GpuProcessHost::OnProcessCrashed()`（gpu_process_host.cc:1042 打 `LOG(ERROR) << "GPU process exited unexpectedly: exit_code="`）
→ `RecordProcessCrash()`（入口即 `if (!process_launched_ || kind_ != GPU_PROCESS_KIND_SANDBOXED) return`）
→ `recent_crash_count_ >= GetFallbackCrashLimit()`（**桌面端 = 3**）
→ `FallBackToNextGpuModeDueToCrash()` → `FallBackToNextGpuMode()`：
**当 `fallback_modes_` 为空时调用 `IntentionallyCrashBrowserForUnusableGpuProcess()` ⇒ `LOG(FATAL)`。**

**故障定性**：设备侧第三方注入（搜狗输入法 / 美化 / IChat 钩子）使 GPU 子进程反复不可用 ⇒ Chromium 把 GPU 降级阶梯走完 ⇒ 按设计自杀主进程。
**不是**缺依赖、**不是**系统版本/权限/硬件差异直接导致、**不是** JS 缺陷；但「永久无法启动」是**项目侧出口缺失**造成的。

### 1.2 项目侧四个真实缺陷（逐条给出处）

1. **阶梯断头**：`src/main/app/gpu-fallback.ts:226-245` + `src/main/index.ts:94-96` 的最高一级是 `app.disableHardwareAcceleration()`。按上游实现它只是 `hardware_disabled_explicitly_ = true; while (HardwareAccelerationEnabled()) FallBackToNextGpuMode()`，**GPU 进程照样启动**（仍走 SOFTWARE_GL / DISPLAY_COMPOSITOR），每档崩 3 次后阶梯仍会空 ⇒ 同一个 FATAL。
2. **自愈在兼容模式被有意关闭**：`requestSelfHeal()` 在 `bootDecisionCache === true` 时直接 `return false`（`gpu-fallback.ts:358`），兼容模式再崩就没有任何后续动作。
3. **熔断计数被首绘清零，救不了「起来几秒后才死」**：`markBootSuccess()` 在 `did-finish-load` 即把 `consecutiveFailures` 归零（`gpu-fallback.ts:325`、`window-manager.ts:167`），而本例合成器/渲染线程都已存在，说明死亡发生在首绘之后 ⇒ `FAILURE_THRESHOLD=2` 永远攒不满。
4. **取证装不下证据**：致命弹窗只指 `startup-errors.log`（`src/main/utils/early-crash-guard.ts:49`、`:124-137`），而原生 FATAL 的证据在 `chromium-debug.log`（`src/main/index.ts:76-77` 已开 `enable-logging=file`，其中含 `exit_code` 与 `LOG(WARNING) << "The GPU process has crashed N time(s)"`）。另 `src/main/index.ts:63-64` 注释「此类退出……无崩溃转储」**已被本份 dmp 证伪**（crashReporter 在 lifecycle 阶段 4 已 `start()`，早于建窗）。

### 1.3 预期结果

- 受影响设备最迟在第 3 次启动落到「最大兼容档」并**能正常打开并使用**（本应用渲染层全用 `getContext('2d')`，无 WebGL/WebGPU，关软件光栅化的功能代价为零，仅性能下降）。
- 下一次同类上报自带 `exit_code`，无需再靠人工翻目录。

---

## 2. 依赖声明

**零新增/零变更 npm 依赖，全程禁止 `npm install` / `npm update`**（会静默拆掉 `@nikkisync/*` 链接）。

| 复用项                                                                     | 位置                                                                     | 用途                                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `parseHeartbeat` / `parseLastExit` / `readStaleEvidence`                   | `src/main/app/exit-forensics.ts:103-188`                                 | 判定「上次被原生层杀死」，改为导出复用而非新写解析                                                   |
| `readGpuBootPrefs` / `mergeWriteGpuBootPrefs` / `readState` / `writeState` | `src/main/app/gpu-fallback.ts:99-184`                                    | 状态与偏好读写口径不变                                                                               |
| `diagLog` / `electronLogger` / `logger`                                    | `src/main/utils/startup-diagnostic.ts`、`src/main/utils/logger.ts`       | 新增日志沿用双通道口径                                                                               |
| `exportLogsAsZip` + `createZipFromDirectory`                               | `src/main/services/log-service.ts:146-`、`src/main/utils/zip-archive.ts` | 诊断包补文件，**不新增 IPC 通道**（渲染层入口即右下角 `FeedbackDialog.tsx:33` 的 `log.exportZip()`） |
| `app.commandLine.appendSwitch`                                             | Electron 官方 API                                                        | 下发 Chromium 开关                                                                                   |

上游开关字符串逐个核实存在（**不发明开关**）：`disable-gpu`（content/public/common/content_switches.cc:134）、`disable-software-rasterizer`（:260）、`in-process-gpu`（:469，本计划不用）、`disable-gpu-process-crash-limit`（:152，上游注释标注 _For tests_，本计划不用）。
第三档生效依据：`SoftwareGLAllowed() = !HasSwitch(kDisableSoftwareRasterizer) && IsAnySoftwareGLAllowed(...)`，两开关同给时 `GpuAccessAllowed()` 走 default 分支返回 false，上游注释正对这一组合（"GPU access is disabled through commandline switch --disable-gpu and --disable-software-rasterizer."）。

---

## 3. 启动说明

```bash
npm run verify                      # 只读检查集（typecheck + eslint 无 --fix + core-gate + prettier --check + 相关单测）
npx vitest run src/main/app/__tests__/gpu-fallback.test.ts src/main/app/__tests__/gpu-selfheal.test.ts \
              src/main/app/__tests__/exit-forensics.test.ts src/main/app/__tests__/gpu-status.test.ts   # 节点级
npm run test:main                   # 主进程子集
npm test                            # 全量（收口，一票否决）
npm run typecheck && npm run typecheck:e2e && npm run lint && npm run i18n:guard
```

本机实机验证（不打包，dev 宿主）：

```bash
NIKKI_GPU_FORCE_LEVEL=2 npm run dev
# 判定 A：进程树里不应出现 --type=gpu-process
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '--type=gpu-process' } | Measure-Object | Select -Expand Count"
# 判定 B：设置 → 日志与诊断 → GPU 状态卡出现 compatLevel=2；启动日志含 level=2
```

设备侧一次性验证（**V0，零代码，可立刻给被困用户**）：让用户用快捷方式启动一次

```
"D:\InfinityNikki\meow-star-map\喵星图.exe" --disable-gpu --disable-software-rasterizer
```

Electron 直接吃命令行里的 Chromium 开关。能正常打开 ⇒ 机制端到端闭环；仍闪退 ⇒ 归因需回炉（说明问题不在 GPU 子进程档位）。

---

## 4. 错误处理

| 分支                                             | 行为                                                                                                          | 兜底 / 日志                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `gpu-fallback.json` 缺失/损坏/无 `compatLevel`   | 视为 `0`，按旧语义（`fallbackActive` / 计数）判定                                                             | 静默（既有 `readState` 口径不变） |
| `heartbeat.json` / `last-exit.json` 读失败       | 视为「无原生杀死证据」，退回计数慢路径                                                                        | `diagLog('GPU', ...)`             |
| 心跳存在且 `last-exit.json` 的 `bootId` 与之匹配 | 判定 JS 管理退出 ⇒ **不升级**（避免用户主动退出被误判）                                                       | 既有 `readStaleEvidence` 分支     |
| 已在 level 2 仍被杀死                            | **不再上升、不再 relaunch**（防死循环），落 `logger.error` + 提示「最大兼容模式仍启动失败，请附带诊断包反馈」 | `diagLog` + `electronLogger`      |
| `appendSwitch` 抛错                              | try/catch 吞掉，退化为仅 `disableHardwareAcceleration()`                                                      | `diagLog('INDEX', ...)`           |
| `app.getVersion()` 不可得                        | 保守：不做版本级复位（沿用「版本不可得 → 保守回退」既有口径）                                                 | `diagLog`                         |
| 诊断包内 `chromium-debug.log` 不存在 / >10MB     | 跳过或只取尾部 2MB，**不阻断导出**                                                                            | `diagLog('LOG', ...)`             |
| 用户在设置页重开硬件加速                         | `writeHardwareAccelPref(true)` 额外把 `compatLevel` 复位 0、清 `fallbackActive`                               | 既有复位入口                      |

第三档不涉及安全削弱：不关渲染器沙箱、不用 `--no-sandbox`、不用 `--disable-gpu-sandbox`（后者在 Chrome 侧被 `bad_flags_prompt.cc` 列为降低安全性的旗标，本计划不引入）。

---

## 5. 参数校验

- `compatLevel` 入站仅两源，均严格校验：
  - 文件：`typeof raw.compatLevel === 'number' && Number.isFinite(...) && ∈ {0,1,2}`，否则落 `0`；负数 / 小数 / 字符串 / `null` ⇒ `0`。
  - 环境变量：`NIKKI_GPU_FORCE_LEVEL ∈ {'0','1','2'}` 才生效；其他值（`'01'`、`'2.0'`、空串、任意串）⇒ 忽略并 `diagLog('INDEX','invalid NIKKI_GPU_FORCE_LEVEL ignored')`。
- `resolveCompatLevel(state, prevNativeKill, nowVersion)` 为**纯函数**（无 fs、无 electron），非法/缺字段收敛到保守值，返回恒为 `0|1|2`（越界夹取）。
- 常量：`FAILURE_THRESHOLD = 2`（保持既有值，作慢路径）、`MAX_COMPAT_LEVEL = 2`、`BOOT_SUCCESS_SETTLE_MS = 8_000`。
- `markBootSuccess(settledMs?)` 不接受非有限数；非法 ⇒ 按「未达窗口」不清零（宁可不给成功，不可误清）。
- 诊断包新增项沿用白名单式收集（固定文件名 + 既有扩展名集合），**不接收渲染层传入的任何路径**；`log:exportZip` 通道签名与 zod 校验不变（仍 `wrapHandler` + 目标 `.zip` 校验）。

---

## 6. 基础测试用例（正常 / 异常 / 边界；每节点先红后绿）

| 编号 | 套件                        | 类型 | 断言                                                                     |
| ---- | --------------------------- | ---- | ------------------------------------------------------------------------ |
| L1   | `gpu-fallback.test.ts`      | 正常 | 全新状态 ⇒ level 0，既有用例语义不变                                     |
| L2   | 同上                        | 正常 | `fallbackActive=true` 且同版本 ⇒ level ≥ 1                               |
| L3   | 同上                        | 正常 | `prevNativeKill=true`：level 0→1、1→2、2 保持 2                          |
| L4   | 同上                        | 异常 | `compatLevel` 为 `'2'`/`-1`/`3`/`NaN`/`null` ⇒ 归一合法值，不抛          |
| L5   | 同上                        | 异常 | 心跳与 `last-exit` 同 bootId（JS 退出）⇒ **不升级**                      |
| L6   | 同上                        | 边界 | `consecutiveFailures=1` 且无心跳证据 ⇒ 不升级                            |
| L7   | 同上                        | 边界 | 版本变化 ⇒ level 复位 0 给一次干净重试并盖 `compatLevelVersion`          |
| B1   | `gpu-selfheal.test.ts`      | 正常 | 兼容模式（level 1）再崩 ⇒ 升 level 2 落盘并 relaunch 一次                |
| B2   | 同上                        | 边界 | level 2 仍崩 ⇒ 不 relaunch、不升 3、落一条 error                         |
| S1   | `window-manager` 相关       | 正常 | 首绘后 <8s 死亡 ⇒ 下次启动计数不清零                                     |
| S2   | 同上                        | 边界 | 首绘后 ≥8s ⇒ 计数清零（既有语义保持）                                    |
| S3   | 同上                        | 异常 | `did-fail-load` ⇒ 不视为 settled                                         |
| F1   | `early-crash-guard.test.ts` | 正常 | 弹窗正文含 `chromium-debug.log` 路径行                                   |
| F2   | `log-service.test.ts`       | 正常 | 诊断包集合含 `chromium-debug.log`、`gpu-fallback.json`、`diag.log`       |
| F3   | 同上                        | 边界 | `chromium-debug.log` 缺失 ⇒ 导出不失败、其余照收                         |
| F4   | 同上                        | 异常 | >10MB ⇒ 只截尾部，不整包复制                                             |
| G1   | `gpu-status.test.ts`        | 正常 | payload 增 `compatLevel`，`reason` 新增 `max-compat`                     |
| G2   | 同上                        | 边界 | `compatLevel` 缺省 ⇒ 显示 0，`hwAccel` 判定不变                          |
| E1   | `e2e/smoke.e2e.ts` S8       | 正常 | 全新 userData 仍 `hardwareAcceleration.enabled===true`（默认档不受影响） |

---

## 7. 子任务分解（严格 TDD：红灯 → 改 → 绿灯 → 回归 → commit）

### T0 计划与取证落仓（本文件）

- 文件：`docs/plans/2026-11-02-gpu-fatal-level3-compat-实施计划.md`
- 验收：`git ls-files` 可列出该文件；`npm run verify` 不因文档失败（`docs/**` 不在闸门格式范围内）
- commit：`docs(plans): GPU FATAL 根因取证与三级降级出口实施计划`

### T1 三级阶梯状态机（核心）

- 文件：`src/main/app/gpu-fallback.ts`、`src/main/app/__tests__/gpu-fallback.test.ts`
- 输入：`{ consecutiveFailures, fallbackActive, fallbackVersion, compatLevel?, compatLevelVersion? }` + `prevNativeKill: boolean` + `appVersion`；输出：`GpuCompatLevel(0|1|2)`
- 改动：新增导出纯函数 `resolveCompatLevel()` 与 `recordBootLevel()`（保留 `shouldDisableHardwareAcceleration()` 作布尔包装，避免既有状态机用例语义大改）；`markGpuProcessCrash()` 落 `compatLevel = max(cur,1)`；`requestSelfHeal()` 在 `level < 2` 时允许升档 relaunch，`level === 2` 时放弃并记 error
- 验收：`npx vitest run src/main/app/__tests__/gpu-fallback.test.ts src/main/app/__tests__/gpu-selfheal.test.ts` 全绿；**改前 L3/L4/L7/B1/B2 必红**（附失败计数）
- commit：`feat(gpu): 三级兼容阶梯状态机（最大兼容档）`

### T2 心跳驱动升级（复用取证判定）

- 文件：`src/main/app/exit-forensics.ts`（导出 `parseHeartbeat`/`parseLastExit`，新增只读 `getPreviousExitEvidence()`，同步、ready 前可调）、`src/main/app/gpu-fallback.ts`、`src/main/app/__tests__/exit-forensics.test.ts`
- 输入：`userData/heartbeat.json` + `last-exit.json`；输出：`prevNativeKill`
- 改动：`readStaleEvidence()` 把结论写入模块级变量并导出访问器；`exit-forensics.ts:29` 的「不参与任何业务控制流」注释订正为「判定结论可被 GPU 降级阶梯消费为升级证据，取证写盘本身仍 fail-open」
- 验收：`npx vitest run src/main/app/__tests__/exit-forensics.test.ts` 全绿 + L3/L5 绿；改前 L5 必红
- commit：`feat(forensics): 陈旧心跳可被降级阶梯消费`

### T3 成功判定延后（堵掉「首绘后死亡」漏洞）

- 文件：`src/main/app/window-manager.ts`（`did-finish-load`，现 :167）、`src/main/app/gpu-fallback.ts`（`BOOT_SUCCESS_SETTLE_MS`）+ 对应测试
- 输入：首绘事件时间；输出：是否清零计数
- 改动：首绘后 `setTimeout(8s)` 到点才 `markBootSuccess()`；timer `unref` 且在清理链 `clearTimeout`；未达窗口不清零
- 验收：S1/S2/S3 全绿（S1 改前必红）+ `npm run test:main`
- commit：`fix(gpu): 首绘后存活 8s 才确认启动成功`

### T4 开关下发 + 取证增强

- 文件：`src/main/index.ts`（:94-96 档位判定、:63-64 失效注释订正）、`src/main/services/log-service.ts`（**受保护路径**：前 5 行加 `// @core-change: 诊断包纳入 chromium-debug.log 与 gpu 回退状态，补齐原生 FATAL 取证`）、`src/main/utils/early-crash-guard.ts` + 两套件测试
- 输入：level；输出：命令行开关 + 诊断包文件集合 + 弹窗文案
- 改动：`level >= 1` ⇒ `disableHardwareAcceleration()`；`level === 2` ⇒ 追加 `appendSwitch('disable-gpu')` + `appendSwitch('disable-software-rasterizer')`；`exportLogsAsZip` 增取 `chromium-debug.log`(+`.old` 截尾)、`gpu-fallback.json`、`diag.log`；弹窗与 `startup-errors.log` 明示「原生证据见 chromium-debug.log」
- 验收：F1-F4 全绿 + `npm run verify` 的 `core-gate` 步骤通过
- commit：`fix(diag): 最大兼容档开关下发 + 诊断包补齐原生 FATAL 证据`

### T5 可观测（不改 IPC 语义，只加可选字段）

- 文件：`src/main/app/gpu-status.ts`、`src/shared/types/electron-api.ts`、`src/renderer/pages/settings/diagnostics-sections.tsx`、`src/renderer/i18n/locales/*.json`（12 语言 1 键 `settings.gpu.compatLevel`）、`docs/IPC_CONTRACT.md`
- 输入：状态文件；输出：`compatLevel` + `reason='max-compat'` + 启动摘要行
- 验收：`npx vitest run src/main/app/__tests__/gpu-status.test.ts src/renderer/pages/settings/diagnostics-sections.test.tsx` 全绿 + `npm run i18n:guard` / `i18n:check` 通过 + 契约登记
- commit：`feat(gpu): 兼容档位可观测（状态卡 + 契约登记）`

### T6 全量回归 + 本机三档实测 + 文档回写

- 顺序：`npm run verify` → `npm test`（全量，一票否决）→ `npm run typecheck` → `npm run typecheck:e2e` → `npm run lint` → `npm run i18n:guard` → `NIKKI_GPU_FORCE_LEVEL=0/1/2` 各起一次并按 §3 判定 A/B 取证 → 本文件追加「执行记录」
- 验收：全量 0 failed；level 2 时 `--type=gpu-process` 计数为 0 且窗口出图
- **本轮不执行 `npm run dist:win`、不发版**

---

## 8. 附录：本次转储的可复现解析法（无 WinDbg 也可跑）

```bash
# 1) 流目录（注意 NumberOfStreams 在 StreamDirectoryRva 之前，别写反）
python - <<'PY'
import struct
d = open(r"D:\BaiduNetdiskDownload\232ca58b-b15f-4e33-a615-6e8c05a09f8d.dmp", "rb").read()
sig, ver, n, dir = struct.unpack_from("<4sIII", d, 0)
for i in range(n):
    print(struct.unpack_from("<III", d, dir + i * 12))  # (type, size, rva)
PY
# 2) ExceptionStream @0x13cb4：ThreadId(4) + pad(4) + Code(4) + Flags(4) + Record(8) + Address(8) + NParams(4) + pad(4) + Params[N]*8 + LOC(size,rva)
# 3) ModuleList @0x142c0：count(4) 后 stride=108 —— base@0 size@8 checksum@12 <TS>@16 nameRva@20 VS_FIXEDFILEINFO@24 CvRecord@76 MiscRecord@84
#    RSDS 记录：sig(4)+Guid(16)+Age(4)+Filename(剩余长度)
# 4) 线程名流 type=0x43500001 @0x13040：count(4) 后每项 12B (tid, rva, pad)，rva 处为 MINIDUMP_STRING（u32 长度 + UTF-16）
# 5) 内存块：MemoryListStream(type 5)；线程栈地址区间 = [Stack.StartOfMemoryRange, +Memory.DataSize)
# 6) FATAL 原文两处：Crashpad 注解 @0x1ab40（LOG_FATAL / _productName / _version / ver / ptype / LocaleDataPakExists-*）与 CrBrowserMain 栈 @0x5a500
```

---

## 9. 风险与回退

| 风险                                        | 处置                                                                           | 回退                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| 第三档渲染全 CPU、大图浏览变慢              | 本应用无 WebGL/WebGPU，功能不受损；UI 明示档位并保留一键复位                   | revert T4 的 level 2 分支（阶梯退化为两级）                   |
| 心跳证据把「系统强杀/断电」也算成升级依据   | 只升一级且封顶 2；版本变更自动复位                                             | revert T2（退回纯计数慢路径）                                 |
| 8s 存活窗口让正常用户偶发多启动一次才计成功 | 仅影响清零时机，不影响功能；阈值仍为 2                                         | revert T3                                                     |
| 上游改掉 `disable-software-rasterizer` 语义 | §3 的 V0 与本机 level 2 判定 A/B 是显式守卫，失效会立刻表现为「仍有 GPU 进程」 | 改用 `--in-process-gpu`（需另评估驱动级崩溃带走主进程的风险） |
| `NIKKI_GPU_FORCE_LEVEL` 被误当生产开关      | 仅 `'0'                                                                        | '1'                                                           | '2'`生效、dev/test 语义、启动即`diagLog` 记录 | 删除该 env 分支，不影响持久化档位 |

**待用户侧唯一动作（可选但高价值）**：V0 启动一次后，用右下角「导出诊断包」发回 zip（含 `chromium-debug.log` 里的 `exit_code`）——这是把「注入秒死」与「驱动 TDR」彻底分开的最后一块证据；本轮代码改动不依赖它。
