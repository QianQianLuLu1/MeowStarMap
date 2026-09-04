# NikkiGallery 2.5.0-beta Changelog

Release date: 2026-09-01 · Version: 2.5.0-beta

> This release builds on 2.3.5 with a brand-new Resonance module, plus a series of improvements to stability, compatibility, and the scanning experience.

## Added

### Resonance module (fully local, works offline)

Expanding on the Resonance Records page introduced in 2.3.6, this release completes the Resonance experience with My Wardrobe, JSON import/export, and personal statistics—all bundled with offline static data and 12-language localization. Everything runs locally and works 100% offline.

- **Resonance Records**: Browse records across 73 banners (local thumbnails, rarity color dots, pull spans and pity hints). Manually add, edit timestamps, or delete entries; long lists stay smooth thanks to virtual scrolling.
- **My Wardrobe**: Manage ownership across five categories—pieces, makeup, Momo, props, and resonance colors—with set completion progress (completed / in progress / not started), name search, ownership and rarity filters, batch selection, and one-click inference of ownership from resonance records (text-only, with no dependency on item images).
- **Data import & export**: Import local JSON (parse preview → counts of new/duplicate/invalid with per-entry navigation → batched transactional commit with visible progress, cancel support, and idempotent resumption). On version mismatch you can choose compatible import or discard; legacy gongeo.us export formats are also supported. Export with selectable content via the system save dialog; clearing all data requires a dangerous double confirmation.
- **Personal statistics**: Overview cards (total pulls / 4★5★ pieces / average drop rate / sets obtained), luck percentiles and tiers (a static snapshot with source and generation date shown in the UI, auto-hidden when missing), an SVG drop-distribution histogram, per-banner cumulative curves, and per-banner detail tables.
- **Data layer**: Five new SQLite resonance tables (idempotent migration, included in the existing full-database backup/restore); all 9 IPC channels are validated by zod schemas (imports are guarded as untrusted input—single file ≤64MB, total records ≤200k).
- **Offline guardrails**: Offline assertion tests (zero-network stubbed assertions for core flows + full static scanning of new source + negative cases to prevent false greens) keep the offline experience reliable.

### Resonance Records page

A dedicated Resonance Records page gathers in-game resonance screenshots and records for easier review and search.

### LAN (WiFi) sharing

Added WiFi LAN sharing with a share menu (WifiShareDialog), so you can quickly share albums and media with devices on the same local network—smoother sharing overall.

### Duplicates page context menu and batch actions

The Duplicates page now has a right-click context menu wired to the share menu and batch actions, making it easy to view, share, and manage duplicate files in one place.

### Early-startup crash observability

Fatal errors at any stage of the main process (including native-module pre-checks and before window creation) are now written to the user-friendly diagnostics directory `Documents/NikkiGallery/Diagnostics` and shown in an error box that does not depend on the UI, making issues easier to locate.

### Path safety layer

Added media path safety validation that tolerates system permission restrictions and antivirus interception, improving startup and scan stability in restricted environments.

### Embedded XMP metadata for the editor

Added an `editor_metadata` column to persist embedded XMP adjustment parameters produced by the editor, keeping image edit traces for later review and reuse.

## Optimized

### GPU render fallback and crash self-recovery

The rendering layer now has a soft fallback path when the GPU is unavailable, and can self-recover after a renderer crash, reducing crash probability caused by graphics-card incompatibility.

### Enhanced game directory discovery

The scanner adds multi-source fallbacks (Steam / Epic / registry / user directories) and hidden-directory traversal, improving auto-location success rate and first-scan speed.

### Scanner and path-classifier refactor

Unified scan roots such as `GamePlayPhotos`, refined media-type definitions, and reclassified legacy gallery attribution for X6Game screenshots / videos, making media classification more accurate.

### Scanner diagnostics and i18n sync

Added scanner diagnostic output and synced internationalized strings for easier troubleshooting and a consistent cross-language experience.

### Targeted scanning for the official GamePlayPhotos album

Scanning is now specifically tuned for the official GamePlayPhotos album directory, improving accuracy and stability for that album type.

### Thumbnail generation and media worker thread

Refined the thumbnail generation logic and strengthened error handling at the media worker thread entry point, improving media-loading stability and thumbnail generation efficiency.

## Fixed

- Fixed known issues.

## Developer Info

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
