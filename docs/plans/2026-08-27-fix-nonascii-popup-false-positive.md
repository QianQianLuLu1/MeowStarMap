# 修复「安装路径含特殊字符」弹窗误报（2026-08-27）

## 问题

「安装路径含特殊字符 / Non-ASCII Install Path」弹窗在软件**能正常启动运行**时仍显示。
根因：该弹窗由两处**抢先、非阻塞**警告逻辑触发——只要 `process.execPath` 含任意非 ASCII 字符
（码点 >127，如中文安装目录）即弹窗，与软件是否真能启动无关。现代 Windows 对中文路径通常兼容，
原生模块照常加载、软件正常运行，故形成误报。

正确行为：该弹窗应仅在非 ASCII 路径**真正导致启动/原生模块加载失败**时才出现。

## 依赖声明

| 类型     | 名称                                                                       | 说明                                   |
| -------- | -------------------------------------------------------------------------- | -------------------------------------- |
| 运行时   | Node 内置 `path`/`fs`                                                      | 无新增依赖                             |
| 复用模块 | `src/main/utils/path-safety.ts`（`hasNonAsciiPath`）                       | 非 ASCII 路径判定，逻辑不变            |
| 复用模块 | `src/main/app/native-load-guard.ts`（`nativeLoadErrorBox`/`showErrorBox`） | 失败错误框文案拼装与弹窗，复用不改签名 |
| 测试     | vitest（正常/CI 环境跑）；本机以 `tsc -b` + `eslint` 兜底                  | 验证手段                               |

不引入任何新 npm 依赖；优先复用既有「启动期预检 + 不依赖 i18n 的双语弹窗 + 诊断落盘」模式。

## 启动说明

`app.whenReady()` 回调内依次调用 `verifyCriticalNativeModules()`（`src/main/index.ts:107`）与
`verifyStartupEnvironment()`（`src/main/index.ts:117-122`），接线**无需改动**。行为变化均在子模块内：

- 非 ASCII 安装路径 + 原生模块加载成功 → 不再弹任何「特殊字符」框；
- 非 ASCII 路径 + 原生模块加载失败 → 弹失败框，且内容追加「安装路径含特殊字符可能也是成因」提示；
- 纯英文路径行为完全不变；
- userData 目录不可写（权限不足/杀软拦截）时的阻塞错误框保持不变。

## 错误处理

- 删除抢先警告块后，唯一弹「特殊字符」框的时机 = 原生模块加载抛错 **且** `hasNonAsciiPath(execPath)` 为真，
  错误内容追加一段双语提示（「检测提示：应用安装路径包含特殊字符（非英文字符），这可能也是…」）。
- `userData` 不可写（原 `checkUserDataWritable`）：保留阻塞弹框 + `logStartupError` + 返回 false 终止启动，逻辑不变。
- 任意 `showErrorBox` 调用仍处 try/catch 兜底，弹框异常不阻断启动主流程。

## 参数校验

- `hasNonAsciiPath(p)`：空串返回 false；逐字符码点 >127 判定（实现正确，不修改）。
- `getExecPath` 缺省 `process.execPath`；`getEnv` 缺省 `process.env`；跳过开关仍仅严格 `=== '1'` 生效。
- 仅在 catch 分支内当 `hasNonAsciiPath(getExecPath())` 为真才拼接提示，避免对纯英文路径产生文本污染。

## 基础测试用例

- `native-load-guard.test.ts`：
  1. 非 ASCII 路径（`C:\Users\用户\...\app.exe`）+ 三模块全加载成功 → `showErrorBox` 不被调用、返回 true；
  2. 非 ASCII 路径 + `better-sqlite3` 抛 `The specified module could not be found.` → `showErrorBox` 调用 1 次且 content 含 `特殊字符`/`non-ASCII`；
  3. 纯英文路径 + 模块失败 → 弹框但 content 不含非 ASCII 提示（保留原 VC++ 用例）。
- `startup-environment.test.ts`：
  1. 非 ASCII 路径 + 可写 userData → `showErrorBox` 不被调用、返回 true；
  2. userData 无法创建（父路径为文件，OS 无关模拟）→ 弹「数据目录」框、返回 false；
  3. `NIKKI_SKIP_ENV_GUARD=1` → 不弹框返回 true。

## 各子任务（文件 / 输入输出 / 验收标准）

### A. `src/main/app/native-load-guard.ts`

- 输入：含 198-215 行抢先警告块（`if (hasNonAsciiPath(execPath)) showErrorBox(...)`）。
- 输出：删除该块；在 catch 分支内，按 `hasNonAsciiPath(getExecPath())` 为真把非 ASCII 原因双语段追加进
  `nativeLoadErrorBox` 返回的 content 后再 `showErrorBox`。
- 验收：`tsc -b` 该文件 0 错；`eslint .` 0 错；`vitest` 全绿（含修正+新增用例）。

### B. `src/main/app/startup-environment.ts`

- 输入：含 `checkInstallPathNonAscii`（52-72 行）及其调用（129 行）、`import { hasNonAsciiPath, ensureWritableDir }`（12 行）。
- 输出：删除 `checkInstallPathNonAscii` 函数、调用行与 `hasNonAsciiPath` import；保留 `ensureWritableDir` 与
  `checkUserDataWritable`。（`getExecPath` 接口字段保留以兼容 `index.ts` 接线，仅移除未使用的局部 const。）
- 验收：`tsc -b` 0 错；`eslint .` 0 错；非 ASCII 路径 + 可写 userData 时 `showErrorBox` 不被调用且返回 true。

### C. 同步更新测试

- 文件：`native-load-guard.test.ts`、`startup-environment.test.ts`。
- 输出：按「基础测试用例」重写旧预期、新增 native-load-guard 失败相关用例。
- 验收：`vitest run` 两文件全绿（17 用例）。

### D. 集成验证

- 运行 `npx tsc -b`（改动文件 0 错）、`eslint`（0 错）、`npx vitest run` 两文件（全绿）、
  `npx electron-vite build` → `dist/main` 生成。
- 验收：`dist/main` 内搜索 `Non-ASCII Install Path` 零匹配（编译产物已无抢先弹窗代码）。

## 改动范围纪律

仅改 4 个文件：`native-load-guard.ts` / `startup-environment.ts` 及其测试。不触碰
`ffmpeg-paths.ts`（静默降级无弹窗）、`permission.ts`、`media-repository.ts`、`.github/workflows/build.yml`
（均为与本弹窗无关的既有改动）。
