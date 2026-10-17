# 图片水印无法正常使用修复（2026-10-17）

- 日期：2026-10-17
- 分支 / 基线 HEAD：`feat/gallery-runtime-embed` @ `f9d2343`
- 状态：待执行（本文档先于业务代码入库；执行记录回填 §10）
- 范围已与用户确认：A 放行用户显式选中的单文件、B `saveTemplate` 内层 `success` 契约、C 加载失败可见、D 批量侧 `style` 与 `{date}/{time}` 对齐

## 0. 背景（Context）

用户反馈：图片编辑器「水印」页签切到**图片水印**（logo 模式）后，选完图片水印不出现、
无任何报错；文字水印正常。画廊批量「添加水印」与编辑器批量应用同样受影响。

### 根因（三处叠加，均有行号证据）

1. **取图路径**：`src/renderer/components/editor/WatermarkPanel.tsx:219` 用
   `window.electronAPI.dialog.openFile({filters:[png/jpg/jpeg/webp]})` 取绝对路径存入
   `config.image.path`；预览与导出都经 `src/renderer/hooks/useImageProcessor.ts:107`/`:~261`
   → `processImageData(..., {watermark})` → `src/renderer/utils/imageProcessor.ts:945`
   `applyWatermark` → `:887` `drawImageWatermark` → `:898` `loadImage(imgCfg.path)`；
   `loadImage` → `toMediaUrl` → `src/renderer/utils/file.ts:31` 生成 `media://file?path=...`。
2. **授权缺口**：`src/main/app/media-protocol.ts:112` 调 `isMediaPathAllowed`，其
   `:271-363` 只有四条放行规则（① NikkiSync 资产表 ② 缩略图缓存目录 ③ DB 已索引
   `file_path`/`thumbnail` ④ 已索引 `source_path` 下的媒体扩展名文件），**没有任何一条查
   `pathGuard.isUserPicked`**；且 `:287-288` 在 DB 未就绪时直接 `return false`。
   同时 `src/main/ipc/handlers/dialog-handler.ts:77-80` 的 `dialog:openFile`
   **只在 `properties` 含 `openDirectory` 时**登记 `registerUserPicked`。
   ⇒ 用户从 Downloads / 桌面等**未被扫描索引**的目录挑的 logo 恒 403。
3. **静默吞错**：403 触发 `img.onerror` → `imageProcessor.ts:897-901` 的 `catch { return }`
   把错误吞掉，水印静默消失（预览与导出都丢），面板预览 `<img>`（`WatermarkPanel.tsx:505-506`）
   裂图，用户看不到任何提示。

文字水印从配置字符串直接绘制、不经 `media://`，所以不受影响——与「只有图片水印坏」的现象吻合。

### 已核验的既有事实（决定修法，非推测）

| 事实                                                                                                 | 出处                                                                                            | 对设计的约束                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 渲染层类型**早已**声明 `saveTemplate` 返回 `Promise<{success:boolean; id?:number; message?:string}>` | `src/renderer/vite-env.d.ts:416-419`                                                            | B 必须**补 handler 返回值**，不能删前端 `result.success` 判断                                                                                                             |
| `processorError` 仅在 `!loading && !previewUrl` 时渲染                                               | `src/renderer/pages/EditorPage.tsx:835`                                                         | logo 读失败时预览仍在 → 单靠 `setError` **不可见**，C 必须走 toast                                                                                                        |
| 预览 catch 会先用 `FALLBACK_PREVIEW_MAX_SIZE` 整体重渲染再判失败                                     | `src/renderer/hooks/useImageProcessor.ts:116-141`                                               | 让 `applyWatermark` 直接抛错会让**整张预览消失**（新回归）→ C 采用旁路回调、预览继续                                                                                      |
| `dialog.openFile` 全仓仅 3 个渲染层调用点                                                            | `WatermarkPanel.tsx:219`、`resonance/ImportExportView.tsx:94`、`resonance/WardrobeView.tsx:503` | 后两者挑 JSON，走 `resonance-handler.ts:113` 的 `assertFileReadPath`；本改动经 `registerUserPicked → register` 顺带修好「挑到 userHome 之外的 JSON 读不了」，属正向副作用 |
| `isUserPicked` 判定为「根自身 或 根+`path.sep` 前缀」                                                | `src/main/ipc/validator.ts:230-243`                                                             | 登记一个**文件**路径只放行该文件本身，**不外溢**到同目录兄弟文件                                                                                                          |
| `mediaPathCache` 写入**含否定结果**、TTL 5 分钟                                                      | `media-protocol.ts:343-356`、`:294-300`                                                         | 新规则若放在缓存读取之后，「先判否后登记」会在 5 分钟内持续 403（表现为「过几分钟又好了」的随机故障）                                                                     |
| `media-protocol.test.ts` 的 electron mock **只提供 `protocol`**，且未 mock validator                 | `src/main/app/__tests__/media-protocol.test.ts:24-29`                                           | 新增 `import { pathGuard }` 会连带加载真实 validator（模块加载期调 `app.getPath` 与 `t()`）→ **必须补 validator mock**                                                    |
| 共享 mock 已含 `pathGuard.isUserPicked` / `registerUserPicked` 的 `vi.fn()`                          | `tests/mocks/mock-validator.ts:111-121`                                                         | 新用例用 `vi.mocked(pathGuard.isUserPicked)` 控制，不用真实登记（`userPicked` 是无注销 API 的模块级单例，会跨用例污染）                                                   |
| jsdom project 只含 `src/renderer/**/*.test.tsx` 与 `src/renderer/hooks/**/*.test.ts`                 | `vitest.config.ts:31-46`                                                                        | 新建 `src/renderer/utils/*.test.ts` **必须**首行 `// @vitest-environment jsdom`（`imageProcessor.canvas.test.ts:1` 同款）                                                 |
| sharp 为 `^0.35.5`；`<image href="data:...">` 无 `xmlns:xlink`                                       | `package.json:142`、`watermark-service.ts:262`                                                  | 单元测试全程 mock sharp（`:28-54`），该属性**从未被任何测试覆盖** → 必须靠 §9 手工实测确认（见 §8 E4）                                                                    |
| `tileSpacingX/Y` 正数校验已存在                                                                      | `watermark-service.ts:27-44`                                                                    | 负值曾在主进程造成死循环冻结，本次**不得削弱**该校验                                                                                                                      |

