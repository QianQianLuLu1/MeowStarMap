# 换用猫脸插画作为软件图标并重新打包 2.5.5

> 日期：2026-10-26 ｜ 状态：已完成（全部实测读数见文末 §8.5）
> 背景：用户提供一张 4912×4912 方形插画，要求作为软件图标并重新打包 Windows 安装包。

## 〇、路径作用域声明

本文所有路径均为本仓相对路径；用户提供的原图与 `release/` 产物在本机绝对路径下，不在本仓。

## 一、前提取证（先判做不做，再动手）

| 前提（请求自带）                         | 取证命令                                                                                            | 现场输出                                                                                                                                         | 判定                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 「把图作为软件图标」= 换 `.ico` 文件即可 | 把 `resources/icons/icon.ico` 四档 payload 的中段 96 字节分别 `indexOf` 进两个产物，见 §八 探针读数 | app exe **四档全 MISS**；Setup exe **四档全 HIT**                                                                                                | **不成立**——换 `.ico` 只影响安装器图标，app exe / 快捷方式 / 任务栏不变 |
| 仓库里已有产品图标                       | 读 `resources/icons/icon.svg`                                                                       | 590 B 占位图：`<rect fill="#0078D4">` 蓝色圆角方块 + 白色几何块，与产品形象无关                                                                  | **不成立**——现图标是占位符                                              |
| exe 图标为何不生效                       | 读 `package.json` 的 `build.win` 与 `node_modules/app-builder-lib/out/winPackager.js`               | `signAndEditExecutable: false`；`winPackager.js:240-243` 该值时 `signApp` 直接 return，日志原文即给出解法「use `signExecutable: false` instead」 | 根因确认，属**配置跳过资源编辑**，非图标文件问题                        |
| 快捷方式/窗口图标是否独立于 exe          | 读 `src/main/app/desktop-shortcut.ts`、`src/main/app/window-manager.ts`、NSIS 模板                  | 前者 `icon: exePath`；后者 BrowserWindow **无** `icon` 选项（Windows 回退 exe 图标）；模板 `installer.nsh:197` 用 `$appExe 0`                    | 三者全部跟随 exe 图标 ⇒ 修好开关即自动生效，**无需改任何 TS 源码**      |
| 同版本 2.5.5 可复打                      | `npx tsx scripts/check-changelog-release.ts` 判据 + 读 `CHANGELOG.md`                               | `[2.5.5]` 节存在于 `:19`，`[Unreleased]` 无 `- ` 条目                                                                                            | 成立（与 10-24/10-25/10-26 三轮同版本复打一致）                         |
| 需要新增依赖                             | 查 `sharp` / `png-to-ico` 是否已装                                                                  | `sharp ^0.35.5`（dependencies）、`png-to-ico ^3.0.2`（devDependencies），均已装                                                                  | 成立且为零                                                              |

## 二、依赖声明

**零新增、零变更依赖。** 不 `npm install`、不改 `package-lock.json`、不动 `build.files` / `asarUnpack`。

| 包           | 位置                        | 版本      | 用途                                      |
| ------------ | --------------------------- | --------- | ----------------------------------------- |
| `sharp`      | `package.json` dependencies | `^0.35.5` | JPG → 主源 PNG、四档降采样、raw RGBA 读写 |
| `png-to-ico` | devDependencies             | `^3.0.2`  | PNG Buffer 数组 → `.ico` 容器             |

不引入 `electron-icon-builder` / `png2icons` / `to-ico`（均未安装，现有两件套已足够）。

### 一处实测踩到的 API 陷阱

`sharp(buf).resize(s,s).kernel(sharp.kernel.lanczos3)` 在本项目装的 sharp 版本上直接抛 `TypeError: ...kernel is not a function`。核必须作为 options 传给 `resize`：

```js
sharp(master).resize(s, s, { kernel: sharp.kernel.lanczos3 }) // 正确
```

## 三、启动与验证说明

- 环境：现有 `node_modules` 即可。本 shell 会导出 `ELECTRON_RUN_AS_NODE=1`（实测确认），**任何启动 electron 的步骤前必须 `unset`**，否则打包态用例全倒在启动前。
- 命令链：`node scripts/generate-icon.js` → `npx vitest run scripts/__tests__/app-icon.test.ts` → `npm run verify` → 静态三面 → `electron-builder --dir` 快验 → `npm run dist:win` → `npm run e2e:smoke` → `git commit`。
- **`npm run verify` 不会自动跑图标测试**：`scripts/verify-changes.ts:184` 的相关测试派发只扫 TS 文件，而 `generate-icon.js` 是 `.js`。改完必须显式跑上面那条 vitest。

