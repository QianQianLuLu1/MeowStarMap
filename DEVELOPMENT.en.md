# Development Guide (DEVELOPMENT.en.md)

> A beginner-friendly development guide for "Meow Star Map" (喵星图).
> All commands can be copied directly into a PowerShell terminal.
> Project codename: `meow-star-map` / App name: Meow Star Map / Current version: 2.5.5 / Platform: Windows x64

---

## Table of Contents

- [1. Environment Requirements](#1-environment-requirements)
- [2. Install & Run Commands](#2-install--run-commands)
- [3. Directory Layout](#3-directory-layout)
- [4. Debugging](#4-debugging)
- [5. Code Conventions](#5-code-conventions)
- [6. Troubleshooting](#6-troubleshooting)
- [7. Packaging Workflow](#7-packaging-workflow)
- [8. Component Documentation (Storybook)](#8-component-documentation-storybook)
- [9. User Data Migration (Upgrading from a Pre-Rename Version)](#9-user-data-migration-upgrading-from-a-pre-rename-version)

---

## 1. Environment Requirements

### 1.1 Required Software

| Software    | Version       | Notes                                                                     |
| ----------- | ------------- | ------------------------------------------------------------------------- |
| **Node.js** | 22.x LTS      | `.node-version` in the project root pins to `22`; Node < 22 will not work |
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

Expected output: `v22.x.x`.

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
cd MeowStarMap
```

### 2.2 Install Dependencies (first run only)

```bash
npm install
```

> The project `.npmrc` currently contains comments only (no effective config); Electron and electron-builder
> mirrors are injected via environment variables (`ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`, see [6.1](#61-npm-install-fails)).

### 2.3 Rebuild Native Modules (after first install or after switching Node versions)

```bash
npx @electron/rebuild
```

> Native modules: `better-sqlite3`, `sharp`, `koffi`.
> Without rebuilding you will see `Module not found` or `.node` load errors.
> Packaging rebuilds them automatically via `build.npmRebuild: true` in `package.json`; locally you only need this after switching Node/Electron versions.

### 2.4 Start in Dev Mode (the exe app)

```bash
npm run dev
```

This is driven by `electron-vite dev`:

1. Compile main-process TypeScript into `dist/main/`
2. Launch the Electron desktop app, with the renderer served by the Vite dev server (hot reload)

> Restart `npm run dev` after editing code under `src/main/`.
> Renderer changes hot-reload via HMR built into `npm run dev` — see [4.2](#42-renderer-hot-reload).

### 2.5 HTML Preview (quick preview without launching Electron)

```bash
npm run build:preview
```

Open the generated root `preview.html` in a browser to view the renderer UI.

> `npm run preview` runs `electron-vite preview`: it performs a production build and launches the Electron app for local preview — not a browser-based HTML preview.

### 2.6 Build Artifacts (no installer)

```bash
npm run build
```

Includes clean, main-process compile, and renderer build. Output goes to `dist/`.

> This machine has an npm Safe-Delete gateway, so the `clean` step of `npm run build` may fail with EPERM.
> In that case use the equivalent step-by-step commands:
>
> ```bash
> npx electron-vite build
> node -e "require('fs').writeFileSync('dist/main/package.json', JSON.stringify({ type: 'commonjs' }))"
> ```
>
> (`electron-vite build` already writes `dist/main/package.json`; the second command is only a safety net.)

### 2.7 Build the Installer

```bash
npm run dist:win
```

See [7. Packaging Workflow](#7-packaging-workflow).

### 2.8 Packaged-App Smoke Test (E2E)

Runtime smoke test against the `release/win-unpacked/` artifact (Playwright `_electron.launch`):
verifies non-white-screen startup, `app://` protocol loading, preload injection, IPC/SQLite probes and startup stability.

```bash
# Prerequisite: release/win-unpacked exists (run npm run dist:win first)
npm run e2e:smoke

# One shot: package + smoke
npm run dist:win:smoke
```

- Tests & config: `e2e/smoke.e2e.ts` / `e2e/playwright.config.ts`; manual checklist in `docs/manual-smoke-checklist.md` (tracked), while the original design doc was archived to `docs/archive/plans/e2e-smoke-playwright.md` (excluded by `.gitignore`, kept locally only, recoverable from git history)
- CI runs it automatically after the build job; failures upload screenshots and main-process logs (artifact `e2e-smoke-failure`)
- Before a release, also walk through the manual checklist in `docs/manual-smoke-checklist.md` (items that need real samples: scanning/decryption/editing etc.)

---

## 3. Directory Layout

```
MeowStarMap/
├── src/
│   ├── main/                  # Electron main process (Node environment)
│   │   ├── index.ts           # Main entry (early guards + protocol registration + Application bootstrap)
│   │   ├── preload.ts         # Preload entry: assembles namespaces and exposes electronAPI (split refactor, Aug 2026)
│   │   ├── preload-logger.ts  # Zero-dependency preload logger (must not import main logger/i18n/app)
│   │   ├── preload/           # Preload split modules (namespaced by domain)
│   │   │   ├── ipc.ts               # IpcError class + call<T> unwrapping + subscribe event helper
│   │   │   ├── plugin-bridge.ts     # Plugin capability bridge (window.pluginAPI) + i18n.t injection point
│   │   │   └── api/                 # electronAPI namespaces (scanner/file/editor/... 33 files; each exports a <key>API object)
│   │   ├── app/               # App lifecycle management (25 source files)
│   │   │   ├── application.ts       # App main class
│   │   │   ├── lifecycle.ts         # Lifecycle management
│   │   │   ├── cleanup.ts           # Exit cleanup
│   │   │   ├── startup-tasks.ts     # Startup tasks
│   │   │   ├── window-manager.ts    # Window management
│   │   │   ├── desktop-shortcut.ts  # Desktop shortcut
│   │   │   ├── error-handlers.ts    # Error handling
│   │   │   ├── ipc-setup.ts         # IPC registration orchestration
│   │   │   ├── media-protocol.ts    # media:// protocol
│   │   │   └── ...                  # media-update/recovery/theme/auto-update/gpu-fallback etc.
│   │   ├── database/          # SQLite database management
│   │   │   ├── connection.ts        # DB connection and schema init
│   │   │   ├── media-repository.ts  # Media CRUD
│   │   │   ├── resonance-repository.ts # Resonance repository (2.5.0)
│   │   │   ├── import-root-repository.ts # Import-root repository
│   │   │   └── worker/             # DB write operations split into utilityProcess
│   │   ├── scanner/           # File scanner
│   │   │   ├── index.ts             # Scanner manager (thin shell)
│   │   │   ├── scanner-worker-bridge.ts  # Bridge to child process
│   │   │   └── path-classifier.ts   # Path classification (game/launcher/cloud...)
│   │   ├── media-worker/      # Thumbnail / pHash / duplicate detection subprocess
│   │   ├── scheduler/         # Priority-based task scheduler
│   │   ├── services/          # Business services (file/video/watermark/share/backup/xmp...)
│   │   ├── thumbnail/         # Thumbnail generator (sharp-based)
│   │   ├── ipc/handlers/      # IPC channel handlers (one file per domain; 47 domain files — 4 `_`-prefixed helpers plus the set-dir-handler factory, 43 registered by setupIPC())
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
│   │   │   ├── resonance/          # Resonance Records view components (2.5.0)
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
│   │   │   ├── ResonanceRecordsPage.tsx # Resonance Records (2.5.0)
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
│   │   ├── utils/             # Cross-process pure functions (concurrency/taskStages)
│   │   ├── settings-keys.ts   # Renderer-writable preference key whitelist
│   │   ├── dimension.ts       # Smart grouping dimension definitions
│   │   └── scene-category.ts  # Scene category definitions
│   │
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
│   ├── plans/                 # In-progress fix/feature plans
│   ├── archive/               # Completed historical plans and reports
│   └── tutorial/              # User tutorial
│
├── tests/                     # Test setup
├── package.json               # Dependencies and scripts
├── tsconfig.json              # Renderer TypeScript config
├── tsconfig.scripts.json     # Script TypeScript config
├── electron.vite.config.ts    # Main/preload/renderer three-segment build config (renderer port 5173, root src/renderer)
├── vite.preview.config.ts     # Single-file preview build config
├── vitest.config.ts           # Vitest config
├── eslint.config.js           # ESLint rules
├── .prettierrc                # Prettier formatting rules
├── tailwind.config.ts         # Tailwind CSS config
├── postcss.config.cjs         # PostCSS config
└── ARCHITECTURE.md            # Architecture document (detailed)
```

### Key Conventions

- **Path aliases**:
  - `@/*` → `src/renderer/*`
  - `@main/*` → `src/main/*`
  - `@common/*` → `src/common/*` (`src/common` has been removed; the alias survives in configs as legacy only — do not use it in new code)
- **Process isolation**: main-process code cannot import renderer code, and vice versa; shared code lives in `src/shared/`
- **HTML preview**: `preview.html` is iterated in sync with the exe app; UI/features must stay consistent

---

## 4. Debugging

### 4.1 Main Process Debugging

```bash
npm run dev
```

After launch, main-process logs stream to the terminal. Restart the command after editing main-process code.

### 4.2 Renderer Hot Reload

`npm run dev` has renderer HMR built in: edits under `src/renderer/` hot-reload inside the Electron window — no separate Vite server needed.

To inspect the renderer UI in a browser without Electron, run `npm run build:preview` and open the generated root `preview.html`.
**Note**: `preview.html` is a static preview (no Electron main process); IPC is unavailable and all `window.electronAPI` calls return `undefined`.

### 4.3 Open Chrome DevTools

In the running Electron window, press `Ctrl+Shift+I` to open DevTools:

- Console: renderer logs
- Network: network requests
- Application: localStorage / IndexedDB
- React DevTools (install the extension separately)

### 4.4 View Main-Process Logs

Logs are written to:

```
%APPDATA%\meow-star-map\logs\
```

Open in PowerShell:

```powershell
explorer "$env:APPDATA\meow-star-map\logs"
```

Key log files:

- `main.log`: application log
- `faults-YYYY-MM-DD.jsonl`: fault records (10 FaultType categories, rolled by date)
- `startup-errors.log`: startup error log (in the userData root or `Documents\MeowStarMap\Diagnostics\`, 100KB rolling)

### 4.5 Inspect the Database

The database file is at:

```
%APPDATA%\meow-star-map\database\meow_star_map.db
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
      "preLaunchTask": "npm: build",
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

Key rules (since 2026-08-22 the quality rules below are `error`-level and hard-block commits and CI):

- `@typescript-eslint/no-explicit-any`: `error` (explicit `any` is forbidden; provide a concrete type, or use `unknown` with type narrowing when truly unknown)
- `@typescript-eslint/no-unused-vars`: `error` (unused vars fail the build; prefix intentionally-kept params/caught errors with `_`)
- `react-hooks/exhaustive-deps`: `error` (hook dependency arrays must be complete — no missing or unnecessary deps)
- `no-empty`: `error` (empty blocks forbidden; an empty catch is allowed but must carry a comment or handle the error)
- `@typescript-eslint/no-unsafe-function-type` / `@typescript-eslint/no-require-imports`: `error` (no `Function` type, no `require()` imports)
- `react/react-in-jsx-scope`: `off` (React 17+ JSX transform; no need to import React)
- `no-restricted-syntax`: `error` (i18n guardrail: no hardcoded Chinese or debug console calls; hard-blocked since 2026-08-22. The historical legacy whitelist was fully cleared and removed from `eslint.config.js` on 2026-08-23; test files are exempt wholesale — assertions/fixtures may legitimately contain Chinese)

Run before commit and make sure there are **0 errors**:

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

- **Reuse first**: before writing anything, check `src/shared/utils/` and `src/renderer/components/common/` for existing implementations
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

   > Note: Chinese mirrors such as npmmirror do not implement npm's audit API
   > (`/-/npm/v1/security/*`); after switching, `npm audit` fails with a 404
   > (`audit endpoint returned an error`). Run dependency audits with
   > `npm run audit` (audit-ci against the official registry; allowlist in the
   > root `audit-ci.jsonc`). See
   > [docs/troubleshooting-npm-audit-mirror.md](docs/troubleshooting-npm-audit-mirror.md).

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
npx @electron/rebuild
```

If that fails:

```bash
rm -rf node_modules
npm install
npx @electron/rebuild
```

### 6.3 `npm run dev` shows a white screen

**Steps**:

1. Press `Ctrl+Shift+I` in the app window to open DevTools and check Console errors
2. Verify `dist/main/` and `dist/renderer/` exist; if not, run:

   ```bash
   npx electron-vite build
   ```

### 6.4 TypeScript type errors

**Full type check**:

```bash
npm run typecheck
```

**Common errors**:

- `Cannot find module '@/components/...'`: path alias not resolving; check `tsconfig.json` `paths`
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
4. Check `%APPDATA%\meow-star-map\logs\main.log` for errors

### 6.7 App crashes / exits immediately

See the troubleshooting manual for "Crash / exit".

Crash dumps are at (the app redirects them to the user's Documents folder at startup, keeping them out of AppData):

```
%USERPROFILE%\Documents\MeowStarMap\Diagnostics\
```

Open in PowerShell:

```powershell
explorer "$env:USERPROFILE\Documents\MeowStarMap\Diagnostics"
```

> The 10 most recent crash files are retained, and files older than 30 days are auto-cleaned.

### 6.8 Startup failure (error dialog at launch)

**Step 1**: Click "Open log directory" in the dialog and inspect `startup-errors.log`

**Step 2**: Clean potentially corrupt files:

```powershell
explorer "$env:APPDATA\meow-star-map"
```

Delete these files (**back them up first**):

- `meow_star_map.db-wal`
- `meow_star_map.db-shm`
- `meow_star_map.db-journal`

**Do NOT delete** `meow_star_map.db` (that is your media database).

**Step 3**: Reset config (last resort): rename `config.json` to `config.json.bak` and restart the app.

### 6.9 Single-instance lock conflict

**Symptom**: dialog "Application is already running".

**Fix**:

1. Check the system tray for the app icon
2. Click "Clean and restart" in the dialog
3. If that fails, click "Manual handling" and end all processes named "喵星图" in Task Manager

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

**Gate baselines** (use these to tell whether a failure is pre-existing or one you just introduced):

| Command                | Baseline                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`    | **exit 0, zero errors**                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `npm run lint`         | **exit 0, 0 errors / 0 warnings (no output at all)** (measured 2026-10-21). The historical reading was "0 errors / 11 warnings" — all 11 were the DEBT-030 `src/renderer/components/common/*.test.tsx` BOM items, now cleared along with that debt (see `docs/技术债清单.md` §13). The three locations cited by the even older baseline — `.cache/`, `e2e/fullscreen-diagnose.e2e.ts`, `scripts/after-pack-vc-runtime.cjs` — no longer match                                        |
| `npm run format:check` | On this machine (`core.autocrlf=true`) it is **exit 1** — 601 files flagged solely for CRLF line endings (measured 2026-10-10). A read-only check must add `--end-of-line auto`: `npx prettier --check --end-of-line auto <same globs>` measures exit 0. Also note the root lint-staged key `*.{ts,js,json,md}` matches at **any depth**, so `prettier --write` really rewrites `docs/**` too (still worth re-checking a large doc individually with `npx prettier --check <file>`) |
| `npm test`             | 408 files / 6312 passing + 2 skipped (measured 2026-10-17, full run this round; the historical 337 / 5331 reading was the 2026-10-10 snapshot — see `docs/plans/2026-10-10-markdown-inventory-and-corrections.md` §8.10; the two historical environment-dependent failures — `path-safety.test.ts` and `GalleryStackOverflow.test.tsx` — were fixed in 2.5.0)                                                                                                                       |

### 7.2 Full Build Command

```bash
npm run dist:win
```

This runs sequentially:

1. `npm run build`: `clean` → `electron-vite build` → write `dist/main/package.json` (`{"type":"commonjs"}`)
2. `npm run pre-dist-check`: artifact timestamps, key fixpoints, Git working tree, plus README Electron version matching `package.json`
3. `electron-builder --win --publish never`: package the Windows NSIS installer
4. `npm run verify:dist`: verify runtime dependencies such as the VC++ runtime are bundled inside the asar

### 7.3 Step-by-Step (for debugging)

**Compile main process and bundle renderer in one go** (equivalent to `electron-vite build`):

```bash
npx electron-vite build
```

**Package installer only (requires build first)**:

```bash
npx electron-builder --win --publish never
```

> Full release sequence (with artifact verification, recommended for releases):
>
> ```bash
> npx electron-vite build
> npm run pre-dist-check
> npx electron-builder --win --publish never
> npm run verify:dist
> ```
>
> `npm run dist:win` is equivalent to the four steps above (step 1 is `npm run build`, which may fail on this machine due to the Safe-Delete gateway — see [2.6](#26-build-artifacts-no-installer)).

### 7.4 Output Location

After packaging:

```
release/
├── MeowStarMap-Setup-2.5.5.exe  # NSIS installer (artifactName: MeowStarMap-Setup-${version}.${ext})
└── builder-effective-config.yaml             # build config snapshot
```

### 7.5 Build Config (`build` field in `package.json`)

| Field                          | Value                         | Description                                       |
| ------------------------------ | ----------------------------- | ------------------------------------------------- |
| `appId`                        | `com.qianlu.meow-star-map`    | Unique app identifier                             |
| `productName`                  | `喵星图`                      | Display name                                      |
| `directories.output`           | `release`                     | Output directory                                  |
| `files`                        | `dist/**/*`, `resources/**/*` | Files included                                    |
| `asarUnpack`                   | see table below               | Native deps that must not be packed into asar     |
| `win.target`                   | `nsis` x64                    | Windows NSIS installer                            |
| `win.icon`                     | `resources/icons/icon.ico`    | App icon                                          |
| `nsis.oneClick`                | `false`                       | Non-one-click install; allows directory selection |
| `nsis.createDesktopShortcut`   | `always`                      | Always create desktop shortcut                    |
| `nsis.createStartMenuShortcut` | `true`                        | Create Start menu shortcut                        |

**asarUnpack list** (native binaries must be unpacked or they will fail to load):

```
**/ffmpeg-static/**
**/ffprobe-static/**
**/better-sqlite3/**
**/bindings/**
**/file-uri-to-path/**
**/sharp/**
**/@img/**
**/koffi/**
**/@koromix/**
**/nuan5_decryption.dll
```

### 7.6 Regenerate the App Icon

If you modify `resources/icons/icon.svg`, regenerate the `.ico`:

```bash
node scripts/generate-icon.js
```

### 7.7 Install and Test

1. Double-click `release\MeowStarMap-Setup-2.5.5.exe` to install
2. Launch from Start menu or desktop shortcut
3. On first launch a full-disk scan runs to locate the game directory (first scan is slow; please be patient)
4. A desktop shortcut is created automatically (skipped if it already exists)
5. Before release, run the automated smoke test first: `npm run e2e:smoke` (requires `npm run dist:win` beforehand)
6. Then walk through the manual smoke checklist in `docs/manual-smoke-checklist.md` (scanning / thumbnails / decryption / edit & export etc.)

### 7.8 Version Number Management

- **Do not change the version number** unless explicitly requested
- Version is in `package.json` `version` field; it also determines the installer filename: `MeowStarMap-Setup-<version>.exe`
- Current version: `2.5.5`
- After changing it, also update the version badge in `README.md` and the "Current Version" field in `ARCHITECTURE.md` / `ARCHITECTURE.en.md` and the header of this guide

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

## 8. Component Documentation (Storybook)

The renderer-layer component documentation site is built on Storybook 10 (`@storybook/react-vite`),
providing Props documentation, state examples and an accessibility panel for every component.
Usage and authoring conventions: see `docs/Storybook使用指南.md` (Chinese).

### 8.1 Start & Build Commands

Start the local docs site (default port **6006**; hot reload for sources / stories / i18n; can run in parallel with `npm run dev`):

```bash
npm run storybook
```

Build the static site (output goes to `storybook-static/`, deployable as-is; CI builds it in the `storybook` job and uploads a same-named artifact):

```bash
npm run build-storybook
```

### 8.2 Directory Conventions

| Location                                             | Convention                                                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `.storybook/`                                        | Config root: `main.ts` (story discovery) / `preview.ts` (global decorators + `window.electronAPI` stub) / `decorators/` / `mocks/` |
| `src/renderer/components/**/*.stories.tsx`           | Stories are **co-located** with component sources (same name, same directory); maintain stories whenever you modify a component    |
| `docs/storybook/`                                    | MDX guide pages inside the docs site (a11y guide / design tokens / electronAPI mock notes)                                         |
| `docs/Storybook使用指南.md` / `docs/组件文档规范.md` | In-repo usage guide and authoring spec (Chinese)                                                                                   |

### 8.3 Authoring & Maintenance Conventions (summary)

- New / substantially modified components must ship with stories in the same commit (`docs/组件文档规范.md` §6 incremental rule);
- Stories must keep states realistic — never fabricate data to hide defects; log source-level issues in `docs/技术债清单.md`;
- Acceptance baseline: any component with stories must have zero `serious` / `critical` violations in the addon-a11y panel (records in `docs/storybook/accessibility.mdx`).

---

## 9. User Data Migration (Upgrading from a Pre-Rename Version)

From this release the product is named **Meow Star Map (喵星图)**, and the package identity plus
the on-disk database name changed with it: the app data root moves from
`%APPDATA%\wxnn-photo-manager` to `%APPDATA%\meow-star-map`, and the main database file from
`wxnn_photo_manager.db` to `meow_star_map.db`. **There is no automatic migration** — on first launch
an unmigrated install **creates a brand-new empty library** (this is not a failed migration), so the
gallery looks empty while the old data is intact in the previous folder. Follow this section to
move it back by hand.

> ⚠ Publish a migration notice before tagging a renamed release: an existing install's
> `app-update.yml` (`updaterCacheDirName: wxnn-photo-manager-updater`) will pick up the new
> installer and drop it into the new appId plus the new userData, which shows up as an "empty
> gallery". Also, because `appId` and `productName` change together, NSIS no longer upgrades
> in place: the Control Panel / Start Menu will list **two apps** (acceptable for beta; remove the
> old entry by hand).

### 9.1 Before you start

1. Quit the app and kill leftover processes in Task Manager (`喵星图.exe` for the new build,
   `无限暖暖相册管理工具.exe` for the old one).
2. **Never run the old and new builds at the same time**: the single-instance lock key lives in
   userData, so both versions would write the same database and corrupt it.
3. Create `%APPDATA%\meow-star-map` by hand.

### 9.2 Must be moved and renamed

All paths below are relative to their own userData root
(old `…\wxnn-photo-manager` → new `…\meow-star-map`).

| Old path                                                       | Action                                                        | Consequence if skipped                                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `database\wxnn_photo_manager.db`                               | rename to `database\meow_star_map.db`                         | first launch builds an empty library; favourites / categories / edit history / resonance records "disappear" (the old library is simply not attached)              |
| `database\wxnn_photo_manager.db-wal`, `-shm`                   | rename together with the row above                            | recent unflushed writes lost, integrity check falls back                                                                                                           |
| `database\wxnn_photo_manager.db.clean-exit`                    | rename together with the row above                            | the new library misreads the previous clean shutdown as a crash                                                                                                    |
| `database\wxnn_photo_manager.db.corrupt-*`                     | move with a new prefix (only if you still need that snapshot) | historical corruption evidence lost                                                                                                                                |
| `backups\wxnn_photo_manager_<date>_<time>[_uid].db`            | rename **each file** to `meow_star_map_…`, same suffix        | **silent** failure: Settings → Backups lists nothing, and restore/prune cannot reach it (both the filter prefix and the validation regex only accept the new name) |
| `thumbnails\`                                                  | move as-is                                                    | every thumbnail is regenerated                                                                                                                                     |
| `search-index\`                                                | move as-is                                                    | the full-text index is rebuilt                                                                                                                                     |
| `plugins\plugins.json`                                         | move as-is                                                    | plugin install state is reset                                                                                                                                      |
| `sync\server.crt`, `sync\server.key`, `nikkisync\nikkisync.db` | move as-is                                                    | **every paired phone has to be paired again**                                                                                                                      |
| `logs\`, `crashes\`                                            | optional (historical forensics)                               | history lost, features unaffected                                                                                                                                  |

`database\db-backup-*.db` and `database\pre-migration-*.db` are legacy names the current code no
longer produces (you may still have a few on disk); move or archive them as you prefer — a fresh
install never reads them.

### 9.3 Deliberately not moved (let a fresh install rebuild them)

`boot-ok.marker`, `last-exit.json`, `gpu-fallback.json`, `gpu-pref.json`, `heartbeat.json`,
`diag.log`, `startup-errors.log`, `scan-log.jsonl`, `diagnostic-tmp-*` — moving the first two makes
the first launch misread a clean shutdown as a crash. Everything Electron manages itself
(`Cache\`, `Code Cache\`, `GPUCache\`, `Network\`, `Local Storage\`, `Session Storage\`,
`blob_storage\`, `Shared Storage\`, `Preferences`, `Local State`, `DIPS*`, `Dawn*`,
`Dictionaries\`, `SharedStorage*`, `.updaterId`) stays behind.

### 9.4 Check the diagnostics folder too

The user-facing diagnostics folder uses the **display name**:
`<Documents>\喵星图\Diagnostics` first, then `<home>\喵星图\Diagnostics`,
then `%TEMP%\喵星图-Diagnostics`; the emergency startup log in `%TEMP%` is prefixed
`MeowStarMap-*.log`. Leftovers from before the rename — `<Documents>\NikkiGallery\Diagnostics` and
`%TEMP%\NikkiGallery-*.log` — are historical files; delete them by hand once you no longer need them.

> ⚠ Do not delete `%USERPROFILE%\NikkiGallery\` wholesale: an unrelated third-party app keeps its
> `config.json`, `logs\`, `thumb_cache\` etc. there, and this repository never writes to it.

### 9.5 Verify after the move

1. Photo count matches the old install; favourites / categories / tags / resonance records are present.
2. Settings → Backups lists only `meow_star_map_*`, and one restore round-trip succeeds.
3. Browsing existing photos does not trigger thumbnail regeneration; full-text search returns results.
4. `logs\main.log` contains no `unable to open database file`.
5. The phone connects without re-pairing (same `server.crt`).

> The "database file" check in `npm run doctor` reads `data\album_index.db` inside the repository
> (`scripts/doctor.ts:126`) and **does not look at userData**, so it cannot serve as this
> verification step — use the backup list in step 2 instead.

### 9.6 Rollback

The move is copy-only and never overwrites the old folder: delete the whole
`%APPDATA%\meow-star-map` directory and run the old installer again to return to the pre-rename
state. The orphan directories `%APPDATA%\wxnn-photo-manager` and
`%APPDATA%\wxnn-photo-manager-updater` can be removed by hand once you are sure you will not roll
back, and so can whichever of the two desktop shortcuts (`无限暖暖相册管理工具.lnk` vs `喵星图.lnk`)
you no longer need.

---

## Appendix: Common Commands Cheat Sheet

| Task                         | Command                         |
| ---------------------------- | ------------------------------- |
| Install dependencies         | `npm install`                   |
| Rebuild native modules       | `npx @electron/rebuild`         |
| Dev mode (exe app)           | `npm run dev`                   |
| HTML preview build           | `npm run build:preview`         |
| Type check                   | `npm run typecheck`             |
| Lint                         | `npm run lint`                  |
| Lint auto-fix                | `npm run lint:fix`              |
| Code formatting              | `npm run format`                |
| Run unit tests               | `npm test`                      |
| Watch tests                  | `npm run test:watch`            |
| Test coverage                | `npm run test:coverage`         |
| i18n key check               | `npm run i18n:check`            |
| Preview drift check          | `npm run preview:check`         |
| Markdown dead-ref check      | `npm run docs:links`            |
| Tech-debt CI reminder        | `npm run debt:check`            |
| Link NikkiSync deps          | `npm run link:nikkisync`        |
| Diagnose NikkiSync load seam | `npm run verify:nikkisync`      |
| Build artifacts              | `npm run build`                 |
| Build Windows installer      | `npm run dist:win`              |
| Regenerate icon              | `node scripts/generate-icon.js` |
| Start component docs site    | `npm run storybook`             |
| Build docs static site       | `npm run build-storybook`       |

---

## Appendix: Related Documents

- [README.md](README.md): project overview and features
- [ARCHITECTURE.md](ARCHITECTURE.md): detailed architecture document
- [docs/tutorial/用户使用教程.md](docs/tutorial/用户使用教程.md): user guide (Chinese)
- [docs/IPC_CONTRACT.md](docs/IPC_CONTRACT.md): IPC contract spec
- [docs/PLUGIN_API.md](docs/PLUGIN_API.md): plugin API reference
- [docs/CODING_CONVENTIONS.md](docs/CODING_CONVENTIONS.md): the four hard coding conventions and the verify/commit contract (single source of truth)
- [docs/技术债清单.md](docs/技术债清单.md): tech debt ledger (Chinese)
- [docs/Storybook使用指南.md](docs/Storybook使用指南.md): component docs site usage (Chinese)
- [docs/sync-integration/](docs/sync-integration/): NikkiSync integration stage plans and audit reports (16 files, design-of-record; paths mix this repo and upstream — see the scope declaration at the top of each file)
- [docs/archive/项目架构全景.md](docs/archive/项目架构全景.md): project architecture overview (Chinese) — `docs/archive/` is excluded by `.gitignore`, kept locally only, not in the repo

---

## Developer Info / Author & Social Platforms

- **Douyin**: 纤璐不会玩摄影 ([profile](https://v.douyin.com/Dx67wYkw48A/))
- **Xiaohongshu (RED)**: 纤璐不会玩摄影 ([profile](https://www.xiaohongshu.com/user/profile/69270bb200000000370092db))
- **Bilibili**: 纤璐不会玩摄影 ([profile](https://b23.tv/zCR5oGE))
- **GitHub**: [QianQianLuLu1](https://github.com/QianQianLuLu1)
- **CSDN Blog**: [QianQian-LuLu](https://blog.csdn.net/2604_96788940)
- **Author Site**: https://ppebv9al.qwenwork.host/

---

## License

MIT License
