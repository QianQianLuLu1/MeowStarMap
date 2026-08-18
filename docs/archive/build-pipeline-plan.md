# 构建管线收敛方案：以 electron-vite 为唯一构建源

> 调研与规划文档（仅方案，未改动任何源码/配置/脚本）。
> 目标：删除 `vite.config.ts` + 主进程 tsc 构建依赖，让 `electron.vite.config.ts` 统一产出 main / preload / renderer；移除 `ELECTRON_ENTRY` 时间戳 hack；启用被注释的 preload 配置块。

---

## 0. 关键事实勘误（务必先读）

任务描述称 `window-manager.ts` 含 `../../../renderer/index.html` 硬编码路径。经核实，**这与当前代码不符**：

| 位置                                | 实际硬编码                                                | `__dirname` 解析后                                    |
| ----------------------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| `src/main/app/window-manager.ts`    | `path.join(__dirname, '../preload.js')`（第 60、101 行）  | `dist/main/main/app` → `dist/main/main/preload.js` ✅ |
| `src/main/app/renderer-protocol.ts` | `path.resolve(__dirname, '../../../renderer')`（第 7 行） | `dist/main/main/app` → `dist/renderer` ✅             |

- `window-manager.ts` 加载渲染进程用的是 `app://renderer/index.html`（自定义协议），**不含** `../../../renderer` 字面量；`../../../renderer` 真正出自 `renderer-protocol.ts`。
- 两个文件都在 `src/main/app/` 下，编译后 `__dirname` 均为 `dist/main/main/app`。**因此 main 产物的输出目录必须是 `dist/main/main/app/`，否则两个硬编码路径都会错位（白屏风险）。**
- 结论：main 构建块的 `outDir: 'dist/main/main/app'` **必须保留**，仅去掉时间戳、固定文件名。

---

## 1. 涉及文件清单

| 文件                                | 动作     | 说明                                                               |
| ----------------------------------- | -------- | ------------------------------------------------------------------ |
| `package.json`                      | **改**   | `main` 字段 + 多个 scripts                                         |
| `electron.vite.config.ts`           | **改**   | 移除 `buildStamp`/`ELECTRON_ENTRY`，启用 preload 块，固定 fileName |
| `scripts/pre-dist-check.ts`         | **改**   | 适配 bundled 单文件布局（见 §4）                                   |
| `vite.config.ts`（根）              | **删**   | 已被 `electron.vite.config.ts` 的 renderer 块取代                  |
| `src/main/tsconfig.json`            | **保留** | 仅作 `tsc -b`（typecheck）的项目引用，**不再用于产出**             |
| `vite.preview.config.ts`            | **保留** | 预览版单文件构建，独立于三进程构建链                               |
| `scripts/check-doc-versions.ts`     | 不改     | 仅校验 README 版本，与构建源无关                                   |
| `src/main/app/window-manager.ts`    | 不改     | `../preload.js` 路径保持不变                                       |
| `src/main/app/renderer-protocol.ts` | 不改     | `../../../renderer` 路径保持不变                                   |
| `src/main/preload.ts`               | 不改     | 由启用的 preload 块产出 `dist/main/main/preload.js`                |

> **不要删除 `src/main/tsconfig.json`**：根 `tsconfig.json` 第 29 行 `"references": [{ "path": "./src/main/tsconfig.json" }]`，`npm run typecheck`（`tsc -b`）依赖它做主进程类型检查。删除会导致 `tsc -b` 失败。只需移除 `build:main` 脚本对它的"产出"依赖，文件保留。

---

## 2. package.json 改动（`scripts` 与 `main`）

### 2.1 `main` 字段

```diff
-  "main": "dist/main/main/index.js",
+  "main": "dist/main/main/app/index.js",
```

理由：electron-vite 的 main 构建块 `outDir: 'dist/main/main/app'` + `fileName: 'index'` → 产物为 `dist/main/main/app/index.js`。统一入口后 `package.json.main`、electron-vite dev、electron-builder 三者指向同一文件。

### 2.2 `scripts` 改动前后对照