预期结果：图片水印在**编辑器预览、编辑器导出、画廊批量**三条链路均正常生效；任何加载失败
必须对用户可见；批量导出与编辑器预览的样式（拍立得/日期底纹）与 `{date}`/`{time}` 语义一致。

---

## 1. 依赖声明

**零新增 npm 依赖。** 不引入 jimp / canvas 库 / 图像 SDK，全部复用仓库既有能力：

| 复用项                                                   | 出处                                                                | 用途                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------- |
| `pathGuard.registerUserPicked` / `isUserPicked`          | `src/main/ipc/validator.ts:219-243`                                 | A 的授权登记与判定（不新造授权表）          |
| `MEDIA_EXTENSIONS` / `getMimeType`                       | `src/main/utils/media-constants.ts`（`media-protocol.ts:8` 已引）   | A 的扩展名闸门，复用 rule 3/rule 4 同款写法 |
| `selectDirectory` 的登记循环范式                         | `dialog-handler.ts:36-38`（`if (p)` 守卫）                          | openFile 登记照抄该形态                     |
| `useGlobalToast` → `showMessage(msg,'error')`            | `EditorPage.tsx:148`（全页 20+ 处已在用）                           | C 的失败可见通道，不新增 toast 实现         |
| `imageProcessor.canvas.test.ts` 的 jsdom + canvas 桩套路 | `src/renderer/utils/imageProcessor.canvas.test.ts:1,29-59`          | C2 新测试的替身基座                         |
| `tests/mocks/mock-validator.ts`                          | 同文件 `:111-121`                                                   | media-protocol 新用例的 pathGuard 替身      |
| 既有 i18n 键 `toast.imageProcessorLoadFailed`            | `src/renderer/i18n/locales/*.json`（zh-CN/en/ja/zh-TW/fr 均已存在） | C 的错误文案，**本次零新键**                |

## 2. 启动与运行说明

```bash
npm run dev            # electron-vite 开发启动
```

验收路径：进入编辑器 → 右侧「水印」页签 → 顶部切到「图片水印」→「选择图片」→ 选一个
**未被扫描索引**的目录（如 `Downloads`）里的 png。判定基准见 §9。

零新增环境变量、零新增配置项、零数据库迁移（`watermark_templates` 表与 SQL 均不改）。

## 3. 参数校验口径

- **不改任何 zod schema 的宽松度**。`watermark:apply` 的 `z.record(z.string(), z.unknown())`
  （`handlers/watermark.ts:29`）保持原样——收紧它属批量链路重构，超出本次范围（相关缺口见 §8 E3）。
- A 的新授权规则**必须**带扩展名闸门：`MEDIA_EXTENSIONS.has(path.extname(p).toLowerCase())`。
  用户挑中的 `.txt` / `.json` / 无扩展名文件**绝不**因 `isUserPicked` 命中而被 `media://` 送出。
  登记侧（dialog-handler）**不**按扩展名过滤——保持与 `selectDirectory` 同一 doctrine
  「显式选择即授权」，把收窄只放在展示面。
- A 的登记循环**必须**覆盖 `multiSelections` 全量返回路径（`dialog-handler.ts:80` 今天只返回
  `filePaths[0]`，返回值形状**不改**，属破坏性契约变更）。
- D 的 `{date}`/`{time}` 展开顺序为**先展开、再 `escapeXml`**，转义不可丢（`<`/`&` 用例 S5）。
- C 的回调为**可选**参数：不传即维持旧行为，`imageProcessor.canvas.test.ts` 全 7 例不破。

## 4. 错误处理口径

- 不新增 `throw` 路径（C 明确走旁路回调，避免 §0 表格里的预览整块消失回归）。
- 主进程侧错误继续经 `wrapHandler` → `AppError` 家族，不在 handler 手写 `try/catch + return {success:false}`。
- `WatermarkPanel.tsx:189-194` 的 `loadTemplates().then()` 缺 `.catch()`（DB 未就绪时的未处理拒绝）
  在 N3 一并补上，走 `console.error` + 既有 i18n 键提示。
- 渲染层新增的内联提示颜色走 `var(--danger)`，**禁止**硬编码色值（`.qoder/rules/project-conventions.md` §3）。

---

## 5. 子任务分解（TDD 红绿，每节点一次提交）

> 节点顺序理由：A 解除主症状 → C 立刻让「静默失败」变可见（后续节点再出问题不靠猜）
> → B 独立契约修复 → D 最大改动收尾。

### N1 = A：放行用户显式选中的媒体文件

**涉及文件**

1. `src/main/ipc/handlers/dialog-handler.ts`（**受保护路径**，同批加
   `// @core-change: 图片水印需放行用户在对话框显式选中的单文件`）
   - 输入：`dialog:openFile` 的 `{properties?, filters?}`；输出：`filePaths[0] ?? null`（**不变**）
   - 把 `:77-80` 的条件登记改为**对所有返回路径**循环 `pathGuard.registerUserPicked(p)`
     （照抄 `:36-38` 的 `if (p)` 守卫写法）；取消分支 `:75` 不动。
   - 改写 `:76` 注释：显式选择即授权（与 `selectDirectory` 同 doctrine）；真正的展示放行
     由 `media://` 侧媒体扩展名闸门收窄。
2. `src/main/app/media-protocol.ts`（**非**受保护路径，不加授权注释）
   - `import { pathGuard } from '../ipc/validator'`
   - `isMediaPathAllowed` 内新增**规则 0**：位于 rule 4（`:280-285`）之后、
     `const db = ctx.dbManager.getDatabase()`（`:287`）**之前**：
     `MEDIA_EXTENSIONS.has(ext) && pathGuard.isUserPicked(normalizedRequest)` → `return true`，
     **刻意不写 `mediaPathCache`**。
   - 注释写明三条理由：① 放 db 之前 → DB 未就绪时用户挑的 logo 仍可显示（与 rule 4
     「两份库彼此独立」的取舍同构，见 `:275-279`）；② 不入缓存、也不调
     `invalidateMediaPathCache` → 避免「先判否后登记」被 5 分钟否定缓存压住；纯 Set 查找零 IO，
     不需要缓存提速（写清「后人勿顺手加缓存，否则退回随机 403」）；③ 扩展名闸门 → 非媒体文件
     绝不因 userPicked 被 `media://` 送出。
   - 同步更新函数上方 `:256-270` 的规则清单（四条 → 含规则 0）。

