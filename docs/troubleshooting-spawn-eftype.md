# 排查指南：`spawn EFTYPE` 启动失败 / 子进程错误

> 适用现场：启动弹窗提示 **"NikkiGallery 启动失败，程序已退出"**，原因为 `spawn EFTYPE`，
> 引导查看 `C:\Users\<user>\Documents\NikkiGallery\Diagnostics\startup-errors.log`。

## 1. `spawn EFTYPE` 是什么

Windows 上 Node.js/Electron 的 `spawn` 报 `EFTYPE`，等价于 Win32 错误
**193 `ERROR_BAD_EXE_FORMAT`（"不是有效的 Win32 应用程序"）**——被 spawn 的目标文件
**不是合法的 PE 可执行文件**。常见诱因（按现场概率排序）：

| 诱因                  | 说明                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| 二进制被杀软隔离/替换 | `existsSync` 仍为 true，但内容变成 0 字节或文本占位 → spawn 即 EFTYPE（**概率性、部分电脑的主要来源**）       |
| PATH 遮蔽             | PATH 上存在与系统命令同名的非 PE 文件（本仓库 tar.exe 事故即此因，见 `src/main/utils/zip-archive.ts` 头注释） |
| 直接 spawn 脚本       | `.bat` / `.cmd` / `.ps1` / `.lnk` 未设 `shell: true`                                                          |
| 架构不符              | 非 x64 PE（如 ARM64 裸机跑 x64 无模拟）                                                                       |

错误如何升级为"启动失败"弹窗：未挂 `error` 监听的 spawn 失败 → `uncaughtException` →
`early-crash-guard.reportEarlyFatal`（`src/main/utils/early-crash-guard.ts:161-283`）→
写 `startup-errors.log` → 弹窗 → `app.exit(1)`。主窗口创建后同类错误已降级为
"程序出错 / Runtime Error" 非致命弹窗，不退出。

## 2. 第一步：读 `startup-errors.log` 定位是哪一个 spawn

日志候选路径链（首个可创建者生效，**旧版注意两处都看**）：

1. `<Documents>\NikkiGallery\Diagnostics\startup-errors.log`
2. `<homedir>\NikkiGallery\Diagnostics\startup-errors.log`（旧版弹窗指向 Documents 但实际写这里）
3. `%TEMP%\NikkiGallery-Diagnostics\startup-errors.log`
4. 应急兜底：`%TEMP%\NikkiGallery-startup-errors.log`

找形如下面的条目（时间戳 + stage + 摘要行）：

```
[2026-09-25T12:00:00.000Z] [STAGE: index.uncaughtException] spawn EFTYPE
[errno] code=EFTYPE errno=-4054 syscall=spawn EFTYPE path=tar.exe spawnargs=["-c","--format=zip",...]
```

- **`path=`**：失败的目标文件/命令名；**`spawnargs=`**：完整参数。
- **`[STAGE: ...]`**：错误冒泡的阶段（`index.uncaughtException` = 启动早期；`exec-taskmgr`、
  `runtime-spawn-error:ffmpeg-runner` 等为各调用点专属 stage）。
- 拿 `path=` 对照下文第 4 节审计表，即可定位到具体代码调用点。

## 3. 第二步：在现场机器验证目标文件

PowerShell（把 `<path>` 换成日志里的 `path=` 值）：

```powershell
# 大小：0 字节 = 占位文件实锤
Get-Item <path> | Select-Object Length, LastWriteTime

# PE 魔数：合法可执行文件应以 4D 5A（"MZ"）开头
Format-Hex -Path <path> -Count 2

# PATH 遮蔽检查：同名命令解析到哪个文件（注意排除当前目录干扰）
where.exe <命令名>

# 杀软痕迹：Windows 安全中心 → 病毒和威胁防护 → 保护历史记录，查隔离/阻止记录
```

- `Format-Hex` 输出**不是** `4D 5A` → 该文件不是合法 PE：恢复/重装（重装应用或把干净二进制
  放回 `app.asar.unpacked` 对应路径），并把该文件加入杀软白名单。
