# 第三方组件与在线服务

## 安卓嵌入组件

| 组件 | 当前版本 | 用途 | 本工程观察到的外发 |
| --- | --- | --- | --- |
| Bouncy Castle bcprov-jdk18on | 1.86 | Ed25519及ASN.1 | 不自行联网 |
| desugar_jdk_libs | 2.1.5 | Android 11/12 的 Java 标准库 API 兼容实现 | 不自行联网；许可随 APK 提供 |
| AndroidX RecyclerView | 1.4.0 | 相册列表 | 不自行联网 |
| AndroidX Activity | 1.10.1 | 页面/返回/生命周期 | 不自行联网 |
| AndroidX ExifInterface | 1.4.2 | 本地 JPEG/PNG/WebP EXIF 写入与校验 | 不自行联网 |
| ZXing core | 3.5.3 | 二维码解析 | 本地扫码 |
| JourneyApps zxing-android-embedded | 4.3.0 | 相机扫码界面 | 本地相机输入 |
| AndroidX Media3 Transformer/Effect | 1.8.0 | 选定视频旋转与导出 | 当前代码处理本地素材 |
| AndroidX Media3 ExoPlayer/UI | 1.8.0 | LIVE 本地视频预览，默认静音 | 播放器只读取私有缓存文件；原图库素材经现有配对电脑的 TLS 固定证书与签名连接下载，不交给播放器联网 |

以上组件用于本地显示、扫码、加密或处理用户选择的素材，当前未配置广告或统计SDK。Bouncy Castle完整许可在APK内提供；静态清单不等于覆盖所有场景的动态检测。

## PC在线服务

| 服务 | 实际入口 | 请求与数据 | 当前控制/待办 |
| --- | --- | --- | --- |
| NUAN5 | https://nuan5.pro/api/decode-photo2 | POST游戏UID、原生编码参数及JPEG前缀MD5 | 默认关闭，电脑同步设置披露接收方和字段，用户同意后开启并可随时关闭。服务主体、留存和权利渠道尚未核实 |
| 自定义RemoteJson解析 | 用户指定HTTPS endpoint | POST UID、token/params、可选校验与格式/长度字段 | 非默认端点；设置提示展示实际端点与发送字段，配置改变需重新同意 |
| Nikki Albums | https://nikki.ranaxro.com/app_api/hot_update.json | 公共字典和由清单指定的公开资源 | 不提交用户照片；远程字典配置可关闭 |
| NikkiGallery | https://www.nikkigallery.vip/api/v1/clothes/all | 公共名称、套装、动作等字典及服装图标请求 | 同上；不是把其EXE嵌入手机 |
| 无限暖暖官网 | https://infinitynikki.nuanpaper.com/home | GET公共版本日期，启动后及每6小时 | 不发送照片/UID；保留缓存；目前没有用户UI开关 |
| Steam 官方游戏公告 | https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/ （appid=3164330） | GET公共英文版本标题，启动后及每6小时；限时8秒、最多1MiB | 不发送照片、UID或本地参数；失败沿用内置/缓存名称，未知标题留空 |
| GitHub Releases网页 | https://github.com/ToStardust/NikkiSync/releases | 用户在关于页选择打开外部浏览器 | 用户主动访问；不是手机自动云相册 |
| Windows更新检查（2026-10-18新增） | https://api.github.com/repos/ToStardust/NikkiSync/releases 及对应的签名清单/程序下载地址；可由用户填写开发者提供的HTTPS镜像清单 | 电脑界面启动完成后进行一次公共版本检查，手动检查或确认下载时访问更新源；仅发送通常HTTP请求头，不上传照片、UID、配对信息、索引或设置 | 检查失败不阻塞使用；点击下载并重启才替换程序；镜像也必须通过内置公钥签名及文件SHA256验证。手机APK仍由用户手动安装。该变化只在新电脑助手生效，既有安卓1.0.1包不变 |

公网请求会让接收方看到连接IP、路径和通常的请求头。在线解析服务的运营主体、联系渠道、保留期限及服务器所在地区尚未核实。在线解析默认关闭，电脑同步设置持续展示接收方和字段，用户同意后开启并可随时关闭。此清单不代表本软件可代第三方承诺删除或服务可用性。
