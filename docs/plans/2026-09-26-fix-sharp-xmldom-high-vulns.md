# 修复计划：10 项 high 漏洞——sharp 0.35.3→0.35.4 与 @xmldom/xmldom 0.8.13→0.8.15（2026-09-26）

- 日期：2026-09-26
- 状态：已完成（2026-09-26，全部验收标准通过，见第十节）
- 关联文件：`package-lock.json`、`audit-ci.jsonc`（只读不动）、`package.json`（只读不动）、`scripts/__tests__/audit-config.test.ts`（回归守卫）、`.github/workflows/build.yml`（只读不动）
- 关联文档：`docs/troubleshooting-npm-audit-mirror.md`、`docs/plans/2026-09-26-npm-audit-mirror-bypass.md`

## 一、问题与根因

安全审计发现 10 项不在 `audit-ci.jsonc` 豁免清单内的 high 漏洞，均源于 2026-09 新披露的安全公告，与本仓库代码改动无关：

| 包                      | 数量 | 公告                | 性质                                                               | 修复版本                 |
| ----------------------- | ---- | ------------------- | ------------------------------------------------------------------ | ------------------------ |
| `sharp@0.35.3`          | 1    | GHSA-rgj7-g3m4-5g8c | 生产直接依赖，捆绑 libheif 堆溢出（HIGH 7.7）                      | 0.35.4（libheif 1.23.2） |
| `@xmldom/xmldom@0.8.13` | 9    | 多公告              | 构建期传递依赖（electron-builder → plist），dev-only，不入生产产物 | 0.8.15                   |

处理决策：**直接修复而非加入豁免清单**——豁免清单只保留给无修复版本的存量问题；两项均已在 semver 范围内有修复版本（OSV 与官方 registry 已核实）。

暴露面评估：本应用扫描入库白名单（`src/main/utils/media-constants.ts`）与主进程转码白名单（jpg/png/webp）均不含 heic/heif/avif 输入，sharp 实际不会被喂 HEIF 文件，GHSA-rgj7-g3m4-5g8c 实际暴露面≈0；升级属供应链合规动作。

## 二、方案

使用仓库既有命令执行，全部基础设施已就位（`package.json` 第 40-41 行）：

- `npm run audit:fix` = `npm audit fix --registry=https://registry.npmjs.org`（强制官方源；npmmirror 未实现审计端点）
- `npm run audit` = `audit-ci --config ./audit-ci.jsonc`（与 CI Security audit 同配置）

**不修改** `audit-ci.jsonc`（28 项 allowlist 基线由契约测试锁定）、**不修改** `package.json` 依赖声明（修复版本均在既有 semver 范围内）、**不修改** `build.yml`。

## 三、依赖声明

- **无新增依赖；`package.json` 零改动**（验收：`git diff -- package.json` 为空）。
- **`package-lock.json`** 由 `npm run audit:fix` 更新并同步 `node_modules`，预期变更仅限：
  - `sharp` 0.35.3 → 0.35.4（∈ `^0.35.3`）
  - `@img/sharp-win32-x64` 0.35.3 → 0.35.4
  - `@img/sharp-libvips-win32-x64` 1.3.2 → 1.3.3（∈ 根 optionalDependencies `^1.3.2`）
  - `@xmldom/xmldom` 0.8.13 → 0.8.15（∈ plist `^0.8.8`）
  - npm audit fix 可能顺带修复其他 semver 范围内的可修漏洞，属预期收益；出现大版本/越范围变更时停下评估。
- 被修复包的 `resolved` 字段会改写为官方源 URL——`docs/troubleshooting-npm-audit-mirror.md` 已记载的既定行为，可接受（lockfile 本为混源）。
- 兼容边界：sharp 0.35.4 engines 要求 `node >= 20.9.0`（本仓库 `engines` 为 `>=20`；低于 20.9 仅 EBADENGINE warning，不阻塞）；sharp 0.35.4 要求 libvips `>= 8.18.6`（由预编译平台包满足）。