## 四、技术方案

### 4.1 用户已拍定的三个决策

| 决策           | 取值                                                               |
| -------------- | ------------------------------------------------------------------ |
| 画面处理       | **圆角方形蒙版**（保留奶油底，四角透明）。不抠背景、不保持硬边方形 |
| exe 图标不生效 | **一并修好**（翻转构建开关）                                       |
| 版本号         | **保持 2.5.5 原地复打**，不升版本                                  |

### 4.2 圆角蒙版：raw RGBA + 圆角矩形 SDF

sharp 无原生圆角。三候选取舍：

- ❌ `sharp.boolean(mask)`：libvips 只取第二图第 1 band 做**二值**运算，拿不到亚像素覆盖率 ⇒ 边沿锯齿。
- ❌ 内嵌 base64 + `<clipPath>` 交 sharp 栅格化：受 librsvg 的 `href`/`xlink:href` 版本漂移与 `density`/DPI 影响（默认 72dpi ⇒ 输出尺寸 = viewBox×density/72），跨机器不确定。旧占位 SVG 能用是因为它不需要可复现，新链路需要。
- ✅ raw + SDF：纯函数、零依赖、不经 libvips 栅格器、可单测精确断言覆盖值。整条 ico 管线已实测两次产出 buffer 逐字节全等。

半径公式（具名导出 `radiusFor`）：

```
r(size) = clamp(round(size × 3/16), 2, floor(size/2))   ⇒  16→3  32→6  48→9  256→48
```

取 3/16 = 18.75% 是为了**逐字延续**旧占位 SVG 的 `rx="48"`（256 画布）视觉语言，不新增设计决策；`max(2,·)` 防 16 档退化成圆点，`min(·,size/2)` 防将来加 512/1024 档变成正圆。覆盖率用 4×4 均匀子采样（16 次 SDF 判定/像素），`alpha = round(255 × inside / 16)`。

> ⚠️ **半像素陷阱**：SDF 里矩形中心必须取 `w/2`、半宽取 `w/2 - r`（蒙版覆盖 `[0,w]×[0,h]` 全幅）。写成 `(w-1)/2` 会留下 0.5px 偏移，实测 16 档左上角 alpha 变 159 而不是 0，红灯不会灭。

### 4.3 降采样：每档直接从 1024 主源出

不做 256→小档的二次降采样（丢信息），不做逐级 step-down（实测折半链亮度 std 增益 ≤6%，方向一致但不显著，而 sharp 的 resize 内部本就做 shrink-on-integer + reduce）。不做 16/32 档主体特写 ⇒ 见 §七 已知限制。

### 4.4 主源：1024×1024 无损 PNG

实测体积：1024² PNG = **588,940 B**（选定）｜palette 量化 = 347,811 B（省 41% 但把调色板永久烘进真相源）｜512² = 152,379 B（对 256 档只剩 2× 余量）｜WebP/AVIF = 27K/21K（有损源喂有损管线，否决）。

进仓代价：+575KB 单文件；因 `build.files` 含 `resources/**/*`，asar 同步 +575KB（PNG 已压死，LZMA 压不动），对 183,641,784 B 安装包是 **+0.31%**。**不**为省这 0.31% 往 `build.files` 加排除项——那会多出一条被 `scripts/__tests__/pack-identity-name.test.ts` 与 `scripts/__tests__/self-contained-deps.test.ts` 读取的数组元素，收益微小、风险不为零。

`git check-ignore resources/icons/icon-master.png` 实测返回 1 ⇒ 不被忽略，可直接 `git add`。

### 4.5 `png-to-ico` 必须切数组形式

旧写法 `pngToIco(png256)` 走 `index.js:16-31` 单参分支，**内部用它自带的 pngjs bicubic 二次生成 48/32/16**——这正是当前 16 档四角 alpha = 6/11/10/15 的根因。数组形式 `pngToIco([p48,p32,p16,p256])` 走 `index.js:10-14`，逐个 `readPNG(Buffer)`（`lib/png.js:18` 明确接受 Buffer）后**直接 `imagesToIco`，不做任何缩放/校验/归一** ⇒ 尺寸、顺序、圆角全由我们负责。副作用：`imagesToIco` 用 `height = width * 2` 假定正方形，非方图会静默产出坏图标 ⇒ 参数校验要挡住（见 §五）。

### 4.6 256 档仍是 BMP：**不处理**

`png-to-ico` 一律写 BMP（`getDib`），现有 `.ico` 的 256 档就是 270,376 B 的 BMP。实测新产出 **285,478 B，与改造前逐字节同尺寸**。PNG 内嵌只能省 ~215KB，但 png-to-ico 不支持、要自己拼 ICO 容器，而 resedit 只是把 payload 原样搬进 `RT_ICON`（现网安装器图标一直是 BMP 且正常）。按最小改动：保持 BMP。