| script           | 现状（before）                                                                                             | 目标（after）                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`            | `npm run build:main && electron .`                                                                         | `electron-vite dev`                                                                                                                         |
| `dev:ev`         | `electron-vite dev`                                                                                        | `electron-vite dev`（保留作别名，可删）                                                                                                     |
| `build`          | `npm run clean && npm run build:main && npm run build:renderer`                                            | `npm run clean && electron-vite build && node -e "require('fs').writeFileSync('dist/main/package.json',JSON.stringify({type:'commonjs'}))"` |
| `build:main`     | `tsc -p src/main/tsconfig.json && ...`                                                                     | **删除**                                                                                                                                    |
| `build:renderer` | `vite build`                                                                                               | **删除**                                                                                                                                    |
| `build:preview`  | `vite build --config vite.preview.config.ts`                                                               | 不变（独立预览构建）                                                                                                                        |
| `preview`        | `vite preview`                                                                                             | `electron-vite preview`（根 `vite.config.ts` 删除后 `vite preview` 会失配）                                                                 |
| `dist`           | `npm run build && electron-builder --publish never`                                                        | 不变（`build` 已改为 electron-vite）                                                                                                        |
| `dist:win`       | `npm run build && npm run pre-dist-check && electron-builder --win --publish never && npm run verify:dist` | 不变（`build` 已改为 electron-vite，pre-dist-check 内部已适配）                                                                             |
| `pre-dist-check` | `tsx scripts/pre-dist-check.ts && tsx scripts/check-doc-versions.ts`                                       | 不变（脚本内部已适配 bundled 布局）                                                                                                         |
| `verify:dist`    | `tsx scripts/pre-dist-check.ts --verify-asar`                                                              | 不变（仅校验 asar 原生二进制，与构建源无关）                                                                                                |

> `build` 中保留手写 `dist/main/package.json {type:commonjs}` 这一步：**必须保留**。根 `package.json` 是 `type: module`，而 main/preload 产物是 CJS。向 `dist/main/` 写入该 shim 后，向上查找即可让 `dist/main/main/app/index.js` 与 `dist/main/main/preload.js` 被 Node 以 CJS 解析（electron-vite 沿用此机制）。

---

## 3. electron.vite.config.ts 关键 diff

### 3.1 移除时间戳 hack 与 ELECTRON_ENTRY（文件顶部）

```diff
- const buildStamp = Date.now().toString(36)
-
- process.env.ELECTRON_ENTRY = path.resolve(root, `dist/main/main/app/index-${buildStamp}.js`)
+ // 统一以 package.json 的 main（dist/main/main/app/index.js）为入口，
+ // 不再注入 ELECTRON_ENTRY，由 electron-vite 自动解析 main 块 entry。
```

### 3.2 main 构建块（outDir 不变，固定 fileName）

```diff
   main: {
     build: {
       outDir: 'dist/main/main/app',
-      emptyOutDir: false,
+      emptyOutDir: true,   // 仅清空 app/（该目录只放主进程单 bundle），安全；父级 dist/main 由 clean 脚本清空
       lib: {
         entry: 'src/main/index.ts',
         formats: ['cjs'],
-        fileName: `index-${buildStamp}`
+        fileName: 'index'
       },
       rollupOptions: {
         external: externalizeNodeModules(),
         output: {
-          entryFileNames: `[name]-${buildStamp}.js`,
-          chunkFileNames: `[name]-${buildStamp}.js`
+          entryFileNames: '[name].js',
+          chunkFileNames: '[name].js'
         }
       }
     },
     resolve: { alias: { '@common': ..., '@main': ... } },
     plugins: []
   },