**输入 / 输出契约**：`media://file?path=<绝对路径>` 对「用户本次会话显式挑中且扩展名属媒体白名单」
的文件由 403 → 200；其余路径判定结果与改动前逐字一致。

**红灯测试（改码前必须真实失败）**

`src/main/ipc/handlers/dialog-handler.test.ts`

| 用例                                                                                                           | 断言                                                                                                          | 修复前                                          |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **改写** `:109-119` → `dialog:openFile 文件模式同样登记 userPicked（图片水印授权）`                            | openDirectory 保持 `toHaveBeenCalledWith('/picked-dir')`；文件模式改判 `toHaveBeenCalledWith('/picked-file')` | 旧断言 `not.toHaveBeenCalled()` 锁死 buggy 行为 |
| 新增 `未显式传 properties（默认 openFile）也登记 userPicked`（用 `[undefined]` 调用＝WatermarkPanel 真实形态） | 登记发生                                                                                                      | **必红**                                        |
| 新增 `取消时不登记 userPicked`                                                                                 | `not.toHaveBeenCalled()`                                                                                      | 即绿（**守卫意图迁移至此，不删除**）            |

`src/main/app/__tests__/media-protocol.test.ts`（文件头补
`vi.mock('../../ipc/validator', async () => await import('../../../tests/mocks/mock-validator'))`，
`beforeEach` 补 `vi.mocked(pathGuard.isUserPicked).mockReset()`）

| 用例    | 场景                                                 | 期望    | 修复前                          |
| ------- | ---------------------------------------------------- | ------- | ------------------------------- |
| A1      | db 全不命中 + `isUserPicked` 命中 + `.png`           | `true`  | **必红**                        |
| A2      | `makeAppCtx({db:null})` + 命中 + `.png`              | `true`  | **必红**                        |
| A3 边界 | 命中但扩展名 `.txt` / `.json`                        | `false` | 绿（闸门护栏）                  |
| A4 边界 | 同目录兄弟文件未登记                                 | `false` | 绿（不外溢到目录级）            |
| A5 缓存 | 先请求未登记路径得 403，登记后**立即**再请求同一 URL | 200     | **必红**（锁死 5 分钟随机 403） |
| A6 边界 | Windows 大小写 / 正反斜杠归一后命中                  | `true`  | **必红**                        |

**绿灯验收**：A1–A6 + dialog 三条全绿；既有用例 4（`:176` 白名单外 403）、5（`:190` db=null 403）
不破——用例 5 补一行注释说明「userPicked 未命中所以仍 403」。

**子集命令**：`npx vitest run src/main/ipc/handlers/dialog-handler.test.ts src/main/app/__tests__/media-protocol.test.ts`
→ `npm run test:main`

### N2 = C：水印加载失败必须可见

**涉及文件**

1. `src/renderer/utils/imageProcessor.ts`：`ProcessOptions`（`:190-193`）加可选
   `onWatermarkImageError?: (message: string) => void`，经 `processImageData`（`:719-721`）
   透传 → `applyWatermark` → `drawImageWatermark`；`:897-901` 的 `catch { return }` 改为
   `catch (err) { onWatermarkImageError?.(err instanceof Error ? err.message : String(err)); return }`
   （**行为仍是跳过水印继续合成**；`loadImage` 抛的 message 已是 `toast.imageProcessorLoadFailed` 译文）。
2. `src/renderer/hooks/useImageProcessor.ts`：新增 `watermarkError` 状态，三处 `processImageData`
   （`:107`/`:120`/`:~261`）传回调；水印配置变更时清空；加入 `UseImageProcessorReturn` 类型与返回值。
3. `src/renderer/pages/EditorPage.tsx`：`useEffect` 订阅 `watermarkError` → `showMessage(watermarkError,'error')`，
   `useRef` 去重（防防抖重渲染刷屏）。
4. `src/renderer/components/editor/WatermarkPanel.tsx:505-509`：预览 `<img>` 加 `onError` →
   面板内联提示 + 引导「重新选择图片」，颜色 `var(--danger)`。

**红灯测试**：新建 `src/renderer/utils/imageProcessor.watermark.test.ts`
（首行 `// @vitest-environment jsdom`；canvas 桩补齐 `save/restore/translate/rotate/fillRect/fillText/measureText/
fillStyle/font/globalAlpha/globalCompositeOperation`，`measureText` 返 `{width:100}`；
`Image` 用 `vi.spyOn(global,'Image')` + `dispatchEvent(new Event('error'))`，桩法参照
`useImageProcessor.test.ts:60-72` 的「必须可 new」教训）

| 用例    | 断言                                                                                   | 修复前                              |
| ------- | -------------------------------------------------------------------------------------- | ----------------------------------- |
| C1      | logo 失败 ⇒ `onWatermarkImageError` 收到含 `src` 的消息，且仍 **resolve 出 ImageData** | **必红**（参数不存在且静默 return） |
| C2 护栏 | 加载成功 ⇒ 不回调且 `drawImage` 被调                                                   | 防「永远报错」                      |
| C3 边界 | 文字水印 + 坏 logo 共存 ⇒ `fillText` 仍被调                                            | 锁死「一个坏 logo 拖垮整条水印」    |
| C4      | `useImageProcessor.test.ts` 新增：透传回调 ⇒ `watermarkError` 暴露                     | **必红**                            |

**绿灯验收**：C1–C4 绿；`imageProcessor.canvas.test.ts` 全 7 例、`useImageProcessor.test.ts` 既有用例不破。
**子集命令**：`npx vitest run src/renderer/utils/imageProcessor.watermark.test.ts src/renderer/utils/imageProcessor.canvas.test.ts src/renderer/hooks/useImageProcessor.test.ts` → `npm run test:renderer`