- `where.exe` 解析结果在 System32 之前且非 `4D 5A` → PATH 遮蔽：修正用户 PATH。

## 4. 附：本仓库子进程调用点审计表（定位 `path=` 后对照）

> 下表 `file:line` 为 2026-10-17 复核的实测值（`early-crash-guard.reportEarlyFatal` 因新增流状态竞态分类而下移 20 行）。行号会随代码改动漂移，定位时请以调用点符号
> （`execFile` / `execFileSync` / `spawn` / `exec`）为准，不要把行号当稳定锚点。

| 调用点（file:line）                                                                                                | 目标                                     | 功能域               | 错误处理现状                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/main/app/lifecycle.ts:109,123,134`                                                                            | powershell / taskkill                    | 单实例锁冲突清理     | try/catch（同步）                                                                                          |
| `src/main/app/lifecycle.ts:172,195`                                                                                | taskmgr                                  | 锁冲突对话框按钮     | `.on('error')`（ebb2044 加）                                                                               |
| `src/main/app/desktop-shortcut.ts:124`                                                                             | reg                                      | 桌面快捷方式创建     | callback err → resolve(null)                                                                               |
| `src/main/app/permission.ts:38`                                                                                    | powershell                               | 管理员重启           | `child.on('error')` 降级 relaunch                                                                          |
| `src/main/scanner/game-directory-discovery.ts:411,508,966`                                                         | reg / powershell                         | 游戏目录发现         | callback err → resolve(null)                                                                               |
| `src/main/services/share-clipboard-service.ts:315,434,562,629,664,822,891`                                         | reg / wmic / powershell / tasklist / cmd | 分享检测/启动        | callback err → 降级                                                                                        |
| ffmpeg / ffprobe（`video-probe.ts`、`media-worker/worker-entry.ts`、`thumbnail/generator.ts`、`ffmpeg-runner.ts`） | ffmpeg-static / ffprobe-static           | 视频扫描/缩略图/剪辑 | error 事件 → reject（**v2.5.2 起：spawn 类错误落 startup-errors.log，stage 前缀 `runtime-spawn-error:`**） |
| 6 处 `utilityProcess.fork`（scanner/media/database/thumbnail/video/decryption bridge）                             | electron.exe                             | worker               | READY 超时 + exit 处理（fork 的是 electron.exe 自身，不会产生 EFTYPE）                                     |

## 5. 版本对照：哪些源头已修复

| 版本                                 | 状态                                                                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **≤ 2.5.1 旧安装包**（早于 ebb2044） | 已知源头：诊断包导出 `spawn tar.exe`（PATH 遮蔽即 EFTYPE，无 error 监听 → 致命弹窗）、`exec('taskmgr')` 无监听 → **升级到最新版即可消除**                         |
| **ebb2044（2026-09-25）**            | tar.exe 改进程内 archiver；taskmgr 挂 error 监听；`[errno]` 摘要行；Diagnostics 路径统一 Documents；开窗后 spawn 错误降级非致命                                   |
| **本次修复（含 ffmpeg PE 预检）**    | ffmpeg/ffprobe 二进制 spawn 前校验 MZ 魔数，占位/损坏文件自动降级 PATH 并记 diag.log；ffmpeg 链路 spawn 失败落 startup-errors.log；decryption-worker 打包缺失修复 |

现场判断方法：看 `About`/安装目录的版本号；或看 startup-errors.log 是否已有
`[errno]` 摘要行与 `runtime-spawn-error:` stage（有 → 已含本次修复）。

## 6. 修复后仍复现？

若最新版仍弹"启动失败"+ spawn EFTYPE：

1. 按第 2 节取 `path=` 与 stage，确认是否来自审计表之外（即第三方依赖内部的 spawn）；
2. 连同 `startup-errors.log`、`diag.log`、`faults-*.log`（设置 → 诊断 → 导出诊断包）反馈。
