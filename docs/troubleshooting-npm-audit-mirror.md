# 排错：国内镜像源下 `npm audit` 报 404

## 现象

在配置了 npmmirror（淘宝镜像）作为 npm registry 的环境下执行 `npm audit`（或任何内部调用它的命令）报错：

```text
npm warn audit 404 Not Found - POST https://registry.npmmirror.com/-/npm/v1/security/audits/quick
  - [NOT_IMPLEMENTED] /-/npm/v1/security/* not implemented yet
npm error audit endpoint returned an error
```

## 原因

- npmmirror 等国内镜像**未实现** npm 官方的审计接口 `/-/npm/v1/security/*`，`npm audit` 需要向该端点 POST 依赖树，镜像返回 404。
- 本项目根 `.npmrc` 是刻意的"纯注释零配置"（见其文件头注释），镜像源通常来自**用户级**配置（`npm config set registry`，见 `DEVELOPMENT.md` 6.1），因此该问题在部分开发者机器上出现、CI 上不出现。
- npm 配置优先级：CLI 参数 > 环境变量 > 项目 `.npmrc` > 用户 `.npmrc` > 全局 > 默认。命令级 `--registry` 覆盖无需改动任何配置文件。

## 解决方案

### 方案一（推荐）：使用项目封装的审计命令

```bash
npm run audit
```

等价于 `audit-ci --config ./audit-ci.jsonc`：通过根目录 `audit-ci.jsonc` 固定走官方 registry 完成审计，high/critical 漏洞（豁免清单以外）以非零退出码失败。**CI（`.github/workflows/build.yml` 的 Security audit 步骤）读取的是同一份配置**，本地与 CI 结果一致；豁免清单及分批说明也集中维护在该文件，勿在两处分别维护。

### 方案二：一次性命令级覆盖（只读报告）

```bash
npm audit --registry=https://registry.npmjs.org
```

不改任何配置，仅本次请求走官方端点。注意：裸 `npm audit` 不含豁免清单，存量豁免的漏洞会一并报出，属预期现象。

### 方案三：PowerShell 会话级环境变量覆盖

```powershell
$env:npm_config_registry = "https://registry.npmjs.org"
npm audit
Remove-Item Env:\npm_config_registry   # 用完还原，避免影响后续安装
```

环境变量优先级高于用户/项目 `.npmrc`，仅对当前终端会话生效。

## 相关说明

- **为什么不在项目 `.npmrc` 里固定 registry**：① 既有约定"镜像配置不走项目 `.npmrc`"（npm 11 对非标准键告警，镜像由环境变量承载）；② 若固定 npmmirror，海外 CI runner 会被迫走镜像，拖慢安装；③ 审计源的覆盖已收敛到 `audit-ci.jsonc` 一处。
- **`npm run audit:fix`**（`npm audit fix --registry=https://registry.npmjs.org`）：会按官方源执行修复并**改写 `package-lock.json`**——被修复包的 `resolved` 将写入官方源 URL。本仓库 lockfile 本就是混合源（npmmirror / npmjs.org 混合），混入少量官方 URL 不影响使用；如需彻底归一，删除 `package-lock.json` 后用目标源重装（见 `DEVELOPMENT.md` 6.1 的清理步骤）。
- **官方源不可达时**：audit-ci 内置重试（默认 5 次）后失败，不会静默跳过审计；项目**未启用** `--pass-enoaudit`，以避免审计失效被掩盖。
- **CI 侧**：GitHub runner 直连官方源更快且天然支持审计，无需切镜像；PR 事件另有 `dependency-review-action`（`fail-on-severity: high`）作为第二道防线。