### N3 = B：模板保存内层 `success` 契约 + 列表兜底

**涉及文件**

1. `src/main/ipc/handlers/watermark.ts:153`（**受保护**，
   `// @core-change: watermark:saveTemplate 按 IPC_CONTRACT §1.2 补内层 success 字段`）
   → `return { success: true, id: Number(result.lastInsertRowid) }`
2. `src/main/preload/api/watermark.ts:10`（**受保护**，同主题注释）
   → `call<{ success: true; id: number }>`（对齐 `vite-env.d.ts:419`）。
   **不增删 `electronAPI` 键** → `preload.test.ts` 的 34 键清单不受影响。
3. `WatermarkPanel.tsx:189-194`：`loadTemplates()` 补 `.catch()`。
4. `docs/IPC_CONTRACT.md`：新增「水印域」章节（当前**完全没有** watermark 条目），逐项写
   `watermark:apply` / `saveTemplate`（返 `{success:true,id}`，前端判 `result.success`）/
   `loadTemplates`（裸数组，DB 未就绪为 `[]`）/ `deleteTemplate`（返 `{deleted:true}`，前端
   try/catch 不判 success；`vite-env.d.ts:421` 声明与实现不符，按 §4 检查清单登记为待办）。

**红灯测试**

| 用例                                                                           | 文件                                                          | 断言                                                                                            | 修复前   |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------- |
| `saveTemplate 返回内层 success`                                                | `src/main/ipc/handlers/watermark.test.ts`                     | `result.data.success===true && result.data.id===10`；另加 `simulateCall` 解包后仍拿到 `success` | **必红** |
| B1 保存成功 ⇒ 输入框清空 + 列表出现新项（mock 形状钉成 `{success:true,id:1}`） | 新建 `src/renderer/components/editor/WatermarkPanel.test.tsx` | 同上                                                                                            | **必红** |
| B2 `loadTemplates` reject ⇒ 无未处理拒绝且有可见反馈                           | 同上                                                          | 同上                                                                                            | **必红** |

**绿灯验收**：三条绿；既有 `watermark.test.ts:142`（用 `toBe` 非 `toEqual`）不破；
`useBatchOperations.test.ts`（判 `watermark:apply` 的 `result.success`，本来就有）不破。
**子集命令**：`npx vitest run src/main/ipc/handlers/watermark.test.ts src/renderer/components/editor/WatermarkPanel.test.tsx` → `npm run test:main` + `npm run test:renderer`

### N4 = D：批量侧与渲染层对齐

**涉及文件**

1. 新建 `src/shared/utils/watermark-text.ts`：`export function formatWatermarkText(content: string, now: Date = new Date()): string`，
   逐字搬 `imageProcessor.ts:820-825`（`YYYY.MM.DD` / `HH:mm`、`/\{date\}/gi`、`/\{time\}/gi`）。
   只用 `Date`，满足 `shared/**` 禁 Node/Electron 依赖；JSDoc 声明「主/渲染共用，禁止第三份副本」。
   > 为什么不各写一份：`{date}` 展开已在渲染层（`:820`）、主进程批量（`watermark-service.ts:211`）
   > 与 `file-service.ts:32`（`YYYYMMDD`，另一套格式）三处漂移，**漂移正是本缺陷家族的成因**。
2. `imageProcessor.ts:820-825` 改为委托共享实现，**对外仍 `export function formatWatermarkText`**
   → `imageProcessor.test.ts` 既有用例一字不动即为「迁移无损」证据。
3. `src/main/types/file.ts:42-63`（非保护）加 `style?: WatermarkStyle`，
   `import type { WatermarkStyle } from '../../shared/types/watermark'`（该文件 `:34` 是权威定义）。
4. `src/main/services/watermark-service.ts`（**受保护**，
   `// @core-change: 批量水印补齐 polaroid/date-label 底纹与 {date}/{time} 展开`）的
   `buildTextWatermarkSvg`（`:183-225`）：
   - `:211` 先 `formatWatermarkText` 展开再 `escapeXml`；
   - `style==='polaroid'` → 底部白带 `<rect>`（`frameRatio 0.16`、`Math.max(1, round(ch*0.16))`，
     对齐 `imageProcessor.ts:982-986`）+ 框内单次文字（字号 `min(size, frameHeight*0.4)`，对齐 `:989-993`）；
   - `style==='date-label'` → 每个 `<text>` **前置**圆角暗底 `<rect>`（`pad=size*0.3`、`rx=size*0.25`、
     `rgba(0,0,0,0.55)`，对齐 `:861-868`，先 rect 后 text 保画家序）；
   - 硬编码 `#ffffff` / `rgba(0,0,0,0.55)` 处加「SVG 内部色，非 UI 主题色」注释（§3 允许例外）。
5. 同批一行：`drawPolaroidFrame`（`:993`）改用展开后文本，消除渲染层自身的 polaroid + `{date}` 字面量瑕疵。

**红灯测试**

| 用例                                           | 文件                                           | 断言                                                                            | 修复前                                     |
| ---------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------ |
| 正常 / 大小写 / 多占位 / 空串 / 无占位原样返回 | 新建 `src/shared/utils/watermark-text.test.ts` | 见 §4 口径                                                                      | 新文件本身即绿（覆盖率阈值对新文件的门槛） |
| S1                                             | `src/main/services/watermark-service.test.ts`  | `content='{date}'` ⇒ SVG 不含字面 `{date}`、含 `YYYY.MM.DD`                     | **必红**                                   |
| S2                                             | 同上                                           | `style='polaroid'` ⇒ 含底部白带 rect（y≈ch·0.84、h≈ch·0.16、`#ffffff`）         | **必红**                                   |
| S3                                             | 同上                                           | `style='date-label'` ⇒ 文字前存在 `rx` 圆角暗底 rect                            | **必红**                                   |
| S4 护栏                                        | 同上                                           | `style` 缺省 / `signature` / `copyright` ⇒ **不得**出现底纹元素                 | 防新分支默认生效                           |
| S5 边界                                        | 同上                                           | 展开后仍做 XML 转义（含 `<`、`&`）                                              | **必红**                                   |
| 类型层                                         | 同上                                           | `makeBaseConfig` 传 `style:'polaroid'` 在未加 `types/file.ts` 字段前应报 TS2353 | 「编译即失败」证据                         |

