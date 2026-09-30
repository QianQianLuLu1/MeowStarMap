# 修复「右键分享后第三方平台 Ctrl+V 无法粘贴图片」实施计划

- 状态：已批准（2026-09-30）
- 关联：T09 剪贴板分享（`src/main/services/share-clipboard-service.ts`）
- 执行约束：最小改动、零新 npm 依赖、严格 TDD（红→绿）、全量回归通过后才算完成

## 1 根因分析

- 现实现：`share-clipboard-service.ts:378` 用 `clipboard.writeBuffer('CF_HDROP', buf)` 写剪贴板。Electron 内部将格式名交给 `RegisterClipboardFormatW(L"CF_HDROP")`，而 **Windows 规定 RegisterClipboardFormat 只返回 0xC000~0xFFFF 的"已注册自定义格式"ID，永远不会返回标准格式 CF_HDROP(15)**。因此实际写入的是一个恰好名为"CF_HDROP"的私有格式，微信/QQ/vivo 读取标准 CF_HDROP 时看不到任何数据 → Ctrl+V 无反应。
- `buildHdropBuffer`（DROPFILES 20 字节头 + UTF-16LE 双 \0 结尾路径列表）布局本身正确——问题不在缓冲区，在传输格式。
- 本地 `node_modules/electron/electron.d.ts`（Electron 40.10.6）确认**没有** `ClipboardItem` / `text/uri-list` 文件写入 API（更新版本才引入），升级 Electron 违反最小改动约束，排除。
- 已否决备选：`clipboard.writeImage`（丢失原文件语义、不支持视频、重编码画质）；koffi 直调 user32（新增 ~50 行 FFI 生命周期风险代码，OpenClipboard 异常路径风险高）。

## 2 依赖声明

- **npm 依赖：零新增、零变更**。
- 系统依赖：`powershell.exe` 5.1（Windows 10/11 内置，代码内引用**固定字面量** `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`——不读取 `SystemRoot` 等环境变量、不回退 PATH 查找，杜绝环境注入与 PATH 劫持）。
- 复用仓库已有：`execFile` 回调包装模式（同文件 `regQuery` 先例）、现有 i18n 文案键（`share.message.*` / `share.log.*`，无新增）、现有测试 mock 基建（两测试文件已 `vi.mock('child_process'/'electron'/'fs')`）。

## 3 启动与验证说明

```bash
# TDD 红/绿
npx vitest run src/main/services/share-clipboard-service.test.ts src/main/services/share-clipboard-service.integration.test.ts
# 局部回归
npx vitest run src/main src/renderer/utils/share.test.ts src/renderer/pages/GalleryPage.share.test.tsx
# 全局回归
npm test && npm run typecheck && npm run lint
# 手工验收
npm run dev   # 右键图片 → 分享到微信 → 微信聊天框 Ctrl+V 出现可发送文件
```

## 4 修复方案（子任务与验收标准）

### T1 写入本计划文档

- 文件：`docs/plans/2026-09-30-fix-clipboard-share-paste.md`（新建）。
- 输入：已批准计划；输出：入库文档。
- 验收：文件存在且含依赖/启动/错误处理/参数校验/测试矩阵模块。✅

### T2 红灯 — 重写与新增单元测试

- 文件：`src/main/services/share-clipboard-service.test.ts`。
- 新增回归测试（修复前**必须失败**）：「全部文件存在 → 成功复制时调用 `execFile` 启动 powershell.exe 且带 `-EncodedCommand`（解码含 `SetFileDropList`），stdin Base64 载荷解码后含每个路径；且 `clipboard.writeBuffer` 不得被调用」。修复前 writeBuffer 被调用 → 断言失败（RED）。
- 按规则重写 4 个固化旧错误行为的用例（writeBuffer 断言 → execFile powershell 新契约）；`execFile` mock 默认成功回调（beforeEach）。
- 输入/输出：mocked `fs.promises.stat`、mocked `execFile`；断言服务返回值与 execFile 调用参数。
- 验收：`npx vitest run …share-clipboard-service.test.ts` 新/重写用例失败且失败原因正确（RED 确认）。

### T3 修复 — 服务实现

- 文件：`src/main/services/share-clipboard-service.ts`（唯一业务代码改动）。
- 删除：`import { clipboard } from 'electron'`、`DROPFILES_SIZE`、`buildHdropBuffer`、`clipboard.writeBuffer('CF_HDROP', buf)`。
- 新增（~35 行）：① `POWERSHELL_EXE` 常量；② `writeHdropViaPowerShell(filePaths)`：`execFile(POWERSHELL_EXE, ['-NoProfile','-NonInteractive','-STA','-EncodedCommand', b64(固定脚本)], {timeout:10000, windowsHide:true}, cb)`；脚本固定为 Add-Type WinForms → StringCollection → 从 stdin 逐行 `FromBase64String→UTF8` Add → `Clipboard.SetFileDropList($L)`；`child.stdin?.end()` 写入每路径 UTF-8 Base64 一行；③ `copyFilesToClipboard` 成功路径：非 win32 判定前置（沿用 `unsupportedPlatform` 分支）→ `await writeHdropViaPowerShell(valid)`。
- 更新文件头注释（L1-25）为 PowerShell SetFileDropList 机制。返回值结构、日志、i18n 键不变；handler/preload/renderer/i18n 零改动。
- 验收：T2 文件单测全绿（GREEN）。

