# 修复 WiFi 局域网分享无法使用（fix-wifi-lan-share）

## 0. 问题概述

在「图库」板块选中一张或多张图片后，底部批量操作栏（BatchActions）出现「WiFi 局域网分享」按钮。点击后弹出 `WifiShareDialog`，自动启动局域网 HTTP 服务，展示访问地址、6 位 PIN、文件数、倒计时与复制按钮；手机浏览器打开地址并输入 PIN 即可下载。

**现象**：点击按钮后弹窗始终提示「启动失败 / startFailed」，分享功能不可用。

## 1. 根因分析

`WifiShareDialog.startShare`（第 57 行）用 `if (res.success && res.url)` 判断启动是否成功。但 preload 的 `call()`（`src/main/preload/ipc.ts`）成功时返回的是解包后的 `res.data`，即 `{ url, port, pin, fileCount, timeoutMs }`，`success` 字段已被剥离。因此运行时 `res.success` 永远为 `undefined`，判断恒假 → 永远走失败分支弹出错误，而服务端其实已正常启动。

佐证：

- 主进程 `share:startWifi` handler（`src/main/ipc/handlers/share.ts:113-128`）经 `wrapHandler` 返回 `{ success: true, data: { url, port, pin, fileCount, timeoutMs } }`。
- preload `call<T>` 成功时 `return res.data`（`src/main/preload/ipc.ts`），渲染层拿到的是 `data` 本身，不含 `success`。
- 既有 `WifiShareDialog.test.tsx` 直接注入 fake `electronAPI.share.startWifi` 返回 `{ success: true, ... }`，绕过了真实 preload 解包，是「假绿」，掩盖了该缺陷。

类型层也存在两处与真实契约不符的声明：

- `src/renderer/vite-env.d.ts:803-812`：`startWifi` 返回含不存在的 `success` 且把必填字段标成可选；`stopWifi` 标为 `{ success, message? }`（实际是 `{ stopped }`）。
- `src/shared/types/ipc.ts:83-90`：`ShareStartWifiResult` 为陈旧重复定义 `{ success, session, error }`（handler 实际从 `electron-api.ts` 引入正确定义 `{ url, port, pin, fileCount, timeoutMs }`）。

## 2. 修复范围（仅聚焦 WiFi 分享）