**绿灯验收**：S1–S5 + 共享层用例绿；`watermark-service.test.ts` 既有 40+ 例（`:523` 转义、
`:542`/`:556` tile 计数、`:566` 尺寸）不破；`imageProcessor.test.ts` 的 `formatWatermarkText` 组不破。
**子集命令**：`npx vitest run src/shared/utils/watermark-text.test.ts src/main/services/watermark-service.test.ts src/renderer/utils/imageProcessor.test.ts` → `npm run test:main`

---

## 6. 受保护路径与 `@core-change` 归属

结论：**只需 4 个文件**（均在保护清单）——
`src/main/ipc/handlers/dialog-handler.ts`、`src/main/ipc/handlers/watermark.ts`、
`src/main/preload/api/watermark.ts`、`src/main/services/watermark-service.ts`。

`src/main/app/media-protocol.ts`、`src/main/types/file.ts`、`src/shared/utils/**`、
`src/renderer/**` **不在**清单内（`shared/types` ≠ `shared/errors`），**不加**授权注释。
测试文件与 `handlers/_*` 豁免。`scripts/__tests__/core-path-gate.test.ts` 只守「清单一致性 +
不得残留批量占位文案」，本次不改 `PROTECTED_GLOBS`，不受影响。

## 7. 全量闸门（一票否决）

```bash
npm run test:main
npm run test:renderer
npm test                 # 仓库真实全量
npm run typecheck
npm run lint
npm run i18n:guard
npx tsx scripts/core-path-gate.ts
npm run docs:links
npm run verify
```

本次目标**零新增 i18n 键**（C 复用 `toast.imageProcessorLoadFailed`，N3 复用既有键）；
若实现中被迫新增，则 12 个 locale 必须同步并让 `i18n:guard` 通过。

## 8. 本次不做（已知问题登记）

- **E1 重启后模板 logo 再次失效**：`PathGuard.userPicked` 是进程内 `Set`（`validator.ts:174`），
  `refreshPathGuardRoots`（`src/main/app/media-update.ts`）只从 DB 重建 `roots`，**不含**用户挑过的
  logo。A 修好后「存模板 → 下次启动套用 → 水印又没了」仍会发生。建议根治方向：选图时复制一份进
  缩略图缓存目录（`isMediaPathAllowed` 规则 1 天然覆盖受控目录、跨重启稳定），属新增文件流，本次不做；
  由 C 保证失败可见 + 面板引导重选。
  **明确否决**「把 `watermark_templates` 里的路径当授权表」——该表渲染层可自由写入，等于新开一条
  `media://` 绕过面。
- **E3 批量侧 logo 零守卫**：`watermark-service.ts:235-237` 对 `config.image.path` 直接 `fsp.readFile`，
  不经 `assertMediaAccessPath`，渲染层可把任意绝对路径的图片字节合成进导出文件。与本次缺陷无因果，
  属既有安全面缺口。最小加固：`handlers/watermark.ts:33-35` 追加
  `if (config.image?.path) assertMediaAccessPath(ctx, config.image.path)`。需单独授权，建议紧随本次独立立项。
- **E4 sharp/resvg 对 `<image href>` 的支持性**：`watermark-service.ts:262` 只写 SVG2 的 `href`，
  无 `xmlns:xlink` + `xlink:href`，且单测全程 mock sharp → 无任何自动化覆盖。**本轮已实测排除**
  （见 §10.3）：sharp 0.35.5 / libvips 8.18.7 能渲染仅 `href` 的 `<image>`，与补 `xlink:href`
  的产物字节完全一致，**无需改代码**。
- **polaroid 双绘**：`applyWatermark`（`:957-966`）在 polaroid 下把文字画两遍（框内居中 + 按 position）。
  合并会改变既有预览观感、超出「水印可用性」范畴 → 仅注释登记为已知差异。
- **E5 批量侧静默跳过**：`watermark-service.ts:235` 的 `pathExists` 失败与 `:102-104` 的
  `overlays.length===0 → continue` 是批量侧的「静默丢水印 + processed 不计数」，与 C 同类。
  最小可见化（末尾消息区分「因 logo 缺失跳过 N 个」）不扩成本批重构，暂缓。
- **`useWatermark.ts` 的 opacity 单位漂移**（`:20/:61` 默认 `0.7`，而面板/canvas 用 0-100）：
  该 hook 无消费方，`useWatermark.test.ts:111` 锁死了 0.7，动它必红且属越界重构 → 仅加 TODO 注释登记技术债。
- 11 个非中文 locale 的 `watermark.*` 空字符串键（i18next 默认把空串当有效值 ⇒ 非中文界面标签空白）、
  `{filename}` 占位符两侧均未实现、`shared/types/watermark.ts` 与 `imageProcessor.ts` 的
  `WatermarkApplyResult` 双份漂移。

## 9. 手工端到端验收（唯一能证明用户症状消失的证据）

1. 编辑器 → 图片水印 → 选**未被索引**目录（Downloads）里的 logo ⇒ 预览立刻出现水印（A）。
2. 先对一个被拒路径请求过一次，再改选正解 ⇒ **立刻**生效、无 5 分钟延迟（A + 缓存设计）。
3. 把 logo 文件删掉 ⇒ toast「加载图片失败: …」+ 面板内联提示，且滤镜预览仍在（C）。
4. 保存模板 ⇒ 输入框清空、列表出现新项（B）。
5. 勾 date-label / polaroid + `{date}` ⇒ 编辑器批量应用（渲染层链路）与画廊「添加水印」
   （主进程链路）产物观感一致（A + D）。
6. **画廊批量含 logo 的实测**（真走 sharp）⇒ 导出图确有图片水印（判定 E4）。
7. 重启应用 → 套用旧模板：logo 在已扫描目录内应仍显示；在未索引目录时应报**可见错误**而非静默（E1）。

透明度的精确数值、混合模式的视觉差异不做像素级断言，只验「有/无水印 + 有/无错误提示」。

## 10. 执行记录

以下读数全部来自本轮实跑（非引用历史基线）。

### 10.1 各节点红灯 → 绿灯