### 4.7 `signAndEditExecutable: false` → `signExecutable: false` 的连带影响（逐条已核）

- `winPackager.js:112-115`（`signIf` 遇 `signExecutable:false` 跳过）、`:221`（`createTransformerForExtraFiles` 返回 null）、`:236-243`（`signingDisabled` 仍真但不再提前 return）、`:253`（跳过 asar 内签名）四处逻辑确认：签名照旧不做，资源编辑恢复。
- `app-builder-lib/scheme.json` 已有 `signExecutable` 属性 ⇒ 不会 schema 校验失败。`forceCodeSigning` 未配 ⇒ `:237-239` 不抛。
- 资源编辑走 `out/util/resEdit.js` 纯 JS resedit，**不需要证书、不需要 wine**；CI 的 dist job 在 `windows-latest`（`.github/workflows/build.yml:175`）。
- `resEdit.js:28` 只在 `requestedExecutionLevel !== "asInvoker"` 时才动清单，本项目配的就是 `asInvoker` ⇒ 清单原样保留，`scripts/pre-dist-check.ts` 的 `checkNoAdminManifest` 只判 `requireAdministrator` ⇒ 仍过。
- **顺带收益（不是风险）**：同一个开关也关掉了 PE 版本元数据。实测当前 app exe 的 `ProductName/FileDescription` 仍是 `Electron`、`FileVersion` 仍是 `41.10.6`；翻转后会写入 `喵星图 / 2.5.5`（`winPackager.js:137-147`）。这正好闭合 `docs/plans/2026-10-23-rename-packaging-pass.md` 第九节 6 登记的遗留项。
- **构建缓存不会掩盖新图标**：`winPackager.js:183-191` 的 digest 把 `iconPath` 的**文件内容**一起哈希，且缓存要求 `cscFile != null`（本机无证书）⇒ 不启用。
- **无任何测试断言 exe 字节长度/哈希等于 `electron/dist/electron.exe`**：`scripts/__tests__/pre-dist-check.test.ts`（只测纯函数与 asar 路径解析）、`pack-identity-name.test.ts`（其 `build` interface 未含 `win` 段）、`self-contained-deps.test.ts`（只看 `files`/`asarUnpack`）、`audit-config.test.ts`（只看 audit-ci/workflow）、`e2e/dist-guard.ts`（只看 `preload.js` 头部形状）——五者都不碰 exe 字节。

## 五、参数校验

`scripts/generate-icon.js` 是本次唯一新增入参面的地方（无 CLI 参数，输入是仓库内固定路径）。

| 入参                              | 必填 | 类型/边界                                               | 非法值处理                                                                                        |
| --------------------------------- | ---- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `resources/icons/icon-master.png` | 是   | 存在且可读                                              | `readFileSync` 抛错 → `generateIcon().catch` 打印 `Failed to generate icon: <err>` + `exit(1)`    |
| 主源长宽                          | 是   | **必须 `width === height`**                             | `imagesToIco` 假定正方形，非方图静默产出坏图标 ⇒ 生成前显式校验，不等则抛错并带实际读数 `<w>×<h>` |
| 主源边长                          | 是   | `>= 256`（最大目标档）                                  | 小于 256 时 lanczos 会**放大**产出糊图 ⇒ 显式拒绝                                                 |
| `size`（内部）                    | 是   | `ICO_SIZES` 四成员                                      | 由 `Object.freeze` 常量表保证，不接外部输入                                                       |
| `radius`（内部）                  | 是   | `2 <= r <= floor(size/2)`                               | 由 `radiusFor` 的 clamp 保证，边界用例钉住 3/6/9/48                                               |
| `ss`（子采样数）                  | 否   | 正整数，默认 4                                          | 仅内部调用，不暴露                                                                                |
| `package.json` 的 `build.win`     | 是   | `signExecutable === false` 且无 `signAndEditExecutable` | 由图标守卫用例在**每次 `npm test`** 钉住，不合规即测试红                                          |

**渲染层 / IPC 面零改动**：本次不新增任何跨进程入参，不动 `src/main/ipc/**`、`src/shared/**`，不触碰四个受保护路径 ⇒ 无需 `// @core-change:` 注释。

## 六、错误处理与风险

### 异常分支与兜底

