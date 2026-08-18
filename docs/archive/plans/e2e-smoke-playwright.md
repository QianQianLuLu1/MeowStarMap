# E2E 冒烟测试计划：用 Playwright 对打包产物做运行时冒烟（e2e-smoke-playwright）

> 状态：**待审阅**（仅调研与方案文档，未新增任何代码文件）
> 目标读者：维护者 / 发布者
> 关联现状：`scripts/pre-dist-check.ts` + `npm run verify:dist` 只做**静态**产物校验（文件时序、asar 内容标记），
> 无法发现打包后**运行时**问题：白屏、启动崩溃、preload 未注入、原生模块（better-sqlite3 / sharp / koffi）加载失败、
> app:// 协议路径回退错误等。本方案补齐这一层。

---

## 0. 调研结论摘要（基于当前代码事实）

| 调研点          | 现状事实                                                                                                                                                                       | 对冒烟方案的影响                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 构建链          | `.github/workflows/build.yml` 的 `build` job：`npm run dist:win`（= build + pre-dist-check + electron-builder + verify:dist），产出 `release/*.exe` 与 `release/win-unpacked/` | 冒烟插入点：electron-builder 之后、upload-artifact 之前                                             |
| 产物 exe        | `build.productName = "无限暖暖相册管理工具"`，未显式配置 `executableName`，unpacked exe 名跟随 productName（含中文）                                                           | 测试脚本需按 glob `release/win-unpacked/*.exe` 定位 exe，不能硬编码                                 |
| 渲染入口        | 生产分支走 `app://renderer/index.html`（`src/main/app/renderer-protocol.ts` 注册的特权协议，映射到 `dist/renderer`）                                                           | 断言页面 URL 前缀为 `app://renderer/`；协议失效是历史白屏根因之一，须覆盖                           |
| preload 暴露    | `src/main/preload.ts` 通过 `contextBridge.exposeInMainWorld` 暴露 `electronAPI`、`IpcError`、`pluginAPI`、`pluggableElectronIpc`（只读 facade）                                | 冒烟断言这四个全局对象存在且关键命名空间可用                                                        |
| 白屏自检        | `window-manager.ts`：打包分支下渲染进程 8s 内未上报 `renderer:ready` 会打开 DevTools 并弹原生诊断对话框                                                                        | 冒烟必须在 8s 内完成就绪断言；原生对话框无法被 Playwright 自动关闭，属风险项（见 §5/§7）            |
| 就绪信号        | `src/renderer/main.tsx` 挂载完成后调用 `window.electronAPI?.reportReady?.()`（即 `renderer:ready` IPC）                                                                        | 可把「`#root` 非空」作为等价就绪判据，无需额外改码                                                  |
| DB 探针         | `electronAPI.app.getVersion()` → `app:getVersion`（只读、无副作用）；`electronAPI.uiTheme.get()` / `settings.get` 走 SQLite `app_settings` 表                                  | 前者验证 IPC 链路，后者验证 better-sqlite3 原生模块真实可加载（比前者更强）                         |
| 原生模块        | better-sqlite3、sharp、koffi + `resources/nuan5_decryption.dll` 均走 `asarUnpack`                                                                                              | DB 探针（uiTheme.get）即可覆盖 better-sqlite3；sharp/koffi 的深度验证放人工冒烟（需要真实图片文件） |
| Playwright 支持 | Playwright 官方提供 `_electron.launch({ executablePath })`，直接使用产物自带 Electron，**无需下载浏览器二进制**                                                                | CI 上零额外下载，集成成本低                                                                         |

---

## 1. 技术方案：Playwright + `_electron.launch` 冒烟打包产物

### 1.1 启动方式（Windows CI / 本地一致）

```ts
// e2e/smoke.e2e.ts（示意，本计划不落地代码）
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { glob } from 'tinyglobby' // 项目已有依赖

async function launchApp(): Promise<ElectronApplication> {
  // exe 名跟随 productName（含中文），用 glob 定位而非硬编码
  const [exe] = await glob(['release/win-unpacked/*.exe'], { absolute: true })
  if (!exe) throw new Error('未找到 release/win-unpacked/*.exe，请先 npm run dist:win')

  return electron.launch({
    executablePath: exe,
    // 隔离 userData，避免 CI 残留/本机数据污染测试；也验证首次启动的 DB 建库迁移路径
    args: ['--user-data-dir', path.join(os.tmpdir(), `e2e-smoke-${Date.now()}`)],
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 30_000
  })
}
```

