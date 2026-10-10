# Electron 40 EOL 供应链高危通告治理：专项立案（2026-09-30）

> 本文为 2026-09-30 轮次快照，当前口径以主规约文档为准（生命周期/约定见根 AGENTS.md 与 docs/CODING_CONVENTIONS.md；通道见 docs/IPC_CONTRACT.md）。

- 日期：2026-09-30
- 状态：已立案 / 待排期（本文档仅完成问题核实、决策记录与升级方案立案；升级执行另行排期启动，启动时需按 §3.1 重新核对当期版本态势）

> **后续结论（2026-10-10）**：升级已执行完毕——提交 `fd81fef` 将 electron 升至 41.10.6 并把 Node 引擎下限收敛到 `>=22.12.0`，本立案的「待排期」状态已失效；技术债 DEBT-020 已按升级事实关闭。本文的 40.10.6 基线数据与红灯取证保留为该轮证据。

- 关联文件：`package.json` / `package-lock.json`（electron 40.10.6 精确锁定，本立案不动）、`audit-ci.jsonc`（豁免清单，本立案不动）、`.github/workflows/build.yml`（Security audit 门禁，本立案不动）、`scripts/__tests__/audit-config.test.ts`（allowlist 契约测试，升级落地时同步）
- 关联文档：`docs/plans/2026-09-30-replace-share-icon.md`（§10 S5 首次记录本问题）、`docs/plans/2026-09-26-fix-sharp-xmldom-high-vulns.md`（同类安全治理先例与口径）、`docs/troubleshooting-npm-audit-mirror.md`（registry 约定）

## 一、问题与基线核实

### 1.1 门禁失败事实（红灯基线，2026-09-30 实测）

CI 门禁位于 `.github/workflows/build.yml` 的 `lint-typecheck` job（失败即阻断下游 test / build / 发布）：

```yaml
- name: Security audit (audit-ci, fail on high/critical)
  run: npx audit-ci --config ./audit-ci.jsonc
```

本地 `npm run audit`（与 CI 同配置同 registry）复现：**退出码 1**，失败通告恰为 4 条 electron 新披露 high：

```text
Found vulnerable advisory paths:
GHSA-9qh4-3jw8-366w|electron
GHSA-gr2m-v5gq-v685|electron
GHSA-hq2x-r82h-9wj4|electron
GHSA-j84w-jfhq-vhvj|electron

Failed security audit due to high vulnerabilities.
Vulnerable advisories are:
https://github.com/advisories/GHSA-9qh4-3jw8-366w
https://github.com/advisories/GHSA-gr2m-v5gq-v685
https://github.com/advisories/GHSA-hq2x-r82h-9wj4
https://github.com/advisories/GHSA-j84w-jfhq-vhvj
```

### 1.2 通告全表（共 5 High + 1 Medium）

经 GitHub Advisory API（`affects=electron@40.10.6` 精确查询）与 `npm audit` JSON 输出逐条交叉核实，electron 40.10.6 当前命中的通告全集：