| 节点              | 修复前红灯（原始判定）                                                                                                                                    | 修复后                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| N1 dialog         | `Tests 3 failed \| 13 passed (16)`——文件模式登记、未传 properties、multiSelections 三条全红（`expected [] to deeply equal ['/a.png','/b.png','/c.png']`） | `16 passed (16)`                                                |
| N1 media-protocol | `Tests 4 failed \| 47 passed (51)`——38/39/42/43 红，40/41 作为边界护栏即绿；既有 45 例在新 validator mock 下**无一破裂**                                  | `52 passed (52)`                                                |
| N2                | `Tests 2 failed \| 1 passed (3)`——C1/C3 红（`expected "vi.fn()" to be called 1 times, but got 0 times`），C2 护栏即绿                                     | `42 passed (42)`（含 canvas 7 例、imageProcessor 与 hook 全套） |
| N3 handler        | `Tests 1 failed \| 10 passed (11)`——`AssertionError: expected undefined to be true`                                                                       | `11 passed`                                                     |
| N3 面板           | B1/B3 随改随绿；**B2 经反向验证**：临时把 `.catch` 换成空吞后 `Tests 1 failed \| 2 passed (3)`，确认该用例对缺陷敏感，随后恢复实现                        | `14 passed (14)`                                                |
| N4                | `Tests 4 failed \| 50 passed (54)`——S1/S2/S3/S4 红                                                                                                        | `135 passed (135)`（含 shared 6 例、批量 54 例、渲染层 75 例）  |

三处与计划不符、据实修正的地方：

1. **计划的「N4 类型层红灯」不成立**：`src/main/tsconfig.json:26` 的 `exclude: ["**/*.test.ts"]`
   使主进程测试文件不进 `tsc -b`，传 `style:'polaroid'` 不会报 TS2353。该节点的闸门实为运行时断言。
2. **S4 初版断言写错**：查 `#ffffff` 与默认 `text.color: '#ffffff'` 撞色，导致它在修复前就红。
   已改为按 `<rect` 元素结构判定，S4 恢复其「护栏」本意（修复前绿、防新分支泄漏）。
   S5 同理：转义本来就正确，它是顺序护栏而非红灯。
3. **N2/N3 的 UI 侧用例（C4、B1/B3）是在改码后补写的**，不是先红后绿；它们钉的是契约形状。
   真正的缺陷敏感红灯为 N1 的 7 条、N2 的 C1/C3、N3 的 handler 1 条、N4 的 S1–S3。

### 10.2 全量闸门（本轮实测）

| 闸门                                | 结果                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `npm test`（仓库真实全量）          | `Test Files 412 passed (412)`，`Tests 6361 passed \| 2 skipped (6363)`                         |
| `npm run test:main`                 | `206 passed (206)`，`3822 passed \| 2 skipped`                                                 |
| `npm run test:renderer`             | `189 passed (189)`，`2231 passed`                                                              |
| `npm run test:coverage`             | 退出码 0（阈值门控通过）；新增 `shared/utils/watermark-text.ts` 四项均 100%                    |
| `npm run typecheck`                 | 通过（`tsc -b` + `tsc -p tsconfig.scripts.json`）                                              |
| `npm run lint`                      | `0 errors`；11 条 `unicode-bom` **warning** 全部落在 DEBT-030 已登记的存量测试文件，非本轮引入 |
| `npm run i18n:guard`                | 通过（零新增键）                                                                               |
| `npx tsx scripts/core-path-gate.ts` | `✓ 通过（4 个受保护文件）`，与 §6 预估一致                                                     |
| `npm run docs:links`                | `✅ 无死引用`                                                                                  |
| `npm run verify`                    | `总计: 5 项, 0 失败` → `✓ 全部通过 — 可以安全提交`                                             |

首跑 `npm test` 曾出现 2 处失败，均已定位、非掩盖：

- `scripts/__tests__/check-md-links.test.ts` 死引用 1 处——原因是新计划文档尚未进 `git ls-files`
  索引（该闸门以 tracked 集合判存在，`fs.existsSync` 刻意不用）。`git add` 文档后转绿。
- `src/main/thumbnail/generator.limiter.test.ts` 一例超时——**与本轮改动无关的并发时序 flaky**：
  单跑 `1 passed`，第二轮全量 `412 passed (412)` 未复现；`src/main/thumbnail/` 未被本次任何改动触及。

`verify` 另报 3 个源文件无同名匹配套件（`src/main/preload/api/watermark.ts`、
`src/main/types/file.ts`、`src/renderer/pages/EditorPage.tsx`）——均为既有结构缺口，非本轮新增文件。

### 10.3 E4（sharp 渲染 `href`）实测结论

单元测试全程 mock sharp，此环无自动化覆盖，故用一次性脚本以**真实 sharp** 光栅化后取样
（脚本已删除，未入库）：

```
sharp 0.35.5 / libvips 8.18.7
仅 href      : 与基线不同，差异 1600 像素，包围盒 5,5 → 44,44（40×40 logo 的预期落点）
href+xlink   : 与「仅 href」产物 md5 完全相同
polaroid rect: 差异包围盒 0,101 → 199,119（= H - round(H*0.16)，与实现公式一致），带内取样 [255,255,255]
纯 <text>    : 差异 1234 像素，包围盒 29,50 → 168,68（文字落点）
```

⇒ `watermark-service.ts:262` 的 SVG2 `href` **确实被渲染**，无需补 `xmlns:xlink`；
批量导出的底框/文字路径也经真实光栅化确认出像素。

### 10.4 未做到的部分（如实标注）

- **§9 的 GUI 手工冒烟未执行**：我没有驱动 Electron 窗口的能力，`npm run dev` 只会在你机器上
  弹出一个我无法检视的窗口。§9 七步需要你在本机跑一遍；我能证明的是机制层——
  A5 用例直接调真实 `protocol.handle` 回调断言 403→200，10.3 用真实 sharp 证明像素落图。
- **视觉精细度未做像素级验收**：透明度、混合模式、date-label 底板与文字的实际贴合度只验到
  「有图层、位置对、能出像素」，未验「好看」。