要点：

- 打包产物 exe 自带 `app.asar`，`_electron.launch` 只需 `executablePath`，Playwright 会自动挂上远程调试管道。
- GitHub Actions `windows-latest` 运行器具图形会话，Electron GUI 可直接启动（Playwright 官方 Electron 测试指南同款做法）；**不需要** `npx playwright install` 下载浏览器。
- `--user-data-dir` 指向临时目录：每次冒烟都是「全新用户」，天然覆盖**首启建库 + 迁移**路径（历史回归高发点），同时不污染发布者的本机数据。

### 1.2 四大核心断言

```ts
const app = await launchApp()
const win: Page = await app.firstWindow() // ① 主窗口创建成功

await win.waitForLoadState('domcontentloaded')
expect(win.url()).toMatch(/^app:\/\/renderer\//) // app:// 协议加载成功（路径回退回归点）

// ② 非白屏：#root 有真实渲染内容（等价于 renderer:ready 上报条件）
await win.waitForFunction(
  () => {
    const root = document.getElementById('root')
    return !!root && root.childElementCount > 0 && root.querySelectorAll('*').length > 10
  },
  undefined,
  { timeout: 15_000 }
)

// ③ preload 加载成功：contextBridge 四个全局对象齐备
const preloadOk = await win.evaluate(() => ({
  api: typeof window.electronAPI === 'object' && window.electronAPI !== null,
  ipcError: typeof window.IpcError === 'function',
  pluginAPI: typeof window.pluginAPI === 'object',
  namespaces:
    !!window.electronAPI?.scanner &&
    !!window.electronAPI?.media &&
    !!window.electronAPI?.app &&
    !!window.electronAPI?.settings &&
    !!window.electronAPI?.plugin
}))
expect(preloadOk).toEqual({ api: true, ipcError: true, pluginAPI: true, namespaces: true })

// ④ DB / IPC 探针（只读、无副作用）
const version = await win.evaluate(() => window.electronAPI.app.getVersion())
expect(version).toBe(expectedVersion) // 读 package.json version 比对

// 更强探针：uiTheme.get 实际查询 SQLite app_settings 表 → 证明 better-sqlite3 原生模块已正确加载
const theme = await win.evaluate(() => window.electronAPI.uiTheme.get())
expect(['default', 'soft-pink-luxury']).toContain(theme.theme)

// ⑤ 进程不立即崩溃退出：静置 N 秒后仍存活且渲染进程可响应
const proc = app.process()
expect(proc.exitCode).toBeNull()
await new Promise((r) => setTimeout(r, 5_000))
expect(proc.exitCode).toBeNull()
expect(await win.evaluate(() => 1)).toBe(1)

await app.close() // afterAll / afterEach 兜底，防 CI 挂起
```

补充说明：

- 「非白屏」用三层判据：URL 协议正确 → DOM 挂载非空（元素数量阈值）→ 可选截图人工/像素比对。`window-manager.ts` 的 8s 诊断定时器与这里的 15s 断言互不冲突——冒烟若失败会在诊断弹窗之前先由测试框架报失败（风险见 §5）。
- 可选增强（P2）：收集 `win.on('console', ...)` 与 `win.on('pageerror', ...)`，测试结束断言**无 error 级别**日志（配 allowlist），把「窗口出来了但内部报错」也拦下来。

---

## 2. 冒烟用例清单（最小集）

优先级覆盖四个历史回归点：**白屏、路径回退、preload、原生模块**。

