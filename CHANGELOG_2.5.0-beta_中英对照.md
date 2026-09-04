# 无限暖暖相册管理工具 2.5.0-beta 更新日志 / NikkiGallery 2.5.0-beta Changelog

发布日期 / Release date：2026-09-01 · 版本 / Version：2.5.0-beta

[跳转到中文版](#中文更新日志) | [Jump to English](#english-changelog)

---

<a id="中文更新日志"></a>

## 中文更新日志

> 本版本在 2.3.5 的基础上，重点带来全新的「共鸣录」模块，并围绕稳定性、兼容性与扫描体验做了一系列增强。

### 新增

**「共鸣录」完整模块上线（纯本地、断网可用）**
在 2.3.6「共鸣记录页」的基础上，本次正式实装「我的衣橱」「JSON 导入 / 导出」「个人统计」，并内置离线静态数据与 12 语言国际化，全程纯本地、断网 100% 可用。

- **共鸣记录**：支持 73 个卡池的记录浏览（本地缩略图、品质色点、该抽跨度与垫抽提示），可手动补录、修改补录时间或删除，超长列表采用虚拟滚动保持流畅。
- **我的衣橱**：按部件 / 妆容 / Momo / 道具 / 共鸣色五分类管理拥有状态，提供套装聚合进度（已集齐 / 集齐中 / 未收集）、名称搜索、拥有状态与稀有度筛选、批量勾选，以及「从共鸣记录一键推断」拥有情况（纯文字模式，不依赖任何物品图片）。
- **数据导入 / 导出**：支持本地 JSON 文件导入（解析预览 → 新增 / 重复 / 无效计数与逐条定位 → 分批事务提交，进度可视、可取消、断点幂等），版本不兼容时提供「兼容导入 / 放弃」双选项并兼容 gongeo.us 旧版导出格式；导出可勾选内容并通过系统保存对话框落地；清空全部需危险二次确认。
- **个人统计**：提供总览卡（总抽数 / 4★5★ 部件 / 平均出货 / 已获套装）、欧非百分位与档位（静态快照，UI 标注来源与生成日期，缺失时自动隐藏）、SVG 出货分布直方图、按卡池累计曲线与按卡池明细表。
- **数据层**：SQLite 新增 5 张共鸣表（幂等迁移，纳入既有整库备份 / 恢复）；9 个 IPC 通道全部经 zod schema 校验（导入文件按不可信输入同等强度守卫，单文件 ≤64MB、总记录 ≤20 万）。
- **离线守护**：新增离线断言测试（核心流程零网络调用打桩断言 + 全部新增源码静态扫描 + 反向用例防假绿），保障离线能力可靠。

**共鸣记录页**：新增「共鸣记录」专属页面，集中展示游戏内共鸣相关截图与记录，便于回顾与检索。

**局域网分享**：新增 WiFi 局域网分享与分享菜单（WifiShareDialog），可在同一局域网内的设备间快速共享相册与媒体，分享体验更顺畅。

**重复项页面右键菜单与批量操作**：为「重复项」页面新增右键上下文菜单，并与分享菜单、批量操作联动，重复文件的查看、分享与管理一步到位。

**启动早期崩溃可观测性**：主进程任意阶段（含原生模块预检、窗口创建前）发生致命错误时，均会写入用户友好的诊断目录 `文档 / NikkiGallery / Diagnostics` 并弹出不依赖界面的报错框，便于快速定位问题。

**路径安全校验层**：新增媒体路径安全校验，兼容系统权限限制与杀毒软件拦截场景，提升受限环境下的启动与扫描稳定性。

**编辑器内嵌 XMP 元数据**：数据库新增 `editor_metadata` 列，持久化编辑器产生的内嵌 XMP 调整参数，保留图片编辑痕迹，便于后续回溯与复用。

### 优化

**GPU 渲染回退与崩溃自恢复**：渲染层新增 GPU 不可用时的软回退路径，并在渲染进程异常后支持自恢复，降低显卡兼容问题导致的崩溃概率。

**游戏目录发现增强**：扫描器新增多源兜底（Steam / Epic / 注册表 / 用户目录）与隐藏目录遍历能力，提升游戏目录自动定位成功率与首次扫描速度。

**扫描器与路径分类器重构**：统一 `GamePlayPhotos` 等扫描根，优化媒体类型定义并重新分类 X6Game 截图 / 视频的图库归属，使媒体归类更准确。

**扫描器诊断与多语言同步**：新增扫描器诊断信息输出，并同步多语言文案，便于排障与跨语言一致体验。

**官方相册（GamePlayPhotos）扫描定向优化**：针对官方 GamePlayPhotos 相册目录进行扫描定向优化，提升该类相册的扫描准确性与稳定性。

**缩略图生成与媒体工作线程优化**：优化缩略图生成逻辑并增强媒体工作线程的入口错误处理，提升媒体加载稳定性与缩略图生成效率。

### 修复

- 修复了已知 bug。

### 开发者信息

- **开发团队 / 作者**：QianLu（GitHub：[QianQianLuLu1](https://github.com/QianQianLuLu1)），个人开发者，品牌「纤璐不会玩摄影」。
- **贡献者鸣谢**：仓库仅记录作者本人（git 中 QianQianLuLu1 与 QianLu 为同一人的两个提交身份），无额外外部贡献者名单；共鸣录逻辑复用自开源项目 gongeo.us-nikki-tracker（MIT License，已获原作者授权），特此致谢。
- **反馈与 Issue 提交渠道**：[GitHub Issues](https://github.com/QianQianLuLu1/NikkiGallery/issues)
- **相关链接**：
  - 仓库 / 主页：https://github.com/QianQianLuLu1/NikkiGallery
  - 作者官网：https://ppebv9al.qwenwork.host/
  - 抖音：[纤璐不会玩摄影](https://v.douyin.com/Dx67wYkw48A/)
  - 小红书：[纤璐不会玩摄影](https://www.xiaohongshu.com/user/profile/69270bb200000000370092db)
  - 哔哩哔哩：[纤璐不会玩摄影](https://b23.tv/zCR5oGE)
  - CSDN 博客：[QianQian-LuLu](https://blog.csdn.net/2604_96788940)
- **许可证**：MIT

---

<a id="english-changelog"></a>

## English Changelog

> This release builds on 2.3.5 with a brand-new Resonance module, plus a series of improvements to stability, compatibility, and the scanning experience.

### Added

**Resonance module (fully local, works offline)**
Expanding on the Resonance Records page introduced in 2.3.6, this release completes the Resonance experience with My Wardrobe, JSON import/export, and personal statistics—all bundled with offline static data and 12-language localization. Everything runs locally and works 100% offline.

- **Resonance Records**: Browse records across 73 banners (local thumbnails, rarity color dots, pull spans and pity hints). Manually add, edit timestamps, or delete entries; long lists stay smooth thanks to virtual scrolling.
- **My Wardrobe**: Manage ownership across five categories—pieces, makeup, Momo, props, and resonance colors—with set completion progress (completed / in progress / not started), name search, ownership and rarity filters, batch selection, and one-click inference of ownership from resonance records (text-only, with no dependency on item images).
- **Data import & export**: Import local JSON (parse preview → counts of new/duplicate/invalid with per-entry navigation → batched transactional commit with visible progress, cancel support, and idempotent resumption). On version mismatch you can choose compatible import or discard; legacy gongeo.us export formats are also supported. Export with selectable content via the system save dialog; clearing all data requires a dangerous double confirmation.
- **Personal statistics**: Overview cards (total pulls / 4★5★ pieces / average drop rate / sets obtained), luck percentiles and tiers (a static snapshot with source and generation date shown in the UI, auto-hidden when missing), an SVG drop-distribution histogram, per-banner cumulative curves, and per-banner detail tables.
- **Data layer**: Five new SQLite resonance tables (idempotent migration, included in the existing full-database backup/restore); all 9 IPC channels are validated by zod schemas (imports are guarded as untrusted input—single file ≤64MB, total records ≤200k).
- **Offline guardrails**: Offline assertion tests (zero-network stubbed assertions for core flows + full static scanning of new source + negative cases to prevent false greens) keep the offline experience reliable.

**Resonance Records page**: A dedicated Resonance Records page gathers in-game resonance screenshots and records for easier review and search.

**LAN (WiFi) sharing**: Added WiFi LAN sharing with a share menu (WifiShareDialog), so you can quickly share albums and media with devices on the same local network—smoother sharing overall.

**Duplicates page context menu and batch actions**: The Duplicates page now has a right-click context menu wired to the share menu and batch actions, making it easy to view, share, and manage duplicate files in one place.

**Early-startup crash observability**: Fatal errors at any stage of the main process (including native-module pre-checks and before window creation) are now written to the user-friendly diagnostics directory `Documents/NikkiGallery/Diagnostics` and shown in an error box that does not depend on the UI, making issues easier to locate.

**Path safety layer**: Added media path safety validation that tolerates system permission restrictions and antivirus interception, improving startup and scan stability in restricted environments.

**Embedded XMP metadata for the editor**: Added an `editor_metadata` column to persist embedded XMP adjustment parameters produced by the editor, keeping image edit traces for later review and reuse.

### Optimized

**GPU render fallback and crash self-recovery**: The rendering layer now has a soft fallback path when the GPU is unavailable, and can self-recover after a renderer crash, reducing crash probability caused by graphics-card incompatibility.

**Enhanced game directory discovery**: The scanner adds multi-source fallbacks (Steam / Epic / registry / user directories) and hidden-directory traversal, improving auto-location success rate and first-scan speed.

**Scanner and path-classifier refactor**: Unified scan roots such as `GamePlayPhotos`, refined media-type definitions, and reclassified legacy gallery attribution for X6Game screenshots / videos, making media classification more accurate.

**Scanner diagnostics and i18n sync**: Added scanner diagnostic output and synced internationalized strings for easier troubleshooting and a consistent cross-language experience.

**Targeted scanning for the official GamePlayPhotos album**: Scanning is now specifically tuned for the official GamePlayPhotos album directory, improving accuracy and stability for that album type.

**Thumbnail generation and media worker thread**: Refined the thumbnail generation logic and strengthened error handling at the media worker thread entry point, improving media-loading stability and thumbnail generation efficiency.

### Fixed

- Fixed known issues.

### Developer Info

- **Developer / Author**: QianLu (GitHub: [QianQianLuLu1](https://github.com/QianQianLuLu1)), an independent developer under the brand "纤璐不会玩摄影" (Xianlu Can't Photograph).
- **Acknowledgements**: The repository records only the author (QianQianLuLu1 and QianLu are two commit identities of the same person); there is no additional external contributor list. The Resonance logic reuses the open-source project gongeo.us-nikki-tracker (MIT License, used with the original author's permission)—thank you.
- **Feedback & Issues**: [GitHub Issues](https://github.com/QianQianLuLu1/NikkiGallery/issues)
- **Links**:
  - Repository / Homepage: https://github.com/QianQianLuLu1/NikkiGallery
  - Author Site: https://ppebv9al.qwenwork.host/
  - Douyin (TikTok CN): [纤璐不会玩摄影](https://v.douyin.com/Dx67wYkw48A/)
  - Xiaohongshu (RED): [纤璐不会玩摄影](https://www.xiaohongshu.com/user/profile/69270bb200000000370092db)
  - Bilibili: [纤璐不会玩摄影](https://b23.tv/zCR5oGE)
  - CSDN Blog: [QianQian-LuLu](https://blog.csdn.net/2604_96788940)
- **License**: MIT