```

### 3.3 启用被注释的 preload 块（替换原注释说明）

```diff
-  // 说明：preload 的产出路径 dist/main/main/preload.js 由业务代码 window-manager.ts 硬编码引用，
-  // 文件名不可改。本沙箱环境该文件被监视器以不可写共享方式持锁……
-  // preload: { ... 注释块 ... },
+  // preload 产出 dist/main/main/preload.js，文件名不可改（window-manager.ts 的 ../preload.js 依赖）。
+  // 文件锁（沙箱监视器持锁）仅为环境产物，真实开发机不存在；这里统一由 electron-vite 接管。
+  preload: {
+    build: {
+      outDir: 'dist/main/main',
+      emptyOutDir: false,   // 父级 dist/main 由 clean 清空；此处 false 避免误删同级的 app/ 子目录
+      lib: { entry: 'src/main/preload.ts', formats: ['cjs'], fileName: 'preload' },
+      rollupOptions: {
+        external: externalizeNodeModules(),
+        output: { entryFileNames: '[name].js', chunkFileNames: '[name].js' }
+      }
+    },
+    resolve: { alias: { '@common': path.resolve(root, 'src/common'), '@main': path.resolve(root, 'src/main') } },
+    plugins: []
+  },
```

> **`emptyOutDir` 取值说明**：preload 的 `outDir` 是 `dist/main/main`（含 `app/` 子目录）。若设为 `true` 会在 preload 构建时清空 `dist/main/main`、连带删除 main 已产出的 `app/index.js`。故 preload 保持 `false`，整体清洁交给 `clean` 脚本（见 §2.2 `build` 中的 `npm run clean`）。

渲染进程（renderer）块**不动**。dev 下的 CSP 剥离插件、build 下的 crossorigin 剥离插件、external 列表、`@`/`electron` 别名、`__PREVIEW__` define 全部保留。

---

## 4. 对 `scripts/pre-dist-check.ts` 的影响（最易被忽略的破坏性变更）

electron-vite main 构建是 **rollup 单入口 lib 模式**：所有相对/别名源码被**打包进单个 `dist/main/main/app/index.js`**。tsc 那种"每文件一 `.js`"的布局**不复存在**。因此 pre-dist-check.ts 中依赖 per-file 路径的校验会全部误报失败，必须改写：

| 原校验                           | 原路径                                         | 问题                                                      | 改写方案                                                   |
| -------------------------------- | ---------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| #1 main 入口存在                 | `dist/main/main/index.js`                      | tsc 布局，迁移后不存在                                    | 改为 `dist/main/main/app/index.js`                         |
| #3 产物比源码新                  | 同上                                           | 路径失效                                                  | 用新路径 `app/index.js` 比较 mtime                         |
| #4 `.min(0)` 修复                | `dist/main/main/ipc/handlers/media-handler.js` | 该文件不再存在                                            | grep `dist/main/main/app/index.js` 含 `.min(0)`            |
| #5 `repairLegacyDataV2` 修复     | `dist/main/main/scanner/worker-entry.js`       | 该文件不再存在                                            | grep `dist/main/main/app/index.js` 含 `repairLegacyDataV2` |
| #10 `../../../renderer` 回退层数 | `dist/main/main/app/window-manager.js`         | 该文件不再存在；且字面量真实来源是 `renderer-protocol.ts` | grep `dist/main/main/app/index.js` 含 `../../../renderer`  |

以下校验**不受影响**，保持原样：#2 `dist/renderer/index.html`、#6/#7 `dist/renderer/assets/main-*.js`、#9 renderer 无 crossorigin、#11 pluggable-electron 仅动态 import、`--verify-asar` 原生二进制校验。

**建议新增一项**：检查 `dist/main/main/preload.js` 存在（preload 现由 electron-vite 产出，防止 revert 到旧 tsc 时漏构建）。

> 标记字符串（`.min(0)`、`repairLegacyDataV2`、`../../../renderer`、`../preload.js`）在 esbuild 打包后均原样保留（未做变量重命名/字符串混淆）；若后续给 main 开启 `minify`，这些字面量仍会被保留，但为调试与可校验性，建议 main/preload 保持 `minify: false`（electron-vite 默认即 false，无需额外配置）。

---

## 5. 对 `window-manager.ts` 路径硬编码的影响评估

| 硬编码                                           | 迁移后解析                                                  | 结论                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `path.join(__dirname, '../preload.js')`          | `dist/main/main/app` → `dist/main/main/preload.js`          | ✅ 与启用的 preload 块输出 `dist/main/main/preload.js` 完全吻合，**无需改动** |
| `app://renderer/index.html`                      | 由 `renderer-protocol.ts` 映射到 `dist/renderer/index.html` | ✅ 渲染块输出 `dist/renderer/index.html`，**无需改动**                        |
| `../../../renderer`（在 `renderer-protocol.ts`） | `dist/main/main/app` → `dist/renderer`                      | ✅ 输出目录保留 `app/`，**无需改动**                                          |

**总体结论**：只要 main 构建块的 `outDir` 保持 `dist/main/main/app`（本方案已保留），三个硬编码路径全部有效，无白屏回归风险。无需修改任何业务源码。

---

## 6. 回滚方案（基于 git 版本控制）

所有改动文件均已提交的前提下，回滚即恢复历史版本：

```bash
# 1. 恢复被改/被删的构建相关文件
git checkout -- package.json electron.vite.config.ts scripts/pre-dist-check.ts vite.config.ts

# 2. 重新以旧链构建验证
npm run clean && npm run build:main && npm run build:renderer
npm run dist:win
```