- **C 的可见提示在非中文界面会是空串**：`toast.imageProcessorLoadFailed` 在 12 个 locale 里
  只有 `zh-CN` 有值，其余 11 个为空字符串，而 i18next 默认把空串当有效返回。
  即失败提示对英文等界面等于没提示。属 §8 已登记的既有 i18n 漂移的连带后果，
  补全 11 语种文案超出本次范围（会让「零新增键」变成「补 11 个已有键的值」），建议紧随其后立项。
  → **已由 §11 N7 落地**（用户确认纳入本轮）。
- 改动**尚未提交**：已 `git add` 新增文件（为让 tracked 集合闸门通过），未做 commit，等你确认。

---

## 11. 二次审查与修复（2026-10-17 第二轮，提交前独立复核）

- 基线：本文档 §10 记录的那批改动，已 `git add` 未 commit。
- 做法：对本批 21 个文件做独立代码审查（先核机制、再逐处读码定性），把确认成立的缺陷按 §5 的
  红-绿流程修掉。**下列每个节点的红灯读数均为本轮实跑，非引用 §10 的历史数字。**
- 结论：审查确认原批的**机制层是对的**（`pathGuard` 是 `validator.ts` 的模块级单例，dialog 写与
  media-protocol 读同一对象；无循环导入；仓内无 import-boundary 规则；规则 0 判在取 DB 之前且不写
  `mediaPathCache` 的三条理由成立；`--danger` 定义于 `globals.css`；`saveTemplate` 内层 `success`
  与 `vite-env.d.ts` 契约一致；polaroid 的提前 `return` 不跳过 logo 合成），但有 7 处缺陷。

### 11.1 节点与红绿读数

| 节点 | 缺陷                                                                                                                                                                                                                                         | 涉及文件                                                                                                                                                                  | 红灯（修复前实跑）                                                                                                             | 绿灯（修复后实跑）                                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| R1   | `buildTextWatermarkSvg` 的 `if (!text?.content) return null` 判在 polaroid 分支**之前**，而 `applyBatch` 的 `overlays.length === 0 → continue` → **拍立得 + 空文字时批量导出连文件都不写**，预览却有白框                                     | `src/main/services/watermark-service.ts` · 同名 test                                                                                                                      | 新增 S6 ⇒ `1 failed \| 54 passed (55)`（`expected +0 to be 1`）                                                                | `55 passed (55)`；补 S6b 后同文件全绿                                                            |
| R2   | polaroid 预览**双绘**：`applyWatermark` 先由 `drawPolaroidFrame` 在白带内写字，再无条件走 `drawTextWatermark`；面板预设是 `bottomCenter` + `margin: 0`，第二份正落在白带内 → 预览两串字重叠，导出只有一份                                    | `src/renderer/utils/imageProcessor.ts` · `imageProcessor.watermark.test.ts`                                                                                               | 新增 P1 ⇒ `1 failed \| 3 passed (4)`（`fillText` 调用 2 次，期望 1 次）                                                        | 4 文件子集 `118 passed (118)`                                                                    |
| R3   | 导出 SVG 与画布两处口径差：`date-label` 仍带下划线（画布 `:876` 抑制）、`font` 空值不回落 `sans-serif`（画布 `:844/:1003` 回落）                                                                                                             | `src/main/services/watermark-service.ts` · 同名 test                                                                                                                      | 新增 S7/S8 ⇒ `2 failed \| 55 passed (57)`                                                                                      | `57 passed (57)`                                                                                 |
| R4   | `userPicked` 写侧登记**对话框原形态**、读侧查 **realpath 之后**的形态 ⇒ 祖先含 junction / 符号链接 / SUBST / 映射盘 / OneDrive 重定向时两侧永不相交，用户刚挑好的 logo 仍恒 403                                                              | `src/main/ipc/validator.ts`（非受保护）· `validator.test.ts`                                                                                                              | 新增 D3 ⇒ `1 failed \| 16 passed (17)`；D4（realpath 抛错 fail-open）为护栏、修复前即绿                                        | 6 文件子集 `143 passed (143)`                                                                    |
| R5   | 本批把 `dialog:openFile` 的**单个文件**纳入 `userPicked`，而 `scanner:start` / `settings:set` 的短路判据只看 `isUserPicked` ⇒ 挑中的 logo 能冒充「显式授权的扫描根」，绕过校验并被持久化                                                     | `validator.ts` · `handlers/dialog-handler.ts` · `handlers/scanner-handler.ts` · `handlers/settings-handler.ts`（三者受保护）· `tests/mocks/mock-validator.ts` · 四个 test | 新增 B5 / C3 / D6 ⇒ `3 failed \| 53 passed (56)`                                                                               | 6 文件子集 `143 passed (143)`（B1/B3/C1 由 `isUserPicked` 迁至 `isUserPickedDir`，守卫意图保留） |
| R6   | §8 E3：`config.image.path` 不经任何路径校验，service 直接 `fsp.readFile` ⇒ 渲染进程可指任意绝对路径把私人图片字节合成进导出文件                                                                                                              | `handlers/watermark.ts`（受保护）· `watermark.test.ts` · `docs/IPC_CONTRACT.md` §10                                                                                       | 新增 W1 ⇒ `1 failed \| 12 passed (13)`（守卫从未被调用）                                                                       | `13 passed (13)`（W2 为「无 logo 不做多余校验」护栏，修复前即绿）                                |
| R7   | `toast.imageProcessorLoadFailed` 的**值**在 11 个非中文包是空串，而 i18next 把空串当有效译文（`returnEmptyString` 默认 true ⇒ `fallbackLng` 不触发）⇒ 本批新增的失败提示在非中文界面渲染成空白，`i18n:guard` / `i18n:check` 只看键、一路绿灯 | 11 个 `src/renderer/i18n/locales/*.json` · 新增 `locales/image-watermark-toast-keys.test.ts`                                                                              | 新增 I1/I2 ⇒ `2 failed \| 1 passed (3)`（`zh-TW.json … 不应为空串`）；I3（zh-CN 基准串未漂移，`preview:check` 依赖）修复前即绿 | locales 目录 5 文件 `29 passed (29)`；`npm run i18n:guard`、`npm run i18n:check` 通过            |