| #             | 用例              | 断言要点                                                                                      | 覆盖回归点                                  |
| ------------- | ----------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------- |
| S1            | 启动与主窗口      | `firstWindow()` 可获取；URL 前缀 `app://renderer/`；`domcontentloaded` 达成                   | 路径回退 / app:// 协议失效                  |
| S2            | 非白屏            | `#root` 子元素数量 > 阈值（15s 内）；失败时自动截图                                           | 白屏（P0 历史问题）                         |
| S3            | preload 注入      | `electronAPI` / `IpcError` / `pluginAPI` 存在；scanner/media/app/settings/plugin 命名空间齐备 | preload 丢失 / contextBridge 失败           |
| S4            | 主进程 IPC 探针   | `app.getVersion()` 返回且等于 `package.json` 版本                                             | IPC 注册链路断裂                            |
| S5            | DB / 原生模块探针 | `uiTheme.get()` 返回合法 theme（真实查询 `app_settings` 表）                                  | better-sqlite3 未 rebuild / asarUnpack 失效 |
| S6            | 启动稳定性        | 静置 5s 后进程未退出、渲染进程可 evaluate                                                     | 启动即崩溃（原生模块 require 抛错等）       |
| S7（P2 可选） | 无控制台错误      | 收集 console error / pageerror，排除 allowlist 后应为空                                       | 隐性运行时错误                              |

> 刻意不放进自动化最小集：扫描、缩略图生成、解密、视频编辑——这些依赖真实游戏图片/视频样本，
> 放入人工冒烟清单（§6）。后续若提供 fixture 样本目录可扩展为 P2 自动化用例。

---

## 3. 依赖与脚本

### 3.1 新增 devDependency

| 包                 | 版本建议            | 说明                                                                                                                           |
| ------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `@playwright/test` | 最新稳定版（^1.5x） | 自带 `playwright-core`；`_electron` 从 `playwright` 导入。**无需 `playwright install`**（使用产物自带 Electron，无浏览器下载） |

不新增其他运行时依赖。`tinyglobby` 已有，用于定位 exe。

### 3.2 新增文件（实施阶段才创建）

```
e2e/
  playwright.config.ts   # testDir=e2e，testMatch=*.e2e.ts，timeout/retries/reporter
  smoke.e2e.ts           # S1~S6 用例
  helpers.ts             # launchApp / glob exe / 截图采集
```

> 命名用 `*.e2e.ts` 而非 `*.test.ts`：vitest 默认 include 为 `**/*.{test,spec}.*`，天然不会误跑 e2e；
> eslint / `tsc -b` 是否吞掉 `e2e/` 需实施时验证（必要时在 tsconfig exclude 或 eslint ignores 中处理）。

### 3.3 package.json 新增 script

```jsonc
{
  "scripts": {
    // 前置要求：release/win-unpacked 已存在（本地先 npm run dist:win；CI 由 build 步骤产出）
    "e2e:smoke": "playwright test --config e2e/playwright.config.ts",
    "dist:win:smoke": "npm run dist:win && npm run e2e:smoke" // 本地一键：打包+冒烟
  }
}
```

### 3.4 运行命令

| 场景                   | 命令                                                |
| ---------------------- | --------------------------------------------------- |
| 本地完整验证           | `npm run dist:win:smoke`                            |
| 本地仅冒烟（已有产物） | `npm run e2e:smoke`                                 |
| CI                     | 见 §4（`npm run e2e:smoke`，失败自动采集截图/日志） |

---

## 4. CI 集成方式（build.yml）

**原则：在 `build` job 内、electron-builder 产出 unpacked 之后、upload-artifact 之前运行。**
理由：`win-unpacked` 目前不是 artifact；拆独立 job 需先把数百 MB 的 unpacked 目录上传再下载，成本不成比例。

### 4.1 推荐结构：build job 内插入一个 step（最小改动）

```yaml
build:
  name: Build & Release (Windows x64 NSIS)
  runs-on: windows-latest
  needs: [lint-typecheck, test]
  timeout-minutes: 40 # 显式护栏，防止冒烟/打包挂起
  steps:
    # ... checkout / setup-node / npm ci / electron-rebuild / 构建步骤保持不变 ...

    # ↓ 新增：冒烟（插在两个构建步骤之后、Upload installer artifact 之前）
    - name: E2E smoke test on win-unpacked
      run: npm run e2e:smoke

    # ↓ 新增：失败现场采集（截图 + 主进程诊断日志），仅在冒烟失败时上传
    - name: Upload smoke failure artifacts
      if: failure()
      uses: actions/upload-artifact@v4
      with:
        name: e2e-smoke-failure
        path: |
          e2e/test-results/**
          test-results/**
        if-no-files-found: ignore
        retention-days: 7

    - name: Upload installer artifact
      # ... 现有步骤不变 ...
```