| 文件                                                      | 改动                                                                                                                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/components/common/WifiShareDialog.tsx`      | 第 57 行判断 `res.success && res.url` → `res?.url`；失败统一由 `catch(IpcError)` 处理；其余逻辑（倒计时 / 复制 / PIN 展示 / stop）不变                                     |
| `src/renderer/vite-env.d.ts`                              | 第 803-812 行 `startWifi` 返回类型改为 `{ url: string; port: number; pin: string; fileCount: number; timeoutMs: number }`；`stopWifi` 改为 `Promise<{ stopped: boolean }>` |
| `src/shared/types/ipc.ts`                                 | 第 83-90 行 `ShareStartWifiResult` 对齐为 `{ url, port, pin, fileCount, timeoutMs }`（与 `electron-api.ts:284` 一致，类型级无运行时副作用）                                |
| `src/renderer/components/common/WifiShareDialog.test.tsx` | `startWifi` mock 改为返回真实契约（去 `success`）；「启动失败」用例改为 `reject` 触发并断言 `share.wifi.startFailed`；保留成功渲染/复制/stop 复位断言                      |
| `src/main/ipc/handlers/share.test.ts`                     | 参照（已覆盖契约，不改动，保持通过）                                                                                                                                       |

**不改动**：`wrapHandler`、`preload.call`、`share-wifi-service`、`share-clipboard-service`、扫描/解密/数据库等无关逻辑。

## 3. 依赖声明

- `network-address@^1.1.2`（已在 `package.json:113` 声明且 `node_modules` 已安装）：仅用于获取局域网网卡 IP（`getLanIp`）。**不新增任何依赖**。
- 服务端：`Node` 内置 `http` 模块自建，零额外库。
- 二维码：采用「大字号访问地址 + 复制按钮 + 引导文案」替代，WifiShareDialog 注释明确「不引入二维码库」。
- 测试：`vitest@1.6.1` + `jsdom`（项目既有 devDependencies）。

## 4. 启动说明

- 开发态：`npm run dev`（electron-vite）启动应用 →「图库」选中图片 → 底部任务栏点「WiFi 局域网分享」→ 自动 `startWifi` → 展示访问地址 + PIN + 倒计时 + 复制按钮。
- 手机端：同一局域网浏览器打开地址，输入桌面端显示的 PIN，即可下载原图/视频。
- 纯逻辑验证：直接运行 Vitest（见第 7 节），无需启动 GUI。
- 构建/打包说明（与本项目既有流程一致，本次不打包）：`npx electron-vite build` + 写 `dist/main/package.json {"type":"commonjs"}` + `npx electron-builder --win --publish never`。

## 5. 错误处理

- 主进程 `wrapHandler` 统一包装：`{ success: true, data }` 或 `{ success: false, error: { code, message } }`。
- preload `call()` 在 `success:false` 时抛 `IpcError`（含 `code` + `message`）。
- 渲染层 `WifiShareDialog.startShare` 的 `catch`：`formatIpcError(err)` 映射 i18n 文案（缺失回退原文）后 `showMessage(error, 'error')`。
- 服务端失败路径：`collectFiles` 过滤不可读/非文件，空则抛 `noFilesToShare`；端口占用随机重试；监听失败抛错；均经 IPC 错误上抛到 `catch`。
- PIN 校验失败返回 401 鉴权页（连续失败 5 次锁定 5 分钟，已在服务内具备）。

## 6. 参数校验

- `share:startWifi` handler 对每个 `path` 调用 `assertFileReadPath`（拦截越权/不可读路径）。
- `wifiShareService.start` 内 `collectFiles`：`fs.statSync` 过滤不可读/非普通文件，空数组抛 `noFilesToShare`。
- `WifiShareDialog` 入口校验 `open && filePaths.length > 0`，空则 `t('share.wifi.noFiles')`。
- `GalleryPage.handleBatchShareWifi` 已用 `selectedMediaIds` 映射 `f.file_path`（真实绝对路径）传入，服务端拿到真实文件。

## 7. 基础测试用例

1. **渲染-成功**（WifiShareDialog）：mock `startWifi` 返回真实契约 `{ url, port, pin, fileCount, timeoutMs }` → 断言渲染访问地址、`PIN`、`fileCount`、`started` 成功提示，且「复制地址」「复制 PIN」可点击。
2. **渲染-失败**（WifiShareDialog）：mock `startWifi` `mockRejectedValue(new Error('端口占用'))` → 断言出现 `share.wifi.startFailed` 错误文案（不再依赖不存在的 `res.success`）。
3. **渲染-stop 复位**（WifiShareDialog）：成功后再 `stopWifi` → 断言会话区复位（`session` 为 `null` 或 UI 回到初始态）。
4. **主进程契约**（share.test.ts，不改动，保持通过）：`share:startWifi` 返回 `data.url/pin/fileCount/timeoutMs`；`share:stopWifi` 返回 `data.stopped`。
5. **类型检查**：对改动文件 `tsc -b` 零新增错误（项目存在大量既有无关类型错误，不在本次范围）。

## 8. 子任务与验收标准

### 子任务 A — 修正渲染层契约（`WifiShareDialog.tsx`）

- 输入：`startWifi` 真实返回 `{ url, port, pin, fileCount, timeoutMs }`。
- 输出：`res?.url` 为真时 `setSession` 渲染；失败由 `catch` 提示。
- 验收：`npx vitest run src/renderer/components/common/WifiShareDialog.test.tsx` 全绿；不再读取 `res.success`。

### 子任务 B — 对齐类型声明（`vite-env.d.ts` / `ipc.ts`）

- 输入：真实契约 `{ url, port, pin, fileCount, timeoutMs }`。
- 输出：`startWifi` 返回必填字段、`stopWifi` 返回 `{ stopped }`；`ipc.ts.ShareStartWifiResult` 与 `electron-api.ts` 一致。
- 验收：`tsc` 对 `WifiShareDialog` 调用 `setSession({ url: res.url, ... })` 无 `string|undefined` 报错。

### 子任务 C — 修正并补测试（`WifiShareDialog.test.tsx`）

- 输入：mock 返回真实契约 + reject 用例。
- 输出：成功渲染断言、失败 `startFailed` 断言、stop 复位断言。
- 验收：单测全绿，失败路径被真实覆盖。

### 子任务 D — 运行验证

- 输入：改动后代码。
- 输出：渲染测试 + 主进程 share 测试全绿；改动文件 `tsc -b` 零新增错误。
- 验收：报告通过；若有报错误则就地修复后重跑直至全绿。

## 9. 审查纪律（每段代码最多审查一次，给出具体检查项）

- A：`res?.url` 替换 `res.success && res.url`；检查 `setSession` 字段齐全（active/url/port/pin/fileCount/startedAt/timeoutMs）；检查 `catch` 未被删除；检查 `showMessage(t('share.wifi.started',{port}))` 仍保留。
- B：检查 `vite-env.d.ts` 与 `ipc.ts` 两处 `ShareStartWifiResult` 字段顺序/类型与 `electron-api.ts:284` 完全一致；`stopWifi` 为 `{ stopped: boolean }`。
- C：检查 mock 返回体无 `success`；`reject` 用例断言文案为 `share.wifi.startFailed`；断言选择器与现有 DOM 一致。
- D：检查测试命令输出「passed」；`tsc` 仅本次改动文件无错误。无严重缺陷即推进，不循环重验。