| 异常                         | 兜底                                                                                                 | 日志输出                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------- |
| 主源缺失 / 非方 / 过小       | 抛 `Error` 带具体读数，不静默降级                                                                    | `Failed to generate icon:`   |
| 生成器被 import 时产生副作用 | main 守卫（照抄 `scripts/pre-dist-check.ts` 的写法）+ 用例钉住「import 前后 ico 的 mtimeMs 不变」    | —                            |
| resedit 写 exe 失败          | electron-builder 抛出 → `npm run dist:win` 非零退出，`release/` 不留半成品 Setup                     | builder `resource-edit&sign` |
| exe 图标实际未进 PE          | 四档 96 字节探针（HIT/MISS 逐行可读）+ `verify:dist`                                                 | 探针输出                     |
| 清单被误改导致要求管理员     | `scripts/pre-dist-check.ts` 的 `checkNoAdminManifest`                                                | `[FAIL]`                     |
| 产物比源码旧                 | `pre-dist-check.ts` 只扫 `src/main`/`src/shared`/`src/renderer` 的 `.ts/.tsx`（**不扫 `scripts/`**） | `[FAIL]`                     |
| `[Unreleased]` 被顺手加条目  | `scripts/check-changelog-release.ts` 是 **error 不是 warning**，直接阻断打包                         | `errors.push` 含行号         |

### 风险 Top 4

**R1｜resedit 第二次改写把 `INTEGRITY/ELECTRONASAR` 弄丢 ⇒ 打包态启动即挂。**
实测证据：翻转前 app exe 与 `node_modules/electron/dist/electron.exe` 已同尺寸、仅差 2 字节，差异来自 `electronWin.js:37-45 addWinAsarIntegrity`——它**本身就在用 resedit**。顺序 `beforeCopyExtraFiles`(integrity) → fuses → `signApp`(icon/version)，翻转后是同一条 exe 被 resedit 连写两次，本仓从未跑过这条组合。
兜底：`--dir` 快验里**真启动一次**就把风险出清（约 3 分钟，不必等 30 分钟压包）。若真起不来：回退 `package.json` 为 `signAndEditExecutable: false`（一行），并改用「`BrowserWindow` 显式 `icon: nativeImage.createFromPath(...)`」这条更笨但零构建风险的路径——注意那**修不了快捷方式/任务栏**，只修窗口图标，届时应把问题上报而不是静默降级。

**R2｜Windows 图标缓存导致误判「没生效」。**
`release/win-unpacked` 每次是新目录、缓存键不同，一般不受影响；但安装到 `Program Files` 原路径会命中旧缓存，目视看到蓝方块即误判。
兜底：判定一律以**字节探针 + `VersionInfo` 读数**为准，目视只作旁证；必要时 `ie4uinit.exe -show` 或把 exe 复制到全新目录再看。

**R3｜`old-name-ledger` 计数被新文件打破。**
`scripts/__tests__/old-name-ledger.test.ts` 的判据是逐文件逐模式**相等** + 总数等于 `expectedTotal`，扫描根含 `scripts` 与 `docs`、扩展名含 `.ts`/`.md`。⇒ 新增测试、新增脚本、新写的文档句子里**一个字都不能出现那 29 条旧名模式**。
兜底：新文件写完立刻单跑该守卫；若注释里不小心写了目录名字面量，**删掉该串而不是去改台账**。

**R4｜`tsc -p tsconfig.scripts.json` 因 `allowJs` 从 `.js` 推出隐式 any。**
该配置是 `allowJs: true` + `noEmit: true`，测试 import `generate-icon.js` 会走 JS 类型推断。
兜底：给导出函数补 JSDoc（`@param`/`@returns`）。**不要**为此改 tsconfig 或加 `// @ts-ignore`。

**整体回滚**：改动面 11 个文件、无 DB / 无 IPC / 无受保护路径 ⇒ `git revert` 单提交即可。`release/` 是 gitignore 资产、不可 revert ⇒ 旧包按 §八 的 sha256 指纹核对后手工改名保存。

## 七、已知限制（如实登记）

1. **16×16 档可辨识度天然有限**。不做主体特写 ⇒ 通知栏/托盘尺寸下拍立得相框边线与猫耳轮廓会被压平，画面无真正暗部（实测 16 档 `min` 亮度约 175）。若日后托盘图标看不清，正确解法是**单独做一张猫脸特写主源**，而不是在生成器里加 crop 代码。
2. **256 档仍是 BMP 负载（270,376 B）**，不是 PNG 内嵌；`.ico` 总尺寸与改造前完全一致。
3. **安装包 +575KB**（主源 PNG 随 `resources/**/*` 进 asar），占 183,641,784 B 的 +0.31%。
4. **同版本号复打** ⇒ `release/latest.yml` 的 `version` 仍是 `2.5.5`，已装 2.5.5 的机器不会自动重下新包。
5. **未签名**（本次仍不引入证书），SmartScreen 行为与改造前一致。
6. **明确不做**：往 `scripts/pre-dist-check.ts` 的 `--verify-asar` 分支新增「exe 必须带图标」常驻出货闸门。理由：图标守卫用例已把真正的失效点（那个开关被加回来）钉在每次 `npm test` 里，而该脚本是上千行的关键闸门，为省一次人工探针去改它不划算。若日后要做，另起一批。