## 四、启动说明（环境与验证命令）

环境要求：Node ≥ 20.9（现有开发环境即可），可访问官方 npm registry。

```bash
npm run audit          # 审计检查（与 CI 同配置；修复前应红、修复后应绿）
npm run audit:fix      # 自动修复（改写 package-lock.json 并同步 node_modules）
npx vitest run scripts/__tests__/audit-config.test.ts   # 审计契约测试
npx vitest run src/main/utils/video-frame.test.ts       # 真机 sharp/libvips 解码金丝雀
npm run test:main      # 主进程测试子集
npm test               # 全量测试
npm run typecheck      # tsc -b
npm run lint           # eslint
```

## 五、实施节点（每步验证通过才进下一步）

- **Node 0（计划落盘 + 红灯基线）**：写入本计划文件；运行 `npm run audit` 记录修复前红灯（退出码 1、10 high）。本任务的"修复前必须失败的测试"即 audit 检查本身——漏洞是依赖版本问题，单元测试无法覆盖；既有单测为防回归守卫（修复前后都必须绿）。
- **Node 1（执行修复）**：`npm run audit:fix`；`git diff --stat package-lock.json` + grep 锁定版本，核对变更仅限预期四包（及 semver 内顺带修复项）。
- **Node 2（审计绿灯 + 契约）**：`npm run audit` 退出码 0；`npx vitest run scripts/__tests__/audit-config.test.ts` 全绿。
- **Node 3（sharp 回归）**：`npx vitest run src/main/utils/video-frame.test.ts`（唯一不 mock sharp 的测试，真机验证 libvips 1.3.3）→ `npm run test:main` 全绿。
- **Node 4（全量回归）**：`npm test` 全绿、`npm run typecheck` 退出码 0、`npm run lint` 无新增错误。
- **Node 5（可选，默认跳过）**：`npm run dist:win` 验证 npmRebuild + asarUnpack 与 pre-dist-check 的 `@img/*.node` 断言（sharp 相关 glob/外部化配置均版本无关，风险低）。

## 六、错误处理与参数校验

错误处理：

- audit:fix 网络失败/官方源不可达：按 `docs/troubleshooting-npm-audit-mirror.md` 处理并重跑（audit-ci 内置 5 次重试；npm audit fix 可直接重跑）。
- lockfile 出现预期外的大版本/越范围变更：`git checkout -- package-lock.json` 回滚后重跑 audit:fix 复核；仍复现则停下向用户报告，不擅自接受。
- video-frame.test.ts 失败：说明 libvips 1.3.3 解码行为变化，停下分析根因，不得弱化、跳过或伪造测试。
- 任何节点失败：就地修复重跑该节点，不进入下一步。

参数校验（本任务无代码入参变更，被校验面即审计契约，由既有契约测试承担）：

- `audit-ci.jsonc`：registry 必须为官方源、`high: true`、allowlist 含 28 项迁移基线（`MIGRATION_BASELINE`）。
- `package.json`：`audit` 脚本必须精确为 `audit-ci --config ./audit-ci.jsonc`；`audit:fix` 必须含 `npm audit fix` 与官方 registry。
- `build.yml`：必须含 `npx audit-ci --config ./audit-ci.jsonc`，且不得再内联 allowlist。

## 七、测试用例矩阵

