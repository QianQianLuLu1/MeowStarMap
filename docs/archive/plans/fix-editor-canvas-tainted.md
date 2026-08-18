# 修复「编辑器 canvas 被跨源数据污染」计划

> 目标：图片编辑页不再报 `Failed to execute 'getImageData' on 'CanvasRenderingContext2D': The canvas has been tainted by cross-origin data.`，预览出图、直方图、滤镜缩略图、滑块实时预览、水印、批量应用全链路恢复。
> 本计划仅描述方案、影响与验证，代码改动由实施阶段落地。

## 1. 背景与根因

图片编辑页打开后图片显示区空白，控制台抛出：

```text
Failed to execute 'getImageData' on 'CanvasRenderingContext2D':
The canvas has been tainted by cross-origin data.
```

根因是**页面 origin 与图片 origin 不同源，且两侧都缺少 CORS 放行**，共四个环节叠加：

1. **页面经 `app://renderer` 加载** — [window-manager.ts#L170](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/main/app/window-manager.ts#L170) 附近，页面 origin 为 `app://renderer`。
2. **编辑器图片经 `media://file?path=...` 加载** — [file.ts#L31](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/renderer/utils/file.ts#L31)；media scheme 在 [index.ts#L28-L37](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/main/index.ts#L28-L37) 注册为 `standard`（隐含 secure / supportFetchAPI 等特权），standard scheme 自带**独立 origin**，因此 `app://renderer` 与 `media://...` 天然跨源。
3. **media:// handler 的响应缺少 `Access-Control-Allow-Origin` 头** — [media-protocol.ts#L90-L113](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/main/app/media-protocol.ts#L90-L113) 的 206 与 200 两个成功分支 headers 里都没有 ACAO；对照 `app://` 协议在 [renderer-protocol.ts#L73](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/main/app/renderer-protocol.ts#L73) 已显式带了该头。
4. **渲染端 4 处 U-G14 代码只对 http(s) 设置 `crossOrigin = 'anonymous'`** — `media://` 前缀不在判断内，`<img>` 以 no-cors 模式加载跨源图并绘制进 canvas → canvas 被 tainted → [imageProcessor.ts#L528](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/renderer/utils/imageProcessor.ts#L528) 的 `getImageData` 抛 `SecurityError`。

**修复原则**：主进程为 media scheme 声明 `corsEnabled` 特权 + 补 `Access-Control-Allow-Origin: *` 响应头 + 渲染端 4 处放行 `media://` 的 `crossOrigin='anonymous'`，**三侧必须在同一版本（同一提交）落地**——只改部分侧会让请求从「canvas 报错」恶化为「图片直接加载失败」（anonymous 模式下无特权/无 ACAO 头的请求会被 CORS 直接拦截）。

## 2. 依赖声明

### 2.1 改动文件清单及依赖关系

| 文件                                                                                                                                         | 改动                                                                              | 依赖关系                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------- |
| [src/main/index.ts](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/main/index.ts)                                                             | media scheme privileges 增加一行 `corsEnabled: true`（子任务 A）                  | **无前置依赖**；与响应头/渲染端改动同一提交落地 |
| [src/main/app/media-protocol.ts](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/main/app/media-protocol.ts)                                   | 206 与 200 分支 headers 各加一行 `'Access-Control-Allow-Origin': '*'`（子任务 A） | **无前置依赖**；但必须与渲染端改动同一提交落地  |
| [src/renderer/utils/file.ts](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/renderer/utils/file.ts)                                           | 新增工具函数 `needsAnonymousCors(url: string): boolean`（子任务 B）               | 被下面 4 个消费方依赖，须先落地                 |
| [src/renderer/hooks/useImageProcessor.ts](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/renderer/hooks/useImageProcessor.ts)                 | L131-134 条件判断替换为 `needsAnonymousCors`                                      | 依赖 file.ts 新函数                             |
| [src/renderer/components/editor/Histogram.tsx](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/renderer/components/editor/Histogram.tsx)       | L105-108 条件判断替换为 `needsAnonymousCors`                                      | 依赖 file.ts 新函数                             |
| [src/renderer/components/editor/FilterPanel.tsx](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/renderer/components/editor/FilterPanel.tsx)   | L96-99 条件判断替换为 `needsAnonymousCors`                                        | 依赖 file.ts 新函数                             |
| [src/renderer/utils/imageProcessor.ts](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/renderer/utils/imageProcessor.ts)                       | L754-757 条件判断替换为 `needsAnonymousCors`                                      | 依赖 file.ts 新函数                             |
| [src/main/app/\_\_tests\_\_/media-protocol.test.ts](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/main/app/__tests__/media-protocol.test.ts) | 为 200/206 响应补 ACAO 断言                                                       | 依赖子任务 A                                    |
| [src/renderer/hooks/useImageProcessor.test.ts](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/renderer/hooks/useImageProcessor.test.ts)       | 新增 media:// source 设置 `crossOrigin='anonymous'` 回归用例                      | 依赖子任务 B                                    |

### 2.2 双侧同一提交落地（硬性约束）

主进程响应头（子任务 A）与渲染端 crossOrigin 放行（子任务 B）**必须在同一提交中落地**：

- 只改渲染端：`<img crossOrigin='anonymous'>` 请求 media:// 时，响应无 ACAO 头 → CORS 拦截 → 图片**直接加载失败**（比现在的 tainted 报错更糟）。
- 只改主进程：响应带了 ACAO，但渲染端仍以 no-cors 模式加载 → canvas 依旧 tainted，问题不变。

### 2.3 运行时与依赖版本

- Node / Electron / vitest 版本一律以 [package.json](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/package.json) 为准（当前基线：`engines.node >= 20`、`electron 40.10.6`、`vitest ^1.6.1`）。
- **不引入任何新 npm 依赖**。本修复只涉及响应头常量、一行协议特权声明与一个纯字符串前缀判断函数，零新增第三方包。

## 3. 启动说明

```powershell
# 1. 安装依赖（不新增任何包，仅同步 lockfile）
npm install

# 2. dev 验证（开发模式，app://renderer + media:// 双 origin 与打包产物一致）
npm run dev
# 进入任意图片的编辑页：预览出图、直方图、滤镜缩略图、滑块实时预览、图片水印、批量应用逐项确认

# 3. 生产验证（打包产物复核）
npm run build
# 随后启动打包产物（release/win-unpacked 或 npm run preview 视实际产物而定），复验同一冒烟清单

# 4. 测试与静态检查命令
npm run test:main     # 主进程单测（media-protocol ACAO 断言落在这里）
npm run test:renderer # 渲染端单测（needsAnonymousCors / useImageProcessor 回归落在这里）
npm run lint
npm run typecheck
```

## 4. 子任务分解

> 每个子任务写明：修改哪些文件、输入输出、验收标准。

### 4.1 子任务 A（主进程）：media:// 成功响应补 ACAO 头

- **修改文件**：仅 [src/main/app/media-protocol.ts](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/main/app/media-protocol.ts)、配套测试 [src/main/app/\_\_tests\_\_/media-protocol.test.ts](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/main/app/__tests__/media-protocol.test.ts)，以及 [src/main/index.ts](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/main/index.ts)（仅一行特权变更）。
- **改动内容**：
  - 206 分支（约 L94-100）headers 对象中新增一行 `'Access-Control-Allow-Origin': '*'`；
  - 200 分支（约 L107-112）headers 对象中新增同一行；
  - 400 / 403 / 404 / 416 / 500 各错误分支**不加**（错误分支无需 CORS 放行，保持最小改动）；
  - 白名单 `isMediaPathAllowed`、Range 解析 `parseRangeHeader`、realpath 防穿越逻辑**一律不动**；
  - [src/main/index.ts](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/main/index.ts) 中 media scheme privileges 补 `corsEnabled: true`（仅允许该一行特权变更，app scheme 不动）。运行时实证表明：未声明 corsEnabled 时，渲染进程以 `crossOrigin='anonymous'` 发起的 CORS 模式请求在到达 protocol.handle handler 之前即被 Chromium 网络层拒绝，响应里的 ACAO 头没有机会生效。
- **输入**：现有 media:// 请求流（渲染进程 `<img>` / fetch 发起）。
- **输出**：200/206 响应 headers 多一个 `Access-Control-Allow-Origin: *`，其余行为（状态码、Content-Range、流式读取、缓存头、错误分支）完全等价。
- **验收标准**：
  - `npm run typecheck` 通过；
  - `npm run test:main` 全绿（测试**先补** 200/206 的 ACAO 断言，再改实现或同步改，见 §6 用例①）。
- **corsEnabled 特权的验收说明**：`corsEnabled` 属 Electron 运行时协议特权，单测无法覆盖；其验收依据为运行时实证——补充该特权后，以 `crossOrigin='anonymous'` 加载 media:// 图片、drawImage 入 canvas 后 `getImageData` 成功返回像素数据（已通过新打包产物的临时 e2e 实证）；最终使用验收依赖子任务 C 的编辑页冒烟。

### 4.2 子任务 B（渲染端）：放行 media:// 的 crossOrigin='anonymous'

- **修改文件**：
  1. [src/renderer/utils/file.ts](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/renderer/utils/file.ts)：新增 `needsAnonymousCors(url: string): boolean`（规格见 §5 参数校验）；
  2. [src/renderer/hooks/useImageProcessor.ts](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/renderer/hooks/useImageProcessor.ts) L131-134；
  3. [src/renderer/components/editor/Histogram.tsx](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/renderer/components/editor/Histogram.tsx) L105-108；
  4. [src/renderer/components/editor/FilterPanel.tsx](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/renderer/components/editor/FilterPanel.tsx) L96-99；
  5. [src/renderer/utils/imageProcessor.ts](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/renderer/utils/imageProcessor.ts) L754-757。
- **改动内容**：4 处消费点**每处仅替换条件判断行**——把现有「仅 http(s) 前缀」的判断换成 `needsAnonymousCors(source)`；`img.crossOrigin = 'anonymous'` 的赋值语句及其余逻辑不动。
- **明确不改**：[EditorPage.tsx](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/renderer/pages/EditorPage.tsx) L570-579 的批量应用分支——该处已无条件设置 `anonymous`，主进程补头后自然恢复，无需触碰。
- **输入**：现有 source URL（`media://file?path=...` / http(s) / blob: / data: / mock:// 等）。
- **输出**：media:// 图片以 anonymous CORS 模式加载，canvas 不再 tainted，`getImageData` 正常返回。
- **验收标准**：
  - `npm run typecheck` 通过；
  - `npm run test:renderer` 全绿（含 §6 用例②③）。

### 4.3 子任务 C（全量验证）

- **修改文件**：无新增改动，纯验证。
- **验证内容**：
  1. `npm run lint`、`npm run typecheck`、`npm test` 三项全绿；
  2. `npm run dev` 进入编辑器冒烟：预览出图、直方图渲染、滤镜缩略图、滑块实时预览、图片水印、批量应用（含 EditorPage L570-579 分支）；
  3. 回归确认：图库缩略图正常、视频播放（Range 请求路径）无回归；
  4. 如条件允许：`npm run build` 后复核打包产物，或执行 `npm run e2e:smoke`。
- **验收标准**：以上冒烟清单逐项通过，且 dev 与打包产物两个 origin 场景均覆盖。

## 5. 参数校验

### 5.1 新工具函数 `needsAnonymousCors(url: string): boolean`

- **输入校验**：非 string（运行期防御）或空串一律返回 `false`，不抛异常。
- **前缀白名单**：仅对 `http://`、`https://`、`media://` 三种前缀返回 `true`。
- **明确排除**：`blob:`、`data:`、`mock://` 一律返回 `false`（这些来源要么同源、要么不适用 CORS，设 anonymous 反而有害）。
- 建议实现为纯前缀判断（`startsWith`），不做 URL 解析，保持零依赖、零副作用，便于单测。

### 5.2 主进程侧边界

- media-protocol 的白名单校验 `isMediaPathAllowed` 与 Range 解析 `parseRangeHeader` 逻辑**不改**：ACAO 头只影响 CORS 放行，不改变任何访问控制与字节区间语义。
- 错误分支（400/403/404/416/500）不新增响应头。

## 6. 基础测试用例

| #   | 用例                                                                         | 落点                                                                                                                                         | 断言                                                                                                                     |
| --- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| ①   | media-protocol 成功响应带 ACAO 头                                            | [src/main/app/\_\_tests\_\_/media-protocol.test.ts](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/main/app/__tests__/media-protocol.test.ts) | 200（无 Range）与 206（带 Range）响应的 headers 均含 `Access-Control-Allow-Origin: *`；其余既有头（Content-Type 等）不变 |
| ②   | `needsAnonymousCors` 前缀判断单测                                            | 渲染端 utils 单测（随 file.ts 现有测试组织方式落点，或新建同目录测试文件）                                                                   | `http://…` / `https://…` / `media://…` → `true`；`blob:…` / `data:…` / `mock://…` / 空串 / 非 string → `false`           |
| ③   | useImageProcessor 对 media:// source 设置 `crossOrigin='anonymous'` 回归用例 | [src/renderer/hooks/useImageProcessor.test.ts](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/renderer/hooks/useImageProcessor.test.ts)       | source 为 `media://file?path=…` 时创建的 img 元素 `crossOrigin === 'anonymous'`；原有 http(s) 用例保持通过               |

## 7. 错误处理

- **主进程**：media-protocol handler 现有 try/catch 及 400/403/404/416/500 错误分支**保持不动**；新增响应头只出现在成功分支的 headers 对象里，**不改变任何错误分支的行为与状态码**。
- **渲染端**：[useImageProcessor.ts#L100-L105](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/renderer/hooks/useImageProcessor.ts#L100-L105) 的 catch → `setError` 降级链路**保留**——即使未来再出现加载/解码异常，仍走既有的错误态展示，不会白屏静默。
- 本修复不新增任何 try/catch、不新增错误提示文案、不改变任何错误上报路径。

## 8. 执行纪律

每一步必须**先验证通过再进入下一步**，报错当步修复，不把错误带到下一步：

1. **计划文件**（本文档）评审确认 → 进入下一步；
2. **主进程 + 测试**（子任务 A）：`npm run typecheck` + `npm run test:main` 全绿后 → 进入下一步；
3. **渲染端 + 测试**（子任务 B）：`npm run typecheck` + `npm run test:renderer` 全绿后 → 进入下一步；
4. **全量验证**（子任务 C）：lint / typecheck / npm test / dev 冒烟 / 打包产物复核。

注意：步骤 2 与步骤 3 的**代码提交必须合并为同一提交**（见 §2.2），验证可以分步、提交不可拆分。

## 9. 禁止触碰清单

| 文件 / 区域                                                                                                         | 禁止原因                                                                                       |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [src/main/index.ts](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/main/index.ts)                                    | 仅允许 media scheme privileges 增加 `corsEnabled: true` 这一行；其余协议特权与注册逻辑不得改动 |
| [src/main/app/window-manager.ts](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/main/app/window-manager.ts)          | 窗口加载 `app://renderer` 的链路，非本问题根因                                                 |
| [src/main/app/renderer-protocol.ts](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/main/app/renderer-protocol.ts)    | app:// 协议已有 ACAO 头，且承载既往**白屏修复链路**，动它有回归风险                            |
| media-protocol.ts 的白名单 `isMediaPathAllowed` / Range 解析 `parseRangeHeader` / realpath 防穿越                   | 安全与流媒体核心逻辑，与本修复正交，只加响应头                                                 |
| [EditorPage.tsx](file:///d:/Nikki%20Gallery/WXNN%20XiangCe/src/renderer/pages/EditorPage.tsx) L570-579 批量应用分支 | 已无条件设置 anonymous，主进程补头后自然恢复，改动属多余且有回归风险                           |

## 10. 风险与缓解

| 风险                                                                                    | 缓解                                                                                                                           |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 单侧改动先行（只合主进程或只合渲染端），导致图片从「canvas 报错」恶化为「直接加载失败」 | 子任务 A/B 强制**同一提交**落地；验证阶段两侧测试全绿后才允许提交                                                              |
| `Access-Control-Allow-Origin: *` 扩大安全面                                             | 影响可忽略：media:// 仍受白名单 `isMediaPathAllowed` + realpath 防穿越约束，仅能读已索引媒体；窗口已禁导航，外部网页无法发请求 |
| 既有测试断言了旧 headers 集合，加头后断言失败                                           | 实施时同步更新既有断言（§6 用例①先补 ACAO 断言），test:main 全绿作为子任务 A 的验收门槛                                        |
| dev 与打包产物 origin/协议行为不一致导致「dev 好、包坏」                                | 子任务 C 要求 dev 冒烟 + `npm run build` 后打包产物复核（或 `npm run e2e:smoke`），双 origin 场景都覆盖                        |

## 11. 替代方案评估

| 方案                                                | 评估结论                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| fetch + blob / `createImageBitmap` 重写图片加载链路 | 需要连带调整 CSP，改动面大、涉及所有图片消费点，风险远超本修复收益                                                              |
| 给 media scheme 注册 `corsEnabled` 特权             | 运行时实证表明必需，已采纳：未声明该特权时 `crossOrigin='anonymous'` 的 CORS 请求在网络层即被拒，ACAO 响应头无法生效（见 §4.1） |
| 响应头加 `Vary: Origin`                             | 本应用无跨 origin 共享缓存场景（ACAO 固定为 `*`），加 Vary 属冗余，保持响应头精简                                               |
| 回退 `file://` + `loadFile` 加载页面                | 会重新引入既往已修复的白屏问题，方向性倒退，直接否决                                                                            |

## 12. 验证命令汇总

```powershell
# 主进程单测（含 media-protocol ACAO 断言）
npm run test:main

# 渲染端单测（含 needsAnonymousCors / useImageProcessor 回归）
npm run test:renderer

# 静态检查
npm run lint
npm run typecheck

# 全量
npm test

# dev 冒烟
npm run dev
# 编辑页：预览出图 / 直方图 / 滤镜缩略图 / 滑块实时预览 / 图片水印 / 批量应用；
# 回归：图库缩略图、视频播放（Range）无异常。

# 打包产物复核（如条件允许）
npm run build
npm run e2e:smoke
```