| #   | GHSA                                                                     | CVE             | 标题（npm audit 原文）                                                                     | 级别（CVSS 3.1） | 首个修复版本 | 披露       | 门禁影响                                     |
| --- | ------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------ | ---------------- | ------------ | ---------- | -------------------------------------------- |
| 1   | [GHSA-9qh4-3jw8-366w](https://github.com/advisories/GHSA-9qh4-3jw8-366w) | CVE-2026-102676 | `<webview>` can enable Node.js integration in Web Workers despite embedder restrictions    | High（8.3）      | 41.10.6      | 2026-09-29 | 不在豁免清单 → **触发门禁**                  |
| 2   | [GHSA-gr2m-v5gq-v685](https://github.com/advisories/GHSA-gr2m-v5gq-v685) | CVE-2026-102674 | Windows opened from a sandboxed top-level document do not inherit its sandbox restrictions | High（8.2）      | 41.10.6      | 2026-09-29 | 不在豁免清单 → **触发门禁**                  |
| 3   | [GHSA-hq2x-r82h-9wj4](https://github.com/advisories/GHSA-hq2x-r82h-9wj4) | CVE-2026-102673 | Drops inherited HTML sandbox restrictions for popups opened through OpenURLFromTab         | High（8.2）      | 41.10.4      | 2026-09-29 | 不在豁免清单 → **触发门禁**                  |
| 4   | [GHSA-j84w-jfhq-vhvj](https://github.com/advisories/GHSA-j84w-jfhq-vhvj) | CVE-2026-102675 | File and HTTP protocol handlers allow cross-origin reads without corsEnabled               | High（7.4）      | 41.10.6      | 2026-09-29 | 不在豁免清单 → **触发门禁**                  |
| 5   | [GHSA-9f4c-93c8-jc8g](https://github.com/advisories/GHSA-9f4c-93c8-jc8g) | CVE-2026-70608  | Sandboxed iframe can bypass the allow-popups restriction via the OpenURL navigation path   | High（7.2）      | 41.10.3      | 2026-08-05 | 已在豁免清单（`audit-ci.jsonc` electron 项） |
| 6   | [GHSA-vv43-5jgx-7qv8](https://github.com/advisories/GHSA-vv43-5jgx-7qv8) | CVE-2026-102672 | Local race condition in Squirrel.Mac update installation on macOS                          | Medium（6.7）    | 41.10.5      | 2026-09-29 | 低于 `high: true` 阈值，不阻断               |

> 口径说明：
>
> 1. 此前记录（share-icon 任务 §10 S5）中的"4 条新披露 high"即上表 #1–#4（2026-09-29 批次）；#5 为 2026-08 批次既有豁免项，#6 为 medium。
> 2. `audit-ci.jsonc:14` 注释中 GHSA-9f4c-93c8-jc8g 的"修复需升级 electron >= 43.4.1"为当时记录的修复版本之一，非最小修复版本（41.10.3）；升级落地时以 advisory 数据为准。
> 3. `npm audit` 元数据：全仓 22 项漏洞（15 high / 3 critical / 4 moderate），除 electron 4 条新披露 high 外均已被豁免或低于阈值；audit-ci 另提示 15 条存量豁免项已可移除（2026-09-26 audit:fix 顺带修复，见 §3.3）。

### 1.3 暴露面评估（本应用视角）

- **GHSA-9qh4-3jw8-366w（webview）**：已核实 `src/` 全部源码 0 处使用 `<webview>`，触发前提不成立，实际暴露面 ≈ 0。
- **GHSA-j84w-jfhq-vhvj（自定义协议跨源读取）**：本应用真实使用自定义协议面向渲染层提供本地媒体（`src/main/app/media-protocol.ts` 的 `protocol.handle('media', ...)`、`renderer-protocol.ts` 与 `registerSchemesAsPrivileged`），该通告面**真实相关**，是本批中实际暴露面最高的一条。
- **GHSA-gr2m-v5gq-v685 / GHSA-hq2x-r82h-9wj4 / GHSA-9f4c-93c8-jc8g（沙箱继承）**：触发前提为渲染层从沙箱内容打开新窗口/弹窗；本应用为单用户本地桌面相册，渲染内容为受控前端 + 本地照片库，暴露面有限但非零。
- **GHSA-vv43-5jgx-7qv8（Squirrel.Mac）**：本应用目标平台为 Windows x64（NSIS），不使用 Squirrel.Mac 自动更新，暴露面 ≈ 0（且 medium 本就不阻断）。

总体定级：**真实风险 + 供应链合规双重驱动，应升级；无需紧急热修**。与 2026-09-26 sharp 治理"升级属供应链合规动作"的口径一致，且本批多一条真实协议面风险。

### 1.4 历史基线核实（非当前任务引入）

- `git status`：`package.json` / `package-lock.json` / `audit-ci.jsonc` 相对 HEAD 零改动（2026-09-30 share-icon 任务与本立案两次核实一致）；
- `package.json` 声明版本与 lock 解析版本一致（`electron@40.10.6` 精确 pin）；
- 结论：漏洞暴露为依赖声明改动前即存在的历史基线状态；修复责任属独立专项，不计入任何当前任务。

### 1.5 无 40.x 回移，必须跨大版本

- 40.x 分支已 EOL（2026-07-01 起停止支持），40.10.6 即该分支**终版**；上述通告的修复版本列表均无 40.x 补丁（40.x 最后一次安全回移为 2026-07-27 批次的 40.9.2 / 40.9.3）；
- 因此不存在"40.x 内升 patch"的低风险路径，修复必然是跨大版本升级（`npm audit` 自身结论一致：`fixAvailable: electron 44.5.1, isSemVerMajor: true`）。

## 二、决策记录（2026-09-30）

1. **不将新增通告加入豁免清单**：豁免清单只保留给无修复版本的存量问题（沿用 2026-09-26 sharp/xmldom 治理确立的口径）。本批通告存在明确修复版本，仅因需大版本升级而暂未执行；以豁免绕过等于弱化安全门禁，不做。
2. **如实记录、独立专项排期**：本文档即立案与排期载体（同时登记入 `docs/技术债清单.md` §9 保持债务可见性）；升级执行另行启动。
3. **知情接受的门禁影响**：升级完成前，push main / PR 的 Security audit 步骤持续红灯并阻断下游；PR 上的 `actions/dependency-review-action@v4`（`fail-on-severity: high`）亦会拦截依赖变更。此为门禁如实反映真实风险，属预期行为而非误报，不以任何配置手段消除。

## 三、升级方案概要（供专项启动时执行，非本立案范围）

### 3.1 版本目标（2026-09-30 口径，启动时须重新核对）

| 目标             | 版本    | 支持状态（2026-09-30）                                                 | 评价                                                |
| ---------------- | ------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| 理论最小清除版本 | 41.10.6 | 41.x 已 EOL（2026-08-24）                                              | 一次清除全部 6 条通告，但落入无补丁分支，不推荐停留 |
| **推荐**         | 44.5.1  | 当前最新稳定大版本（44.0.0 发布于 2026-08-25，Chromium 152 / Node 24） | 首选；与 `npm audit` fixAvailable 结论一致          |
| 备选             | 43.7.6  | 支持中（EOL 2027-01-05）                                               | 若 44.x 出现阻塞性 breaking change 的退路           |

### 3.2 风险清单（升级前逐项评估）

- **原生模块 ABI**：`better-sqlite3`（数据库）、`sharp`（缩略图/图片处理）、`koffi` + `nuan5_decryption.dll`（解密 worker）——大版本升级后需重新编译/校验预编译产物；koffi 链路还涉及 `dist:win` 打包断言（npmRebuild / asarUnpack / pre-dist-check 的 `*.node` 检查）。
- **Electron 大版本 breaking changes**：重点回归 `src/main/preload/` 的 `exposeIfTrusted` origin 门禁与 `contextBridge` 语义、`protocol.handle` 自定义协议注册（通告 #4 即该面，升级后应复验 `media://` 行为）、webPreferences/沙箱默认值变化。
- **生态兼容**：`electron-builder`（NSIS win x64 目标）、`electron-updater`、`pluggable-electron` 与新 Electron 的兼容性，必要时同步升级。
- **运行时差异**：Node 24 / Chromium 152 行为差异对扫描 utilityProcess worker、ffmpeg 视频链路的影响。

### 3.3 验证清单（升级执行时）

1. `npm run audit` 退出码 0；
2. `scripts/__tests__/audit-config.test.ts` 契约测试同步：allowlist 应**收敛**——至少移除 electron 豁免项 GHSA-9f4c-93c8-jc8g（28 项基线相应下调）；audit-ci 已提示可移除的 15 条存量豁免（2026-09-26 audit:fix 顺带修复）可一并清理；
3. `npm run typecheck` / `npm run lint` / `npm test` 全量回归；
4. `npm run dist:win` 打包验证 + `npm run e2e:smoke`；
5. 手工冒烟：解密入库（koffi + dll 链路）、缩略图生成、视频编辑、分享（含剪贴板 Ctrl+V 文件粘贴路径）、自动更新检查、`media://` 协议加载。

## 四、验收标准（专项启动时判定）

1. `npm run audit` 退出码 0，且豁免清单条目数 ≤ 现有 28 项（只减不增）；
2. `package-lock.json` 中 electron 版本 ≥ 选定目标；`package.json` / `package-lock.json` 的依赖面变更经评审，且为本次专项唯一依赖面改动；
3. 全量测试、typecheck、lint、audit 契约测试、打包与 e2e 冒烟全部通过；
4. 本文档回填执行结果（沿用仓库 plan 文档回填惯例），并同步更新 `docs/技术债清单.md` §9 状态。

## 五、参考来源

- 影响全集精确查询：<https://api.github.com/advisories?affects=electron@40.10.6>
- 各通告详情：<https://github.com/advisories/GHSA-9qh4-3jw8-366w>、<https://github.com/advisories/GHSA-gr2m-v5gq-v685>、<https://github.com/advisories/GHSA-hq2x-r82h-9wj4>、<https://github.com/advisories/GHSA-j84w-jfhq-vhvj>、<https://github.com/advisories/GHSA-9f4c-93c8-jc8g>、<https://github.com/advisories/GHSA-vv43-5jgx-7qv8>
- 版本态势：<https://releases.electronjs.org/>、<https://endoflife.date/electron>、<https://www.electronjs.org/blog/>