| 类别 | 用例                                                    | 预期                                 |
| ---- | ------------------------------------------------------- | ------------------------------------ |
| 正常 | `npm run audit`（修复后）                               | 退出码 0                             |
| 正常 | `scripts/__tests__/audit-config.test.ts`                | 全绿（契约未漂移）                   |
| 正常 | `src/main/utils/video-frame.test.ts`（真实 sharp 解码） | 全绿（libvips 1.3.3 行为稳定）       |
| 正常 | `npm test` 全量                                         | 无新增失败项                         |
| 异常 | `npm run audit`（修复前）                               | 退出码 1，10 high（红灯基线）        |
| 异常 | lockfile 预期外大版本变更                               | 拦截并回滚，不放行                   |
| 边界 | 平台包 1.3.3 ∈ `^1.3.2`、xmldom 0.8.15 ∈ `^0.8.8`       | 范围边界成立，package.json 不动      |
| 边界 | lockfile 混源 resolved 改写为官方源                     | 预期行为（troubleshooting 文档记载） |

## 八、验收标准（可判定）

1. Node 0：`npm run audit` 退出码 1，红灯基线记录在案（输出含 sharp / @xmldom/xmldom 的 high 项）。
2. Node 2：`npm run audit` 退出码 0。
3. `git diff -- package.json` 为空；lockfile 中 sharp@0.35.4、@xmldom/xmldom@0.8.15。
4. `npx vitest run scripts/__tests__/audit-config.test.ts` 全绿。
5. `npm run test:main` 全绿，随后 `npm test` 全绿（无新增失败项）。
6. `npm run typecheck` 退出码 0；`npm run lint` 无新增错误。
7. CI 影响：本次不改 build.yml 与 audit-ci.jsonc；push 后 Security audit 步骤应转绿。

## 九、实施结果（2026-09-26 回填）

红灯基线（Node 0）：`npm run audit` 退出码 1，失败公告共 10 条——sharp GHSA-rgj7-g3m4-5g8c 1 条、@xmldom/xmldom 8 条、**js-yaml GHSA-2883-xcg3-v3hh 1 条**（影响 4.0.0–4.3.1，与任务报告"9 项 xmldom"的口径差异在此）。js-yaml 同为 semver 内可修（→4.3.2），一并由 audit:fix 修复。

lockfile 实际变更：70 个包版本变更、**0 个大版本**，除目标包外，audit:fix 顺带在 semver 范围内修复了豁免清单中的可修项（brace-expansion 全系、fast-uri、ip-address、nanoid、undici、glob、tar 7.5.20→7.5.22、browserslist/caniuse-lite 等）——audit-ci 已提示这 15 条公告可从 allowlist 移除，留待后续清理豁免清单时处理。

与预期的偏差（不影响安全目标）：

1. **`@img/sharp-libvips-win32-x64` 保持 1.3.2 未升级**：sharp 0.35.4 的 win32 平台包 `@img/sharp-win32-x64@0.35.4` 自带 libvips DLL（`libvips-cpp-8.18.6.dll`，内含 libheif 1.23.2），运行时实际加载源为该平台包；根 optionalDependencies 钉住的 libvips 包只是加载 shim（headers/lib，无运行时 DLL），保持 1.3.2 无安全影响。已用 `require('sharp').versions` 实测确认运行时为 `sharp 0.35.4 / vips 8.18.6 / heif 1.23.2`（修复版）。
2. **`package.json` 工作区 diff 非空但与本次无关**：其 2 行（`audit`/`audit:fix` 脚本）为上一轮 audit 基建（`2026-09-26-npm-audit-mirror-bypass.md`）的既有未提交内容；本次 `npm audit fix` 未改动 package.json。

验收对照：①红灯基线已记录（退出码 1）②`npm run audit` 退出码 0 ③lockfile sharp@0.35.4、@xmldom/xmldom@0.8.15、js-yaml@4.3.2 ④契约测试 19/19 ⑤test:main 3082/3082、全量 4802/4802 ⑥typecheck 0、lint 0。Node 5（dist:win 打包验证）按计划默认跳过。

## 十、交付物与提交

- 变更文件：`docs/plans/2026-09-26-fix-sharp-xmldom-high-vulns.md`（本文件，新增）、`package-lock.json`（audit fix 更新）；node_modules 本地同步。
- 不执行 git commit（未被要求），变更留在工作区供审查。
