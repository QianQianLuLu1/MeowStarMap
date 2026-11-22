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
| versionCode / versionName | 66 / 1.0.40（基线） | 68 / 2.5.7 起（对齐桌面包 2.5.7，versionCode 自上游计数递增） |
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

## 本机 Windows 构建须知（2026-11-22 实测）

本仓路径含中文（…\项目\软件\…），AGP 有两条已知限制，绕行方案如下（CI 的 ubuntu ASCII 路径不受影响）：

1. **路径检查**：AGP 默认拒绝非 ASCII 项目路径，已在 `gradle.properties` 加 `android.overridePathCheck=true`（上游无此行）；
2. **单测类加载**：非 ASCII 路径下 Gradle 测试 worker 会对全部测试类抛 `ClassNotFoundException`（AGP 已知缺陷，override 不豁免）。绕行：把 `mobile/` 镜像到 ASCII 路径后在其中构建，产物拷回——
   ```powershell
   robocopy "D:\项目\软件\MeowStarMap\MeowStarMap\mobile" "D:\msm-build\mobile" /MIR /XD build .gradle .cxx
   cd D:\msm-build\mobile
   gradlew.bat --no-daemon testDebugUnitTest assembleDebug
   ```
3. **Gradle 发行包**：`services.gradle.org` 在本网络偶发 TLS 劫持（PKIX 失败）。临时把 `gradle/wrapper/gradle-wrapper.properties` 的 distributionUrl 指向 `https://mirrors.cloud.tencent.com/gradle/gradle-8.13-bin.zip` 可解，**用后必须还原官方 URL**（仓库当前保持官方 URL）。

## 签名资产（2026-11-22 生成）

- keystore：`D:\Android\keystore\meowstarmap-release.keystore`（alias `meowstarmap`，RSA 3072，有效期 30 年，仓库外保存）
- 密码：同目录 `meowstarmap-password.txt`（随机生成，未入仓、未入文档）
- **发布前必办**：所有者改用自选密码重签（发布前重签无兼容成本）并完成异地双备份；keystore 丢失 = 已发布版本永远无法升级。
- 环境变量机制沿用上游 `MOMO_RELEASE_STORE_FILE/_STORE_PASSWORD/_KEY_ALIAS`（alias 缺省值 `momo-camera` 为上游遗留，本仓显式传 `meowstarmap`）。