说明：

- Playwright 失败截图默认落在 `test-results/`（由 `playwright.config.ts` 的 `use.screenshot: 'only-on-failure'` 控制）。
- 主进程 `diag.log` 位于 `--user-data-dir` 临时目录，helpers 在 afterAll 中把它拷进 `test-results/` 一并上传（实施点）。
- `tag` 发布分支与 PR 分支**都跑**冒烟：两个构建步骤（`Build & publish` / `Build only`）之后都要能到达冒烟 step（用 `if: always() && steps...` 或将构建步骤合并输出，实施时注意条件表达式）。

### 4.2 备选结构（若日后想拆 job）

```yaml
e2e-smoke:
  needs: [build]
  runs-on: windows-latest
  timeout-minutes: 20
  steps:
    # 需要 build job 先把 release/win-unpacked 作为 artifact 上传（新增 upload 步骤）
    - uses: actions/download-artifact@v4 # 下载 win-unpacked
    - run: npm ci # 仅为 @playwright/test
    - run: npm run e2e:smoke
```

缺点：unpacked 体积大（含 ffmpeg/sharp 二进制），上传下载耗时明显；**现阶段不推荐**，仅当 build job 时长成为瓶颈时再考虑。

---

## 5. 超时与失败处理（防 CI 挂起）

| 层级            | 措施                                                                                                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Playwright 全局 | `playwright.config.ts`：`timeout: 60_000`（单用例）、`expect.timeout: 15_000`、`retries: 1`（仅 CI）、`fullyParallel: false`（单实例串行，避免多开 Electron 抢 userData）                                                                                                       |
| 启动            | `electron.launch({ timeout: 30_000 })`；exe 无法启动时快速失败                                                                                                                                                                                                                  |
| 用例内          | 所有 `waitForFunction/waitForLoadState` 显式带 timeout；静置稳定性检查用固定 5s sleep 而非轮询等待                                                                                                                                                                              |
| 进程兜底        | `afterEach`/`afterAll` 无条件 `await app.close()`（try/catch 包裹）；close 失败时 `app.process().kill()`                                                                                                                                                                        |
| Job 级          | build job 加 `timeout-minutes: 40`（与 test job 的 15 分钟同理：护栏兜底）                                                                                                                                                                                                      |
| 失败现场        | `screenshot: 'only-on-failure'` + `video: 'retain-on-failure'`（可选）；helpers 采集 `--user-data-dir` 下 `diag.log` / `logs/` 到 `test-results/`；失败 artifact 保留 7 天                                                                                                      |
| 8s 诊断对话框   | `window-manager.ts` 的白屏诊断会弹**原生** `dialog.showMessageBox`（Playwright 无法自动点掉）。缓解：冒烟断言在 15s 内失败即终止并 close；若对话框先弹出导致 close 卡住，用 `process().kill()` 兜底。P2 可考虑给主进程加 `E2E_SMOKE=1` 环境变量跳过诊断弹窗（需改码，另行评审） |
| 自动更新        | 启动时 electron-updater 可能联网检查更新（非阻塞）。风险：网络异常仅记录日志不影响启动，暂不处理；若实测产生干扰，再评估注入禁用开关                                                                                                                                            |

---

## 6. 人工冒烟清单（发布者本地双击 exe 逐项勾选）

适用时机：每次发布前，对 `release/win-unpacked/*.exe`（或安装后的 exe）**全新环境**（或全新 userData）执行。

