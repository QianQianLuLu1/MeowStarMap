# 计划：npm audit 在国内镜像源下 404 的分析与修复

- 日期：2026-09-26
- 状态：已完成（2026-09-26 实施回填：迁移保真测试最终采用硬编码 `MIGRATION_BASELINE` 28 项基线替代"git show HEAD 提取"方案——build.yml 提交后该提取方式将失效，测试注释中已说明）
- 关联文件：`audit-ci.jsonc`（新增）、`package.json`、`.github/workflows/build.yml`、`scripts/__tests__/audit-config.test.ts`（新增）、`docs/troubleshooting-npm-audit-mirror.md`（新增）、`DEVELOPMENT.md` / `DEVELOPMENT.en.md`

## 一、问题与根因

在配置了 npmmirror（淘宝镜像）的环境下执行 `npm audit` 报错：

```text
npm warn audit 404 Not Found - POST https://registry.npmmirror.com/-/npm/v1/security/audits/quick
  - [NOT_IMPLEMENTED] /-/npm/v1/security/* not implemented yet
npm error audit endpoint returned an error
```

根因：npmmirror 未实现 npm 官方审计接口 `/-/npm/v1/security/*`。本项目的 npmmirror 源来自**用户级**配置（`DEVELOPMENT.md` 6.1 节教授的 `npm config set registry`），项目根 `.npmrc` 是刻意的"纯注释零配置"（见其文件头注释：镜像一律走环境变量，避免 npm 11 对非标准键告警）。

npm 配置优先级：CLI 参数 > 环境变量 > 项目 `.npmrc` > 用户 `.npmrc` > 全局 > 默认。因此命令级 `--registry` 覆盖是最干净的临时方案，不需要改任何配置文件。

## 二、现状盘点

- `audit-ci@7.1.0` 已在 devDependencies（`package.json:152`），但 scripts 中没有任何 audit 入口。
- CI（`.github/workflows/build.yml` lint-typecheck job）已有两道供应链防线：
  - `dependency-review-action@v4`（仅 PR 事件，`fail-on-severity: high`）；
  - `npx audit-ci --high --allowlist <28 项 GHSA> --registry=https://registry.npmjs.org`（内联 allowlist，带分批注释）。
- `package-lock.json` 为混合源（npmmirror 1181 条 / npmjs.org 394 条）。
- 缺口在**本地日常开发**：本地 `npm audit` 必然 404，且没有与 CI 对齐的审计入口。

## 三、方案

采用 audit-ci 7.1.0 官方推荐的 **JSONC 配置文件**方式（README：_"Prefer to use a JSONC or JSON5 config file … over managing your config with CLI arguments"_；配置键与 CLI 参数一一对应，支持注释、`registry` 键）：

1. 新增根目录 `audit-ci.jsonc`：`high: true`、`registry: https://registry.npmjs.org`、28 项 allowlist 及分批注释（从 build.yml 迁入，作为唯一事实来源）。
2. `package.json` 新增脚本：
   - `audit`：`audit-ci --config ./audit-ci.jsonc`（与 CI 同源同结果）；
   - `audit:fix`：`npm audit fix --registry=https://registry.npmjs.org`。
3. build.yml 审计步骤简化为 `npx audit-ci --config ./audit-ci.jsonc`，长注释迁往 jsonc。
4. 文档：新增 `docs/troubleshooting-npm-audit-mirror.md`；`DEVELOPMENT.md` 6.1 节（中英双语）补提示。

**依赖声明**：无新增依赖、无 lockfile 变更（复用已有 audit-ci ^7.1.0）。

**不把 registry 写入项目 .npmrc 的理由**：① 既有约定"镜像配置不走项目 .npmrc"；② 若固定 npmmirror，海外 CI runner 会被迫走镜像；③ 审计源覆盖收敛到 `audit-ci.jsonc` 一处即可。

## 四、实施步骤（红-绿闭环）

### 节点 1（红灯）：契约测试 `scripts/__tests__/audit-config.test.ts`