## 八、执行记录

### 8.1 基线指纹（改动前，回滚与取证用）

| 文件                                           | 字节        | sha256                                                                                              |
| ---------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| `resources/icons/icon.ico`                     | 285,478     | `b4c393b438ffd5d9853aa4739e1c1547c9e03e0f5d63da1d394fac765ccd77c6`                                  |
| `resources/icons/icon.svg`（占位，本批已删除） | 590         | `ef1a127a49a555e03f2c4ad36344602ba94097e57fcc88e1b0247458e1863572`                                  |
| `release/MeowStarMap-Setup-2.5.5.exe`          | 183,641,784 | `b109fb17f0ff2a63e076924a60bfa72029bfec920e012dfe577a21dd07fa1439`                                  |
| `release/win-unpacked` 下 app exe              | 223,764,992 | `51a0aadb5d5eb7f4aabc078f6d347fb02fe010df0ca21f3a4ef1ac649196e84b`                                  |
| 用户原图（本机绝对路径，不入仓）               | 4,244,855   | `a486a62c2411bfdaaa34e4436afb87b85d1b463ffa6f76687404a31945533132`（4912×4912，EXIF Orientation=1） |

`git status --porcelain` 改动前为空，HEAD = `c498eb6`。`ELECTRON_RUN_AS_NODE` 实测为 `1`。

### 8.2 红灯取证

**旧 `icon.ico` 四档实测**（手写 ICO/BMP 解析：40 字节头 + bottom-up BGRA + AND 位图）：

| 档位    | 四角 alpha         | 四角 AND 位     | 中心 alpha | 中心 RGB       | 蓝主导占比 | meanR−meanB |
| ------- | ------------------ | --------------- | ---------- | -------------- | ---------- | ----------- |
| 48×48   | `[0,0,0,0]`        | `[1,1,1,1]`     | 255        | `(8,123,213)`  | 91.5%      | −161.9      |
| 32×32   | `[0,0,0,0]`        | `[1,1,1,1]`     | 255        | `(34,136,217)` | 91.7%      | −163.4      |
| 16×16   | **`[6,11,10,15]`** | **`[0,0,0,0]`** | 255        | `(65,154,223)` | 93.8%      | −165.9      |
| 256×256 | `[0,0,0,0]`        | `[1,1,1,1]`     | 255        | `(0,120,212)`  | 91.0%      | −160.6      |

⇒ 两点直接决定测试判据写法：

- 「四角透明」**只有 16 档是真红灯**（旧 256/48/32 三档四角已经是 0，因为占位 SVG 自带 `rx="48"`）。所以断言必须**逐档**做，让 16 档去红；只断 256 档会得到一条改前即绿的假红灯。
- 「逐像素等于 `#0078D4`」**不可用作判据**——只有 256 档中心恰好 `(0,120,212)`，小尺寸档因 bicubic 混色而偏离。改用聚合统计：蓝主导占比 + `meanR − meanB`，两侧余量都是数量级。

**探针复现主缺陷**：同一份 `icon.ico` 的四档中段 96 字节，打 app exe ⇒ `48/32/16/256 全 MISS`；打 Setup ⇒ `全 HIT`。这就是「只有安装器图标生效」的直接证据。

### 8.3 新链路在内存中的预演读数（未落盘时已验证）

| 项               | 实测值                                                                       |
| ---------------- | ---------------------------------------------------------------------------- |
| 主源 1024² PNG   | 588,940 B，metadata `channels: 3`（⇒ 必须 `ensureAlpha()` 才能乘覆盖率）     |
| 新 `.ico` 总字节 | **285,478 B**（与改造前逐字节同尺寸）                                        |
| 四档半径         | 48→9 / 32→6 / 16→3 / 256→48                                                  |
| 四档四角 alpha   | 全部 `[0,0,0,0]`，AND 位全部 `[1,1,1,1]`（16 档由红转绿）                    |
| 四档中心 alpha   | 全部 255；中心 RGB `(253,253,253)/(255,255,255)/(244,241,238)/(254,254,254)` |
| 四档蓝主导占比   | 全部 **0.0%**；`meanR−meanB` = +32.2 / +32.2 / +32.2 / +31.9                 |
| 确定性           | 两次跑整条管线，`Buffer.compare === 0`                                       |