```
发布版本：__________    测试机：__________    日期：__________

【启动】
[ ] 双击 exe 后 10s 内窗口出现，无白屏、无错误弹窗
[ ] 首次启动自动建库完成，首页/引导页正常渲染
[ ] 主题显示正常（默认简约 / 柔粉轻奢切换一次）

【扫描】
[ ] 选择包含游戏照片的目录，扫描进度条正常推进并可取消
[ ] 扫描完成后照片入库，数量与目录实际一致
[ ] 中断后再启动，出现"上次扫描未完成"提示（半可见性）

【缩略图】
[ ] 图库缩略图正常生成显示（低清→高清档位）
[ ] 大量图片滚动时无明显卡顿/黑图

【解密 / 游戏数据】
[ ] 游戏参数文件（.data 类）能被识别并解码预览
[ ] 染色分享码 / 家园建造分享码解码各验证一条

【搜索】
[ ] 文件名关键字搜索有结果返回
[ ] 分类 / 套装 / 场景筛选可用

【插件】
[ ] 插件页能列出示例插件（plugins-samples 安装后）
[ ] 启停插件一次，界面扩展点生效/消失

【编辑与导出】
[ ] 编辑器打开一张图，套一个滤镜并保存（备份生成）
[ ] 水印应用一次；导出到目标目录成功

【数据完整性】
[ ] 回收站软删除→恢复 一次
[ ] 数据库备份→恢复 一次
[ ] 重启应用，以上数据仍在

【异常兜底】
[ ] 打开一个不含任何图片的空目录扫描，无崩溃
[ ] 任务管理器确认退出后无残留进程
```

---

## 7. 分步实施清单与风险

### 7.1 实施步骤（审阅通过后按序执行）

1. **依赖与脚手架**：`npm i -D @playwright/test`；新建 `e2e/`（config + helpers + smoke.e2e.ts）。
2. **用例实现**：落地 S1~S6（§2），全部通过本地 `npm run dist:win:smoke`。
3. **脚本接线**：package.json 增加 `e2e:smoke` / `dist:win:smoke`；确认 vitest / eslint / `tsc -b` 不误伤 `e2e/`。
4. **失败现场采集**：helpers 实现截图落盘 + `diag.log` 归集到 `test-results/`。
5. **CI 接入**：按 §4.1 修改 `build.yml`（冒烟 step + 失败 artifact + timeout-minutes）。
6. **验证 CI**：先在一个 PR 上观察一轮完整流水线；人为制造一次白屏（临时改坏 renderer 入口）验证冒烟确实红、失败 artifact 可下载。
7. **文档同步**：`DEVELOPMENT.md` 增补冒烟命令；发布流程文档引用 §6 人工清单。
8. **（P2，另行评审）**：控制台错误断言（S7）、`E2E_SMOKE=1` 跳过诊断弹窗、fixture 样本驱动的扫描/解密自动化用例。

### 7.2 风险与缓解

| 风险                                            | 等级 | 缓解                                                                                                                       |
| ----------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------- |
| CI runner GUI 会话限制导致 Electron 启动异常    | 中   | Playwright Electron 在 windows-latest 属常见实践；先跑一轮验证，异常则降级为仅本地冒烟 + issue 跟踪                        |
| exe 名含中文，PowerShell / glob 处理路径出错    | 低   | 统一用 glob 结果传绝对路径给 `executablePath`，不手拼字符串；用例中打印解析到的路径便于排障                                |
| 8s 白屏诊断原生对话框阻塞 close                 | 中   | afterEach `process().kill()` 兜底；P2 加环境变量开关跳过诊断                                                               |
| `app:getVersion` 断言随版本号变化失效           | 低   | 版本期望值运行时读 `package.json`，不硬编码                                                                                |
| 冒烟依赖 `--user-data-dir` 参数语义变化         | 低   | 该参数为 Chromium 稳定开关；helpers 中断言 userData 实际落在临时目录（`app.evaluate(({app}) => app.getPath('userData'))`） |
| 冒烟拉长 build job 时长                         | 低   | 最小集预计 < 2 分钟；`retries: 1` 控制最坏情况                                                                             |
| sharp / koffi（解密 DLL）加载失败自动化覆盖不足 | 中   | DB 探针覆盖 better-sqlite3；sharp/koffi 依赖真实样本，暂由 §6 人工清单兜底，P2 引入 fixture                                |
| 自动更新检查在 CI 产生噪音                      | 低   | 非阻塞行为；实测若有干扰再注入禁用开关                                                                                     |

---

## 附：待确认事项（执行前需审阅者拍板）

1. CI 集成采用 §4.1（build job 内 step，**推荐**）还是 §4.2（独立 job）？
2. 是否接受冒烟仅在 windows-latest 运行（当前 CI 全部为 windows，无矩阵扩展需求）？
3. `e2e/` 目录命名与 `*.e2e.ts` 约定是否 OK（避免与 vitest `*.test.ts` 冲突）？
4. tag 发布分支是否同样强制冒烟通过才允许发布（**建议：是**）？