输入：仓库根的 `audit-ci.jsonc`、`package.json`、`.github/workflows/build.yml`、`.npmrc`、`git show HEAD:.github/workflows/build.yml`。
输出：Vitest 测试报告。

测试点（正常 / 异常 / 边界）：

- 正常：jsonc 可解析且含 `$schema`/`high`/`registry`/`allowlist`；registry 去尾斜杠后等于官方源；allowlist 无重复、每项匹配 `GHSA(-[A-Z0-9]{4}){3}` 或 npm 包名；`package.json` 的 `audit` 脚本指向 `--config ./audit-ci.jsonc`、`audit:fix` 含官方 registry；build.yml 审计步骤引用 `--config ./audit-ci.jsonc` 且不再内联 GHSA；`.npmrc` 不含 `registry=`（守既有约定）。
- 异常：JSONC 解析器对裸 JSON5（缺引号键）抛错；缺必需键报错并列出缺失键；allowlist 重复项 / 畸形项（小写、段数不足、空串）报错。
- 边界：字符串值内的 `//`、`/* */` 不被当注释剥离（URL 保真）；CRLF / BOM / 尾注释可解析；空 allowlist 数组合法（不误伤未来清零场景）。
- 迁移保真：jsonc 中的 GHSA 集合与 `git show HEAD:.github/workflows/build.yml` 提取的 28 项一致，防迁移丢项。

验收：`npx vitest run scripts/__tests__/audit-config.test.ts` 在修复前**失败**（红灯）。

### 节点 2（转绿）：落实配置

- 新建 `audit-ci.jsonc`（逐项核对 28 个 GHSA id）。
- `package.json` 加 `audit` / `audit:fix` 两个脚本。
- build.yml 审计步骤改为 `npx audit-ci --config ./audit-ci.jsonc`。

验收：同一条命令转绿。

### 节点 3：功能验收

1. 裸 `npm audit` 复现 404（记录现状，确认问题真实存在）。
2. `npm run audit`：经官方源完成审计，期望 exit 0（若 exit 1 且为**新增**未豁免漏洞，停下报告，不擅自加 allowlist）。
3. `npm audit fix --dry-run --registry=https://registry.npmjs.org`：验证修复路径可达且不改动 lockfile（不实际运行 `audit:fix`，避免污染工作树）。

### 节点 4：文档

- `docs/troubleshooting-npm-audit-mirror.md`：现象 / 根因 / 三种本地方案（`npm run audit`、一次性 `--registry`、PowerShell 会话级环境变量）/ `audit:fix` 与 lockfile 混源注意点 / CI 说明 / 为何不写入 `.npmrc`。
- `DEVELOPMENT.md` 6.1 节与 `DEVELOPMENT.en.md` 对应节：切镜像步骤后补"镜像不支持 npm audit，审计请用 `npm run audit`"及文档链接。

### 节点 5：回归

`npm test` 全量、`npm run typecheck`、`npm run lint`、`npm run format:check`——与改动前基线一致、无新增失败。不触碰工作树中 spawn-eftype 相关未提交改动。

## 五、错误处理与参数校验

- 官方源不可达：audit-ci 内置重试（`--retry-count` 默认 5）后失败；**不启用** `--pass-enoaudit`（会掩盖审计失效，静默放行）。
- `audit-ci.jsonc` 畸形：契约测试红灯拦截；audit-ci 运行时也会明确报错。
- `--config ./audit-ci.jsonc` 相对仓库根（`npm run` 固定在根目录执行），无路径漂移。
- `audit fix` 会把被修复包的 `resolved` 写为官方源 URL（lockfile 本已混源）；彻底归一需删 lockfile 重装，写入文档但不在本次执行。

## 六、验收标准（可判定）

1. 修复前 `npx vitest run scripts/__tests__/audit-config.test.ts` 失败，修复后通过。
2. `npm run audit` 在 npmmirror 用户级源环境下成功完成审计（不再 404）。
3. `npm test` / `typecheck` / `lint` / `format:check` 全量无新增失败。