### 8.4 探针脚本（只读，可复跑）

```bash
node --input-type=module -e '
import fs from "fs";
const ico = fs.readFileSync("resources/icons/icon.ico");
const buf = fs.readFileSync(process.argv[2]);
for (let i = 0; i < ico.readUInt16LE(4); i++) {
  const d = 6 + i * 16, w = ico[d] || 256
  const sz = ico.readUInt32LE(d + 8), off = ico.readUInt32LE(d + 12)
  const probe = ico.subarray(off + Math.floor(sz / 2), off + Math.floor(sz / 2) + 96)
  console.log(`${w}x${w}`, buf.indexOf(probe) >= 0 ? "HIT" : "MISS")
}' "release/win-unpacked/喵星图.exe"
```

### 8.5 逐阶段读数

**Phase 1 主源**：`resources/icons/icon-master.png` = 1024×1024、588,940 B、`channels: 3`、`hasAlpha: false`、`orientation` 已为 `undefined`（`.rotate()` 显式清 EXIF）。`git check-ignore` 返回 1，已 `git add`。

**Phase 2 红灯**：`npx vitest run scripts/__tests__/app-icon.test.ts` ⇒ **10 failed / 3 passed**。三条通过项正是预先声明的回归守卫（四档结构、逐档中心不透明）与主源存在（该条因 Phase 1 已建主源而提前变绿，故**临时把主源移开复跑，确认它确实会红**，非空判据）。

红灯期间发现自己写的三处缺陷，均已订正（记录以免被误读为「放宽断言让它过」）：

1. `expect(标签, 实际值)` 把 vitest 的第二参数当第一参数用了 ⇒ 断言实际在比较字符串，会让 R2 对**所有**档位红而不是精确指向 16×16。改为 `expect(实际值, 标签)` 后，失败信息精确为
   `AssertionError: 16x16 四角 alpha: expected [ 6, 11, 10, 15 ] to deeply equal [ +0, +0, +0, +0 ]`。
2. 「零覆盖像素数 ≈ 4×(r²−πr²/4)」与「8×8 角像素 = 0」两条**期望值本身算错**：实测 8×8 r=2 角像素覆盖率是 96（该像素离圆心最近处已在圆内），16×16 的零覆盖数是 4 而解析式给 7.73，256 档 1848 对 1977.77——面积式统计的是角带总面积，不是「整像素全零」的个数。换成两条**既为真又能区分半像素偏移**的几何性质：

   | 档位         | 对称性违例（正确 / bug） | 蒙版面积偏差（正确 / bug） |
   | ------------ | ------------------------ | -------------------------- |
   | 8×8 r=2      | 0 / 52                   | +0.44 / −14.56             |
   | 16×16 r=3    | 0 / 92                   | −0.29 / −31.29             |
   | 32×32 r=6    | 0 / 180                  | −0.34 / −63.34             |
   | 48×48 r=9    | 0 / 292                  | −0.73 / −95.73             |
   | 256×256 r=48 | 0 / 1540                 | +0.33 / −510.67            |

   断言取「对称性违例 == 0」与「|面积 − (w·h − 4r² + πr²)| < 1.5」。

3. R6 用裸子串 `not.toContain('icon.svg')` 判据过粗——生成器注释里作为历史叙述提到该文件名即被误判。改为只禁**带引号的路径字面量**，并**正向锁定** `'icon-master.png'`，双向都收得更紧。

**Phase 3 生成器与 ico**：`node scripts/generate-icon.js` 产出 285,478 B（与预测逐字节同尺寸），sha256 `16c4897c277c099b510a66031202848844a70b159f9bedda110c1b5bc3bc3df1`；**连跑两次 sha256 相同 ⇒ 确定性 PASS**。逐档实测：

| 档位    | payload   | 四角 alpha  | 四角 AND    | 中心 alpha | 蓝主导 | meanR−meanB |
| ------- | --------- | ----------- | ----------- | ---------- | ------ | ----------- |
| 48×48   | 9,640 B   | `[0,0,0,0]` | `[1,1,1,1]` | 255        | 0.0%   | +32.2       |
| 32×32   | 4,264 B   | `[0,0,0,0]` | `[1,1,1,1]` | 255        | 0.0%   | +32.2       |
| 16×16   | 1,128 B   | `[0,0,0,0]` | `[1,1,1,1]` | 255        | 0.0%   | +32.2       |
| 256×256 | 270,376 B | `[0,0,0,0]` | `[1,1,1,1]` | 255        | 0.0%   | +31.9       |

