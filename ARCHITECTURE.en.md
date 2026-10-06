# NikkiGallery Architecture Document

> **Project Code**: `wxnn-photo-manager`
> **Application Name**: NikkiGallery (无限暖暖相册管理工具)
> **Current Version**: 2.5.3
> **Platform**: Windows x64
> **Document Version**: 1.5
> **Last Updated**: 2026-10-06

---

## Table of Contents

- [1. Project Overview](#1-project-overview)
- [2. Technology Stack](#2-technology-stack)
- [3. Process Model](#3-process-model)
- [4. Directory Structure](#4-directory-structure)
- [5. Main Process Module Responsibilities (src/main)](#5-main-process-module-responsibilitiessrcmain)
- [6. Renderer Process Module Responsibilities (src/renderer)](#6-renderer-process-module-responsibilitiessrcrenderer)
- [7. Shared Modules (src/shared)](#7-shared-modules-srcshared)
- [8. Data Flow](#8-data-flow)
- [9. Database Architecture](#9-database-architecture)
- [10. Security and Observability](#10-security-and-observability)
- [11. Build and Release](#11-build-and-release)
- [12. Key Design Constraints](#12-key-design-constraints)

---

## 1. Project Overview

### 1.1 Project Positioning

NikkiGallery is an Electron + React based desktop application that provides players of the game "Infinity Nikki" with local photo album scanning, browsing, editing, organizing, sharing, and backup capabilities. All user data is stored locally with no cloud uploads.

### 1.2 Core Capabilities

| Capability                    | Description                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Media Scanning**            | Auto-locates game directories; full/incremental scans of 16 signature folders including NikkiPhotos, MagazinePhotos, ScreenShot                                                                                                                                                                                                                                                                  |
| **Gallery Browsing**          | 5 views: grid/list/timeline/masonry/event timeline; virtual scrolling; multi-tier thumbnails                                                                                                                                                                                                                                                                                                     |
| **Detail View**               | EXIF shooting params, game camera params (pose/aperture/lighting/filter), outfit/dye/interaction info, coordinate location                                                                                                                                                                                                                                                                       |
| **Image Editing**             | 22 adjustments (exposure/contrast/HSL/curves/split-tone/LUT/watermark) + edit history stack + batch apply                                                                                                                                                                                                                                                                                        |
| **Video Processing**          | Thumbnail extraction, metadata reading, trimming, speed adjustment (0.25x-4.0x), format conversion, Apple Live Photo export                                                                                                                                                                                                                                                                      |
| **Duplicate Detection**       | Exact SHA256 + perceptual hash (pHash) dual detection; 4-dimensional smart scoring recommends keeper                                                                                                                                                                                                                                                                                             |
| **Smart Grouping**            | 6-dimensional aggregation by album type / scene category / scene time / outfit / file type                                                                                                                                                                                                                                                                                                       |
| **Character Profiles**        | Multi-account management, UID-based isolation, cross-profile transfer, stats almanac                                                                                                                                                                                                                                                                                                             |
| **Category Management**       | System categories + user-defined tree; drag-sort; color and icon configuration                                                                                                                                                                                                                                                                                                                   |
| **Recycle Bin**               | Soft delete / restore / hard delete / empty; double confirmation and three-stage transaction consistency                                                                                                                                                                                                                                                                                         |
| **Sharing**                   | WeChat/QQ/vivo clipboard sharing + WiFi LAN sharing (PIN auth + Range support)                                                                                                                                                                                                                                                                                                                   |
| **Backup & Restore**          | Auto scheduled + manual backup; UID suffix identification; 5-copy LRU retention                                                                                                                                                                                                                                                                                                                  |
| **Settings Center**           | 8 groups: startup / appearance / scan / profile / data / diagnostics / about / tools                                                                                                                                                                                                                                                                                                             |
| **Internationalization**      | 12 languages (zh-CN/zh-TW/en/ja/ko/fr/de/es/pt/ru/th/vi) with "Follow System" option                                                                                                                                                                                                                                                                                                             |
| **Themes**                    | Default theme + Soft Pink Luxury theme; CSS variable driven; zero JS re-render switching                                                                                                                                                                                                                                                                                                         |
| **Diagnostics**               | Fault logs (10 FaultTypes) + crash dumps + startup diagnostics + process exit diagnostics                                                                                                                                                                                                                                                                                                        |
| **Game Param Decryption**     | Decrypts in-game photo camera params via koffi calling nuan5_decryption.dll                                                                                                                                                                                                                                                                                                                      |
| **Resonance Records** (2.5.0) | Browse pull records and add manual entries; My Wardrobe (items / makeup / Momo / props / eureka colors) ownership with outfit completion progress; local JSON import & export (parse preview → batched transactions → cancellable and idempotent resume); personal stats (luck percentile and drop distribution). 5 resonance tables + 9 IPC channels, fully offline with zero external requests |

### 1.3 Application Form

The project ships two application forms that **share the same UI layout, color scheme, menu hierarchy, interaction logic, and visual style**:

- **exe Desktop Program**: NSIS installer packaged by electron-builder, carries full functionality
- **HTML Preview Version**: A quick preview/debugging carrier; no installer run required to view design effects

> **Synchronous Iteration Principle**: The HTML preview version and the exe program must iterate synchronously to ensure version consistency. The HTML preview is not an independent product but a design preview carrier during development.

---

## 2. Technology Stack

### 2.1 Core Tech Stack

| Layer                    | Technology                    | Version     | Rationale                                                                         |
| ------------------------ | ----------------------------- | ----------- | --------------------------------------------------------------------------------- |
| **Runtime**              | Electron                      | 40.10       | Cross-platform desktop app framework; reuses web tech stack; supports native APIs |
| **Frontend Framework**   | React                         | 19.2        | Mature ecosystem; high team familiarity; supports concurrent features             |
| **State Management**     | Zustand                       | 5.0         | Lightweight, TypeScript-friendly; avoids Redux boilerplate                        |
| **Build Tool**           | Vite                          | 5.4         | Fast HMR for renderer; Rollup bundling                                            |
| **Type System**          | TypeScript                    | 5.9         | strict mode; cross-process type sharing                                           |
| **Styling**              | Tailwind CSS                  | 3.4         | Atomic CSS; CSS variable-driven theming                                           |
| **Animation Library**    | Motion                        | 12.42       | Declarative React animations; outperforms CSS keyframes                           |
| **Database**             | better-sqlite3                | 12.11       | Synchronous SQLite; WAL mode; excellent performance                               |
| **Image Processing**     | sharp                         | 0.35        | C++ binding to libvips; thumbnail/editor pipeline                                 |
| **Video Processing**     | ffmpeg-static + fluent-ffmpeg | 5.3 / 2.1   | Static ffmpeg binary; no system install required                                  |
| **EXIF Parsing**         | exifr                         | 7.1         | Modern EXIF parser; supports multiple formats                                     |
| **FFI**                  | koffi                         | 3.1         | Calls nuan5_decryption.dll; more modern than node-ffi-napi                        |
| **Parameter Validation** | zod                           | 4.4         | TypeScript-first schema validation; essential at IPC boundary                     |
| **i18n**                 | i18next + react-i18next       | 26.3 / 17.0 | Standard i18n solution; supports namespaces                                       |
| **Test Framework**       | Vitest                        | 1.6         | Vite-native testing; zero config                                                  |

### 2.2 Key Dependency Rationale

#### Why not p-limit?

The project uses the in-house `concurrency.ts` (`runWithConcurrency`). Reason: p-limit v7+ became pure ESM; main process compiles to CommonJS where `require()` fails. The in-house implementation is only 30 lines and avoids ESM/CJS compatibility issues.

#### Why utilityProcess instead of worker_threads?

Electron 40 provides the `utilityProcess` API with process-level isolation, independent event loop, and independent V8 context — better suited for CPU-intensive tasks (sharp thumbnails, pHash computation) than worker_threads. The five workers (scanner / database / media / thumbnail / video) are independent; a single crash does not affect the main process.

#### Why better-sqlite3 instead of sqlite3?

better-sqlite3 is a synchronous API with 5-10x the performance of sqlite3 (async callbacks). Write operations are split into a separate process via utilityProcess to prevent synchronous I/O from blocking the main process event loop.

#### Why koffi instead of node-ffi-napi?

node-ffi-napi is no longer maintained. koffi is the modern replacement with better performance and complete TypeScript type support.

---

## 3. Process Model

### 3.1 Process Topology

```
┌──────────────────────────────────────────────────────────────────┐
│                      Main Process                                │
│                      src/main/index.ts                            │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ BrowserWindow │  │  IPC Handlers│  │  media:// Protocol    │  │
│  │  (Renderer)   │  │(~40 handlers)│  │  (Path Whitelist)     │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ DatabaseMgr   │  │ ScannerMgr   │  │ MediaWorkerMgr       │  │
│  │ (read sync)   │  │ (shell)      │  │ (shell)              │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         │                  │                     │              │
│         │   TaskScheduler  │                     │              │
│         │   (priority Q)   │                     │              │
│         │                  │                     │              │
└─────────┼──────────────────┼─────────────────────┼──────────────┘
          │                  │                     │
          ▼                  ▼                     ▼
   ┌──────────────┐   ┌──────────────┐    ┌──────────────────┐
   │  Database    │   │  Scanner     │    │  Media Worker    │
   │  Worker      │   │  Worker      │    │  (utilityProc)   │
   │  (utilityProc│   │  (utilityProc│    │                  │
   │              │   │              │    │  - Thumbnail     │
   │  - All DB    │   │  - Full scan │    │    batch         │
   │    writes    │   │  - Increment │    │  - pHash batch   │
   │  - Txn       │   │  - Signature │    │  - Duplicate     │
   │  - Batch     │   │  - Path      │    │    mark          │
   │              │   │    classify  │    │                  │
   └──────┬───────┘   └──────┬───────┘    └─────────┬────────┘
          │                  │                      │
          │                  │                      │
          └──────────────────┴──────────────────────┘
                             │
                             ▼
                   ┌─────────────────────┐
                   │  wxnn_photo_manager  │
                   │  .db (SQLite WAL)    │
                   │  userData/database/  │
                   └─────────────────────┘

   (Two additional utilityProcesses: thumbnail-worker — sharp scaling;
     video-worker — video-editing FFmpeg execution, see §5.6 / §5.12)
```

### 3.2 Process Responsibility Matrix

| Process              | Entry                                         | Responsibilities                                                                                                                                   | Communication                              |
| -------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Main Process**     | `src/main/index.ts`                           | BrowserWindow management, IPC handler registration, media:// protocol, nativeTheme sync, single-instance lock, startup orchestration, exit cleanup | ipcMain.handle / webContents.send          |
| **Renderer**         | `src/renderer/main.tsx`                       | UI rendering, user interaction, state management                                                                                                   | window.electronAPI (preload contextBridge) |
| **scanner-worker**   | `src/main/scanner/worker-entry.ts`            | Full/incremental/signature scanning, file metadata extraction, missing detection, legacy data repair                                               | utilityProcess.parentPort                  |
| **database-worker**  | `src/main/database/worker/database-worker.ts` | Handles all `media_files` / `categories` / `character_profiles` write operations (INSERT/UPDATE/DELETE/transactions)                               | utilityProcess.parentPort                  |
| **media-worker**     | `src/main/media-worker/worker-entry.ts`       | Thumbnail batch generation (sharp), pHash batch computation (DCT-II), duplicate marking (Union-Find)                                               | utilityProcess.parentPort                  |
| **thumbnail-worker** | `src/main/thumbnail/worker-entry.ts`          | sharp scaling implementation (CPU-intensive part migrated from ThumbnailGenerator)                                                                 | utilityProcess.parentPort                  |
| **video-worker**     | `src/main/video-editor/worker-entry.ts`       | FFmpeg command construction and execution for video editing, with progress reporting                                                               | utilityProcess.parentPort                  |

### 3.3 Communication Protocols

The five utilityProcesses use a consistent pattern but independent message protocols. All messages are serializable JSON. The protocols below cover scanner / database / media; thumbnail-worker (`THUMBNAIL_PROCESS_START` / `THUMBNAIL_WORKER_DISPOSE` → `WORKER_READY` / `THUMBNAIL_PROCESS_COMPLETE`) and video-worker (`EDIT_START` / `EDIT_STOP` / `EDITOR_DISPOSE` → `WORKER_READY` / `EDIT_PROGRESS` / `EDIT_COMPLETE`) are defined in `src/main/thumbnail/worker-protocol.ts` and `src/main/video-editor/worker-protocol.ts`.

#### scanner-worker Protocol

| Direction   | Message Type    | Fields                                                                     |
| ----------- | --------------- | -------------------------------------------------------------------------- |
| Main→worker | `SCAN_START`    | `dbPath`, `options: { path?, incremental?, customKnownPaths?, fullScan? }` |
| Main→worker | `SCAN_STOP`     | —                                                                          |
| Main→worker | `SCAN_DISPOSE`  | —                                                                          |
| worker→Main | `WORKER_READY`  | —                                                                          |
| worker→Main | `SCAN_PROGRESS` | `scanned`, `found`, `currentPath`, `status`                                |
| worker→Main | `SCAN_COMPLETE` | `success`, `message`, `filesFound?`                                        |
| worker→Main | `SCAN_LOG`      | `level`, `message`, `args?`                                                |
| worker→Main | `WORKER_ERROR`  | `message`, `stack?`                                                        |

#### database-worker Protocol

| Direction   | Message Type       | Fields                                        |
| ----------- | ------------------ | --------------------------------------------- |
| Main→worker | `DB_OPEN`          | `dbPath`                                      |
| Main→worker | `DB_EXECUTE`       | `requestId`, `statement: { sql, params? }`    |
| Main→worker | `DB_EXECUTE_BATCH` | `requestId`, `statements: DbStatement[]`      |
| Main→worker | `DB_TRANSACTION`   | `requestId`, `statements: DbStatement[]`      |
| Main→worker | `DB_DISPOSE`       | —                                             |
| worker→Main | `DB_READY`         | —                                             |
| worker→Main | `DB_RESULT`        | `requestId`, `success`, `result?`, `message?` |
| worker→Main | `DB_LOG`           | `level`, `message`, `args?`                   |
| worker→Main | `DB_WORKER_ERROR`  | `message`, `stack?`                           |

**Write Request Queue**: `DatabaseWorkerBridge` maintains `Map<requestId, {resolve, reject, sql, enqueuedAt}>`. When the worker returns `DB_RESULT`, it matches by `requestId` and resolves/rejects. On abnormal worker exit, all entries are rejected. `lastInsertRowid` is converted from bigint to number to avoid IPC precision loss.

#### media-worker Protocol

| Direction   | Message Type                                       | Fields                                                      |
| ----------- | -------------------------------------------------- | ----------------------------------------------------------- |
| Main→worker | `THUMBNAIL_BATCH_START`                            | `dbPath`, `cacheDir`, `thumbnailQuality`                    |
| Main→worker | `PHASH_BATCH_START`                                | `dbPath` (auto-chains `markDuplicates` on completion)       |
| Main→worker | `DUPLICATE_MARK_START`                             | `dbPath`                                                    |
| Main→worker | `THUMBNAIL_STOP` / `PHASH_STOP` / `DUPLICATE_STOP` | Each cancels independently                                  |
| Main→worker | `MEDIA_WORKER_DISPOSE`                             | —                                                           |
| worker→Main | `WORKER_READY`                                     | —                                                           |
| worker→Main | `THUMBNAIL_PROGRESS` / `THUMBNAIL_COMPLETE`        | `processed`, `total`, `currentFile?`                        |
| worker→Main | `PHASH_PROGRESS` / `PHASH_COMPLETE`                | `processed`, `total`, `duplicatesResult?`                   |
| worker→Main | `DUPLICATE_PROGRESS` / `DUPLICATE_COMPLETE`        | `compared`, `totalPairs`, `markedDuplicates`, `totalGroups` |
| worker→Main | `MEDIA_WORKER_LOG` / `WORKER_ERROR`                | —                                                           |

### 3.4 Startup and Shutdown Sequence

#### Startup Flow (`Application.initialize()`)

```
1. app.requestSingleInstanceLock()
   ├─ Failure: 3 retries (1s interval)
   ├─ Still fails: dialog "Clean & Restart / Manual / Exit"
   └─ User picks "Clean & Restart": taskkill /F /T /PID → app.relaunch + app.exit(0)

2. app.whenReady()

3. Register global exception handlers (uncaughtException / unhandledRejection)
   ├─ logStartupError → startup-errors.log
   ├─ First-time showErrorBox dialog
   └─ app.releaseSingleInstanceLock + app.exit(1)

4. dbManager.initialize()
   ├─ Open wxnn_photo_manager.db
   ├─ PRAGMA optimizations (WAL/synchronous=NORMAL/cache_size=20MB/mmap_size=256MB)
   ├─ runMigrations() (schema_migrations table tracking)
   └─ setWorkerBridge(databaseWorkerBridge)

5. applyCustomDirectories() (4 dirs: backup/thumbnail/log/crash)
   ├─ resolveCustomDir → ensureDir → migrateDirFiles (async)
   └─ Failure of any one does not block others

6. initLogger() (non-blocking on failure)

7. crashReporter.start() + initCrashDir()

8. backupService.init() + scheduleStartupBackup()
   editorService.init() + setScheduler()

9. registerMediaProtocol() (media:// protocol)

10. scannerManager.setDbPath() + mediaWorkerManager.setDbPath()

11. setupIPC() (register ~15 domain IPC handlers + pathGuard init)

12. createMainWindow()
    ├─ loadFile('dist/renderer/index.html')
    └─ ready-to-show → taskScheduler.resume()

13. applyUITheme() + cleanupAndRepairDatabase() + setupThemeListener()

14. ensureDesktopShortcut() (packaged env only, fire-and-forget)

15. Post-startup delayed tasks (taskScheduler.enqueueLow):
    ├─ STARTUP_SCAN_DELAY_MS (5000ms) → performStartupScan()
    ├─ +5s → thumbnailGen.enforceLimitNow()
    └─ +6s → enforceCrashLimit()
    Concurrent: thumbnailGen.startLruBackgroundTask() (every 5 min)

16. before-quit handler:
    ├─ event.preventDefault() + isCleaningUp=true
    ├─ Dynamic timeout based on WAL size (2s / 5s)
    ├─ forceExitTimer (force exit on timeout)
    └─ performCleanup().finally() → app.exit(0)
```

#### Shutdown Flow (`performCleanup()`)

```
1. Collect before-cleanup diagnostics (active handles/requests/child processes)

2. Clean startupTimers + mediaUpdateTimer

3. killAllProcesses('SIGKILL')  // ffmpeg/ffprobe/PowerShell

4. taskScheduler.pause() + cancelAllLow()

5. scannerManager.stopScan()

6. scannerWorkerBridge.dispose() (1s timeout)

7. mediaWorkerBridge.dispose() (1s timeout)

8. databaseWorkerBridge.dispose() (1s timeout, includes WAL checkpoint)

9. wifiShareService.stop()

10. backupService.dispose()

11. thumbnailGen.stopLruBackgroundTask() + flushAccessTimes()

12. dbManager.close()
    ├─ PRAGMA optimize
    ├─ PRAGMA wal_checkpoint(PASSIVE)
    └─ db.close()

13. app.releaseSingleInstanceLock()

14. disposeDecryptionService() (koffi DLL unload)

15. Synchronously write exit diagnostics to faults-*.jsonl (fs.appendFileSync)
```

---

## 4. Directory Structure

```
wxnn-photo-manager/
├── docs/                              # Project documentation
│   ├── archive/                       # Archived docs (plans, reports, specs, old architecture docs)
│   ├── i18n/                          # i18n refactor SOP and whitelist status snapshot
│   ├── plans/                         # Recent implementation plans and reports
│   ├── screenshots/                   # Screenshots
│   ├── storybook/                     # Storybook MDX guides
│   ├── tutorial/                      # User tutorial (MD + single-file edition)
│   └── IPC_CONTRACT.md / PLUGIN_API.md etc.
├── resources/                         # App resources
│   ├── icons/                         # App icons (ico/svg)
│   └── nuan5_decryption.dll           # Game photo param decryption DLL
├── scripts/                           # Build helper scripts
│   ├── after-pack-vc-runtime.cjs      # afterPack VC++ runtime copy
│   ├── pre-dist-check.ts              # Pre-package check (artifact timestamps/fixpoints/git clean)
│   ├── check-doc-versions.ts          # README Electron version consistency check
│   ├── check-i18n-keys.ts             # i18n key completeness check
│   ├── check-preview-drift.ts         # HTML preview drift check
│   ├── generate-icon.js               # Icon generation
│   ├── copy-resonance-thumbnails.ts / generate-resonance-*.ts / sync-i18n-keys.ts
│   ├── electron-browser-stub.js       # electron stub for preview / Storybook
│   ├── i18n/                          # i18n extraction/guard scripts
│   └── perf-test/                     # Performance baseline scripts
├── src/
│   ├── main/                          # Main process
│   │   ├── app/                       # App lifecycle management (23 source files)
│   │   │   ├── application.ts         # App main class (phased orchestration)
│   │   │   ├── lifecycle.ts           # Lifecycle management (single-instance lock etc.)
│   │   │   ├── cleanup.ts             # Exit cleanup
│   │   │   ├── startup-tasks.ts       # Startup tasks
│   │   │   ├── startup-environment.ts # Startup environment checks
│   │   │   ├── window-manager.ts      # Window management
│   │   │   ├── navigation-guard.ts    # Navigation trust check (will-navigate interception)
│   │   │   ├── desktop-shortcut.ts    # Desktop shortcut
│   │   │   ├── error-handlers.ts      # Error handling
│   │   │   ├── ipc-setup.ts           # IPC registration orchestration
│   │   │   ├── media-protocol.ts      # media:// protocol
│   │   │   ├── renderer-protocol.ts   # app:// renderer document protocol
│   │   │   ├── renderer-bridge.ts     # Renderer event bridge
│   │   │   ├── media-update.ts        # Media update notification
│   │   │   ├── recovery.ts            # Recovery logic
│   │   │   ├── theme.ts               # Theme sync
│   │   │   ├── custom-dirs.ts         # Custom directory management
│   │   │   ├── auto-update.ts         # Auto update
│   │   │   ├── exit-forensics.ts      # Exit forensics
│   │   │   ├── gpu-fallback.ts        # GPU fallback decision
│   │   │   ├── native-load-guard.ts   # Native module load pre-check
│   │   │   ├── permission.ts          # Permission management
│   │   │   └── app-context.ts         # App context
│   │   ├── database/                  # Database layer
│   │   │   ├── connection.ts          # DatabaseManager
│   │   │   ├── media-repository.ts    # MediaRepository (SQL access layer)
│   │   │   ├── resonance-repository.ts # Resonance repository
│   │   │   ├── import-root-repository.ts # Import-root repository
│   │   │   ├── sql-chunk.ts           # SQL chunking utility
│   │   │   └── worker/                # database-worker (utilityProcess)
│   │   ├── scanner/                   # Scanner
│   │   │   ├── index.ts               # ScannerManager (thin shell)
│   │   │   ├── scanner-worker-bridge.ts
│   │   │   ├── path-classifier.ts     # Path classification pure functions
│   │   │   ├── scan-channels.ts       # Scan channel orchestration
│   │   │   ├── game-directory-discovery.ts # Three-channel game directory discovery
│   │   │   ├── repair-legacy-data-v1..v6.ts # Legacy data repair series
│   │   │   ├── worker-entry.ts        # scanner-worker entry
│   │   │   └── worker-protocol.ts
│   │   ├── media-worker/              # media-worker (thumbnail/pHash/duplicate)
│   │   │   ├── manager.ts             # MediaWorkerManager (thin shell)
│   │   │   ├── bridge.ts
│   │   │   ├── bktree-index.ts / bktree-js.ts # pHash BK-tree index
│   │   │   ├── worker-entry.ts
│   │   │   └── worker-protocol.ts
│   │   ├── scheduler/
│   │   │   └── task-scheduler.ts      # Priority task scheduler queue
│   │   ├── thumbnail/
│   │   │   ├── generator.ts           # ThumbnailGenerator (single generation + LRU)
│   │   │   └── worker-*.ts            # thumbnail-worker (utilityProcess: sharp scaling)
│   │   ├── services/                  # Business service layer (13 services)
│   │   │   ├── file-service.ts
│   │   │   ├── video-service.ts
│   │   │   ├── watermark-service.ts
│   │   │   ├── backup-service.ts
│   │   │   ├── crash-service.ts
│   │   │   ├── livephoto-service.ts
│   │   │   ├── editor-service.ts
│   │   │   ├── share-clipboard-service.ts
│   │   │   ├── share-wifi-service.ts
│   │   │   ├── thumbnail-phash-service.ts
│   │   │   ├── decryption-service.ts
│   │   │   ├── xmp-metadata-service.ts
│   │   │   └── log-service.ts
│   │   ├── ipc/                       # IPC layer
│   │   │   ├── handler-context.ts     # Dependency injection context
│   │   │   ├── validator.ts           # wrapHandler + PathGuard + schemas
│   │   │   ├── media-read-guard.ts    # assertMediaReadPath (with realpath re-check)
│   │   │   └── handlers/              # ~40 domain files (incl. set-dir-handler factory and _shared helpers)
│   │   │       ├── media-handler.ts / media-lifecycle-handler.ts / media-cleanup-handler.ts
│   │   │       ├── file.ts / file-export-handler.ts / file-rename-handler.ts
│   │   │       ├── video.ts / watermark.ts / editor.ts
│   │   │       ├── editor-metadata-handler.ts / editor-preset-handler.ts / export-pref-handler.ts
│   │   │       ├── backup.ts / cache.ts / log.ts / crash.ts
│   │   │       ├── share.ts / scanner-handler.ts / scan-log-handler.ts / shell-handler.ts
│   │   │       ├── app-handler.ts / settings-handler.ts / theme-handler.ts
│   │   │       ├── dialog-handler.ts / import-handler.ts / import-root-handler.ts / data-handler.ts
│   │   │       ├── decrypt-handler.ts / duplicate-handler.ts / similar-handler.ts
│   │   │       ├── operation-history-handler.ts / task-handler.ts
│   │   │       ├── profile-handler.ts / search-index-handler.ts
│   │   │       ├── thumbnail-handler.ts / category-handler.ts / plugin.ts / plugin-bridge-handler.ts
│   │   │       ├── resonance-handler.ts
│   │   │       └── set-dir-handler.ts
│   │   ├── plugins/                   # Plugin host
│   │   │   ├── plugin-host.ts         # Plugin loading and lifecycle
│   │   │   └── permission-guard.ts    # Permission validation
│   │   ├── video-editor/              # Video editor subprocess
│   │   │   ├── bridge.ts              # Main process bridge
│   │   │   ├── filter-builder.ts      # FFmpeg filter construction
│   │   │   ├── watermark-builder.ts   # Watermark overlay
│   │   │   ├── types.ts               # Video editing type definitions
│   │   │   ├── worker-entry.ts        # Worker process entry
│   │   │   └── worker-protocol.ts     # Message protocol
│   │   ├── i18n/                      # Main process i18n
│   │   │   ├── index.ts
│   │   │   └── worker-safe.ts         # Worker-side pure lookup translation
│   │   ├── utils/                     # Main process utilities (26 modules)
│   │   │   ├── active-task-store.ts / concurrency.ts / constants.ts / dir-manager.ts
│   │   │   ├── disk.ts / duplicate-scoring.ts / early-crash-guard.ts / eta-calculator.ts
│   │   │   ├── ffmpeg-paths.ts / ffmpeg-runner.ts / file-utils.ts / ipc-validate.ts
│   │   │   ├── logger.ts / managed-read-stream.ts / media-constants.ts / path-safety.ts
│   │   │   ├── phash.ts / process-registry.ts / progress-throttle.ts
│   │   │   ├── scene-brightness.ts / startup-diagnostic.ts
│   │   │   ├── task-registry.ts / user-diag-path.ts / video-frame.ts / video-probe.ts
│   │   │   └── worker-restart-policy.ts
│   │   ├── types/                     # Main process type declarations
│   │   │   ├── decryption.ts / file.ts / ipc.ts
│   │   │   ├── ffprobe-static.d.ts / koffi.d.ts
│   │   ├── index.ts                   # Main process entry (early guards + protocol registration + Application bootstrap)
│   │   ├── preload.ts                 # preload entry (assembly + contextBridge exposure)
│   │   ├── preload-logger.ts          # Renderer log forwarding preload
│   │   ├── preload/                   # preload split modules (ipc base layer / plugin-bridge / api/ 30 namespaces)
│   │   └── tsconfig.json
│   ├── renderer/                      # Renderer process
│   │   ├── assets/                    # Static assets
│   │   │   ├── cloth-names.json       # 7369 clothing names
│   │   │   └── outfit-names.json      # 657 outfit names
│   │   ├── components/
│   │   │   ├── common/                # Common components (30+)
│   │   │   ├── editor/                # Editor components (12)
│   │   │   ├── gallery/               # Gallery components (16)
│   │   │   ├── layout/                # Layout components (AppShell/Sidebar/TitleBar)
│   │   │   ├── resonance/             # Resonance Records view components
│   │   │   ├── scanner/               # Scanner components (ScanButton/ScanProgress)
│   │   │   └── video/                 # VideoPlayer
│   │   ├── data/resonance/            # Resonance static data (catalog/banners/percentile/12-language names/thumbnails)
│   │   ├── hooks/                     # 23 custom hooks
│   │   ├── i18n/                      # Internationalization
│   │   │   ├── index.ts
│   │   │   └── locales/               # 12 language JSON files
│   │   ├── icons/                     # 74 SVG icons centrally managed (single file)
│   │   │   └── index.tsx
│   │   ├── pages/                     # 9 pages
│   │   │   ├── settings/              # Settings page sections (split by group)
│   │   │   ├── GalleryPage.tsx
│   │   │   ├── CategoriesPage.tsx
│   │   │   ├── DetailPage.tsx
│   │   │   ├── DuplicatesPage.tsx
│   │   │   ├── EditorPage.tsx
│   │   │   ├── OutfitGalleryPage.tsx
│   │   │   ├── RecycleBinPage.tsx
│   │   │   ├── ResonanceRecordsPage.tsx
│   │   │   └── SettingsPage.tsx
│   │   ├── plugins/                  # Plugin runtime (plugin-runtime.ts)
│   │   ├── preview/                   # Preview mock data and install scripts
│   │   │   ├── index.html             # Preview entry HTML
│   │   │   ├── mock/                  # Mock data (media/categories/resonance...)
│   │   │   └── install.ts             # Preview environment setup
│   │   ├── search/                    # Full-text search index
│   │   │   ├── search-index.ts        # FlexSearch index management
│   │   │   ├── search-service.ts      # Search service
│   │   │   ├── doc-builder.ts         # Document builder
│   │   │   └── use-search-index.ts    # Search hook
│   │   ├── stores/                    # 6 Zustand stores
│   │   │   ├── mediaStore.ts
│   │   │   ├── uiStore.ts
│   │   │   ├── themeStore.ts
│   │   │   ├── operationHistoryStore.ts
│   │   │   ├── resonanceStore.ts
│   │   │   └── pluginStore.ts
│   │   ├── styles/
│   │   │   ├── globals.css            # Global styles + CSS variables
│   │   │   └── themes/
│   │   │       ├── index.ts
│   │   │       └── soft-pink-luxury.css
│   │   ├── types/
│   │   │   └── decryption.ts
│   │   ├── utils/                     # 23 utility files (incl. resonance/ subdir of pure functions)
│   │   ├── App.tsx                    # App root component
│   │   ├── main.tsx                   # Renderer process entry
│   │   ├── preview-entry.tsx          # Preview entry
│   │   ├── index.html
│   │   └── vite-env.d.ts
│   └── shared/                        # Cross-process shared layer
│       ├── errors/
│       │   ├── app-error.ts           # AppError class and 6 subclasses
│       │   └── error-codes.ts         # Error codes and category mapping
│       ├── types/                     # Shared type definitions (14 domain modules + index)
│       │   ├── media.ts / category.ts / profile.ts / editor.ts
│       │   ├── watermark.ts / settings.ts / ipc.ts / ipc-types.ts
│       │   ├── progress.ts / plugin.ts / editor-metadata.ts / duplicate.ts
│       │   ├── resonance.ts / electron-api.ts
│       │   └── index.ts
│       ├── utils/                     # concurrency.ts / taskStages.ts
│       ├── settings-keys.ts           # Renderer-writable preference key whitelist
│       ├── dimension.ts               # Smart grouping dimensions
│       └── scene-category.ts          # Game scene categories
├── tests/
│   ├── setup.ts
│   └── mocks/                         # electron / sqlite / parent-port test stubs
├── tools/                             # Auxiliary tools
│   ├── image-decode-analysis/
│   └── scripts/
├── .gitignore / .npmrc / .prettierrc / .prettierignore
├── .husky/ / commitlint.config.cjs    # Git hooks and commit validation
├── electron.vite.config.ts            # Main/preload/renderer three-segment build config
├── vite.preview.config.ts             # Single-file preview build config
├── eslint.config.js
├── package.json
├── postcss.config.cjs
├── tailwind.config.ts
├── tsconfig.json / tsconfig.scripts.json
├── vitest.config.ts
└── README.md
```

---

## 5. Main Process Module Responsibilities (src/main)

### 5.1 Entry and Lifecycle

#### `index.ts` — Bootstrap

The earliest main-process entry, responsible for:

- **Earliest exception capture**: uncaughtException / unhandledRejection persisted to startup-errors.log via startup-diagnostic
- **crashDumps redirection**: crash dumps output to `Documents/NikkiGallery/Diagnostics` (`user-diag-path.ts`); Chromium native log persisted with rotation
- **GPU fallback decision**: `recordBootDecision()` → `disableHardwareAcceleration()` when required
- **Protocol privilege declaration**: `registerSchemesAsPrivileged` registers media:// and app://
- **Application bootstrap**: after `app.whenReady()`, dynamically imports Application from `app/application.ts` and calls `initialize()`

#### `app/application.ts` — Application Class (Phased Orchestration)

`Application.initialize()` orchestrates the following (module implementations in §5.10):

- **Single-instance lock management**: `requestSingleInstanceLock` + 3 retries + three-option dialog (Clean & Restart / Manual / Exit)
- **Phased initialization**: DB → custom directories → logger → crash → backup → IPC → window → theme → post-startup tasks
- **media:// protocol registration and whitelist**: 5-layer LRU cached path validation
- **Theme sync**: `applyUITheme` syncs nativeTheme + TitleBarOverlay + setBackgroundColor
- **Startup scan**: First launch forces full scan; subsequent launches follow user settings
- **Scene time auto-analysis**: Infers day/night/dawn/dusk from image brightness histogram
- **Database cleanup & repair**: Stale record deletion + missing thumbnail repair + orphan thumbnail cleanup
- **before-quit async cleanup**: Includes WAL checkpoint + child process kill + worker dispose + force timeout fallback

#### `preload.ts` + `preload/` — contextBridge Bridge Layer

Namespace-oriented split refactor (Aug 2026): the original 1176-line monolithic file was split into an
entry assembly plus a module tree by functional domain. The external contract (global names / method
signatures / channel strings) is unchanged, guarded by unit tests (`preload/__tests__/`).

- `preload.ts` entry: assembles `electronAPI` (reportReady + 30 namespaces) and performs 5 `exposeInMainWorld`
  calls — all gated by `exposeIfTrusted()`: untrusted documents (origin not app:// / media:// / dev 5173) get zero exposure
- `preload/ipc.ts`: `IpcError` class + unified call entry `call<T>(channel, ...args)` (unwraps `IpcResponse<T>`, throws `IpcError` on failure) + `subscribe` event helper
- `preload/api/*.ts`: one namespace object per file (`scannerAPI`, `fileAPI`…); methods and channel strings are verbatim identical to pre-split
- `preload/plugin-bridge.ts`: plugin capability bridge (`window.pluginAPI`) and the `__setPluginI18nT` injection point
- `preload/origin-guard.ts`: document origin self-check (second defense line); allow-set mirrors `app/navigation-guard.ts`
- Business DTO type snapshots live in `src/shared/types/electron-api.ts` (the preload layer no longer inlines type definitions)
- Zero-dependency constraint enforced mechanically by tests: only `electron` allowed at runtime; shared imports must be type-only

### 5.2 Database Layer (database/)

#### `connection.ts` — DatabaseManager

- Opens the better-sqlite3 connection, runs schema migrations and PRAGMA optimizations
- **Does not perform business writes** — write operations are forwarded to the worker process via `executeAsync`
- Named migration tracking (`schema_migrations` table): `safeAddColumn` / `isMigrationApplied` / `markMigrationApplied`
- Settings read/write: `getSetting<T>` / `setSetting<T>` (with runtime type validation)
- `PRAGMA optimize` + `wal_checkpoint(PASSIVE)` before close

#### `media-repository.ts` — MediaRepository

- Pure SQL access layer extracted from the original 34 inlined IPC handlers in `media.ts` (seam)
- **Writes go async via worker**, **reads go synchronous on main process db**
- Can be instantiated against an in-memory database; this is the test seam

#### `worker/` — database-worker Process

- `database-worker-bridge.ts`: Main-process side bridge; lazily forks worker, maintains `requestId → Promise` write request queue
- `database-worker.ts`: Worker process entry; independently holds a better-sqlite3 connection (WAL multi-connection safe); only responds to 4 write commands
- `worker-protocol.ts`: Message protocol type definitions

### 5.3 Scanner (scanner/)

#### `index.ts` — ScannerManager (thin shell)

After splitting, only the interface shell remains. Forwards start/stop via `ScannerWorkerBridge`, subscribes to worker events and re-emits `progress` / `complete` via EventEmitter.

#### `scanner-worker-bridge.ts` — ScannerWorkerBridge

Lazily forks worker, forwards `SCAN_START/STOP/DISPOSE`, receives worker events. On abnormal worker exit, if `isScanning=true`, synthesizes a failed `SCAN_COMPLETE` event to avoid being stuck in running state.

#### `path-classifier.ts` — Path Classification Pure Functions

Three functions jointly determine `media_source` / `album_type` / `account_uid` for each photo on ingest:

- `extractUidFromPath` — UID regex `[\\/](\d{6,12})[\\/]`; inside the GamePlayPhotos subtree the anchor regex (`GPP_ANCHOR_UID`) takes priority; returns `'default'` when unmatched
- `extractAlbumTypeFromPath` — Parent directory name matches `ALBUM_TYPE_MAP` (22 game album folders)
- `extractMediaSourceFromPath` — Order-sensitive rules: `launcher\cache` / `\MallPic\` / `\X6Game\Saved\ScreenShot\` / `\CloudPhotos\Temp\` → launcher; `\CloudPhotos\` → cloud; else → game

#### `worker-entry.ts` — Scanner Worker Process Entry

Carries all core scanning logic:

- `findMediaDirectories` — Game directory lookup priority: user custom → hardcoded defaults → Steam registry + libraryfolders.vdf → Epic registry → full-disk signature search (depth 15, with shallow depth 4 fast pass first)
- `scanDirectory` — Recursively scans media files; skips system directories (Windows/ProgramData/$recycle.bin/onedrive/iclouddrive etc.)
- `saveBatchToDatabase` — Batch ingest (transactional batch writes via worker)
- `checkMissingFiles` — Detects missing files, marks `is_missing`
- `repairLegacyData` — Repairs old data (recomputes records with `media_source='unknown'`)

### 5.4 Media Worker (media-worker/)

#### `manager.ts` — MediaWorkerManager (thin shell)

Forwards three task types via `MediaWorkerBridge` (thumbnail batch / pHash batch / duplicate marking); maintains pendingPromise and mutex flags for each task type.

#### `bridge.ts` — MediaWorkerBridge

Lazily forks worker, forwards 7 command types, receives 9 event types and dispatches them. Synthesizes failed `*_COMPLETE` events on abnormal worker exit.

#### `worker-entry.ts` — Media Worker Process Entry

- **Thumbnail batch generation**: Based on sharp; supports low (64px) / standard (320px) / high (512px) tiers
- **pHash batch computation**: DCT-II 8x8 perceptual hash, 64-character 0/1 string
- **Duplicate marking**: Union-Find clustering; images with Hamming distance ≤ threshold are grouped; 4-dimensional smart scoring recommends keeper

### 5.5 Task Scheduler (scheduler/)

#### `task-scheduler.ts` — TaskScheduler

Main-process side priority task scheduler, layered above the utilityProcess workers:

- **High priority** (`runHighPriority<T>`): User-initiated; runs immediately; can preempt running low-priority tasks (via `cancel` callback, max wait 2000ms)
- **Low priority** (`enqueueLow`): Background-initiated; FIFO queue; serial execution (`maxLowConcurrency = 1`); pumps when high-priority is idle
- `pause()` during startup, `resume()` after main window `ready-to-show`
- Events: `low-task-start` / `low-task-complete` / `high-task-start` / `high-task-complete` / `preempt`

### 5.6 Thumbnail Generator (thumbnail/)

#### `generator.ts` — ThumbnailGenerator

- Generates multi-tier thumbnails via sharp; extracts video first frame via ffmpeg
- **LRU eviction** (default 2GB cap, configurable); content-hash naming (first 1MB)
- Concurrent generation mutex (`generatingLocks`)
- Background periodic LRU calibration task (every 5 min; triggers cleanup only when exceeding threshold by 10%)
- Supports custom cache directory

### 5.7 Business Service Layer (services/)

| Service                          | Responsibilities                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FileService**                  | File operations (recycle bin delete/copy/move/rename/export/import), EXIF passthrough, naming rule variables `{date}/{album_type}/{uid}/{original_name}/{sequence}` |
| **VideoService**                 | Video processing (metadata/export/frame capture/trim/speed change); timeout cleanup of partial outputs to avoid residue                                             |
| **WatermarkService**             | Batch watermark application (text + image, 16 blend modes, SVG overlay composition)                                                                                 |
| **BackupService** (singleton)    | Database backup management (auto backup 5s after startup, 7-day min interval, 5-copy LRU retention)                                                                 |
| **CrashService**                 | Crash dump file management (10-copy retention + 30-day expiry)                                                                                                      |
| **LivePhotoService** (singleton) | Apple Live Photo export (JPG + MOV pairing, UUID v4 as ContentIdentifier)                                                                                           |
| **EditorService** (singleton)    | Image edit save (sharp pipeline, original backup to `editor-snapshots`, 50-copy LRU retention)                                                                      |
| **ShareClipboardService**        | Clipboard sharing (CF_HDROP format), 4-layer channel detection (registry/uninstall entries/common dirs/process path reverse lookup)                                 |
| **WifiShareService** (singleton) | WiFi LAN sharing (local IP binding, PIN auth, Range request support)                                                                                                |
| **ThumbnailPhashService**        | 4 shared functions (startup path and IPC path share one impl); forwards to media-worker                                                                             |
| **DecryptionService**            | Game photo param decryption (koffi calls nuan5_decryption.dll, ABI validation + async mutex serialization)                                                          |
| **LogService**                   | Fault record management (faults-*.jsonl reading, cache invalidation, ZIP export)                                                                                    |
| **XmpMetadataService**           | XMP metadata write/read (serializes EditorMetadata into a custom `wxnn:` namespace XMP packet; single and batch writes)                                             |

### 5.8 IPC Layer (ipc/)

#### `handler-context.ts` — Dependency Injection Context

`Application.setupIPC()` constructs a `HandlerContext` object passed to each domain's register function, preventing handlers from directly accessing the Application instance. Fields include:

```
dbManager / scannerManager / mediaWorkerManager / taskScheduler /
thumbnailGen / fileService / videoService / watermarkService /
getMainWindow() / notifyMediaUpdated() / invalidateMediaPathCache() /
applyUITheme(theme) / isThumbnailsGenerating() / setThumbnailsGenerating(v)
```

#### `validator.ts` — IPC Validation Core

Three major capabilities:

1. **`wrapHandler` / `wrapHandlerNoArgs` / `wrapHandlerRaw`** higher-order functions:
   - zod validates params → returns `IPC_VALIDATION_ERROR` on failure
   - Calls handler
   - Success → `{success:true, data: T}`
   - Throws AppError → `{success:false, error: AppError.toIpcError()}`
   - Throws plain Error → tags `INTERNAL_ERROR` + logger.error

2. **`PathGuard` path whitelist**:
   - Default deny
   - Safe roots (user home dir, userData dir) always allowed
   - Dynamic registration (scanner-discovered media dirs, dialog-selected dirs)
   - System sensitive dir blacklist always denied (`SYSTEM_SENSITIVE_DIRS`: Windows/ProgramData/$recycle.bin/System32 etc.)

3. **`schemas`** common zod schema collection: `filePath` / `filePathArray` / `mediaId` / `mediaIdArray` / `rating` / `positiveIntId` / `shortString` / `uid` / `httpUrl` / `uiTheme` / `thumbnailQuality` / `backupFilename` / `shortId` / `cacheLimitBytes`

#### `handlers/` — ~40 Domain Files (incl. set-dir-handler factory and `_shared` helpers)

| Module                         | Responsibilities                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `media-handler.ts`             | Media domain (list/findDuplicates/findSimilar/getGroupCounts/rating/favorite/tags/notes/category/outfit/softDelete/restore/permanentDelete/empty/missing cleanup/outfit almanac etc.) |
| `media-lifecycle-handler.ts`   | Media lifecycle management (missing detection/repair/cleanup)                                                                                                                         |
| `media-cleanup-handler.ts`     | Missing and corrupted record cleanup (cleanupMissing/removeMissing/cleanupCorrupted/removeCorrupted)                                                                                  |
| `file.ts`                      | File ops (delete/copy/getExif); path whitelist validation                                                                                                                             |
| `file-export-handler.ts`       | File export / save-as (file:export with default dir and naming rules / file:saveAs)                                                                                                   |
| `file-rename-handler.ts`       | File rename / move (file:move / file:rename / file:batchRename)                                                                                                                       |
| `video.ts`                     | Video (thumbnail/metadata/export/captureFrame/trim/changeSpeed/exportLivePhoto)                                                                                                       |
| `watermark.ts`                 | Watermark (apply/saveTemplate/loadTemplates/deleteTemplate + progress push)                                                                                                           |
| `editor.ts`                    | Editor (save/saveAs/preset CRUD/importPresetFromFile/exportPresetToFile)                                                                                                              |
| `editor-metadata-handler.ts`   | Editor XMP metadata (export copy with params + one-click edit param restore)                                                                                                          |
| `editor-preset-handler.ts`     | Filter presets (persist / JSON file import-export / list / delete)                                                                                                                    |
| `export-pref-handler.ts`       | Export preference read/write                                                                                                                                                          |
| `backup.ts`                    | Backup (create/list/restore/delete + setDir/resetDir/getDir)                                                                                                                          |
| `cache.ts`                     | Cache (getStats/clean/setLimit/enforceLimit + setDir/resetDir/getDir)                                                                                                                 |
| `log.ts`                       | Logs (listFaults/getDetail/openDir/exportZip/clear/getStats + setDir/resetDir/getDir + reportRendererError)                                                                           |
| `crash.ts`                     | Crash (list/stats/openDir/clear + setDir/resetDir/getDir)                                                                                                                             |
| `share.ts`                     | Share (startWifi/stop/getStatus + copyFiles/detectApp/launchApp)                                                                                                                      |
| `scanner-handler.ts`           | Scanner (start/stop/status)                                                                                                                                                           |
| `scan-log-handler.ts`          | Scan diagnostic logs (read-only query and export for the diagnostics tool page)                                                                                                       |
| `shell-handler.ts`             | System operations (openPath/showItemInFolder/openExternal)                                                                                                                            |
| `app-handler.ts`               | App info (getStatus/getVersions)                                                                                                                                                      |
| `settings-handler.ts`          | App settings read/write (get/set)                                                                                                                                                     |
| `theme-handler.ts`             | Theme switching (set)                                                                                                                                                                 |
| `dialog-handler.ts`            | File/directory selection dialogs (openFile/openDirectory)                                                                                                                             |
| `import-handler.ts`            | File import (importFiles)                                                                                                                                                             |
| `import-root-handler.ts`       | Import root directory management                                                                                                                                                      |
| `data-handler.ts`              | Data management (clear/reset)                                                                                                                                                         |
| `decrypt-handler.ts`           | Game parameter decryption                                                                                                                                                             |
| `duplicate-handler.ts`         | Duplicate detection                                                                                                                                                                   |
| `similar-handler.ts`           | Similar image search                                                                                                                                                                  |
| `operation-history-handler.ts` | Operation history (undo/redo)                                                                                                                                                         |
| `task-handler.ts`              | Background task management (onStandby etc.)                                                                                                                                           |
| `profile-handler.ts`           | Character profile management                                                                                                                                                          |
| `search-index-handler.ts`      | Search index                                                                                                                                                                          |
| `thumbnail-handler.ts`         | Thumbnail generation                                                                                                                                                                  |
| `category-handler.ts`          | Category management                                                                                                                                                                   |
| `plugin.ts`                    | Plugin management                                                                                                                                                                     |
| `plugin-bridge-handler.ts`     | Plugin capability bridge (controlled media/db/fs/watermark/task/i18n calls, with `permission-guard` validation)                                                                       |
| `resonance-handler.ts`         | Resonance Records (9 channels: getData/manual record CRUD/readImportFile/commitImport/export/updateWardrobe/clearAll)                                                                 |
| `set-dir-handler.ts`           | Factory: `registerSetDirHandler` / `registerResetDirHandler`; eliminates 4 isomorphic templates                                                                                       |

### 5.9 Utility Layer (utils/)

| File                       | Responsibilities                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active-task-store.ts`     | Active task state store (for task progress query and cancellation)                                                                                      |
| `concurrency.ts`           | In-house concurrency control (`runWithConcurrency`); replaces p-limit to avoid ESM/CJS compatibility                                                    |
| `constants.ts`             | Main process global named constants (STARTUP_SCAN_DELAY_MS=5000, THUMBNAIL_CONCURRENCY=4, MEDIA_CACHE_TTL_MS=5min etc.)                                 |
| `dir-manager.ts`           | Custom directory management (4 features with configurable paths); `resolveCustomDir` / `ensureDir` / `migrateDirFiles`                                  |
| `disk.ts`                  | Disk space check `assertDiskSpace` (based on `fsp.statfs`)                                                                                              |
| `duplicate-scoring.ts`     | Smart dedupe scoring (4 dims: resolution 40 + file size 30 + capture time 20 + favorite weight 10)                                                      |
| `early-crash-guard.ts`     | Early fatal error reporting (`reportEarlyFatal`: persist diagLog + showErrorBox + release single-instance lock + exit)                                  |
| `ffmpeg-paths.ts`          | Unified ffmpeg/ffprobe binary path resolver; `resolveAsarUnpackedPath` replaces `app.asar` → `app.asar.unpacked`                                        |
| `ffmpeg-runner.ts`         | ffmpeg command execution utility; unified trackFfmpegCommand register/unregister + timeout + event handling                                             |
| `file-utils.ts`            | Filesystem utilities (pathExists/getUniqueFilePath/parseDataUrlToBuffer/bufferToDataUrl/moveFile/calculateFileHash)                                     |
| `ipc-validate.ts`          | IPC param validation utilities (SYSTEM_SENSITIVE_DIRS blacklist + validateFilePath/validateMediaId etc.)                                                |
| `logger.ts`                | Log management (10 FaultTypes, FaultRecord with full env info, 2GB cap with oldest-by-mtime eviction)                                                   |
| `managed-read-stream.ts`   | File read-stream lifecycle utility (`createManagedReadStream`: error listener + AbortSignal cancellation + fd release)                                  |
| `media-constants.ts`       | Unified media extension and MIME type constants (IMAGE/VIDEO/MEDIA_EXTENSIONS, ALBUM_TYPE_MAP 22 entries)                                               |
| `path-safety.ts`           | Path safety utilities (sensitive dir detection / read-only dir detection etc.)                                                                          |
| `phash.ts`                 | Perceptual hash computation (8x8 DCT-II 64-bit hash, precomputed cosine matrix)                                                                         |
| `process-registry.ts`      | Global active child process registry (trackProcess/trackFfmpegCommand/killAllProcesses, 60s fallback cleanup)                                           |
| `progress-throttle.ts`     | Task progress push throttling                                                                                                                           |
| `scene-brightness.ts`      | Image brightness histogram-based scene time analysis (sharp.stats() + BT.601 weighting)                                                                 |
| `startup-diagnostic.ts`    | Startup diagnostics (independent error recording before logger ready; writes to `Documents/NikkiGallery/Diagnostics/startup-errors.log`, 100KB rolling) |
| `task-registry.ts`         | Task registry (background task registration and query)                                                                                                  |
| `user-diag-path.ts`        | User-friendly diagnostics directory resolution (`Documents/NikkiGallery/Diagnostics`)                                                                   |
| `video-frame.ts`           | Video frame extraction utility                                                                                                                          |
| `video-probe.ts`           | Shared ffprobe implementation (probeVideoMetadata; safely parses "30000/1001" frame rate format)                                                        |
| `worker-restart-policy.ts` | Worker restart policy (crash restart count / backoff decision)                                                                                          |

### 5.10 App Lifecycle Management (app/)

Application orchestration layer bootstrapped from `index.ts`, with 23 source files each handling a specific responsibility:

| File                     | Responsibilities                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `application.ts`         | App main class; orchestrates initialization and shutdown                                                  |
| `lifecycle.ts`           | Lifecycle management (single-instance lock, ready/before-quit/will-quit event orchestration)              |
| `cleanup.ts`             | Exit cleanup (WAL checkpoint + subprocess kill + worker dispose + forced timeout fallback)                |
| `startup-tasks.ts`       | Post-startup tasks (auto-scan, database repair, thumbnail completion)                                     |
| `startup-environment.ts` | Startup environment checks (native dependency / path availability)                                        |
| `window-manager.ts`      | Window management (creation, ready-to-show, minimize/restore/close handling)                              |
| `navigation-guard.ts`    | Main window navigation trust check (app:// / media:// + dev 5173; intercepts and logs navigation-blocked) |
| `desktop-shortcut.ts`    | Desktop shortcut auto-repair (detect missing and recreate)                                                |
| `error-handlers.ts`      | Global error handling (uncaughtException, unhandledRejection, render-process-gone)                        |
| `ipc-setup.ts`           | IPC registration orchestration (constructs HandlerContext and calls register functions per domain)        |
| `media-protocol.ts`      | media:// protocol registration and whitelist (5-layer LRU cached path validation)                         |
| `renderer-protocol.ts`   | app:// renderer document protocol registration                                                            |
| `renderer-bridge.ts`     | Renderer event bridge (main process → renderer event push)                                                |
| `media-update.ts`        | Media update notification (throttled 100ms, notifies renderer via webContents.send to refresh)            |
| `recovery.ts`            | Recovery logic (database repair and state restoration after abnormal exit)                                |
| `theme.ts`               | Theme sync (applyUITheme syncs nativeTheme + TitleBarOverlay + setBackgroundColor)                        |
| `custom-dirs.ts`         | Custom directory management (resolve/ensure/migrate for 4 configurable paths)                             |
| `auto-update.ts`         | Auto update (electron-updater)                                                                            |
| `exit-forensics.ts`      | Exit forensics (abnormal exit scene recording)                                                            |
| `gpu-fallback.ts`        | GPU fallback decision (disable hardware acceleration on GPU anomalies)                                    |
| `native-load-guard.ts`   | Native module load pre-check (VC++ runtime etc.; showErrorBox on failure)                                 |
| `permission.ts`          | System permission management                                                                              |
| `app-context.ts`         | App context (globally shared app state and dependency container)                                          |

### 5.11 Plugin Host (plugins/)

| File                  | Responsibilities                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `plugin-host.ts`      | Plugin loading, activation point management, lifecycle hooks (install/activate/uninstall) |
| `permission-guard.ts` | Plugin permission validation (filesystem/network/system resource permission interception) |

### 5.12 Video Editor Subprocess (video-editor/)

A standalone utilityProcess handling FFmpeg command construction and execution for video editing:

| File                   | Responsibilities                                           |
| ---------------------- | ---------------------------------------------------------- |
| `bridge.ts`            | Main process bridge; forwards edit commands to worker      |
| `filter-builder.ts`    | FFmpeg filter chain construction (color/speed/crop)        |
| `watermark-builder.ts` | Watermark overlay (overlay filter parameter building)      |
| `worker-entry.ts`      | Worker process entry; executes FFmpeg and reports progress |
| `worker-protocol.ts`   | Message protocol type definitions                          |
| `types.ts`             | Video editing related type definitions                     |

### 5.13 Main Process i18n (i18n/)

| File             | Responsibilities                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `index.ts`       | Main process i18n entry; provides multi-language support for main process logs/error messages |
| `worker-safe.ts` | Worker-process-safe pure lookup translation (no i18next instance dependency)                  |

---

## 6. Renderer Process Module Responsibilities (src/renderer)

### 6.1 App Entry and Routing

#### `main.tsx`

- `import './i18n'` (i18next initialization)
- `installGlobalErrorHandler()` (registers `window.onerror` + `unhandledrejection`; IPC reports to main process faults)
- `ReactDOM.createRoot` renders `<React.StrictMode>` → `<ErrorBoundary>` → `<App />`

#### `App.tsx`

- **Custom view routing** (not React Router); switches 11 views via `useUIStore.currentView`: `gallery / detail / editor / categories / settings / recycle-bin / favorites / duplicates / launcher-cache / resonance-records / screenshots`
- **keep-alive mode**: `ALL_VIEWS` array + `visitedViews` Set; visited pages stay mounted, hidden via `display:none`; avoids losing scroll position / retriggering `fetchMediaFromDatabase` on view switch
- **View level mapping**: `VIEW_LEVEL_MAP` classifies views into 3 levels (level-1 views / detail / editor) for frosted-glass layering
- **Page transition animation**: `page-enter` CSS class (8px right shift + fade in, 220ms); `onAnimationEnd` removes `will-change`
- **Top-level side effects**: useRefreshMedia / useFilteredMediaFiles / useGlobalUndo / applyThemeClass / display preference application / operation history loading
- **Bridge component**: `OperationHistoryErrorBridge` rendered inside `GlobalToastProvider`

### 6.2 Page Layer (pages/)

| Page                             | Responsibilities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **GalleryPage**                  | Gallery main page (also handles favorites / launcher-cache views). Integrates toolbar + 5 views + batch ops + context menu + import wizard + slideshow + smart grouping + share + rename/watermark dialogs                                                                                                                                                                                                                                                                                                                                             |
| **CategoriesPage**               | Custom category management. Tree structure (parent_id), CRUD, drag-sort, icon/color config                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **DetailPage**                   | Single file detail. Left/right navigation, EXIF and game params across 5 panels, outfit annotation, video metadata, ZoomableContainer zoom                                                                                                                                                                                                                                                                                                                                                                                                             |
| **DuplicatesPage**               | Duplicate detection. Exact/similar scan modes, 5 cleanup strategies, similarity threshold tiers, keeper recommendation marking                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **EditorPage**                   | Image/video editor. useImageProcessor processing pipeline, useEditHistory history stack, useEditorShortcuts shortcuts, batch apply, save-failure recovery                                                                                                                                                                                                                                                                                                                                                                                              |
| **OutfitGalleryPage**            | Outfit gallery. Aggregates by outfit, StatCard + OutfitCard grid, click to jump to filtered gallery                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **RecycleBinPage**               | Recycle bin. Soft-deleted file list, select all/invert, restore/hard delete/empty, failed op retry                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **SettingsPage**                 | Settings center. Left nav + right section content; `activeSection` persisted to localStorage                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **ResonanceRecordsPage** (2.5.0) | Resonance Records. Four switchable views — pull records (73 banners, manual entry / edit time / delete, virtual scrolling), My Wardrobe (five-category ownership, outfit completion progress, name search and filters, batch select, "infer from pull records"), import & export (parse preview → added/duplicate/invalid counts with per-item location → batched transactional commit with visible, cancellable progress), personal stats (overview cards, luck percentile, SVG distribution histogram, per-banner cumulative curve and detail table) |

#### `pages/settings/` — Section Files (split by settings group)

| File                              | Section                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `shared.tsx`                      | GlobalToastProvider / useGlobalToast / SectionShell / common types                                  |
| `sections.tsx`                    | Unified re-export entry (keeps external import paths unchanged)                                     |
| `general-sections.tsx`            | GeneralStartupSection / GeneralFileOpsSection / GeneralExportSection                                |
| `appearance-sections.tsx`         | AppearanceThemeSection / AppearanceDisplaySection                                                   |
| `scan-sections.tsx`               | ScanPathsSection / GameRootsSection / ScanFallbackSection / ScanOptionsSection / ImportRootsSection |
| `scan-log-diagnostic-section.tsx` | Scan log diagnostics Section                                                                        |
| `profile-sections.tsx`            | ProfileManageSection                                                                                |
| `plugin-sections.tsx`             | PluginManageSection                                                                                 |
| `data-sections.tsx`               | DataBackupSection / DataCacheSection / DataClearSection                                             |
| `diagnostics-sections.tsx`        | DiagnosticsLogsSection / DiagnosticsCrashSection                                                    |
| `about-sections.tsx`              | AboutInfoSection / AboutContactSection / AboutLicenseSection                                        |
| `language-sections.tsx`           | LanguageSection                                                                                     |
| `tools-sections.tsx`              | ToolsShareCodeSection                                                                               |

### 6.3 Layout Components (components/layout/)

| Component    | Responsibilities                                                                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AppShell** | Overall layout skeleton. TitleBar (top) + Sidebar (left) + main (content) + bottom status bar                                                                                                        |
| **Sidebar**  | Side bar. Collapsible (motion.aside width animation 64↔220). Contains back-to-top button, character profile switcher, 9 main nav items, smart grouping quick panel (gallery view only), bottom stats |
| **TitleBar** | Top title bar. Fixed height 40px, `app-drag` class (Electron drag region), shows app icon + i18n title                                                                                               |

### 6.4 Common Components (components/common/)

#### Dialog Class (8)

- **BaseDialog**: Modal dialog base. Encapsulates motion enter/exit animations, useFocusTrap focus trap, 4 sizes, mask-click close, Esc close
- **ConfirmDialog**: Confirmation dialog (primary/danger confirm button variants)
- **PropertiesDialog**: File properties dialog (aggregates 5 InfoPanels + basic info)
- **ShareGuideDialog**: Share guide (WeChat/QQ/Vivo three-channel status display)
- **WifiShareDialog**: WiFi share dialog (large-font address + copy button)
- **ShareCodeDecoderDialog**: Share code decoder (3 tabs: clothing DIY / home build / media encryption)
- **FeedbackDialog**: Error feedback dialog (description + attachments + diagnostic package export)
- **TagManager**: Tag management dialog

#### Info Display Panel Class (6)

- **InfoRowPanel**: Common render carrier for 5 InfoPanels. Unified loading/error/empty/data four states, light/dark dual themes, flat rows and grouped groups forms
- **ExifPanel**: EXIF shooting params (camera/lens/aperture/shutter/ISO/focal length/GPS/capture time)
- **CameraInfoPanel**: In-game camera params (pose/aperture/lighting/filter)
- **PhotographyPanel**: Photography info (weather/puzzle/interaction/location)
- **NikkiInfoPanel**: Nikki params panel
- **OutfitPanel**: Outfit info (clothing parts/status/inspiration points/color)
- **InteractionPanel**: Interaction object panel

#### Basic UI Class (7)

- **IconButton**: Icon button (enforces aria-label)
- **SliderControl**: Slider (supports label/unit/double-click reset/onCommit release callback)
- **Spinner**: Loading spinner (4 sizes)
- **Toast**: Toast notification (success/error/info types, stacked display, enter+exit animation)
- **EmptyState**: Empty state component (empty/loading/error three states, CTA button)
- **MissingBadge**: Missing file badge
- **MediaThumbnail**: Media thumbnail (integrates MissingBadge + MediaThumbPlaceholder)

#### Feedback and Error Class (3)

- **ErrorBoundary**: React ErrorBoundary class component
- **ErrorFallback**: Error fallback page (retry/open log dir/copy error info)
- **ContextMenu**: Right-click context menu (Portal render, secondary submenu, auto boundary correction)

#### Share Helper Class (1)

- **ShareMenuButton**: Share menu button (dropdown to select channel)

### 6.5 Gallery Components (components/gallery/)

#### View Render Class (5)

- **VirtualImageGrid**: Grid view (useVirtualGrid virtual scroll, high-DPR detection ≥2 enables 512px tier)
- **ListView**: List view (useVirtualScroll virtual scroll, fixed row height 72px)
- **TimelineView**: Timeline view (grouped by date, responsive column count)
- **MasonryView**: Masonry view (custom column layout algorithm, MIN_COL_WIDTH=220, overscan 400px)
- **EventTimelineView**: Event timeline view (based on game version nodes)

#### Toolbar and Action Class (4)

- **GalleryToolbar**: Gallery top toolbar (view switch/filter/sort/rating/search/scan/share/slideshow/import)
- **BatchActions**: Batch action bar (export/move/watermark/delete/category/share/rename/select all/invert)
- **SlideshowPlayer**: Slideshow player (Fisher-Yates shuffle, 4 intervals, fade/slide/no transition)
- **FullscreenViewer**: Fullscreen browser (View Transitions API shared element transition, mouse auto-hide controls, video playback)

#### Dialog Class (4)

- **ImportWizard**: Import wizard (3 steps: file preview → naming rule + category + conflict strategy → execute)
- **BatchRenameDialog**: Batch rename (template variables {date}/{time}/{scene}/{outfit}/{seq}/{original})
- **RenameDialog**: Single file rename
- **WatermarkDialog**: Watermark dialog

#### Helper Class (3)

- **SmartGroupPanel**: Smart grouping panel (6-dimensional dynamic grouping)
- **TagManager**: Tag management dialog
- **MediaThumbPlaceholder**: Thumbnail placeholder/failure icon

### 6.6 Editor Components (components/editor/)

| Component            | Responsibilities                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **EditorToolbar**    | Editor top toolbar (undo/redo/reset/compare/shortcuts/fullscreen/exit/save as/save/copy params/paste params/apply to selected) |
| **EditorTabs**       | Editor right-side tab container (7 tabs: basic/hsl/curves/split/filters/lut/watermark)                                         |
| **FilterPanel**      | Filter panel (getFilterCategories + getPresetsByCategory, concurrent 4-way thumbnail generation)                               |
| **LutPanel**         | LUT panel (built-in LUT + custom .cube file import, localStorage persistence)                                                  |
| **ToneCurve**        | Curve adjustment (RGB/R/G/B four channels, Canvas drawing, drag control points)                                                |
| **Histogram**        | Histogram (Canvas drawing RGB channel distribution, 80ms debounce)                                                             |
| **ColorWheel**       | Color wheel (Canvas drawing, drag to select hue)                                                                               |
| **CompareView**      | Compare view (drag divider to compare original/edited)                                                                         |
| **WatermarkPanel**   | Watermark config panel (text/image watermark, templates, onCommit pushes to history stack)                                     |
| **BatchApplyDialog** | Batch apply progress dialog                                                                                                    |
| **ShortcutsModal**   | Shortcuts help modal                                                                                                           |
| **VideoEditor**      | Video editor (speed adjustment/format conversion/frame capture/metadata display)                                               |

### 6.7 Scanner and Video Components

- **scanner/ScanButton**: Scan button (3 modes: incremental/full/custom)
- **scanner/ScanProgress**: Scan progress bar (scanned/found/currentPath + stop button)
- **video/VideoPlayer**: Video player (playback progress persisted to localStorage by src hash)

### 6.8 Custom Hooks (23)

#### Media Operation Class (7)

- **useFileOperations**: File ops core hook (delete/move/rename/copy/favorite toggle/property update); registers 4 undoHandlers
- **useBatchOperations**: Batch ops hook (watermark/batch rename state management)
- **useVideoThumbGenerate**: Video thumbnail generation hook (module-level single-shot guard prevents request storms; shared across component instances)
- **useFavoriteToggle**: Favorite toggle hook (optimistic update + failure rollback + pushHistory)
- **useFilteredMediaFiles**: Filter+sort+group hook (module-level cache avoids duplicate computation across components)
- **useGallerySearch**: Search input hook (250ms debounce)
- **useRefreshMedia**: Refresh media hook (wraps fetchMediaFromDatabase)

#### UI Interaction Class (7)

- **useToast**: Toast management hook (max 3, FIFO eviction, crypto.randomUUID for id)
- **useZoomable**: Zoom/pan interaction hook (wheel zoom, drag pan, double-click reset)
- **useSlideshow**: Slideshow playback hook (isPlaying state, interval timer lifecycle)
- **useFocusTrap**: Modal focus trap hook (Tab/Shift+Tab cycle, Esc close)
- **useContainerSize**: Container size listener hook (ResizeObserver + window resize double guarantee; includes virtual scroll variant useVirtualGrid)
- **useFailedImages**: Thumbnail load failure management hook
- **useErrorToast**: Error Toast hook (decides toast type by category, auto-reports non-user-facing errors)

#### Editor Class (4)

- **useEditHistory**: Edit history stack hook (50 cap, historyIndex synced to ref to avoid same-cycle multi-push truncation)
- **useEditorShortcuts**: Editor shortcuts hook (Ctrl+Z/Y/S/Shift+S/Shift+C/Shift+V/F11/?)
- **useImageProcessor**: Image processing hook (80ms debounce preview, max preview 1400px, max export 4096px, JPEG quality 0.92/0.95)
- **useWatermark**: Watermark config state hook (text/image config updates and tiling toggle)

#### IPC Call and Global Class (5)

- **useIpcCall**: IPC call wrapper hook (auto manages loading/error capture/toast display/generic preservation/idempotent safety)
- **useExif**: EXIF load hook
- **useGameParams**: Game params load hook (LRU + TTL cache, 200 entries / 5 min)
- **useGlobalUndo**: Global undo hook (App top-level registers Ctrl+Z, active in non-editor views, skips when input focused)
- **useStagedTask**: Staged task progress hook (drives TaskProgress stage states and item progress, throttled pushes, carries a cancellation signal)

### 6.9 State Management (stores/)

| Store                     | Persistence                                              | Responsibilities                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **uiStore**               | `wxnn-ui-store`                                          | UI global state: currentView + viewStack, selectedMediaId(s), sidebarCollapsed, searchQuery/sortBy/sortOrder/viewMode/filterType/filterDateRange/filterRating, selectedSceneCategories/selectedSceneTimes/filterOutfit, showMissingOnly/showDuplicates, groupDimension/selectedGroupKey, fullscreen state (incl. fullscreenTargetImg for View Transitions shared element transition), slideshow state and config |
| **mediaStore**            | No (in-memory)                                           | Media data: mediaFiles/categories/loading/scanProgress/editingMedia/recycleBinFiles, currentProfileUid/profiles. Pure reducer actions + async action `updateMediaFileAndPersist` (IPC persist first, then update local)                                                                                                                                                                                          |
| **themeStore**            | `wxnn-ui-theme`                                          | Theme management (setTheme + applyThemeClass, auto-derives all non-empty classNames from themes config)                                                                                                                                                                                                                                                                                                          |
| **operationHistoryStore** | No (in-memory + IPC persists to operation_history table) | Global operation history. 50 cap, 9 OperationTypes, type-dispatched UndoHandler registry (module-level Map), database write failure callback Set subscription, loadFromDatabase startup load                                                                                                                                                                                                                     |
| **resonanceStore**        | No (in-memory)                                           | Resonance Records data (records / wardrobe / stats and import-export state); added in 2.5.0                                                                                                                                                                                                                                                                                                                      |
| **pluginStore**           | No (in-memory)                                           | Plugin runtime state (installed/enabled plugin list, in-progress install/uninstall operation flags and error info)                                                                                                                                                                                                                                                                                               |

### 6.10 Utility Functions (utils/)

| Category             | File                                                                                                                       | Purpose                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Formatting           | `format.ts` / `date.ts`                                                                                                    | Byte formatting, date formatting                                                                                                              |
| File Paths           | `file.ts`                                                                                                                  | toFileUrl / getDirName / joinPath                                                                                                             |
| Image Processing     | `imageProcessor.ts`                                                                                                        | Core processing pipeline (HSL/Curves/SplitTone/Watermark algorithms + processImageData)                                                       |
| Filters              | `filter.ts` / `filterPresets.ts` / `lut.ts` / `editor-colors.ts`                                                           | mergeFilterParams, 6 category presets, 3D LUT parse and apply, CHANNEL_COLORS                                                                 |
| Game Data            | `enum-mappings.ts` / `cloth-name-lookup.ts` / `location-data.ts` / `location-map.ts`                                       | Game enum → Chinese mapping, clothing/outfit name lookup, location hierarchy, coordinate → location mapping                                   |
| Business Helpers     | `group-field.ts` / `gallery.tsx` / `responsive.ts` / `category-name.ts` / `duplicateContextMenu.ts` / `scan-exclusions.ts` | Group field extraction, context menu construction, responsive column count, category name resolution, duplicate context menu, scan exclusions |
| Share and Events     | `share.ts` / `game-events.ts`                                                                                              | Share helpers, game event mapping                                                                                                             |
| Animation and Errors | `motionPresets.ts` / `global-error-handler.ts` / `fault-colors.ts`                                                         | Motion animation presets, global error fallback, fault type metadata                                                                          |

### 6.11 Internationalization (i18n/)

- Based on `i18next` + `react-i18next`
- **Supports 13 language options** (incl. "Follow System"): `auto / zh-CN / zh-TW / en / ja / ko / fr / de / es / pt / ru / th / vi`
- Chinese (zh-CN) is the base language with the most complete translations; the other 11 are machine-translated initial versions; missing keys auto-fallback to zh-CN (`fallbackLng: 'zh-CN'`)
- `SUPPORTED_LANGUAGES` array defines order (affects settings page dropdown display order)
- `detectSystemLanguage()`: Infers from `navigator.language` (zh-TW/HK/Mo treated as Traditional)
- Naming conventions: `nav.*` / `common.*` / `settings.groups.*` / `settings.sections.*` / `editor.tabs.*` / `duplicates.strategy.*` / `toast.*` etc.

### 6.12 Styles and Themes (styles/)

#### `globals.css`

- Theme style entry; theme files placed first per CSS @import rules
- Imports Tailwind base/components/utilities
- Defines default theme CSS variable system (`:root`): color/mask/shadow/frosted-glass variables
- Global classes: `.glass-panel` / `.glass-card` / `.app-drag` / `.title-bar` / `.status-bar` / `.page-enter` / `.font-size-*` / `.compact-mode` / `.reduce-motion` / `.nav-item` / `.icon-btn` / `.btn-primary`

#### `themes/index.ts`

- Theme config center. `UITheme = 'default' | 'soft-pink-luxury'`
- `themes` array: `{ id, name, className }` (default appends no class; soft-pink-luxury appends `.soft-pink-luxury` class)
- Adding a theme flow: 1) register here; 2) add same-named CSS file and import in globals.css

#### `themes/soft-pink-luxury.css`

- "Soft Pink Luxury" theme styles
- `.soft-pink-luxury` class scope overrides all CSS variables
- Colors: milky white base (`#fdf9fb`) + low-saturation soft pink accents (`#e2a4bc`) + soft-focus glass material + soft layered light and shadow

### 6.13 Icon Management (icons/)

- **Single-file centralized management of all icons**, exports 74 icon components
- Based on `BaseIcon` unified wrapper: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">`, follows Feather/Lucide style
- `IconProps` interface extends `React.SVGProps<SVGSVGElement>` + `size?: number` (default 16)
- Categorized by purpose: Action (17) / View (5) / Navigation (7) / Editor (10) / Media (5) / Status (4) / File Ops (5) / Category & Tag (3) / Share Channel (4) / Import-Export (2) / Playback Control (2) / Social Platform (3) / Other (7)

### 6.14 Plugin Runtime (plugins/)

#### `plugin-runtime.ts`

- Renderer-side plugin runtime; handles extension point registration and plugin UI rendering
- Provides plugin context, allowing plugins to access controlled renderer APIs
- Works with main process `plugin-host.ts` for plugin lifecycle management
- Extension point mechanism: plugins can register custom panels, toolbar buttons, detail page info blocks, etc.

### 6.15 Full-Text Search Index (search/)

| File                  | Responsibilities                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `search-index.ts`     | FlexSearch index management (create/update/destroy); indexed fields include filename/tags/notes/category name |
| `search-service.ts`   | Search service (query, result sorting, highlight matching)                                                    |
| `doc-builder.ts`      | Document builder (converts MediaFile to FlexSearch document format)                                           |
| `use-search-index.ts` | Search hook (index building/query/debounce, for component use)                                                |

### 6.16 Preview Mock (preview/)

Data support layer for the HTML preview (`preview.html`), enabling the preview to display full UI without an Electron main process:

| File/Directory            | Responsibilities                                                        |
| ------------------------- | ----------------------------------------------------------------------- |
| `install.ts`              | Preview environment setup script (injects mock data into window global) |
| `mock/`                   | Mock data directory                                                     |
| `mock/data/`              | Static JSON data (media-samples/categories/profiles etc.)               |
| `mock/database-mock.ts`   | Database mock (simulates mediaStore IPC responses)                      |
| `mock/event-mock.ts`      | Event mock (simulates scanner:progress and other event pushes)          |
| `mock/filesystem-mock.ts` | Filesystem mock (simulates file paths/thumbnail URLs)                   |
| `mock/ipc-error.ts`       | IPC error mock (simulates IPC call failure response format)             |

---

## 7. Shared Modules (src/shared)

### 7.1 Shared Types (shared/types/)

`src/shared/types/index.ts` is the unified export entry, aggregating 14 domain type modules. All adopt the "database row (XxxRow, snake_case) ↔ renderer model (Xxx, camelCase)" dual-track system.

| File                   | Core Types                                                                                                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **media.ts**           | `MediaType` / `MediaSource` / `SceneTime` / `MediaRow` / `MediaFile` (27 fields) / `MediaListOptions` / `ScanOptions` / `VideoExportFormat` / `DuplicateGroup` / `OutfitStat`                                                                                         |
| **category.ts**        | `CategoryRow` / `Category` / `CategoryCreateInput` / `CategoryTreeNode` / `SystemCategoryIcon` (7 enums)                                                                                                                                                              |
| **profile.ts**         | `ProfileRow` / `CharacterProfile` / `ProfileBaseStats` / `ProfileTopStatRow` / `GroupCountRow` / `ProfileStats`                                                                                                                                                       |
| **editor.ts**          | `HSLColorKey` (12 channels) / `FilterParams` (22 adjustments + HSL + curves + split-tone + LUT) / `FilterPresetRow` / `EditHistoryRow` / `OperationType` (13 op types) / `OperationHistoryRow`                                                                        |
| **watermark.ts**       | `WatermarkPosition` (9 + custom) / `WatermarkStyle` (5 types) / `BlendMode` (16 types) / `WatermarkConfig` / `WatermarkTemplateRow`                                                                                                                                   |
| **settings.ts**        | `AppSettingRow` / `SettingKey` (29 key enums) / `AppTheme` / `AppLanguage` / `UIScale` / `GridSize` / `SettingKeyMap` (key → TS type mapping) / `BackupRecord` / `CacheStats` / `LogStats` / `CrashStats` / `FaultType` / `FaultRecord`                               |
| **ipc.ts**             | Re-exports `IpcError` / `IpcResponse` / `IpcProgress` / `IPC_ERROR_CODES`, `ShareChannel` / `WifiShareSession`, `MediaParamType` / `CameraParams` / `RichCameraParams`, `ImportOptions` / `ExportOptions`, **`IPC_CHANNELS`** (13 domains ~60 channel name constants) |
| **ipc-types.ts**       | `IpcError` (code/message/userMessage/details), `IpcResponse<T>` = `{success:true,data}` ∪ `{success:false,error}`, `IpcProgress`, `IPC_ERROR_CODES` (9 IPC_* error codes)                                                                                             |
| **progress.ts**        | `TaskType` (7 task types: scan/duplicate/batch/watermark/import/video-edit/indexing), `TaskPhase` (6 phases), unified task progress state (pushed via the main-process `task:progress` channel)                                                                       |
| **plugin.ts**          | `NikkiGalleryManifest` / `PluginPermission` capability list / business extension point constants and extension response types                                                                                                                                         |
| **editor-metadata.ts** | `EDITOR_METADATA_SCHEMA_VERSION` / XMP self-describing serialization structures for color, filter, LUT and watermark params                                                                                                                                           |
| **duplicate.ts**       | `DuplicateItem` / duplicate-similarity domain types (main-process handler return contract, consumed by DuplicatesPage)                                                                                                                                                |
| **resonance.ts**       | Resonance domain types + zod schemas + import limit constants (added in 2.5.0)                                                                                                                                                                                        |
| **electron-api.ts**    | Type snapshots of preload `electronAPI` namespace method signatures and DTOs (the preload layer does not inline type definitions)                                                                                                                                     |

### 7.2 Error Architecture (shared/errors/)

#### `error-codes.ts`

- **`ERROR_CODES`**: Extends 2 codes on top of `IPC_ERROR_CODES` 9 codes (`APP_DATABASE_ERROR` / `APP_FILE_SYSTEM_ERROR`), totaling 11 error codes
- **`ErrorCategory`** enum: 6 major categories — `Validation` / `NotFound` / `Permission` / `Database` / `FileSystem` / `Internal`
- **`CODE_TO_CATEGORY`**: Static mapping from error code to category
- Utility functions: `categoryOfCode(code)` / `isUserFacing(category)`

#### `app-error.ts`

- **`AppError`** extends `Error`, carries `code` / `details` / `userMessage` / `cause` four readonly fields
- **Static factory methods** (8): `validation` / `forbidden` / `notFound` / `unauthorized` / `conflict` / `canceled` / `preconditionFailed` / `internal`
- **6 categorized subclasses**: `ValidationError` / `NotFoundError` / `PermissionError` / `DatabaseError` / `FileSystemError` / `InternalError`
- **Serialization**: `toIpcError()` / `toJSON()` outputs `{code, message, userMessage?, details?}`; **`cause` is not transmitted across IPC**
- **Type guards**: `isAppError` / `isValidationError` / `isNotFoundError` / `isPermissionError` / `isDatabaseError` / `isFileSystemError` / `isInternalError`
- **Helper functions**: `toIpcError(unknown)` / `extractUserMessage(error, fallback)`

**Call chain**: handler throws `AppError` → `wrapHandler`'s `handleError` calls `toIpcError()` → wraps as `{success:false, error: IpcError}` → preload `call<T>` unwraps and `throw new IpcError(code, message, details, userMessage)` → renderer `try/catch` receives.

### 7.3 Business Dimensions

#### `shared/dimension.ts`

- **`GroupDimension`**: `'none' | 'album_type' | 'scene_category' | 'scene_time' | 'outfit' | 'file_type'`
- **`GROUP_DIMENSION_OPTIONS`**: 6 `{value, labelKey, label}` triples

#### `shared/scene-category.ts`

- **`SceneCategory`**: 6 types — `thumbnail` / `screenshot` / `travel_journal` / `world_tour` / `collage` / `other`
- **`SceneTime`**: 5 types — `day` / `night` / `dawn` / `dusk` / `unknown`
- **`SCENE_CATEGORIES`** config table (sorted by priority): matches path via `folderPattern` (e.g., `NikkiPhotos_LowQuality` / `ScreenShot` / `MagazinePhotos` / `ClockInPhoto` / `Collage_CollagePhoto`)
- **`OUTFIT_PRESETS`**: 34 Infinity Nikki preset outfit names
- Core functions: `detectSceneCategory(filePath)` / `getSceneCategoryLabel` / `getSceneTimeLabel`

### 7.4 Common Utilities (renderer/utils/)

`src/common/utils/` was originally a cross-process shared pure-utility module; it had no production references (dead code) and was removed entirely during the lightweight optimization pass.
Formatting / date / ETA utilities are consolidated in `src/renderer/utils/` (`format.ts` / `date.ts` etc.), while main-process utilities are cohesive in `src/main/utils/`.

---

## 8. Data Flow

### 8.1 Complete IPC Chain

```
Renderer Process (React Hook/Store)
   │  window.electronAPI.<domain>.<method>(...args)
   ▼
preload.ts (contextBridge.exposeInMainWorld)
   │  call<T>(channel, ...args) → ipcRenderer.invoke
   │  Unwraps IpcResponse<T>; throws IpcError on failure
   ▼
ipcMain.handle (src/main/ipc/handlers/*.ts)
   │  wrapHandler(ctx, zodSchema, handler) wraps:
   │    1. zod validates params → returns IPC_VALIDATION_ERROR on failure
   │    2. assertFileReadPath/assertFileWritePath (file ops class)
   │    3. Calls handler(args, ctx, event)
   │    4. Success → {success:true, data: T}
   │    5. Throws AppError → {success:false, error: AppError.toIpcError()}
   │    6. Throws plain Error → tags INTERNAL_ERROR + logger.error
   ▼
Service / Repository
   │  Business orchestration + SQL access
   ▼
DatabaseManager
   │  Read: sync db.prepare().all()/get()
   │  Write: async dbManager.executeAsync() → DatabaseWorkerBridge → utilityProcess
   ▼
better-sqlite3 (WAL mode, wxnn_photo_manager.db)
```

### 8.2 Example 1: media:list (Read Operation)

1. **Renderer** `mediaStore.ts` calls `window.electronAPI.media.list({ page, pageSize, accountUid, albumType, hideDuplicates, ... })`
2. **preload.ts** `media.list = (options) => call<MediaListResult>('media:list', options)`
3. **`call<T>`** internally: `ipcRenderer.invoke('media:list', options)` → receives `IpcResponse<MediaListResult>` → returns `data` on success, `throw new IpcError(...)` on failure
4. **Main process** `ipc/handlers/media-handler.ts`:
   ```ts
   ipcMain.handle('media:list',
     wrapHandler(ctx, z.tuple([z.object({...}).optional()]),
       async ([options]) => {
         const result = getRepo().listMedia(options ?? {})
         return { files: result.rows.map(...), total, page, pageSize, hasMore }
       }))
   ```
5. **`MediaRepository.listMedia`** (sync path, no worker):
   - `buildListWhereClause(options)` builds WHERE (`is_deleted=0` / `account_uid=?` / `album_type=?` / `is_duplicate=0` / `media_source=?`)
   - Sort whitelist prevents SQL injection (`created_at` / `modified_at` / `file_name` / `file_size` / `rating`; recycle bin defaults to `deleted_at`)
   - Pagination: `SELECT ... LIMIT ? OFFSET ?`
   - `parseTagsField` safely parses `tags` JSON
   - **Cache optimization**: default view (only `is_deleted=0`) hits `app_settings.media_count` cache to skip COUNT; non-default view counts in real time
6. **Returns**: `{success:true, data:{files, total, page, pageSize, hasMore}}`
7. **Side effects**: list does not trigger `notifyMediaUpdated`; write ops (e.g., `media:updateRating`) call `ctx.notifyMediaUpdated()` — throttled 100ms then notifies renderer to refresh via `mainWindow.webContents.send('media:updated')`

### 8.3 Example 2: file:delete (File Operation)

1. **Renderer** `useFileOperations.ts` calls `window.electronAPI.file.delete(paths)`
2. **preload.ts** `file.delete = (filePaths) => call<FileOpResult>('file:delete', filePaths)`
3. **Main process** `ipc/handlers/file.ts`:
   ```ts
   ipcMain.handle(
     'file:delete',
     wrapHandler(ctx, z.tuple([schemas.filePathArray]), async ([filePaths]) => {
       for (const p of filePaths) assertFileReadPath(p) // path whitelist validation
       return ctx.fileService.moveToRecycleBin(filePaths)
     })
   )
   ```
4. **PathGuard whitelist**:
   - **Blacklist fallback**: `SYSTEM_SENSITIVE_DIRS` always denies (even if registered)
   - **Safe roots**: user home dir `os.homedir()` + `app.getPath('userData')` always allowed
   - **Dynamic registration**: scanner-discovered media dirs, dialog-selected dirs registered via `pathGuard.register()`
   - Failure throws `AppError.forbidden`; details `maskPath(p)` keeps only last 2 segments
5. **FileService.moveToRecycleBin**: loops `shell.trashItem(filePath)` (system recycle bin)
6. **Returns**: `{success:true, data:{success:true, message:'Moved N files to recycle bin'}}`

### 8.4 Example 3: media:permanentDelete (Three-Stage Transaction)

A more complex chain showcasing the main process's side-effect orchestration:

1. **Double confirmation**: `dialog.showMessageBox` shows warning; user cancel → `throw AppError.canceled()`
2. **Stage 1**: `repo.softDeleteForPermanentDelete(ids)` — transaction marks `is_deleted=1` (idempotent, retryable)
3. **Stage 2**: One-by-one `shell.trashItem(file_path)`, distinguishing "success / file not exists / failure"
4. **Stage 3**: `repo.hardDeleteBatch(idsToDelete)` — transaction physically deletes DB records
5. **Consistency guarantee**: On interruption, DB still has `is_deleted=1` records; user can retry

### 8.5 media:// Protocol Data Flow

```
Renderer <img src="media://host/?path=<URL-encoded-absolute-path>">
   │
   ▼
protocol.handle('media', async (request) => {...})
   │
   ├─ 1. Parse url.searchParams.get('path')
   ├─ 2. decodeURIComponent + path.resolve normalization
   ├─ 3. isMediaPathAllowed(normalizedPath) whitelist validation
   │      ├─ Path-level LRU cache (TTL 5min, cap 1000)
   │      ├─ Thumbnail cache dir prefix match
   │      ├─ Database file_path exact match (UNIQUE index)
   │      ├─ Database thumbnail exact match
   │      └─ source_path prefix match + extension whitelist
   ├─ 4. fs.promises.access verifies readable
   ├─ 5. Get mimeType + isVideo by extension
   ├─ 6. Range request support: return 206 Partial Content + Content-Range + Accept-Ranges
   └─ 7. Full response: return 200 OK + Content-Type + Content-Length + Cache-Control: max-age=31536000
```

**Key security fixes**:

- Fixed A-S2/C-F5: Original source_path prefix match had no extension restriction; scanning D:\ allowed reading any file on the disk
- Fixed A-S1/C-S2: Original implementation queried DB on every request; now uses in-memory cache (TTL 5 min)

### 8.6 State Flow

```
Electron Main Process IPC
    ↕  (preload contextBridge)
stores (Zustand)
    ↕
hooks (side-effect wrappers)
    ↕
components / pages (display)
```

---

## 9. Database Architecture

### 9.1 Database File

- **Path**: `userData/database/wxnn_photo_manager.db`
- **Mode**: WAL (Write-Ahead Logging)
- **PRAGMA optimizations**:
  - `synchronous=NORMAL` (safe and faster under WAL)
  - `cache_size=-20000` (20MB cache)
  - `temp_store=MEMORY`
  - `mmap_size=268435456` (256MB memory map)
  - `wal_autocheckpoint=1000`
  - `auto_vacuum=INCREMENTAL`
  - `busy_timeout=5000`

### 9.2 Table Structure

| Table                     | Core Fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Purpose                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **`media_files`**         | `id` (PK AUTOINCREMENT), `file_path` (UNIQUE), `file_name`, `file_type` ('image'/'video'), `file_ext`, `file_size`, `width`, `height`, `duration`, `created_at`, `modified_at`, `source_path`, `thumbnail`, `tags` (JSON default '[]'), `category_id`, `rating`, `is_favorite`, `notes`, `indexed_at`, `scene_category`, `scene_time`, `outfit`, `is_deleted`, `deleted_at`, `is_missing`, `missing_count`, `phash` (64-char 0/1 string), `account_uid`, `album_type`, `is_duplicate`, `original_id`, `media_source` | Main table, 27+ fields                                                                           |
| **`categories`**          | `id`, `name` (UNIQUE), `icon`, `color`, `sort_order`, `parent_id`, `is_system`, `created_at`                                                                                                                                                                                                                                                                                                                                                                                                                         | Category tree; includes 7 system categories                                                      |
| **`scan_history`**        | `id`, `scan_type` ('full'/'incremental'/'signature'), `start_time`, `end_time`, `files_found`, `files_new`, `status`                                                                                                                                                                                                                                                                                                                                                                                                 | Scan history                                                                                     |
| **`app_settings`**        | `key` (PK), `value` (JSON string)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | KV settings storage; includes `media_count` cache                                                |
| **`filter_presets`**      | `id`, `name`, `category`, `params` (JSON), `is_builtin`, `created_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                | Filter presets                                                                                   |
| **`watermark_templates`** | `id`, `name`, `config` (JSON), `is_builtin`, `created_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Watermark templates                                                                              |
| **`edit_history`**        | `id`, `media_id` (FK CASCADE), `params` (JSON), `thumbnail`, `created_at`                                                                                                                                                                                                                                                                                                                                                                                                                                            | Per-media edit history                                                                           |
| **`operation_history`**   | `id`, `operation_type` (13 types), `media_id`, `payload` (JSON), `description`, `created_at`                                                                                                                                                                                                                                                                                                                                                                                                                         | Global operation history (cross-restart undo); auto-cleans records older than 30 days on startup |
| **`character_profiles`**  | `uid` (PK), `nickname`, `avatar`, `created_at`, `last_active_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Character profiles; default 'default'                                                            |
| **`schema_migrations`**   | `name` (PK), `applied_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Named migration tracking                                                                         |

**Resonance tables (added in 2.5.0, 5 tables)**: the `RESONANCE_DDL_STATEMENTS` constant (`src/main/database/resonance-repository.ts`) is executed statement by statement with `db.exec` by the resonance migration in `connection.ts`; all use `CREATE TABLE IF NOT EXISTS` and are therefore idempotent. All 5 tables are covered by the existing full-database backup / restore.

| Table                          | Core Fields                                                                                                                                 | Purpose                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **`resonance_pulls`**          | `id` (PK), `banner_id`, `item_id`, `obtained_at`, `source` ('json'/'manual-import'), `created_at`; UNIQUE (banner_id, obtained_at, item_id) | Pull records main table                 |
| **`resonance_edits`**          | `id` (PK), `banner_id`, `item_id`, `obtained_at`, `created_at`; UNIQUE (banner_id, item_id)                                                 | Manually added records                  |
| **`resonance_pearpal`**        | `banner_id`, `item_id`, `pool_cnt`, `obtained_at`, `raw_json`; UNIQUE (banner_id, item_id, pool_cnt)                                        | Pear-Pal capture records, raw JSON kept |
| **`resonance_evo`**            | `banner_id`, `outfit_id`, `level` (0–4), `updated_at`; UNIQUE (banner_id, outfit_id)                                                        | Outfit evolution level                  |
| **`resonance_wardrobe_items`** | `category` ('item'/'makeup'/'momo'/'prop'/'eureka_color'), `item_id`, `updated_at`; PRIMARY KEY (category, item_id)                         | My Wardrobe ownership state             |

### 9.3 Key Indexes

**`media_files` single-column indexes (15)**: `file_type` / `category_id` / `is_favorite` / `modified_at` / `thumbnail` / `source_path` / `scene_category` / `scene_time` / `outfit` / `is_deleted` / `is_missing` / `phash` / `account_uid` / `album_type` / `is_duplicate` / `original_id` / `media_source`

**Composite indexes (5)**:

- `idx_media_files_default_view` (is_deleted, account_uid, album_type) — gallery default list
- `idx_media_files_profile_stats` (account_uid, is_deleted, file_type) — character profile stats
- `idx_media_files_duplicate_group` (is_duplicate, is_deleted, original_id) — duplicate grouping
- `idx_media_files_outfit_agg` (is_deleted, outfit) — outfit aggregation
- `idx_media_files_scene_analysis` (scene_time, file_type, is_deleted) — scene time analysis

**Other indexes**: `idx_categories_parent_id` / `idx_edit_history_media_id` / `idx_operation_history_created_at` / `_media_id` / `_type` / `idx_character_profiles_nickname`

### 9.4 Read-Write Separation Architecture

- **Read operations**: Main process `DatabaseManager` executes synchronously (read-heavy, write-light; sync semantics needed)
- **Write operations**: `DatabaseManager.executeAsync()` → `DatabaseWorkerBridge.execute()` → utilityProcess
- **Fallback path**: When `workerBridge` not injected (e.g., test scenarios), writes degrade to synchronous direct write on main process db
- **Transactions**: worker process uses better-sqlite3 native `db.transaction`; any statement failure rolls back

---

## 10. Security and Observability

### 10.1 Security Baseline

#### 10.1.1 Electron Security Configuration

- `contextIsolation: true` — context isolation
- `nodeIntegration: false` — disable Node integration
- `sandbox: true` — sandbox mode
- `protocol.registerSchemesAsPrivileged` — media:// and app:// protocol privilege declaration

#### 10.1.2 IPC Path Whitelist (PathGuard)

- **Default deny** policy
- **Blacklist fallback**: `SYSTEM_SENSITIVE_DIRS` (Windows/ProgramData/$recycle.bin/System32 etc.) always denies
- **Safe roots**: user home dir + userData dir always allowed
- **Dynamic registration**: scanner-discovered media dirs, dialog-selected dirs
- **File op handlers** must call `assertFileReadPath` / `assertFileWritePath`

#### 10.1.3 media:// Protocol Whitelist

5-layer validation:

1. Path-level LRU cache (TTL 5 min, cap 1000)
2. Thumbnail cache dir prefix match
3. Database `file_path` exact match (UNIQUE index)
4. Database `thumbnail` exact match
5. Indexed `source_path` prefix match + extension whitelist

#### 10.1.4 Parameter Validation

- All IPC handlers wrapped via `wrapHandler`
- zod schema validates parameter types and ranges
- Common schema collection: filePath / filePathArray / mediaId / rating / uid / httpUrl / uiTheme etc.

### 10.2 Observability

#### 10.2.1 Fault Logs (logger.ts)

- **10 FaultTypes**: uncaughtException / unhandledRejection / rendererCrash / ipcError / databaseError / fileSystemError / startupError / exitDiagnosis / decryptionError / custom
- **FaultRecord** contains full env info: appVersion / electronVersion / nodeVersion / platform / osVersion / pid / uptime
- Total log cap 2GB; oldest-by-mtime eviction on overflow
- File naming: `faults-YYYY-MM-DD.jsonl`

#### 10.2.2 Startup Diagnostics (startup-diagnostic.ts)

- Provides independent error recording capability before logger system is ready
- Directly writes to `Documents/NikkiGallery/Diagnostics/startup-errors.log` (tmpdir fallback)
- 100KB rolling cap

#### 10.2.3 Crash Reports (crash-service.ts)

- `crashReporter.start({ uploadToServer: false, compress: true })`
- Dump files retain 10 copies + 30-day expiry
- List/stats/clear/open dir

#### 10.2.4 Process Exit Diagnostics

- `collectExitDiagnosis(stage)` collects active handles/requests/child processes/timers
- before-cleanup and after-cleanup dual-stage comparison
- Synchronously writes to faults-*.jsonl (fs.appendFileSync, avoids async I/O delaying exit)

#### 10.2.5 Renderer Error Reporting

- `installGlobalErrorHandler` registers `window.onerror` + `unhandledrejection`
- IPC reports to main process faults log (`log:reportRendererError`)
- ErrorBoundary catches child component render sync exceptions
- `console-message` event captures renderer error-level logs

### 10.3 Resource Lifecycle Management

#### 10.3.1 Child Process Registry (process-registry.ts)

- `trackProcess` / `trackFfmpegCommand` / `untrackFfmpegCommand`
- `killAllProcesses(signal)` — kills all active ffmpeg/ffprobe/PowerShell child processes on exit
- 60-second fallback cleanup timer

#### 10.3.2 Single-Instance Lock

- `app.requestSingleInstanceLock()` + 3 retries (1s interval)
- Three-option dialog: Clean & Restart / Manual / Exit
- `before-quit` explicitly calls `app.releaseSingleInstanceLock()`
- `uncaughtException` / `unhandledRejection` handlers explicitly release lock + `app.exit(1)`

#### 10.3.3 Force Timeout Exit Fallback

- `before-quit` dynamically calculates timeout based on WAL file size (2s / 5s)
- `forceExitTimer` triggers `app.exit(1)` on timeout
- All `app.exit()` calls execute directly, no setTimeout delay

---

## 11. Build and Release

### 11.1 Build Scripts

```json
"dev": "electron-vite dev",
"clean": "node -e \"...delete dist/renderer/assets and dist/main...\"",
"build": "npm run clean && electron-vite build && node -e \"...write dist/main/package.json {\"type\":\"commonjs\"}...\"",
"build:preview": "vite build --config vite.preview.config.ts",
"preview": "electron-vite preview",
"dist": "npm run build && electron-builder --publish never",
"dist:win": "npm run build && npm run pre-dist-check && electron-builder --win --publish never && npm run verify:dist",
"pre-dist-check": "tsx scripts/pre-dist-check.ts && tsx scripts/check-doc-versions.ts",
"verify:dist": "tsx scripts/pre-dist-check.ts --verify-asar",
"typecheck": "tsc -b",
"typecheck:e2e": "tsc --noEmit -p e2e",
"lint / lint:fix": "eslint . (--fix for auto-fix)",
"format / format:check": "prettier (covers src / scripts / .storybook / root)",
"test / test:watch / test:coverage / test:main / test:renderer / test:db": "vitest (directory variants)",
"i18n:check / i18n:extract / i18n:extract:gallery / i18n:status / i18n:extract-legacy / i18n:prune-whitelist / i18n:codemod / i18n:guard / sync-i18n-keys": "i18n script family (scripts/i18n/)",
"preview:check": "tsx scripts/check-preview-drift.ts",
"e2e:smoke": "playwright test --config e2e/playwright.config.ts --grep-invert @perf",
"e2e:perf": "playwright test --config e2e/playwright.config.ts --grep @perf",
"dist:win:smoke / dist:win:perf": "package + smoke / perf one-shot",
"perf:save-baseline": "tsx scripts/perf-test/save-perf-baseline.ts",
"storybook": "storybook dev -p 6006",
"build-storybook": "storybook build -o storybook-static",
"commit": "cz (commitizen interactive commit)",
"commitlint / commitlint:check": "commitlint message validation"
```

> Removed legacy scripts: `build:main` / `build:renderer` (now handled by `electron-vite`) and `rebuild:native`
> (native modules are rebuilt locally with `npx @electron/rebuild`, and automatically during packaging via
> `build.npmRebuild: true` in `package.json`).

### 11.2 Build Configuration

#### `electron.vite.config.ts` (Main / preload / renderer three-segment)

- **main**: 6 lib entries (`index` / `scanner-worker` / `media-worker` / `thumbnail-worker` / `video-worker` / `database-worker`, each a worker-entry.ts), outDir `dist/main/main/app`, CJS output; `writeCommonjsShim()` writes `dist/main/package.json {"type":"commonjs"}`
- **preload**: entry `src/main/preload.ts`, outDir `dist/main/main`, define injects `__NIKKI_PRELOAD_DEV__`
- **renderer**: `root: './src/renderer'`, dev port 5173 (strictPort), outDir `dist/renderer`; `resolve.alias`: `@` → renderer, `@main` → main, `@common` → common (`src/common` removed; alias kept as legacy), `electron` → `scripts/electron-browser-stub.js`; define injects `__PREVIEW__: false`

#### `vite.preview.config.ts` (Single-file preview)

- `vite-plugin-singlefile` full-inline bundling, outputs root `preview.html`; define injects `__PREVIEW__: true`

#### `tsconfig.json` (Root, Renderer)

- `target: ES2020`, `module: ESNext`, `jsx: react-jsx`, `strict: true`
- `noUnusedLocals` / `noUnusedParameters` / `noFallthroughCasesInSwitch` enabled
- `paths`: `@/*` / `@main/*` / `@common/*`
- `references: [{path: "./src/main/tsconfig.json"}]` — project references (composite)

#### `src/main/tsconfig.json` (Main Process)

- `target: ES2020`, `module: commonjs` (Electron main process needs CJS)
- `outDir: '../../dist/main'`, `rootDir: '../'`
- `declaration: true`, `sourceMap: true`, `composite: true`
- `include: ["**/*", "../shared/**/*"]`

#### `tailwind.config.ts`

- `content: ['./src/renderer/**/*.{js,jsx,ts,tsx}', './src/renderer/index.html']`
- `theme.extend.colors`: 12 CSS variable mappings (`accent` / `bg-primary` / `text-primary` etc.), all referenced via `var(--xxx)` for easy theme switching
- `transitionTimingFunction`: `win11` / `win11-decelerate` two cubic-beziers

#### `electron-builder` config (embedded in package.json)

- `appId: com.qianlu.wxnn-photo-manager`
- `productName: 无限暖暖相册管理工具`
- `directories.output: release`
- `files: [dist/**/*, resources/**/*]`
- **`asarUnpack`**: 10 native dependency entries unpacked to disk — `ffmpeg-static` / `ffprobe-static` / `better-sqlite3` / `bindings` / `file-uri-to-path` / `sharp` / `@img` / `koffi` / `@koromix` / `nuan5_decryption.dll`
- **Windows NSIS**: x64, non-one-click, allows custom install dir, force create desktop shortcut + start menu shortcut
- `signAndEditExecutable: false` / `verifyUpdateCodeSignature: false` — code signing not enabled

### 11.3 Build Flow

1. `clean` — delete `dist/renderer/assets` and `dist/main`
2. `electron-vite build` — compiles the main process (`src/main` + `shared/`, CJS) → `dist/main/`, and bundles the React app with Vite → `dist/renderer/`; then writes `dist/main/package.json` (`{"type":"commonjs"}`)
3. `pre-dist-check` — verifies main / renderer artifact timestamp gap ≤ 5 minutes, that key fixpoints are compiled in, and that the Git working tree is clean; also verifies the Electron version in `README.md` matches `package.json` (a mismatch blocks packaging)
4. `electron-builder --win --publish never` — packages the NSIS installer per `package.json#build` into `release/` as `NikkiGallery-Setup-<version>.exe`; the afterPack hook `scripts/after-pack-vc-runtime.cjs` copies `vcruntime140.dll` / `vcruntime140_1.dll` / `msvcp140.dll` / `concrt140.dll` next to `electron.exe`
5. `verify:dist` — `pre-dist-check --verify-asar`, asserting runtime dependencies such as the VC++ runtime are bundled
6. Native module rebuild — locally via `npx @electron/rebuild`; during packaging automatically via `build.npmRebuild: true` (better-sqlite3 / sharp / koffi)

### 11.4 Key Dependencies

- **Electron 40.10** + **React 19.2** + **Zustand 5** + **Vite 5** + **TypeScript 5.9**
- **better-sqlite3 12** — synchronous SQLite; main process reads + worker writes
- **sharp 0.35** — image processing (thumbnails, editor pipeline)
- **zod 4** — IPC parameter validation
- **exifr 7** — EXIF parsing
- **fluent-ffmpeg 2** + **ffmpeg-static** + **ffprobe-static** — video processing
- **koffi 3** — FFI calls to `nuan5_decryption.dll`
- **i18next 26** + **react-i18next 17** — 12-language internationalization
- **motion 12** — animations

### 11.5 Desktop Shortcut

The NSIS installer may fail to create a desktop shortcut in overwrite-install scenarios; the app proactively checks and re-creates on startup:

- Runs only in `app.isPackaged` env
- Priority: registry custom desktop path → `app.getPath('desktop')` → user home fallback
- When shortcut exists, validates target effectiveness; rebuilds if invalid
- Uses Electron native `shell.writeShortcutLink`
- Fire-and-forget async call; does not block startup flow

---

## 12. Key Design Constraints

### 12.1 Synchronous Iteration Principle

- HTML preview version and exe program must iterate synchronously
- Both share completely unified UI layout, color scheme, menu hierarchy, interaction logic, and visual style
- HTML preview is only a design preview carrier during development, not an independent product
- Subsequent iterative updates must modify both HTML preview and exe program to ensure version sync

### 12.2 Version Number Constraint

- **Version number must remain unchanged unless user explicitly requests**
- Current version: 2.5.3
- After changing it, keep these in sync: `version` in `package.json`, the version badge in `README.md`, the header and §12.2 of `ARCHITECTURE.md` / `ARCHITECTURE.en.md`, and the header plus §7.8 of `DEVELOPMENT.md` / `DEVELOPMENT.en.md`; the installer filename follows automatically via the `artifactName` template (`NikkiGallery-Setup-${version}.exe`)

### 12.3 Performance Red Lines

- Page switch FPS ≥ 55
- Bundle size increment ≤ 20KB gzip
- Do not use motion in VirtualImageGrid virtual list (performance risk)
- Preserve keep-alive mechanism (do not break scroll position and component state)
- Page switch uses lightweight fade-in animation (8px right shift + fade in, 220ms)
- Frosted-glass effect must be paired with substantive colored background content; avoid use on solid-color backgrounds
- Frosted-glass components use `backdrop-filter: blur(12px)` + `rgba(255, 255, 255, 0.7)` base style
- Frosted-glass components do not use inset highlights or saturate filters; keep styles clean
- Frosted-glass background uses `var(--bg-primary)` instead of radial gradients

### 12.4 Process Exit Reliability

- All `app.exit()` calls must execute directly, no setTimeout delay
- `uncaughtException` / `unhandledRejection` handlers must add `app.releaseSingleInstanceLock?.()` + `app.exit(1)` to eliminate zombie processes holding locks
- `before-quit` handler must call `event.preventDefault()` to prevent default exit flow
- `dbManager.close()` must execute in a separate microtask to avoid blocking the event loop
- Async operations in `performCleanup` must add `Promise.race()` timeout protection
- Diagnostic log writes must use sync APIs (`fs.appendFileSync`) to avoid async I/O delaying exit
- Single-instance lock release must execute immediately after all critical cleanup steps complete

### 12.5 Native Binary Dependencies

- `ffmpeg-static` / `ffprobe-static` / `better-sqlite3` / `bindings` / `file-uri-to-path` / `sharp` / `@img` / `koffi` / `@koromix` / `nuan5_decryption.dll` must be unpacked via `asarUnpack`
- ffmpeg/ffprobe paths must replace `app.asar` → `app.asar.unpacked` via the `native-path.ts` utility

### 12.6 Scanner Constraints

- Game directory lookup priority: user custom → hardcoded defaults → Steam registry + libraryfolders.vdf → Epic registry → full-disk signature search (depth 15)
- Full-disk signature search must do shallow depth 4 fast pass first, then deep scan
- Must skip system directories (Windows/ProgramData/$recycle.bin/onedrive/iclouddrive/dropbox/google drive etc.)
- First launch must perform full scan (incremental:false, fullScan:true)
- Scan completion must send `scanner:complete` event
- Video metadata extraction must include 15-second timeout protection
- ScreenShot detection must include path context validation (must contain 'infinitynikki' or 'x6game')

### 12.7 Share Function Constraints

- Must detect both installed and running status of target apps (WeChat, QQ, vivo office suite)
- 4-layer fallback chain: registry candidates → uninstall entry enumeration → common directory scan → process path reverse lookup
- WeChat prioritizes 'Weixin' registry key and 'Weixin.exe' process, with 'WeChat' as fallback
- QQ uses 'QQNT' (no underscore) registry key; queries Uninstall entries' DisplayIcon
- UI must display three states: running, installed but not running, not installed
- Auto-close strategy: 3s for running, 5s for not installed

### 12.8 Database Constraints

- All SQL INSERT statements must ensure VALUES placeholder count matches `insertStmt.run()` parameter count
- `operation_history` table cleans records older than 30 days on startup
- `character_profiles` table `nickname` column must have an index
- SQL insert statements must cache prepared statements as class members; reset on database connection change
- Legacy data repair must execute once at startScan; fixes `media_source='unknown'` records and removes non-game path records

### 12.9 Log Constraints

- Log files must not contain user privacy data
- Log storage must not exceed 2GB; oldest-by-mtime eviction on overflow (see §10.2.1)
- Log files named by date; auto-rolling storage
- Crash dump files limited to 10 most recent; older files auto-cleaned (see §10.2.3)

### 12.10 App Initialization Constraints

- `new Application()` must be wrapped in `app.whenReady().then()` to avoid calling `app.getPath('userData')` before app ready
- When `requestSingleInstanceLock()` returns false, must show dialog prompting user to end old process; silent exit forbidden
- Main process `uncaughtException` handler must use `hasShownRuntimeErrorDialog` flag to avoid high-frequency error popups; only shows first error
- `render-process-gone` event handler must be async; uses `dialog.showMessageBox` to ask "Reload/Close app"; triple fallback (window destroy check → reload → createMainWindow)
- App startup failure error dialog must use `dialog.showMessageBox` (async) with "Open log directory/Exit" buttons
- `before-quit` handler must include 2-second timeout timer; on timeout records diagnostics and `app.exit(1)`; on cleanup complete, clear timeout and `app.exit(0)`

### 12.11 Diagnostic Package Export Constraints

- Must use Windows 10 1803+ built-in `tar.exe` (bsdtar) instead of PowerShell `Compress-Archive` to avoid system policy blocks
- Command must use `tar.exe -c --format=zip -f "target-path.zip" -C "source-dir" .`
- After creation, must verify target file exists and is non-empty; return clear error message on failure
- Must not rely on PowerShell execution policy

### 12.12 Video Response Constraints

- Must support Range requests (206 Partial Content + Content-Range) for seek functionality
- Media protocol privileges must include `stream: true`
- Video thumbnails use `<img>` element; not restricted by `file_type === 'image'`

### 12.13 Custom Concurrency Control Constraints

- Must use in-house `concurrency.ts` (`runWithConcurrency`) to avoid p-limit ESM `require()` issues

### 12.14 Resonance Records Module Constraints

- **Offline first**: the resonance module must not issue any network request. All static data ships with the app — 11 catalog shards plus `banners.json` / `outfits.json` / `percentile.json` / `snapshot-meta.json`, a 12-language entity name pack, and 73 banner thumbnails (~7.1 MB). Banner thumbnails are resolved via a static import from `src/renderer/data/resonance/thumbnails/index.ts` to a relative in-bundle URL (`base: './'`) — zero external links
- **Main-process responsibility boundary**: the main process only does zod validation, PathGuard allow-list checks (`assertFileReadPath` / `assertFileWritePath`), file I/O and SQLite access. Import parsing, merge/dedupe, diff counting and export payload assembly are all renderer-side pure functions (`src/renderer/utils/resonance/`)
- **Import limits** (constants in `src/shared/types/resonance.ts`): `MAX_IMPORT_FILE_BYTES` = 64 MB per file, `MAX_TOTAL_IMPORT_RECORDS` = 200000, `MAX_PULLS_PER_BANNER` = 50000, `MAX_COMMIT_BATCH_ROWS` = 2000 per commit batch, `MAX_WARDROBE_BATCH` = 5000
- **Import commit**: the renderer calls `resonance:commitImport` in batches of `MAX_COMMIT_BATCH_ROWS`; each batch is one transaction with `INSERT OR IGNORE` (idempotent, resumable after interruption). `wardrobe` is carried only by the final batch (full overwrite)
- **All 9 IPC channels** go through `wrapHandler` + zod schema: `resonance:getData`, `addManualRecord`, `updateManualRecord`, `deleteRecord`, `readImportFile`, `commitImport`, `export`, `updateWardrobe`, `clearAll`. `clearAll` is destructive; the renderer owns the second confirmation
- **Offline guard**: `src/renderer/utils/resonance/offline-guard.test.ts` asserts zero network calls in core flows and statically scans new sources, with reverse cases to prevent false greens

### 12.15 Engineering Invariants (settled since 2026-08)

**Scan channel orchestration** (`src/main/scanner/scan-channels.ts`)

- `resolveScanChannels` only serves the "official album channel + ScreenShot/Video secondary channel" orchestration. **A scan carrying `options.path` takes the single-directory branch (`scanDirectory`), bypassing channel orchestration and the UID gate**
- Only `fullScan: true with no path`, or `!targetPath`, goes through `findMediaDirectories → resolveScanChannels`
- Manual fallback / custom directory scans must use `fullScan: true + customKnownPaths` and **must not pass `path`**, otherwise the official-album channel exemptions and native LQ thumbnail reuse are lost

**Keyset cursor pagination** (`useCursor` in `listMedia`)

- Nullable columns sort last under DESC; a `sortValue === null` anchor uses `AND (col IS NULL AND id < ?)`, while a non-null anchor branch must include `OR col IS NULL`
- `orderBy` must contain `${col} IS NULL ${nullOrder}` (DESC → ASC)

**File read-stream lifecycle**

- Always use `createManagedReadStream(filePath, { signal?, range?, onError? })` from `src/main/utils/managed-read-stream.ts`; **never write a bare `fs.createReadStream().pipe(dest)`** (`pipe` only forwards source errors to the destination, so an outer `try/catch` cannot cover the async phase)
- Callers: `src/main/app/media-protocol.ts`, `src/main/services/share-wifi-service.ts`
- When piping into an HTTP response, still attach `error` / `close` on `res` and de-duplicate with a `settled` flag; on Windows an unclosed fd keeps the file locked

**IPC read-path guard** (`src/main/ipc/media-read-guard.ts`)

- After `assertMediaReadPath` hits the fast path (`!isSensitivePath(p) && isMediaPathAllowed(ctx, p)`) it **must** re-check sensitive directories with `fs.realpathSync.native` (plain string matching cannot detect junctions / symlinks); if sensitive, call `assertFileReadPath(real)` (pass `real`, not the incoming argument)
- Deliberate trade-offs: do not re-run `isMediaPathAllowed(real)` and do not cache realpath (TOCTOU); the non-matching branch passes `filePath` through unchanged

**Worker self-recovery and DB handle release**

- The three bridges (`src/main/scanner/scanner-worker-bridge.ts`, `src/main/database/worker/database-worker-bridge.ts`, `src/main/media-worker/bridge.ts`) `await` a `*_DISPOSED` reply (`WORKER_DISPOSED` / `DB_WORKER_DISPOSED` / `MEDIA_WORKER_DISPOSED`) before restore, with `DISPOSE_CONFIRM_TIMEOUT_MS = 2000` as the kill fallback

**Album type resolution** (`src/main/scanner/path-classifier.ts`, `src/main/utils/media-constants.ts`)

- `isGamePlayPhotosTree` (includes the no-`Saved` variant, used for classification) and `isGamePlayPhotosPath` (standard layout only, used for thumbnail reuse) **must not be mixed up**
- Directory-name lookups must use `Object.prototype.hasOwnProperty.call(ALBUM_TYPE_MAP, key)` (a directory can be named `constructor` / `toString`, and a bare index would hit `Object.prototype`)

**Gallery stack-overflow protection**

- The view area is wrapped in a zone-level `ErrorBoundary` (`resetKeys = [viewMode, filterSignature]`, `maxRetries = 3`); the grid view uses `overscan = 150` and `increaseViewportBy` 100/100
- **Do not upgrade react-virtuoso** (the 4.x recursion issue is not fixed upstream, issue #946)

**Navigation / preload authorization boundary (two layers)**

- Main process: `isAppDocumentUrl(url, isDev)` in `src/main/app/navigation-guard.ts`, enforced via `will-navigate` + `will-frame-navigate` in `window-manager.ts`
- Preload: `isTrustedDocumentOrigin` in `src/main/preload/origin-guard.ts`; all 5 `exposeInMainWorld` calls go through `exposeIfTrusted()`
- The two allow-lists are **mirrored but do not share a module** (preload must not import main-process modules) — changing one requires syncing the other. The `will-frame-navigate` callback receives **only one argument** (`url` / `isMainFrame` live on the Event)
- Runtime `process.env` is unavailable in preload (lib mode does not substitute); the dev flag comes from `define: { __NIKKI_PRELOAD_DEV__ }` in `electron.vite.config.ts`

**Native dependencies and early-startup observability**

- `scripts/after-pack-vc-runtime.cjs` copies `vcruntime140.dll` / `vcruntime140_1.dll` / `msvcp140.dll` / `concrt140.dll` next to `electron.exe` in the afterPack phase; `npm run verify:dist` (`pre-dist-check --verify-asar`) asserts they exist
- `src/main/app/native-load-guard.ts` pre-checks inside `app.whenReady` and reports failures via `dialog.showErrorBox` (i18n-independent)
- `reportEarlyFatal` in `src/main/utils/early-crash-guard.ts`: persists a diagLog, shows an error box, releases the single-instance lock and calls `app.exit(1)`, guarded against duplicates. The diagnostics directory comes from `src/main/utils/user-diag-path.ts` (`Documents/NikkiGallery/Diagnostics`)
- Verification switches `NIKKI_EARLY_CRASH_SIM=1` / `NIKKI_SKIP_NATIVE_GUARD=1`; one-way dependency: never import `native-load-guard` back from here

---

## Appendix A: Core Design Patterns

### A.1 Multi-Process Isolation

DB writes / scanning / thumbnail+pHash+duplicate detection / sharp scaling / video editing each run in an independent utilityProcess, avoiding main process event loop blocking.

### A.2 Priority Scheduling

User-initiated (high) can preempt background tasks (low); low-priority FIFO serial (concurrency 1).

### A.3 WAL Multi-Connection Concurrency

Main process reads + worker writes share the same db file; `busy_timeout=5000`.

### A.4 Test Seam

`MediaRepository` can be instantiated against in-memory database; `path-classifier` is pure functions.

### A.5 Unified Security Baseline

`PathGuard` whitelist + system sensitive dir blacklist + zod validation + `wrapHandler` unified response wrapping.

### A.6 Resource Lifecycle Management

`process-registry` tracks all child processes; `before-quit` runs `killAllProcesses` + disposes three worker bridges + WAL checkpoint + force timeout fallback.

### A.7 keep-alive Routing

Avoids view switch re-mounting; preserves scroll and component state.

### A.8 Module-Level Cache

`useFilteredMediaFiles` shares filter results across components.

### A.9 Optimistic Update + Failure Rollback

`useFavoriteToggle` pattern.

### A.10 Type-Dispatched Undo Handlers

`operationHistoryStore` avoids undoFn closure capture.

### A.11 Set Subscription Pattern

`addOperationHistoryErrorHandler` supports multiple subscribers.

### A.12 Unified Animation Presets

`motionPresets` single source.

### A.13 BaseDialog Base Class

All dialogs share focus trap/animation/mask behavior.

### A.14 InfoRowPanel Common Carrier

5 InfoPanels share four-state rendering.

### A.15 CSS Variable Theme System

Theme switching with zero JS re-render.

### A.16 shared/ Cross-Process Sharing

`scene-category` / `dimension` eliminate circular dependencies from renderer reverse-importing main process modules.

---

## Appendix B: Key File Path Index

### B.1 Entry and Config

| File                      | Purpose                                                                           |
| ------------------------- | --------------------------------------------------------------------------------- |
| `src/main/index.ts`       | Main process entry (early guards + protocol registration + Application bootstrap) |
| `src/main/preload.ts`     | preload entry (assembly + contextBridge; module tree in `src/main/preload/`)      |
| `src/renderer/main.tsx`   | Renderer process entry                                                            |
| `src/renderer/App.tsx`    | App root component                                                                |
| `package.json`            | Dependencies and build config                                                     |
| `electron.vite.config.ts` | Main/preload/renderer three-segment build config                                  |
| `vite.preview.config.ts`  | Single-file preview build config                                                  |
| `tsconfig.json`           | TypeScript config (root, renderer)                                                |
| `src/main/tsconfig.json`  | TypeScript config (main process)                                                  |
| `tailwind.config.ts`      | Tailwind config                                                                   |
| `eslint.config.js`        | ESLint config                                                                     |

### B.2 Types and Errors

| File                                  | Purpose                                              |
| ------------------------------------- | ---------------------------------------------------- |
| `src/shared/types/index.ts`           | Shared types unified export                          |
| `src/shared/types/media.ts`           | Media domain types                                   |
| `src/shared/types/ipc.ts`             | IPC domain types + IPC_CHANNELS registry             |
| `src/shared/types/ipc-types.ts`       | IpcResponse / IpcError contract layer                |
| `src/shared/types/progress.ts`        | Task progress state protocol                         |
| `src/shared/types/plugin.ts`          | Plugin system shared types                           |
| `src/shared/types/editor-metadata.ts` | Editor params XMP serialization types                |
| `src/shared/types/duplicate.ts`       | Duplicate/similarity domain types                    |
| `src/shared/types/electron-api.ts`    | Preload electronAPI DTO type snapshots               |
| `src/shared/settings-keys.ts`         | Renderer-writable key whitelist + sensitive key list |
| `src/shared/errors/app-error.ts`      | AppError class and 6 subclasses                      |
| `src/shared/errors/error-codes.ts`    | Error codes and category mapping                     |
| `src/shared/dimension.ts`             | Smart grouping dimensions                            |
| `src/shared/scene-category.ts`        | Game scene categories                                |
| `src/shared/types/resonance.ts`       | Resonance domain types + zod schemas + import limits |     |

### B.3 Main Process Core

| File                                                 | Purpose                                           |
| ---------------------------------------------------- | ------------------------------------------------- |
| `src/main/database/connection.ts`                    | DatabaseManager                                   |
| `src/main/database/media-repository.ts`              | MediaRepository (SQL access layer)                |
| `src/main/database/worker/database-worker-bridge.ts` | Database Worker bridge                            |
| `src/main/database/worker/database-worker.ts`        | Database Worker entry                             |
| `src/main/database/worker/worker-protocol.ts`        | Database Worker protocol                          |
| `src/main/scanner/index.ts`                          | ScannerManager (thin shell)                       |
| `src/main/scanner/scanner-worker-bridge.ts`          | Scanner Worker bridge                             |
| `src/main/scanner/path-classifier.ts`                | Path classification pure functions                |
| `src/main/scanner/worker-entry.ts`                   | Scanner Worker entry                              |
| `src/main/scanner/worker-protocol.ts`                | Scanner Worker protocol                           |
| `src/main/media-worker/manager.ts`                   | MediaWorkerManager (thin shell)                   |
| `src/main/media-worker/bridge.ts`                    | Media Worker bridge                               |
| `src/main/media-worker/worker-entry.ts`              | Media Worker entry                                |
| `src/main/media-worker/worker-protocol.ts`           | Media Worker protocol                             |
| `src/main/scheduler/task-scheduler.ts`               | Priority task scheduler                           |
| `src/main/thumbnail/generator.ts`                    | ThumbnailGenerator                                |
| `src/main/ipc/handler-context.ts`                    | Dependency injection context                      |
| `src/main/ipc/validator.ts`                          | wrapHandler + PathGuard + schemas                 |
| `src/main/ipc/media-read-guard.ts`                   | `assertMediaReadPath` (with realpath re-check)    |
| `src/main/ipc/handlers/resonance-handler.ts`         | 9 resonance IPC channels                          |
| `src/main/preload/api/resonance.ts`                  | `electronAPI.resonance` namespace                 |
| `src/main/preload/origin-guard.ts`                   | `isTrustedDocumentOrigin` + `exposeIfTrusted`     |
| `src/main/app/navigation-guard.ts`                   | `isAppDocumentUrl` (navigation guard layer 1)     |
| `src/main/app/native-load-guard.ts`                  | Native module load pre-check (VC++ runtime)       |
| `src/main/database/resonance-repository.ts`          | Resonance repository + `RESONANCE_DDL_STATEMENTS` |
| `src/main/scanner/scan-channels.ts`                  | `resolveScanChannels` orchestration               |
| `src/main/utils/media-constants.ts`                  | Album type map `ALBUM_TYPE_MAP`                   |
| `src/main/utils/managed-read-stream.ts`              | `createManagedReadStream`                         |
| `src/main/utils/early-crash-guard.ts`                | `reportEarlyFatal`                                |
| `src/main/utils/user-diag-path.ts`                   | Diagnostics directory resolution                  |     |

### B.4 Renderer Process Core

| File                                                   | Purpose                                                                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `src/renderer/stores/mediaStore.ts`                    | Media data store                                                                                                 |
| `src/renderer/stores/uiStore.ts`                       | UI global state store                                                                                            |
| `src/renderer/stores/themeStore.ts`                    | Theme store                                                                                                      |
| `src/renderer/stores/operationHistoryStore.ts`         | Operation history store                                                                                          |
| `src/renderer/hooks/useFileOperations.ts`              | File ops core hook                                                                                               |
| `src/renderer/hooks/useFilteredMediaFiles.ts`          | Filter+sort+group hook                                                                                           |
| `src/renderer/hooks/useIpcCall.ts`                     | IPC call wrapper hook                                                                                            |
| `src/renderer/components/layout/AppShell.tsx`          | Overall layout skeleton                                                                                          |
| `src/renderer/components/layout/Sidebar.tsx`           | Sidebar                                                                                                          |
| `src/renderer/components/common/BaseDialog.tsx`        | Modal dialog base class                                                                                          |
| `src/renderer/components/common/InfoRowPanel.tsx`      | InfoPanel common carrier                                                                                         |
| `src/renderer/components/gallery/VirtualImageGrid.tsx` | Grid view (virtual scroll)                                                                                       |
| `src/renderer/components/gallery/FullscreenViewer.tsx` | Fullscreen browser                                                                                               |
| `src/renderer/utils/imageProcessor.ts`                 | Image processing pipeline                                                                                        |
| `src/renderer/i18n/index.ts`                           | i18n entry                                                                                                       |
| `src/renderer/styles/globals.css`                      | Global styles + CSS variables                                                                                    |
| `src/renderer/styles/themes/index.ts`                  | Theme config center                                                                                              |
| `src/renderer/icons/index.tsx`                         | 74 SVG icons centrally managed                                                                                   |
| `src/renderer/pages/ResonanceRecordsPage.tsx`          | Resonance Records page (records / wardrobe / import-export / stats)                                              |
| `src/renderer/stores/resonanceStore.ts`                | Resonance store                                                                                                  |
| `src/renderer/components/resonance/`                   | Resonance views (Records / Wardrobe / ImportExport / Stats / AddRecordDialog)                                    |
| `src/renderer/utils/resonance/`                        | Resonance pure functions (import parse / merge / export / stats / percentile / static data / offline guard test) |
| `src/renderer/data/resonance/`                         | Resonance static data (catalog / banners / outfits / percentile / 12-language names / banner thumbnails)         |     |

### B.5 Resources

| File                                    | Purpose                                                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resources/icons/icon.ico`              | App icon                                                                                                                                                                 |
| `resources/nuan5_decryption.dll`        | Game photo param decryption DLL                                                                                                                                          |
| `src/renderer/assets/cloth-names.json`  | 7369 clothing names                                                                                                                                                      |
| `src/renderer/assets/outfit-names.json` | 657 outfit names                                                                                                                                                         |
| `src/renderer/data/resonance/`          | Resonance static data (11 catalog shards + banner / outfit / percentile snapshots + 12-language names + 73 banner thumbnails, ~7.1 MB, bundled with zero external links) |     |

---

## Appendix C: Project Overview Supplementary Notes

> This section is condensed from `docs/PROJECT-OVERVIEW.md` (the original file has been deleted); only points not duplicated in this document are kept.

### C.1 Dual-Form Delivery

- **exe installer** (electron-builder): the full desktop application.
- **Single-file HTML preview** (vite-plugin-singlefile + mock IPC): shares the same UI and interactions for install-free preview; the exe build and the preview build must iterate in sync and keep identical versions.

### C.2 Quality Gate Scripts

- `typecheck` (tsc -b), `lint` (eslint), `test` (vitest run), `format` (prettier), `i18n:check`, `preview:check`, `pre-dist-check`.

### C.3 Test Scale

- Vitest 1.6, 263 test files / 4476 cases (measured 2026-09-06, all green).
- The two environment-related failures in the historical baseline (`path-safety.test.ts` read-only-directory case, `GalleryStackOverflow.test.tsx`) were fixed in 2.5.0; there are currently no pre-existing failures.

---

**End of Document**

## Developer Info / Author & Social Platforms

- **Douyin**: 纤璐不会玩摄影 ([profile](https://v.douyin.com/Dx67wYkw48A/))
- **Xiaohongshu (RED)**: 纤璐不会玩摄影 ([profile](https://www.xiaohongshu.com/user/profile/69270bb200000000370092db))
- **Bilibili**: 纤璐不会玩摄影 ([profile](https://b23.tv/zCR5oGE))
- **GitHub**: [QianQianLuLu1](https://github.com/QianQianLuLu1)
- **CSDN Blog**: [QianQian-LuLu](https://blog.csdn.net/2604_96788940)
- **Author Site**: https://ppebv9al.qwenwork.host/
