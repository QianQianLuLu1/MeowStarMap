# WiFi 局域网分享功能修复实施计划

> 针对「图库」选中图片后底部任务栏「WiFi 局域网分享」功能无法正常使用问题的根因分析与修复方案。
> 状态：已执行（9 项单测全绿，改动文件 `tsc -b` 零新增错误、ESLint 0 错误）。

## 1. 问题描述与根因

**现象**：点击「WiFi 局域网分享」后，手机浏览器无法连接分享地址，或对话框一直转圈 / 提示「启动失败」。

**调用链（已确认正确、无需改动）**：

```
BatchActions.onShareWifi
  → GalleryPage.handleBatchShareWifi（取选中项 file_path 绝对路径）
  → <WifiShareDialog>（已修正为按 res?.url 判读契约）
  → window.electronAPI.share.startWifi(filePaths)
  → IPC share:startWifi
  → wifiShareService.start()
```

**根因（位于 `src/main/services/share-wifi-service.ts`）**：

1. `start()` 调用 `server.listen(port, lanIp)`，将 HTTP 服务绑定到**单一特定局域网 IP**（`lanIp` 来自 `getLanIp()`）。
   - 若该 IP 与手机不在同一网段，或回退探测命中 VMware(`192.168.184.x`)/Docker(`172.17.x`)/VPN 等虚拟网卡私有 IP，手机访问 URL 不可达。
   - 若该特定 IP 当前未分配，`listen` 失败 → `start()` 抛错 → 对话框「启动失败」。
2. `PRIVATE_IP_REGEX` 未包含回环地址（`127.0.0.1`/`::1`），同机浏览器打开分享 URL 自测被 403 拒绝，排查困难。
3. `getLanIpFromInterfaces()` 仅按私有网段过滤，未排除虚拟网卡，回退时极易误选虚拟网卡 IP。

## 2. 依赖声明

- **零新增依赖**：HTTP/OS/FS/CRYPTO 均为 Node 内置模块。
- 局域网 IP 探测：沿用既有 `network-address@^1.1.2`（package.json 已声明且已安装），仅 `require` 用于默认路由探测。
- 二维码：沿用既有「大字号地址 + 复制按钮 + 引导文案」方案，不引入二维码库。
- 测试：沿用既有 `vitest` + `jsdom`（devDependencies）。
- 绑定 `0.0.0.0` 为标准做法，无需第三方库。

## 3. 修改的文件与改动

唯一改动核心文件：`src/main/services/share-wifi-service.ts`（其余触发链 / IPC / 渲染层 / 契约均已正确，不动）。

| 改动         | 位置                                                                   | 说明                                                                                                                                                                |
| ------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 绑定全网卡   | `start()` 中 `server.listen(port, '0.0.0.0', …)`                       | 监听全部 IPv4 网卡，手机经任意本机 IP 均可命中；展示 URL 仍用 `getLanIp()` 计算值（仅展示）。安全边界由 `PRIVATE_IP_REGEX` 网关（拒绝非私有远端）保证，不暴露公网。 |
| 展示 IP 校验 | `getLanIp()` 增加 `isLanAddress(byRoute)` 校验                         | `network-address` 默认路由结果须落在某张「非虚拟、非回环」真实网卡上，否则回退扫描。                                                                                |
| 跳过虚拟网卡 | `getLanIpFromInterfaces()` 增加 `isVirtualAdapter(name, address)` 跳过 | 回退扫描不再误选 VMware/Docker/VPN 等私有 IP。                                                                                                                      |
| 回环放行     | `PRIVATE_IP_REGEX` 增加 `127.` 与 `::1`                                | 同机浏览器自测可达（`127.0.0.1`/`::1`/`::ffff:127.0.0.1`）。                                                                                                        |
| 新增辅助     | `isVirtualAdapter()`、`isLanAddress()`                                 | 私有方法，名称/网段匹配虚拟网卡清单（`vmware｜vmnet｜virtualbox｜vbox｜docker｜hyper-v｜vethernet｜tailscale｜zerotier｜wireguard｜wg-｜vpn｜tap-｜tun-`）。        |

**安全权衡**：绑定 `0.0.0.0` 会监听所有网卡接口，但 `handleRequest` 开头的 `PRIVATE_IP_REGEX` 网关仍拦截所有非私有网段远端地址（返回 403），因此不会将服务暴露到公网。

## 4. 启动说明

- **开发态**：`npm run dev` →「图库」选中图片 → 底部任务栏点「WiFi 局域网分享」→ 自动 `startWifi` → 展示访问地址 + PIN + 倒计时 + 复制按钮。
- **本机自测**：同一 PC 浏览器打开展示地址，输入 PIN 即见文件列表并可下载（回环放行后 403 不再出现）。
- **手机端**：手机与 PC 同一局域网，浏览器打开地址，输入桌面端 PIN，即可下载原图/视频。
- **纯逻辑验证**：`npx vitest run src/main/services/share-wifi-service`（无需启动 GUI）。
- **构建/打包（本次不打包）**：`npx electron-vite build` + 写 `dist/main/package.json {"type":"commonjs"}` + `npx electron-builder --win --publish never`。

