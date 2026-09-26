# 未提交变更审查 → 修复 → 提交 → 打包 实施计划

- 日期：2026-09-26
- 状态：已批准，执行中
- 任务：对工作区全部未提交变更（17 个已跟踪修改 + 11 个新增未跟踪文件）做代码审查，修复审查发现的问题，按主题拆分提交，最后执行 `npm run dist:win` 打包。

## 一、审查结论

变更围绕三个主题：

1. **spawn EFTYPE 加固**（配套计划：`docs/plans/2026-09-25-spawn-eftype-analysis-and-fix.md`）：新增 `hasWindowsExecutableHeader` PE 魔数预检（`src/main/utils/path-safety.ts:79`）+ 新模块 `spawn-error-log.ts` 诊断落盘，接线 `ffmpeg-runner` / `video-probe` / `thumbnail/generator` 三处 error 路径，配套测试齐全。
2. **npm audit 镜像绕过 + 漏洞修复**（配套计划：`2026-09-26-npm-audit-mirror-bypass.md`、`2026-09-26-fix-sharp-xmldom-high-vulns.md`）：28 项 GHSA 豁免清单从 build.yml 内联无损迁移至 `audit-ci.jsonc`，新增 `audit`/`audit:fix` 脚本 + 契约测试；lockfile 切回官方源并升级 sharp 0.35.4、@xmldom/xmldom 0.8.15 等传递依赖。
3. **decryption-worker 构建接线**：`electron.vite.config.ts` entry 与 `scripts/pre-dist-check.ts` 检查项一一对应。

审查未发现语法错误、类型错误、逻辑 bug；发现 4 个需修复的小问题（Fix A–D，见第三节）。

记录不修（有意取舍，留档）：

- `resolveBinaryPath` 的 diagLog 固定打 `'FFMPEG'` tag，ffprobe 场景也会标成 FFMPEG——修复需扩散函数签名，收益低。
- `ffmpeg-paths.test.ts` 的 fs mock 忽略 `readSync` 的 offset/length 参数——当前实现下结果正确。
- `audit-ci.jsonc` 中 2026-09 批次 15 项豁免部分已可随 audit:fix 移除——留待后续专项清理。
- lint 存在 16 项既有基线问题（`.cache/`、`e2e/fullscreen-diagnose.e2e.ts`、`scripts/after-pack-vc-runtime.cjs`），非本次引入。

## 二、依赖声明

- 无新增/变更依赖；`audit-ci@^7.1.0` 在 HEAD 已存在。
- 仅 lockfile 传递依赖升级：sharp 0.35.3→0.35.4（GHSA-rgj7-g3m4-5g8c）、@xmldom/xmldom 0.8.13→0.8.15、tar 7.5.22、js-yaml 4.3.2、nanoid 3.3.19、fast-uri 3.1.8、undici 7.30.0 等；registry 全量 npmmirror → registry.npmjs.org。

## 三、修复清单

| 编号  | 位置                                               | 问题                                                                                                                                     | 修复                                                                                     | 验证方式                          |
| ----- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------- |
| Fix A | `src/main/utils/ffmpeg-paths.ts:49`                | PE 预检无平台门控：Linux/macOS 上 bundled ELF 二进制会被误判为"非 Win32 PE"而永远静默回退系统 PATH（潜在 bug）                           | `if (process.platform === 'win32' && !hasWindowsExecutableHeader(resolved))`，并同步注释 | 新用例红灯→修复→绿灯              |
| Fix B | `src/main/utils/spawn-error-log.ts:25`             | 注释称"判定口径与 early-crash-guard 保持一致"，实际扩展了 ENOENT/EACCES（`early-crash-guard.ts:85` 仅判 EFTYPE），同名函数语义漂移易误导 | 注释改为"在 early-crash-guard（仅 EFTYPE）基础上扩展 ENOENT/EACCES"                      | 注释级，无行为变更                |
| Fix C | `src/main/utils/spawn-error-log.test.ts`           | 缺 EACCES 记录路径与 `{code:'EBUSY'}` 不记录的负例；末例 mockImplementation 有泄漏隐患                                                   | 在末例**前**插入 2 个用例（避免被末例的实现覆盖污染）                                    | 加入即绿（覆盖补充，非 bug 回归） |
| Fix D | `docs/plans/2026-09-26-npm-audit-mirror-bypass.md` | 状态行"实施中"已过时；迁移保真测试实际采用硬编码 MIGRATION_BASELINE 基线而非 git show 提取                                               | 状态行改"已完成"，补一句实施口径说明                                                     | 文档级                            |

## 四、启动说明

- 环境要求：Node ≥20（engines 声明），Windows x64。
- 验证命令：见第五节节点表；如需人工核验应用行为可 `npm run dev`。
- 打包命令：`npm run dist:win`（clean → electron-vite build → 写 commonjs 标记 → pre-dist-check + check-doc-versions → electron-builder NSIS x64 → verify:dist），产物输出 `release/NikkiGallery-Setup-2.5.1.exe`。

## 五、分步节点与验收标准

