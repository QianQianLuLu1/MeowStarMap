# Development Guide (DEVELOPMENT.en.md)

> A beginner-friendly development guide for "Infinity Nikki Photo Manager" (NikkiGallery).
> All commands can be copied directly into a PowerShell terminal.
> Project codename: `wxnn-photo-manager` / App name: NikkiGallery / Current version: 2.3.0 / Platform: Windows x64

---

## Table of Contents

- [1. Environment Requirements](#1-environment-requirements)
- [2. Install & Run Commands](#2-install--run-commands)
- [3. Directory Layout](#3-directory-layout)
- [4. Debugging](#4-debugging)
- [5. Code Conventions](#5-code-conventions)
- [6. Troubleshooting](#6-troubleshooting)
- [7. Packaging Workflow](#7-packaging-workflow)

---

## 1. Environment Requirements

### 1.1 Required Software

| Software    | Version       | Notes                                                                     |
| ----------- | ------------- | ------------------------------------------------------------------------- |
| **Node.js** | 20.x LTS      | `.node-version` in the project root pins to `20`; Node < 20 will not work |
| **npm**     | 10+           | Bundled with Node.js; no separate install needed                          |
| **Git**     | any           | Used for version control; recommended                                     |
| **Windows** | 10 1803+ / 11 | Build target platform; macOS and Linux are not supported                  |

### 1.2 Recommended Tools (optional)

- **Visual Studio Code**: Editor. Recommended extensions:
  - ESLint
  - Prettier - Code formatter
  - Tailwind CSS IntelliSense
- **Trae IDE / Cursor**: AI-assisted development environments

### 1.3 Verify Environment

```bash
node -v
```

Expected output: `v20.x.x`.

```bash
npm -v
```

Expected output: `10.x.x` or higher.

> If `node -v` errors or returns a version below 20, download the LTS version from [nodejs.org](https://nodejs.org/).

---

## 2. Install & Run Commands

### 2.1 Locate the Project

The project root is the directory containing this file. All commands assume you are in the project root.

```bash
cd "h:\45001\Documents\WXNN XiangCe"
```

### 2.2 Install Dependencies (first run only)

```bash
npm install
```

> The `.npmrc` file already configures Electron and electron-builder to use a Chinese mirror (npmmirror); no extra setup needed.
> `legacy-peer-deps=true` is enabled to avoid React 19 / older dependency conflicts.

### 2.3 Rebuild Native Modules (after first install or after switching Node versions)

```bash
npm run rebuild:native
```

> Native modules: `better-sqlite3`, `sharp`, `koffi`.
> Without rebuilding you will see `Module not found` or `.node` load errors.

### 2.4 Start in Dev Mode (the exe app)

```bash
npm run dev
```

This runs:

1. `npm run build:main`: compile main-process TypeScript into `dist/main/`
2. `electron .`: launch the Electron desktop app

> Restart `npm run dev` after editing code under `src/main/`.
> For renderer hot-reload, run `vite` separately — see [4.2](#42-frontend-hot-reload).

### 2.5 HTML Preview (quick preview without launching Electron)

```bash
npm run preview
```

Open `http://localhost:5173/` in a browser to view the renderer UI.

### 2.6 Build Artifacts (no installer)

```bash
npm run build
```

Includes clean, main-process compile, and renderer build. Output goes to `dist/`.

### 2.7 Build the Installer

```bash
npm run dist:win
```

See [7. Packaging Workflow](#7-packaging-workflow).

---

## 3. Directory Layout

```
WXNN XiangCe/
├── src/
│   ├── main/                  # Electron main process (Node environment)
│   │   ├── index.ts           # Main entry; starts app, creates windows, registers IPC
│   │   ├── preload.ts         # Preload script; exposes electronAPI to renderer
│   │   ├── app/               # App lifecycle management (14 files)
│   │   │   ├── application.ts       # App main class
│   │   │   ├── lifecycle.ts         # Lifecycle management
│   │   │   ├── cleanup.ts           # Exit cleanup
│   │   │   ├── startup-tasks.ts     # Startup tasks
│   │   │   ├── window-manager.ts    # Window management
│   │   │   ├── desktop-shortcut.ts  # Desktop shortcut
│   │   │   ├── error-handlers.ts    # Error handling
│   │   │   ├── ipc-setup.ts         # IPC registration orchestration
│   │   │   ├── media-protocol.ts    # media:// protocol
│   │   │   └── ...                  # media-update/recovery/theme etc.
│   │   ├── database/          # SQLite database management
│   │   │   ├── connection.ts        # DB connection and schema init
│   │   │   ├── media-repository.ts  # Media CRUD
│   │   │   └── worker/             # DB write operations split into utilityProcess
│   │   ├── scanner/           # File scanner
│   │   │   ├── index.ts             # Scanner manager (thin shell)
│   │   │   ├── scanner-worker-bridge.ts  # Bridge to child process
│   │   │   └── path-classifier.ts   # Path classification (game/launcher/cloud...)
│   │   ├── media-worker/      # Thumbnail / pHash / duplicate detection subprocess
│   │   ├── scheduler/         # Priority-based task scheduler
│   │   ├── services/          # Business services (file/video/watermark/share/backup...)
│   │   ├── thumbnail/         # Thumbnail generator (sharp-based)
│   │   ├── ipc/handlers/      # IPC channel handlers (one file per domain, ~30 files)
│   │   ├── plugins/           # Plugin host (plugin-host/permission-guard)
│   │   ├── video-editor/      # Video editor subprocess (bridge/filter-builder/watermark-builder)
│   │   ├── i18n/              # Main-process internationalization
│   │   ├── utils/             # Main-process utils (logger/ffmpeg-paths/concurrency...)
│   │   ├── types/             # Main-process type declarations
│   │   └── tsconfig.json      # Main-process TypeScript config
│   │
│   ├── renderer/              # Renderer process (browser env, React app)
│   │   ├── App.tsx            # Root component, view routing
│   │   ├── main.tsx           # React entry, mounts to #root
│   │   ├── preview-entry.tsx  # Preview entry
│   │   ├── index.html         # HTML template
│   │   ├── components/        # UI components
│   │   │   ├── common/             # Common components (Spinner/BaseDialog/Toast...)
│   │   │   ├── editor/             # Image editor components
│   │   │   ├── gallery/            # Gallery view components
│   │   │   ├── layout/             # Layout (AppShell/Sidebar/TitleBar)
│   │   │   ├── scanner/            # Scan progress components
│   │   │   └── video/              # Video player
│   │   ├── pages/             # Page components
│   │   │   ├── GalleryPage.tsx     # Gallery home
│   │   │   ├── DetailPage.tsx      # Detail page
│   │   │   ├── EditorPage.tsx      # Editor page
│   │   │   ├── SettingsPage.tsx    # Settings page
│   │   │   ├── CategoriesPage.tsx  # Category management
│   │   │   ├── DuplicatesPage.tsx  # Duplicate detection
│   │   │   ├── RecycleBinPage.tsx  # Recycle bin
│   │   │   ├── OutfitGalleryPage.tsx # Outfit gallery
│   │   │   └── settings/           # Settings sub-sections
│   │   ├── hooks/             # Custom React Hooks
│   │   ├── stores/            # Zustand state management
│   │   ├── i18n/              # Internationalization (12 languages)
│   │   ├── styles/            # Global styles and themes
│   │   ├── plugins/           # Plugin runtime (plugin-runtime.ts)
│   │   ├── search/            # Full-text search index (FlexSearch)
│   │   ├── preview/           # Preview mock data
│   │   ├── icons/             # SVG icon management
│   │   ├── utils/             # Renderer utilities
│   │   └── assets/            # Static assets (outfit name JSONs)
│   │
│   ├── shared/                # Cross-process shared code (used by both main & renderer)
│   │   ├── types/             # Shared type definitions
│   │   ├── errors/            # Unified error codes and AppError class
│   │   ├── dimension.ts       # Layout dimension constants
│   │   └── scene-category.ts  # Scene category definitions
│   │
│   └── common/                # Generic utils (Electron-agnostic, pure JS)
│       └── utils/             # Pure functions: formatSize/generateId/deepClone...
│
├── resources/                 # App resources
│   ├── icons/                 # App icons (.ico/.svg)
│   └── nuan5_decryption.dll   # In-game photo parameter decryption library
│
├── scripts/                   # Helper scripts
│   ├── check-i18n-keys.ts     # i18n key completeness check
│   ├── check-preview-drift.ts # Preview vs source drift check
│   ├── generate-icon.js       # Icon generator
│   └── perf-test/             # Performance tests
│
├── docs/                      # Documentation
│   ├── dev-docs/              # Dev docs (troubleshooting, contribution, etc.)
│   └── screenshots/           # Screenshots
│
├── tests/                     # Test setup
├── package.json               # Dependencies and scripts
├── tsconfig.json              # Renderer TypeScript config
├── tsconfig.scripts.json     # Script TypeScript config
├── vite.config.ts             # Vite config (port 5173, root src/renderer)
├── vitest.config.ts           # Vitest config
├── eslint.config.js           # ESLint rules
├── .prettierrc                # Prettier formatting rules
├── tailwind.config.ts         # Tailwind CSS config
├── postcss.config.js         # PostCSS config
└── ARCHITECTURE.md            # Architecture document (detailed)
```

### Key Conventions

- **Path aliases**:
  - `@/*` → `src/renderer/*`
  - `@main/*` → `src/main/*`
  - `@common/*` → `src/common/*`
- **Process isolation**: main-process code cannot import renderer code, and vice versa; shared code lives in `src/shared/` or `src/common/`
- **HTML preview**: `preview.html` is iterated in sync with the exe app; UI/features must stay consistent

---

## 4. Debugging

### 4.1 Main Process Debugging

```bash
npm run dev
```

After launch, main-process logs stream to the terminal. Restart the command after editing main-process code.

### 4.2 Frontend Hot Reload (standalone Vite server)

```bash
npm run preview
```

Open `http://localhost:5173/` in a browser; edits under `src/renderer/` hot-reload.
**Note**: The preview cannot call IPC (no Electron main process); all `window.electronAPI` calls return `undefined`.

### 4.3 Open Chrome DevTools

In the running Electron window, press `Ctrl+Shift+I` to open DevTools:

- Console: renderer logs
- Network: network requests
- Application: localStorage / IndexedDB
- React DevTools (install the extension separately)

### 4.4 View Main-Process Logs

Logs are written to:

```
%APPDATA%\wxnn-photo-manager\logs\
```

Open in PowerShell:

```powershell
explorer "$env:APPDATA\wxnn-photo-manager\logs"
```

Key log files:

- `app.log`: application log
- `startup-errors.log`: startup error log
- `faults.log`: fault records (10 FaultType categories)

### 4.5 Inspect the Database

The database file is at:

```
%APPDATA%\wxnn-photo-manager\wxnn_photo_manager.db
```

Use [DB Browser for SQLite](https://sqlitebrowser.org/) to open and inspect it.

### 4.6 Type Checking

```bash
npm run typecheck
```

Runs TypeScript type-checking across the project; emits no files.

### 4.7 Lint

```bash
npm run lint
```

Auto-fix fixable issues:

```bash
npm run lint:fix
```

### 4.8 Code Formatting

```bash
npm run format
```

Check only, no writes:

```bash
npm run format:check
```

### 4.9 Run Unit Tests

```bash
npm test
```

Watch mode (auto-rerun on file change):

```bash
npm run test:watch
```

Generate coverage report:

```bash
npm run test:coverage
```

> Coverage report is in `coverage/`; open `coverage/index.html` in a browser.

### 4.10 i18n Key Check

```bash
npm run i18n:check
```

Verifies translation key completeness across 12 languages.

### 4.11 Preview Drift Check

```bash
npm run preview:check
```

Checks `preview.html` vs `src/renderer/` for critical drift (nav items, CSS variables, i18n coverage).

### 4.12 VS Code Debug Config (optional)

Create `.vscode/launch.json` in the project root:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Electron: Main",
      "type": "node",
      "request": "launch",
      "cwd": "${workspaceFolder}",
      "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/electron",
      "windows": {
        "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/electron.cmd"
      },
      "args": ["."],
      "preLaunchTask": "npm: build:main",
      "sourceMaps": true,
      "outFiles": ["${workspaceFolder}/dist/main/**/*.js"]
    }
  ]
}
```

Set breakpoints in main-process code and run the launcher.

---

## 5. Code Conventions

### 5.1 Prettier Formatting

Config: `.prettierrc`

| Rule                  | Value                           |
| --------------------- | ------------------------------- |
| Indent                | 2 spaces                        |
| Print width           | 100 chars                       |
| Semicolons            | none                            |
| Quotes                | single                          |
| Trailing comma        | none                            |
| Arrow function params | always parenthesized `(x) => x` |
| End of line           | LF                              |

Run before commit:

```bash
npm run format
```

### 5.2 ESLint Rules

Config: `eslint.config.js`

Key rules:

- `@typescript-eslint/no-explicit-any`: `warn` (avoid `any`; warn when unavoidable)
- `@typescript-eslint/no-unused-vars`: `warn` (unused vars prefixed with `_` are ignored)
- `react/react-in-jsx-scope`: `off` (React 17+ JSX transform; no need to import React)
- `no-empty`: `warn` (empty catch allowed; comment recommended)

Run before commit:

```bash
npm run lint
```

### 5.3 TypeScript Rules

- Strict mode: `strict: true`
- Unused locals: error
- Unused parameters: error
- Path aliases: `@/` `@main/` `@common/`
- Shared types go in `src/shared/types/`
- Cross-process communication types must be defined in `src/shared/types/ipc-types.ts`

### 5.4 Naming Conventions

| Type                  | Style                         | Example                      |
| --------------------- | ----------------------------- | ---------------------------- |
| Component files       | PascalCase.tsx                | `BaseDialog.tsx`             |
| Utility files         | kebab-case.ts                 | `file-utils.ts`              |
| Hook files            | camelCase starting with `use` | `useToast.ts`                |
| Test files            | originalName.test.ts          | `file-utils.test.ts`         |
| Classes / interfaces  | PascalCase                    | `ScannerManager`             |
| Functions / variables | camelCase                     | `generateThumbnail`          |
| Constants             | UPPER_SNAKE_CASE              | `MAX_SIGNATURE_SEARCH_DEPTH` |
| CSS classes           | kebab-case                    | `.icon-btn`                  |
| React components      | PascalCase                    | `<BaseDialog />`             |

### 5.5 Code Organization Principles

- **Reuse first**: before writing anything, check `src/common/utils/` and `src/renderer/components/common/` for existing implementations
- **Small steps**: one feature point per change; run tests before moving on
- **Solve only the current problem**: no speculative future-proofing; no code for non-existent requirements
- **Small functions**: few params, shallow nesting; split when large
- **Guard clauses**: return early on edge cases; don't wrap main logic in deep nesting
- **Handle errors**: either return a meaningful value or throw upward; never silently swallow
- **Release resources**: listeners, timers, connections, etc.

### 5.6 Comments

- Write "why", not "what"
- If the code itself is hard to read, refactor the code; don't patch with comments
- Complex business logic and known pitfalls must be commented

### 5.7 Pre-Commit Checklist

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm run format:check
```

```bash
npm test
```

All four must pass before commit.

---

## 6. Troubleshooting

### 6.1 `npm install` fails

**Symptom**: dependency install errors or hangs.

**Steps**:

1. Switch to the npm mirror:

   ```bash
   npm config set registry https://registry.npmmirror.com
   ```

2. Clean and reinstall:

   ```bash
   rm -rf node_modules
   rm package-lock.json
   npm cache clean --force
   npm install
   ```

3. If `electron` download fails, make sure the mirror env vars are set (do NOT write them to the project `.npmrc`, otherwise npm prints the `Unknown project config` warning). Set them as user-level env vars:

   ```
   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
   ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
   ```

### 6.2 Startup reports `Module not found: ... .node`

**Cause**: native module not compiled or Node version mismatch.

**Fix**:

```bash
npm run rebuild:native
```

If that fails:

```bash
rm -rf node_modules
npm install
npm run rebuild:native
```

### 6.3 `npm run dev` shows a white screen

**Steps**:

1. Press `Ctrl+Shift+I` in the app window to open DevTools and check Console errors
2. Verify `dist/main/` exists; if not, run:

   ```bash
   npm run build:main
   ```

3. Verify `dist/renderer/` exists; if not, run:

   ```bash
   npm run build:renderer
   ```

### 6.4 TypeScript type errors

**Full type check**:

```bash
npm run typecheck
```

**Common errors**:

- `Cannot find module '@common/utils'`: path alias not resolving; check `tsconfig.json` `paths`
- `Property 'xxx' does not exist on type ...`: interface missing a field; add it under `src/shared/types/`
- `Type 'undefined' is not assignable to ...`: variable may be undefined; add a null check or `??` default

### 6.5 Unit tests fail

**Single-file debug**:

```bash
npx vitest run src/main/utils/file-utils.test.ts
```

**Verbose output**:

```bash
npx vitest run --reporter=verbose
```

**Common issues**:

- Missing API in jsdom: add a mock in `tests/setup.ts`
- `window.electronAPI is undefined`: a placeholder is already injected in `tests/setup.ts`; mock specific methods as needed

### 6.6 No images after launch

See the troubleshooting manual for "Cannot scan screenshots".

Quick checks:

1. Confirm the game has produced screenshots (e.g. `...\InfinityNikki\Saved\ScreenShot\` contains files)
2. In Settings → Scan, click "Scan now"
3. Manually add the game directory to custom scan paths
4. Check `%APPDATA%\wxnn-photo-manager\logs\app.log` for errors

### 6.7 App crashes / exits immediately

See the troubleshooting manual for "Crash / exit".

Crash dumps are at:

```
%APPDATA%\wxnn-photo-manager\Crashpad\
```

Open in PowerShell:

```powershell
explorer "$env:APPDATA\wxnn-photo-manager\Crashpad"
```

> The 20 most recent crash files are retained; older ones are auto-cleaned.

### 6.8 Startup failure (error dialog at launch)

**Step 1**: Click "Open log directory" in the dialog and inspect `startup-errors.log`

**Step 2**: Clean potentially corrupt files:

```powershell
explorer "$env:APPDATA\wxnn-photo-manager"
```

Delete these files (**back them up first**):

- `wxnn_photo_manager.db-wal`
- `wxnn_photo_manager.db-shm`
- `wxnn_photo_manager.db-journal`

**Do NOT delete** `wxnn_photo_manager.db` (that is your media database).

**Step 3**: Reset config (last resort): rename `config.json` to `config.json.bak` and restart the app.

### 6.9 Single-instance lock conflict

**Symptom**: dialog "Application is already running".

**Fix**:

1. Check the system tray for the app icon
2. Click "Clean and restart" in the dialog
3. If that fails, click "Manual handling" and end all processes named "无限暖暖相册管理工具" in Task Manager

Force-kill via PowerShell:

```powershell
Get-Process | Where-Object { $_.ProcessName -like '*wxnn*' -or $_.ProcessName -like '*无限暖暖*' } | Stop-Process -Force
```

### 6.10 More troubleshooting

Full manual: see the troubleshooting sections above.

---

## 7. Packaging Workflow

### 7.1 Pre-Pack Checks

All must pass before packaging:

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm run format:check
```

```bash
npm test
```

### 7.2 Full Build Command

```bash
npm run dist:win
```

This runs sequentially:

1. `npm run clean`: clean `dist/renderer/assets/`
2. `npm run build:main`: compile main process to `dist/main/`
3. `npm run build:renderer`: Vite bundles the renderer to `dist/renderer/`
4. `electron-builder --win`: package Windows NSIS installer

### 7.3 Step-by-Step (for debugging)

**Compile main process only**:

```bash
npm run build:main
```

**Build renderer only**:

```bash
npm run build:renderer
```

**Package installer only (requires build first)**:

```bash
npx electron-builder --win
```

### 7.4 Output Location

After packaging:

```
release/
├── 无限暖暖相册管理工具 Setup 2.3.0.exe    # NSIS installer
└── builder-effective-config.yaml             # build config snapshot
```

### 7.5 Build Config (`build` field in `package.json`)

| Field                          | Value                           | Description                                       |
| ------------------------------ | ------------------------------- | ------------------------------------------------- |
| `appId`                        | `com.qianlu.wxnn-photo-manager` | Unique app identifier                             |
| `productName`                  | `无限暖暖相册管理工具`          | Display name                                      |
| `directories.output`           | `release`                       | Output directory                                  |
| `files`                        | `dist/**/*`, `resources/**/*`   | Files included                                    |
| `asarUnpack`                   | see table below                 | Native deps that must not be packed into asar     |
| `win.target`                   | `nsis` x64                      | Windows NSIS installer                            |
| `win.icon`                     | `resources/icons/icon.ico`      | App icon                                          |
| `nsis.oneClick`                | `false`                         | Non-one-click install; allows directory selection |
| `nsis.createDesktopShortcut`   | `always`                        | Always create desktop shortcut                    |
| `nsis.createStartMenuShortcut` | `true`                          | Create Start menu shortcut                        |

**asarUnpack list** (native binaries must be unpacked or they will fail to load):

```
**/ffmpeg-static/**
**/ffprobe-static/**
**/better-sqlite3/**
**/sharp/**
**/@img/**
**/koffi/**
**/nuan5_decryption.dll
```

### 7.6 Regenerate the App Icon

If you modify `resources/icons/icon.svg`, regenerate the `.ico`:

```bash
node scripts/generate-icon.js
```

### 7.7 Install and Test

1. Double-click `release\无限暖暖相册管理工具 Setup 2.3.0.exe` to install
2. Launch from Start menu or desktop shortcut
3. On first launch a full-disk scan runs to locate the game directory (first scan is slow; please be patient)
4. A desktop shortcut is created automatically (skipped if it already exists)

### 7.8 Version Number Management

- **Do not change the version number** unless explicitly requested
- Version is in `package.json` `version` field
- Current version: `2.3.0`

Example (only when explicitly requested):

```bash
npm version 2.4.0 --no-git-tag-version
```

### 7.9 Sync Principle: HTML Preview vs exe

Every change to the exe app must also be applied to `preview.html` (if it exists), keeping:

- Layout consistent
- Color scheme consistent
- Menu hierarchy consistent
- Interaction logic consistent
- Visual style consistent

Drift check:

```bash
npm run preview:check
```

---

## Appendix: Common Commands Cheat Sheet

| Task                    | Command                         |
| ----------------------- | ------------------------------- |
| Install dependencies    | `npm install`                   |
| Rebuild native modules  | `npm run rebuild:native`        |
| Dev mode (exe app)      | `npm run dev`                   |
| HTML preview            | `npm run preview`               |
| Type check              | `npm run typecheck`             |
| Lint                    | `npm run lint`                  |
| Lint auto-fix           | `npm run lint:fix`              |
| Code formatting         | `npm run format`                |
| Run unit tests          | `npm test`                      |
| Watch tests             | `npm run test:watch`            |
| Test coverage           | `npm run test:coverage`         |
| i18n key check          | `npm run i18n:check`            |
| Preview drift check     | `npm run preview:check`         |
| Build artifacts         | `npm run build`                 |
| Build Windows installer | `npm run dist:win`              |
| Regenerate icon         | `node scripts/generate-icon.js` |

---

## Appendix: Related Documents

- [README.md](README.md): project overview and features
- [ARCHITECTURE.md](ARCHITECTURE.md): detailed architecture document

- [docs/archive/项目架构全景.md](docs/archive/项目架构全景.md): project architecture overview (Chinese)

---

## Contact

- **Developer**: QianLu
- **Social handle**: 纤璐不会玩摄影
- **Douyin**: [v.douyin.com/XkTzyJeCFIU](https://v.douyin.com/XkTzyJeCFIU/)
- **Bilibili**: [b23.tv/FtjgFrW](https://b23.tv/FtjgFrW)

---

## License

MIT License