### 11.2 审查中的两处自我更正（据实记录）

1. **「`escapeXml` 把 `&` 转义两次」是误报**：该函数 `&` 替换在**首位**，后续 `<`/`>` 引入的 `&`
   不再被二次转义；既有 S5 用例（断言 `&amp;x` 与 `&lt;b&gt;`）即为其正确性的现存证据。
   原打算登记的技术债不成立，未写入。
2. **`validator.ts` 此前并不 import `fs`**：R4 需要新增该依赖。判定侧
   `media-protocol.ts` 的 `resolveRealPath` 用的是**非 native** 的 `fs.promises.realpath`，
   故登记侧同用 `fs.realpathSync`（非 `.native`）保证两侧串逐字相等。

### 11.3 两处设计取舍（勿后来误改）

- **R4 只进 `userPicked`、不进 `roots`，且物理拼写落敏感目录时不登记**：`isUserPicked` 在
  `scanner:start` / `settings:set` / `assertMediaAccessPath` 处是**跳过黑名单**的短路，
  给它一个直连 `~\.aws` / `Program Files` 的物理拼写等于开新洞；代价是「真身在敏感目录里的
  logo 仍 403」，属有意取舍。`roots` 不加物理拼写则因其余消费方一律按原路径 resolve 后比对
  `roots`，塞进去会波及约 40 个 handler 的 `assertFileReadPath` 判定而无缺陷需要它。
  连带地，本轮**不**修「已索引媒体目录本身位于 junction 上」（`media-read-guard.ts` 早已登记该残留面）。
- **R6 的 handler 用外层闭包 `ctx`，不接 `wrapHandler` 的第二参数**：`tests/mocks/mock-validator.ts`
  的 `wrapHandler` 以 `handler(unwrap(args))` 单参调用，加参数会把 `ctx` 遮蔽成 `undefined`
  （本轮实现时真实踩过，表现为 4 条既有 apply 用例 `Cannot read properties of undefined
(reading 'watermarkService')`），与本文件 `:110/:116` 既有用法一致。

### 11.4 §8 已知项的状态变更

- **E3 批量侧 logo 零守卫**：已由 R6 关闭（`assertMediaAccessPath` + IPC_CONTRACT §10 改写）。
- **「polaroid 双绘」**：已由 R2 关闭——用户确认接受「改变既有预览观感」以换预览与导出同源。
- **E1 重启后模板 logo 失效**：仍不做（把 `watermark_templates` 的路径当授权表等于新开
  `media://` 绕过面，§8 的否决继续成立）。R6 落地后的连带表现：重启后套用未索引目录 logo 的
  旧模板，批量侧以 `IPC_PATH_FORBIDDEN` 显式失败、需重选图片，与预览侧 403 同口径。
- **E5 批量侧静默跳过**：部分关闭——R1 让 polaroid 空文字不再跳过整文件；`pathExists` 失败
  与 logo 缺失的「跳过 N 个」可见化仍未做。
- 新登记：`toast.imageProcessorCanvasFailed`（`imageProcessor.ts:965` 消费）在同 11 个包里也是
  空串，与 R7 同族但不在本批功能面上，留待 `toast` 命名空间一次性收口（新增的
  `image-watermark-toast-keys.test.ts` 的循环可直接加键）。

### 11.5 全量闸门与提交（本轮实测）

| 闸门                                        | 结果                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`（仓库真实全量）                  | `Test Files 413 passed (413)`，`Tests 6377 passed \| 2 skipped (6379)`（本轮起点 412 / 6361 ⇒ +1 文件 / +16 例）                                                                                                                                                           |
| `npm run typecheck`                         | 通过（`tsc -b` + `tsc -p tsconfig.scripts.json`）                                                                                                                                                                                                                          |
| `npm run lint`                              | `0 errors`；11 条 `unicode-bom` warning 仍是 DEBT-030 已登记的存量测试文件，**未新增**（本轮新建的 locale 测试为 UTF-8 无 BOM）                                                                                                                                            |
| `npm run i18n:guard` / `npm run i18n:check` | 通过（键零新增，12 包 3938 键对齐）                                                                                                                                                                                                                                        |
| `npx tsx scripts/core-path-gate.ts`         | `✓ 通过（6 个受保护文件）`——较 §10.2 的 4 个新增 `scanner-handler.ts` 与 `settings-handler.ts`，各自同批携带 `@core-change` 原因行                                                                                                                                         |
| `npm run docs:links`                        | `✅ 无死引用`（新增的 `image-watermark-toast-keys.test.ts` 先 `git add` 再跑，理由同 §10.2 记的 tracked 集合判定）                                                                                                                                                         |
| `npm run test:coverage`                     | 退出码 `0`，全局 `statements 68.62 / branches 60.17 / functions 61.30 / lines 70.25`，阈值 `66 / 58 / 59 / 68`——§7 记录的覆盖率风险未成立，本轮新增用例把均值抬高（首轮记录为 66.69 / 58.19 / 59.22 / 68.27）                                                              |
| `npm run verify`                            | `总计: 5 项, 0 失败` → `✓ 全部通过 — 可以安全提交`；⚠ 4 个源文件无匹配套件（`main/preload/api/watermark.ts`、`main/types/file.ts`、`renderer/pages/EditorPage.tsx` 为 §10.2 已记录的既有缺口，第 4 项 `tests/mocks/mock-validator.ts` 是本轮新改的测试替身、本就不需配对） |

**提交拆分**（Conventional Commits，逐条过 husky/pre-commit）：`fix(watermark)` 代码与测试 +
`docs/IPC_CONTRACT.md`；`feat(i18n)` 11 个 locale 值 + 新契约测试；`docs(plans)` 本文件；
`chore(release)` CHANGELOG 补录。**版本号不动**：`package.json` 实测已是 `2.5.5-beta`，
全仓无第二处版本真相源（运行时取 `app.getVersion()`），`scripts/check-changelog-release.ts`
确认 `[2.5.5-beta]` 节存在且唯一、`[Unreleased]` 无待发布条目。

**仍未做到**：§9 的 GUI 手工冒烟（本机执行）；R7 同族的 `toast.imageProcessorCanvasFailed`
空串（见 §11.4 新登记项）。