### T4 集成测试对齐

- 文件：`src/main/services/share-clipboard-service.integration.test.ts`。
- 重写引用 writeBuffer 的断言：HDROP 缓冲区结构断言 → 解码 EncodedCommand + stdin 载荷断言；并发 5 次 → execFile 5 次、各自 stdin 载荷含对应路径；非 win32 与平台切换用例同步。TTL/检测用例不动。
- 验收：该文件全绿。

### T5 真机机制验证

- 用临时文件（ASCII + 中文含空格各一）执行实际命令 → 另开进程 `Get-Clipboard -Format FileDropList` 回读必须一致，且 powershell 进程退出后仍可读（证明真实 CF_HDROP 已持久化）；记录耗时。前后快照/尽力恢复用户剪贴板文本。
- 验收：回读一致 + 耗时记录在案。

### T6 回归与收尾

- 局部：`npx vitest run src/main src/renderer/utils/share.test.ts src/renderer/pages/GalleryPage.share.test.tsx` 全绿；全局：`npm test`、`npm run typecheck`、`npm run lint` 无新增失败。更新本计划勾选执行结果。
- 验收：全部通过；否则继续修复直至通过。

## 5 错误处理

- execFile 失败/非零退出/10s 超时/ENOENT → 沿用现有 catch → `{success:false, message:t('share.message.copyFailed',{reason})}` + `logger.error`；ShareGuideDialog 对复制失败本就不自动关闭，错误用户可见。成功仍走 `logger.info`。
- 非 win32 → 现有 `unsupportedPlatform` 分支（判定前移到写剪贴板之前）。PowerShell/WinForms 异常 → 同失败分支。
- stdin 写入用 `child.stdin?.end()` 可选链（测试 mock 返回 undefined 时安全）。
- 日志规范：沿用现有 i18n 键与 logger，不新增用户可见文案。

## 6 参数校验

- 入参 `filePaths: string[]`：上游 handler 已有 zod `schemas.filePathArrayBulk` + `assertMediaReadPath` 双层校验（不动）；服务内空数组/null 早返回、`filterValidPaths` 过滤不变。
- 边界：中文/空格/单引号/换行路径 → Base64+stdin 天然免疫（无引号转义问题）；大批量文件 → stdin 规避 32k argv 上限；stdin 载荷仅 `[A-Za-z0-9+/=\n]`，无注入面。

## 7 基础测试用例矩阵

| 类别 | 用例                      | 期望                                                          |
| ---- | ------------------------- | ------------------------------------------------------------- |
| 正常 | 全部文件存在              | success=true，execFile(powershell) 1 次，stdin 解码含全部路径 |
| 正常 | 2 存在 1 不存在           | count=2 / skipped=1，stdin 只含存在的 2 条                    |
| 正常 | 5 次并发                  | 5 次 execFile，各自 stdin 含对应路径                          |
| 异常 | powershell 非零退出       | success=false，message 含"复制失败"                           |
| 异常 | powershell 超时/抛错      | 同上                                                          |
| 异常 | 全部文件不可访问          | 不调 execFile，skipped=N                                      |
| 异常 | 空数组 / null / undefined | 现有失败分支（"未选择任何文件"）                              |
| 边界 | 中文+空格+单引号路径      | Base64 往返无损                                               |
| 边界 | linux / darwin            | 平台不支持文案，不调 execFile                                 |
| 边界 | win32↔linux 切换再切回    | 行为始终与当前平台一致                                        |
| 边界 | 返回值结构                | success/count/skipped/message 四字段类型正确                  |

## 8 改动边界（明确不动）

renderer 全部、preload、IPC handler 注册与 zod 校验、应用检测/启动逻辑、WiFi 分享、i18n 文案。不做无关重构/格式化。

## 9 执行记录

- [x] T1 计划文档入库
- [x] T2 红灯确认：`share-clipboard-service.test.ts` 5 失败（回归测试 + 4 个重写用例，失败原因正确）/ 19 通过
- [x] T3 修复 + 绿灯：单测 24/24 全绿
- [x] T4 集成测试对齐：单元 + 集成 33/33 全绿
- [x] T5 真机验证：PowerShell SetFileDropList 写入 2 个文件（ASCII + 中文/空格/单引号路径），耗时 **1275ms**；**独立进程**回读 `Clipboard.GetFileDropList()` 与输入完全一致且写入进程退出后仍保留（含标准 CF_HDROP）；验证后已恢复用户剪贴板文本并清理临时文件
- [x] T6 全量回归：局部 `vitest run src/main …` 164 文件 / 3134 测试全绿；`npm test` 293 文件 / 4894 测试全绿；`npm run typecheck` 与 `npm run lint` 通过
- [x] 安全复查（Mimosa L2）：`POWERSHELL_EXE` 原经 `process.env.SystemRoot` 推导，存在环境注入选择被执行程序的风险；已改为**固定字面量** `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`（不读任何环境变量、不回退 PATH 查找；非默认部署下走既有"复制失败"分支）。复测 33/33 + typecheck + lint + 真机字面量路径写入/回读通过

最终用户验收路径：`npm run dev` → 右键图片 → 分享到微信/QQ → 在聊天窗口 Ctrl+V 应出现可发送的原始文件。