## 5. 错误处理

- `listen` 失败（端口占用/绑定异常）：既有 `once('error', reject)` → `start()` reject → 清理 `server` 引用并 `throw` → 渲染层 `catch` 显示 `share.wifi.startFailed`。
- 无真实 LAN IP（`getLanIp()` 仅回退 `127.0.0.1`）：照常绑定 `0.0.0.0`，`logger.warn` 提示当前可能仅本机可达，不阻断启动。
- 文件不可访问/空集合：`collectFiles` 过滤非文件/不可读项，空则抛 `noFilesToShare` → 渲染层提示。
- 文件读取失败：`serveFile` try/catch 回 500。
- PIN 校验失败：返回 401（认证页本体也以 401 返回，浏览器据此展示输入表单，提交 PIN 后 `Set-Cookie` 再访问即 200）；连续 5 次错误锁定 5 分钟（429）。
- 非私有网段远端：返回 403（`PRIVATE_IP_REGEX`，已含回环）。

## 6. 参数校验

- `share:startWifi` handler 对每个 `path` 调用 `assertFileReadPath`（拦截越权/不可读路径）。
- `collectFiles`：`fs.statSync` 过滤不可读/非普通文件，空数组抛 `noFilesToShare`。
- `WifiShareDialog` 入口校验 `filePaths.length > 0`，空则 `share.wifi.noFiles`。
- `GalleryPage.handleBatchShareWifi` 用选中项 `f.file_path` 真实绝对路径传入。

## 7. 基础测试用例

| 用例                    | 文件                                    | 断言                                                                                                             | 结果        |
| ----------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------- |
| 资源清理（既有）        | `share-wifi-service.test.ts`            | listen 失败不泄漏、超时清理、重复 start 清理旧 timer                                                             | ✅ 5 passed |
| 绑定 0.0.0.0 + 回环可达 | `share-wifi-service.connection.test.ts` | `GET /`（未认证）返回 401 认证页且含 PIN 表单；`server.address().address === '0.0.0.0'`；认证后 `GET /` 返回 200 | ✅          |
| PIN 认证后下载          | 同上                                    | `POST /auth?pin=<pin>` 返回 200 + `Set-Cookie`；`GET /download?id=0` 带 cookie 返回 200 且内容等于源文件         | ✅          |
| 未认证下载拒绝          | 同上                                    | `GET /download?id=0`（无 cookie）返回 401                                                                        | ✅          |
| 虚拟网卡 IP 回退        | 同上                                    | 注入 `network-address` 返回 `192.168.184.1`（VMware），`getLanIp` 回退到真实 WiFi `192.168.1.100`                | ✅          |

> 说明：`PRIVATE_IP_REGEX` 为模块私有，回环放行由「`GET /` 经 `127.0.0.1` 返回 401 认证页而非 403」间接验证（若未放行回环则为 403）。

## 8. 子任务与验收（先验证通过再进入下一步）

| 子任务                   | 修改文件                                | 输入 → 输出                                                                                                       | 验收标准                                       |
| ------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1. 写本计划              | `docs/plans/wifi-lan-share-fix.md`      | 需求/根因/方案 → MD                                                                                               | 章节齐全（依赖/启动/错误/校验/测试）+ 子任务表 |
| 2. 绑定全网卡 + 回环放行 | `share-wifi-service.ts`                 | `listen(port,'0.0.0.0')` + `PRIVATE_IP_REGEX` 含回环 → 服务监听全部网卡                                           | `tsc -b` 改动文件零新增错误 + ESLint 0 错误    |
| 3. 加固 LAN IP 探测      | `share-wifi-service.ts`                 | 新增 `isVirtualAdapter`/`isLanAddress`，`getLanIp`/`getLanIpFromInterfaces` 跳过虚拟网卡 → 展示 IP 为真实 WiFi IP | 虚拟网卡单测返回真实 WiFi IP + `tsc`/lint 通过 |
| 4. 端到端连通性单测      | `share-wifi-service.connection.test.ts` | 启动服务 → 回环访问/PIN/下载                                                                                      | `npx vitest run` 该文件全绿                    |
| 5. 复跑验证              | 上述文件                                | 单测 + 类型 + 静态检查                                                                                            | 全部相关单测绿、零新增类型/ESLint 错误         |

## 9. 验证结论（执行后）

- `npx vitest run src/main/services/share-wifi-service`：**2 文件 / 9 测试全绿**。
- `npx tsc -b`：**改动文件（`share-wifi-service.ts` 及新测试）零新增错误**；其余报错均位于无关模块（`media-repository.ts`、`scanner/*`、`mediaStore*` 等既有问题），不在本次改动范围。
- `npx eslint` 改动文件：**0 错误**。

**结论**：根因（绑定单一特定 LAN IP 的脆弱性）已通过「绑定 0.0.0.0 + 展示 IP 探测加固 + 回环放行」消除，且以端到端单测覆盖回环可达、PIN 认证下载、虚拟网卡 IP 回退三类关键路径，未改动任何与问题无关的功能、未新增依赖。