- 旧链 `build:main`(tsc) 与 `build:renderer`(vite) 可立即复活，因为 `src/` 主体未变、`vite.config.ts` 已还原。
- 若改动尚未提交，先 `git stash` 再 checkout，或 `git checkout <commit> -- <files>` 指定历史提交。
- 回滚后 `package.json.main` 回到 `dist/main/main/index.js`，与 tsc 产物一致。

---

## 7. 完整验证步骤

### 7.1 `npm run build` 产物结构核对

执行 `npm run build`，逐项核对：

```
dist/
├── main/
│   ├── package.json            # {"type":"commonjs"} 必须存在
│   └── main/
│       ├── app/
│       │   └── index.js        # ✅ 主进程单 bundle（原 per-file 布局已消失）
│       └── preload.js          # ✅ electron-vite preload 块产出
└── renderer/
    ├── index.html              # ✅ 不含 crossorigin
    └── assets/main-*.js
```

- ✅ `dist/main/main/app/index.js` 存在且非 0 字节
- ✅ `dist/main/main/preload.js` 存在
- ✅ `dist/main/main/package.json` 存在且 `type==commonjs`
- ✅ `dist/renderer/index.html` 存在且无 `crossorigin` 字面量
- ❌ 确认**不再**生成 `dist/main/main/index.js`（旧 tsc 入口）和任何 `index-<stamp>.js`
- 运行 `npm run typecheck`（`tsc -b`）应通过（`src/main/tsconfig.json` 保留作引用）

### 7.2 `electron .` 运行验证

```bash
npm run build      # 先构建
npx electron .     # 或 npm run dev（走 electron-vite dev，自动重建并启动）
```

- 应用正常启动、主窗口显示，无白屏。
- 打开 DevTools 查看 `diag.log`：
  - `WIN preloadPath=.../dist/main/main/preload.js` 且 `file exists check: preload=true`
  - `did-finish-load: page loaded successfully`（8s 内触发，不弹"疑似白屏"）
- 功能冒烟：扫描/导入/缩略图生成可用（验证 main bundle 内 IPC handler 全部打包正确）。

### 7.3 `npm run dist:win` 打包验证

```bash
npm run dist:win
```

- `pre-dist-check`（已适配 bundled 布局）全部 ✅
- electron-builder 产出 `release/NikkiGallery-Setup-<ver>.exe`
- `verify:dist`（`--verify-asar`）校验通过：
  - `better-sqlite3/build/Release/better_sqlite3.node` 存在
  - `@img/sharp-win32-x64/lib/*.node` 存在
  - `@img/sharp-libvips-win32-x64/lib/libvips-*.dll` 存在
  - `@koromix/koffi-win32-x64/koffi.node` 存在
- 安装运行打包版，确认启动正常、原生模块（数据库/缩略图/解密）可用。

---

## 8. 待清理的仓库残留（非脚本，手动/提交前处理）

> 以下删除操作**不属于本方案自动步骤**，由实施者在本地或提交前清理（本调研未执行删除）：

```bash
# 根目录 5 个 vite 缓存/中断遗留
rm -f vite.config.ts.timestamp-*.mjs

# 旧 build 日志
rm -f rebuild_native.log

# 若 dist 中残留旧 electron-vite 带戳产物（clean 已清空 dist/main，正常不会出现）
# 无需单独处理
```

同源待同步文档（不在本方案强制范围，建议后续跟进）：

- `ARCHITECTURE.md` / `DEVELOPMENT.md` / `DEVELOPMENT.en.md` 中 `npm run build:main` 描述与 `.vscode/launch.json` 的 `preLaunchTask: npm: build:main` 将失效，需改为 `electron-vite build` / `electron-vite dev`。

---

## 9. 风险与开放项

1. **per-file → 单 bundle**：pre-dist-check.ts 必须按 §4 改写，否则 `dist:win` 会被自身闸门拦截（最高优先级）。
2. **pluggable-electron 运行时解析**：主进程若 `import 'pluggable-electron/main'`，electron-vite 将其外部化为裸模块、运行时从 node_modules 解析。`src/main/tsconfig.json` 里的 `paths` shim 仅用于类型检查。需 `npm run dist:win` 后实测解密/插件功能。
3. **`emptyOutDir` 顺序**：main(`app/`, true) 与 preload(`dist/main/main`, false) 不会互相误清；整体清洁由 `clean` 负责。
4. **`dist/main/package.json` 不可省**：否则 CJS 产物在 `type:module` 根包下被当 ESM 解析 → 启动即崩。