对照 §8.2 的旧值：16 档四角由 `[6,11,10,15]`/AND `[0,0,0,0]` 转成 `[0,0,0,0]`/AND `[1,1,1,1]`；蓝主导由 91.0–93.8% 归零。占位 SVG 已 `git rm`。

**Phase 4 开关**：`build.win` 现为 `{ target, icon: 'resources/icons/icon.ico', signExecutable: false, verifyUpdateCodeSignature: false, requestedExecutionLevel: 'asInvoker' }`——`signAndEditExecutable` 整键移除。守卫 13/13 转绿。

**连带回归（scripts 子集）**：`npx vitest run scripts/__tests__` ⇒ **25 文件 / 433 用例全绿**，含 `old-name-ledger`（未引入禁串）、`source-encoding`（无 BOM）、`pack-identity-name`、`self-contained-deps`、`audit-config`、`core-path-gate`。

**静态闸门**：`prettier --check --end-of-line auto`（本次 9 个受检文件）All matched files use Prettier code style；`eslint` 两文件 exit 0；`npm run docs:links` ✅ 无死引用（160 处提醒均为既有）；`check-changelog-release` ✅ 收口通过。

**Phase 6 `--dir` 快验**：`npm run build` exit 0（5.44s）；`npx electron-builder --dir --win` exit 0，关键日志由改造前的「executable resource editing and code signing skipped」变为

```
• file signing skipped via signExecutable configuration  file=release\win-unpacked\喵星图.exe
```

三项验收：

1. **四档探针全 HIT**（改前全 MISS），exe 由 223,764,992 → **224,013,312 B**（+248,320，即写入的图标资源体积）。
2. PE 元数据：`ProductName=喵星图`、`FileDescription=喵星图`、`FileVersion=2.5.5`、`ProductVersion=2.5.5.0`、`OriginalFilename=[]`（与 `winPackager.js:143-144` 置空一致）。改前三者均为 Electron 默认值。
3. **真启动通过**：以 `--user-data-dir` 指向 `.cache/` 下临时目录启动（避免触碰开发机真实相册库），主进程 `pid=29284 hwnd=7604324 title=[喵星图]`，共 8 个进程（正常 Electron 拓扑）。⇒ 风险 R1（resedit 第二次改写丢 `INTEGRITY/ELECTRONASAR`）**排除**。临时 userData 已删除。

**Phase 7 全量复打**：`npm run dist:win` **exit 0**。三段闸门读数：

- `pre-dist-check`：`[pre-dist-check] ✅ 全部校验通过，可以执行打包。`
- `check-doc-versions`：✅ README 中所有 Electron 版本均为 41.10，与 `package.json` (41.10.6) 一致。
- `check-changelog-release`：✅ 变更日志收口校验通过。
- `electron-builder`：日志中 `file signing skipped via signExecutable configuration` 出现三次——app exe、`MeowStarMap-Setup-2.5.5.__uninstaller.exe`、`MeowStarMap-Setup-2.5.5.exe`。即**安装器与卸载器现在也一并拿到 PE 资源编辑**，这是旧配置下同样被跳过的项。
- `verify:dist`（`--verify-asar`）：`[pre-dist-check] ✅ 解包产物校验通过。`

产物取证：

| 产物                                  | 四档探针                |
| ------------------------------------- | ----------------------- |
| `release/win-unpacked/喵星图.exe`     | 48/32/16/256 **全 HIT** |
| `release/MeowStarMap-Setup-2.5.5.exe` | 48/32/16/256 **全 HIT** |

Setup 体积 183,641,784 → **184,343,181 B（+701,397）**，与「主源 PNG 588,940 + exe 图标资源 248,320 = 837,260 原始字节，经 LZMA maximum 压后」量级一致。`release/latest.yml` 的 `version` 仍为 `2.5.5`，`sha512` 与 `releaseDate` 已刷新（同版本号 ⇒ 已装 2.5.5 的机器不会自动重下，见 §七 限制 4）。

**静态四面**：`npm run typecheck`（`tsc -b` + `tsc -p tsconfig.scripts.json`）exit 0；`npm run typecheck:e2e` exit 0；`npm run lint`（全量 `eslint .`）exit 0；`npm run format:check` All matched files use Prettier code style；`npm run i18n:guard` ✅。

**Phase 8 全量回归与提交**：