| 节点 | 内容                                                                                                                                                                               | 验收标准（可判定）                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 0    | 写入本计划文档                                                                                                                                                                     | 文件存在且含依赖声明/启动说明/错误处理/参数校验/基础测试用例五小节    |
| 1    | 基线：`npx vitest run` 跑 7 个相关测试文件（path-safety / ffmpeg-paths / spawn-error-log / ffmpeg-runner / video-probe / thumbnail/generator / audit-config）+ `npm run typecheck` | 全部通过、typecheck exit 0                                            |
| 2    | Fix A：先加测试跑出红灯 → 改代码 → 重跑绿灯                                                                                                                                        | 新用例修复前 fail、修复后 pass                                        |
| 3    | Fix B/C/D                                                                                                                                                                          | spawn-error-log.test.ts 全绿；git diff 仅注释/文档/测试               |
| 4    | 全量回归：`npm test` → `npm run typecheck` → `npm run lint`（对照 16 项既有基线，无新增）→ `npm run format:check` → `npm run i18n:guard` → `npm run audit`                         | 全部通过或仅命中已知基线                                              |
| 5    | 按主题拆分 6 次提交（husky 自动跑 lint-staged + commitlint）                                                                                                                       | 6 次提交均成功，`git status` 干净                                     |
| 6    | `npm run dist:win`                                                                                                                                                                 | exit 0，`release/NikkiGallery-Setup-2.5.1.exe` 生成，verify:dist 通过 |

### 提交拆分

1. `fix(main): ffmpeg/ffprobe 增加 PE 魔数预检与 spawn 错误诊断落盘`
   `src/main/utils/path-safety.{ts,test.ts}`、`ffmpeg-paths.{ts,test.ts}`、`spawn-error-log.{ts,test.ts}`、`ffmpeg-runner.{ts,test.ts}`、`video-probe.{ts,test.ts}`、`src/main/thumbnail/generator.{ts,test.ts}`、`docs/plans/2026-09-25-spawn-eftype-analysis-and-fix.md`、`docs/troubleshooting-spawn-eftype.md`
2. `build(ci): audit 豁免清单迁移至 audit-ci.jsonc 并统一本地与 CI 审计`
   `audit-ci.jsonc`、`.github/workflows/build.yml`、`package.json`、`scripts/__tests__/`、`DEVELOPMENT.md`、`DEVELOPMENT.en.md`、`docs/troubleshooting-npm-audit-mirror.md`、`docs/plans/2026-09-26-npm-audit-mirror-bypass.md`
3. `fix(deps): 升级 sharp 与 xmldom 修复高危漏洞并将 lockfile 切回官方源`
   `package-lock.json`、`docs/plans/2026-09-26-fix-sharp-xmldom-high-vulns.md`
4. `build(main): decryption-worker 接入构建产物与打包前检查`
   `electron.vite.config.ts`、`scripts/pre-dist-check.ts`
5. `chore: 新增 .zcodeignore 排除 ZCode 上下文索引` — `.zcodeignore`
6. `docs(plans): 记录本次变更审查与打包计划` — 本文档

未跟踪文件与已跟踪修改必须同提交：`spawn-error-log.ts` 被 3 处 import（不提交则 TS2307 编译失败）、`audit-ci.jsonc` 被 build.yml 与 `npm run audit` 引用（不提交则 CI 审计步骤失败）、troubleshooting 文档被 DEVELOPMENT 中英文档链接（不提交则文档 404）。

## 六、错误处理

- `maybeLogSpawnError` 全程 try/catch，诊断写盘失败绝不向业务冒泡；`logStartupError`（startup-diagnostic）内部自吞写盘异常。
- 打包 clean 步骤若遇 Safe-Delete 网关失败（DEVELOPMENT.md 7.3 已知问题），按文档分步执行：`npx electron-vite build` → `npm run pre-dist-check` → `npx electron-builder --win --publish never` → `npm run verify:dist`。
- `npm run audit` 需访问 registry.npmjs.org（audit-ci.jsonc 已固定 `--registry` 覆盖用户级镜像配置）；网络受限导致失败时如实报告，不伪造通过。
- 全量测试偶发 flaky：失败先重跑一次定位，不掩盖、不弱化断言。
- lint-staged 会对暂存 md/json 自动 prettier 改写：每次提交后复查 `git status`，出现意外改写则修正后 amend。

## 七、参数校验

- 本次无新增对外 API/IPC 入参。
- `hasWindowsExecutableHeader` 入参边界（空串、不存在、目录、size<2、恰 2 字节 MZ、仅 1 字节、ELF 魔数）已由 path-safety.test.ts 的 9 个用例覆盖。
- `isChildProcessSpawnError`/`maybeLogSpawnError` 入参边界（null/undefined/字符串/普通 Error/带 code 对象）由 spawn-error-log.test.ts 覆盖，本次 Fix C 再补 EACCES 与非 spawn 码两例。

## 八、基础测试用例（正常 / 异常 / 边界）

- **正常**：MZ 二进制采用本地路径且不记日志；Linux 平台（Fix A 后）ELF 二进制正常采用 bundled 路径。
- **异常**：文本占位/0 字节占位回退系统 PATH 并记录 diagLog；EFTYPE spawn 错误在 ffmpeg-runner/video-probe/thumbnail-generator 三处 error 路径落盘 startup-errors.log（stage 前缀 `runtime-spawn-error:`，传原始 err 对象）；EACCES 对象被记录；`{code:'EBUSY'}` 静默跳过。
- **边界**：恰 2 字节 MZ 头视为有效；仅 1 字节无效；非 MZ 头（ELF）在 win32 回退；spawnSync 的 syscall 亦命中判定；audit-ci.jsonc allowlist 与 28 项 MIGRATION_BASELINE 基线对账。
