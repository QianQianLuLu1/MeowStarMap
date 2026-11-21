# PORTING · 安卓端移植说明

本目录是自上游 [NikkiSync](https://github.com/ToStardust/NikkiSync) 的 `apps/mobile` 移植而来的 Android 端（喵星图伴侣应用），以 MIT 授权复用。

## 来源与基线

- 上游仓库：https://github.com/ToStardust/NikkiSync
- 移植基线 commit：`6bdab4b4b29b0af5103aafb2d3223e7903c6306c`（2026-11-21 经 `git archive` 逐字节拷入）
- 上游授权：MIT，`LICENSE`（Copyright (c) 2026 ToStardust and NikkiSync contributors）随目录保留，未改动
- 上游作者：ToStardust（星尘）

## 作者授权条件（必须持续满足）

1. 保留上游原 LICENSE 与版权声明；
2. 第三方游戏美术资源不在 MIT 授权内——本目录及其构建产物**不得**引入任何游戏美术（上游仓库级 `assets/photo-filter-icons` 等未拷贝，后续也不得拷入）；
3. 商店侧使用独立应用名 / 包名 / 签名 / 图标（见下方身份映射）。

## 身份映射（上游 → 喵星图）

| 项 | 上游 | 本移植 |
|---|---|---|
| applicationId | `app.nikkisync.mobile` | `com.qianlu.meowstarmap` |
| 应用显示名 | 大喵相机助手 | 喵星图 |
| versionCode / versionName | 66 / 1.0.40（基线） | 67 / 1.0.41 起（沿用上游计数） |
| 签名 | 上游 keystore（`MOMO_RELEASE_*` 环境变量机制保留） | 独立新 keystore（alias `meowstarmap`，仓库外保存） |
| 启动图标 | 上游自绘 mipmap | 由本仓 `resources/icons/icon-master.png` 生成 |
| APK 自更新 | cnb.cool 上游 feed + 上游验签公钥 | 默认禁用（`meowSelfUpdate=false`，见 `mobile/app/build.gradle.kts`）；启用前必须同时更换 feed 与密钥对 |
| Java 包名 / gradle namespace | `app.nikkisync.mobile` | **原样保留**（协议面与源码身份不随商店身份改变） |

## 协议冻结项（红线，违者即停）

配对 scheme/host（`nikki-sync://pair?`、`NS1|`）、NSD 服务类型（`_nikkisync._tcp.`）、HTTP/WS 路径、鉴权头、EXIF 相机与描述串、相册落盘目录、本地键名与数据库名——一律与上游逐字节一致。守护网：仓库根执行 `npm run mobile:freeze`（`scripts/check-mobile-freeze.mjs`），任何冻结文件被改动导致漂移即非零退出。完整清单见 `docs/plans/2026-11-21-安卓端移植进桌面仓库-实施计划.md` 第四节。

## 与上游的双源关系

- 本目录与上游 `apps/mobile` 是**分叉**关系，不做自动同步；
- 上游有价值变更按需**手工择优 backport**，backport 时必须复跑 `npm run mobile:freeze` 与 `./gradlew testDebugUnitTest`；
- 出树引用已全部改接本仓（原 3 处：法务文档 → `mobile/legal/`、更新公钥 → `mobile/signing/`、APK 输出 → 仓库根 `release/`），对上游仓库目录零依赖。