| 闸门                                                             | 结果                                                                                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `npm test`（全量 vitest）                                        | **447 文件 / 6984 通过 / 12 跳过**，exit 0；新增的 `scripts/__tests__/app-icon.test.ts` 13 用例在其中                      |
| `npm run typecheck`（`tsc -b` + `tsc -p tsconfig.scripts.json`） | exit 0                                                                                                                     |
| `npm run typecheck:e2e`                                          | exit 0                                                                                                                     |
| `npm run lint`（全量 `eslint .`）                                | exit 0                                                                                                                     |
| `npm run format:check`                                           | All matched files use Prettier code style                                                                                  |
| `npm run i18n:guard`                                             | ✅ 白名单只减不增、key 已同步                                                                                              |
| `npm run docs:links`                                             | ✅ 无死引用                                                                                                                |
| `npm run e2e:smoke`                                              | **16 passed**（含针对真实 `release/win-unpacked/喵星图.exe` 的 S1–S8 与 userData 隔离校验，以及历史上易倒的 NikkiSync N1） |
| `.husky/pre-commit`                                              | lint-staged → core-path-gate（⊘ 本次不涉及受保护路径）→ `tsc -b`，三步全 PASSED                                            |

提交为 `9f0f343 fix(build): 换用猫脸主源并恢复 exe 图标的 PE 资源编辑`（13 文件 / +755 −26）。提交后 `git status --porcelain` 为空，`git show HEAD:resources/icons/icon.ico` 的 sha256 与验证过的 `16c4897c…3df1` 逐字节一致。

**一处为消除不确定性而做的额外重打**：钩子的 lint-staged 会对暂存文件跑 `prettier --write`，因此 `package.json` 的 mtime 落到了 `22:55:21`——**晚于** 22:49 产出的 Setup。先确证 `git show HEAD:package.json` 与 `HEAD~1` 之间除 `signExecutable` 那一行外无任何其它差异（即钩子并未改写内容），但「产物是否对应 HEAD」这件事不该靠推理回答，故按已提交的树**整链路重打一次** `npm run dist:win`：exit 0，三段闸门与 `verify:dist` 全 ✔，`file signing skipped via signExecutable configuration` 仍出现三次。

重打后的最终读数：

| 产物                                  | 四档**整档逐字节**探针 | 字节        |
| ------------------------------------- | ---------------------- | ----------- |
| `release/win-unpacked/喵星图.exe`     | 48/32/16/256 全 HIT    | 224,013,312 |
| `release/MeowStarMap-Setup-2.5.5.exe` | 48/32/16/256 全 HIT    | 184,343,137 |

Setup 相对改前 183,641,784 B 增加 **701,353 B**（前表记的 +701,397 是首轮读数，两轮差 44 B 来自归档内时间戳，非内容差异）。新鲜度复核：Setup `22:57:20` 晚于最晚出货输入 `22:56:39` ⇒ **安装包确实对应 HEAD `9f0f343`**。

**视觉取证（把图标从 exe 里反向解出来看）**：字节探针只能证明「负载进去了」，不证明「画面对了」。故按 ICONDIRENTRY 取每档**完整** payload 在 exe 中 `indexOf`——四档均**整档逐字节命中**（强于 §8.4 的 96 字节探针），再把 BMP DIB（bottom-up BGRA）翻转回 RGBA 交给 sharp 栅格化成 PNG 目视：

| 档位    | 目视结论                                                                                                                               |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 256×256 | 奶油圆角底 + 倾斜拍立得 + 闭眼白猫 + 框顶猫耳与卷毛，四角透明。与原图一致                                                              |
| 48×48   | 任务栏/资源管理器常用档，主体清晰可辨                                                                                                  |
| 32×32   | 相框边线开始变软，猫脸仍可辨                                                                                                           |
| 16×16   | **与 §七 限制 1 的预告完全吻合**：相框边线与猫耳被压平，只剩黄色环与脸部亮块的可读轮廓。属「不做主体特写」这一决策的既定代价，非新缺陷 |

预览文件写在 `.cache/icon-preview/`（gitignore 区）并已删除，不留残留。

> 若日后要让 16 档也清晰，正确解法仍是**单独做一张猫脸特写主源**（例如 `icon-master-16.png`）并在生成器里按档选源，而不是给现有链路加 crop 参数——后者会把「裁切构图」这个设计决策塞进代码。

**文档残留引用的处置**：全仓检索 `icon.svg` 与 `signAndEditExecutable` 后，仅两类位置仍有命中，均为**应保留的历史叙述**而非失真——带日期的执行记录（`docs/plans/2026-10-23-*`、`docs/plans/2026-10-26-review-fixes-*`）与 `docs/archive/`（gitignore 的本机留档）；另有 `.qoder/`、`storybook-static/` 两处 gitignore 目录。当前生效的配置真相源（`package.json`）与描述现状的文档（`ARCHITECTURE.md` / `ARCHITECTURE.en.md` / `DEVELOPMENT.md` / `DEVELOPMENT.en.md` / `scripts/AGENTS.md`）已全部对齐。
