# 全屏预览前后切换画面抖动修复计划

> 日期：2026-11-01 · 状态：已批准，执行中 · 结论回写见文末「实测记录」

## Context（背景与根因）

全屏预览两条翻页链路在切换时画面抖动，根因各自独立（均已代码取证）：

**① FullscreenViewer（普通全屏查看，方向键/按钮/滚轮/侧键翻页）——「src 与宽高盒错位」**

- `navigate()` 只改 store 下标（`FullscreenViewer.tsx:127-140`），同帧渲染中 img 的 `width/height` 属性立即取**新文件**的元数据（`:436-437`），而 `src`（`displayUrl`）要等 effect 在提交后才换成新缩略图（`:101-102`）。
- 浏览器在 src 变化后、新图解码完成前仍显示旧位图 → **旧画面被塞进新比例的盒子重新 letterbox**（横图→竖图整幅瞬间缩小过半再弹出），随后缩略图、原图再各换一次像素——一次翻页肉眼可见跳 2~3 下。与用户确认的症状「旧图先变形再出新图」完全吻合。
- 修复 = **换源三联状态原子化**：新增 `displayedFile`（displayUrl 当前归属的文件）+ `displayedUrlRef`；新缩略图离屏 `decode()` 就绪前旧画面原样持稳（src、宽高盒都不动），就绪后 `setDisplayUrl + setDisplayedFile + setImgError(false)` 在同一回调成组更新（React 批处理 → 单次提交原子生效）。附带收益：快速往返翻页（A→B 未就绪→回 A）零降级零闪烁；重开同一张图不再先降级缩略图。

**② SlideshowPlayer（幻灯片放映）——「key 重挂载 + 零预加载 + 无宽高盒」**

- 每次翻页 `setTransitionKey(k+1)` 强制重挂载整个媒体容器（`SlideshowPlayer.tsx:116/125/255-258`），img 直接请求 4K 原图（`:269-275`）无 width/height 属性、无预加载 → 空白/黑框 → 图片加载完突然撑开；fade/slide 动画跑在空盒上与撑开叠加。
- 修复（最小化，保留重挂载结构）= ① img 按元数据加 `width/height` 属性（盒在位图加载前即按原比例成形，撑开跳动消失，动画作用于稳定盒子）；② 复用现有 `useNeighborPrefetch`（`src/renderer/hooks/useNeighborPrefetch.ts:18`）传入 `playOrder.map(i => playableFiles[i])` 洗牌感知的顺序数组，按播放顺序预热相邻原图。

改动均为 renderer 组件层，不在核心路径保护清单内，无需 `@core-change` 注释；与工作区已有的 topbar-fix 未提交改动同文件不同区域，可共存。

## 依赖声明

无新增依赖。复用：`useNeighborPrefetch`、`toFileUrl`、`whenTransitionSettled`（既有）、@testing-library/react + vitest jsdom project（既有基建）。

## 启动说明

- 环境：Node ≥ 22（本机就绪）、依赖已装（禁 npm install）。
- 单测：`npx vitest run src/renderer/components/gallery/FullscreenViewer.jitter.test.tsx src/renderer/components/gallery/SlideshowPlayer.jitter.test.tsx`
- 全量回归：`npm test`；变更验证（只读）：`npm run verify`
- 真机：`npm run dev`

## 错误处理

- 沿用既有 probe 降级语义：`decode()` 缺失或拒绝时**仍换源**（绝不因预解码失败判死图片）；缩略图失败走既有 img `onError` 升级原图，原图再失败才进 `imgError` 占位。
- 新增错误路径：缩略图 probe 换源回调带守卫「原图已先行换源则跳过」，防止缓存命中时出现原图→缩略图质量回退；effect cleanup `cancelled` 防过期 probe 覆盖（沿既有模式）。
- 全部降级为静默（与既有 probe/预取一致），无新增 console/日志分支。
- 前图加载失败（占位显示）期间翻页：错误占位持稳到新图缩略图就绪再原子切换，消除既有「复位 effect 在提交后才跑」的一帧闪占位。

## 参数校验

纯 UI 层，无新增 IPC/入参/存储键。既有兜底不动：`if (!fullscreenOpen || !currentFile) return null`、`displayUrl ?? fileUrl ?? ''` 空串兜底、`window.electronAPI` 判空。新增状态的边界：`displayedFile` 初始化 `currentFile ?? null`；元数据缺失文件不设宽高属性（与现状一致，无法预成形，仅保证单次硬切不叠加变形帧）；`playOrder` 越界邻居由 `useNeighborPrefetch` 既有判空跳过，视频邻居既有跳过逻辑生效。

## 修复方案（最小改动）

| 文件                                                               | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/renderer/components/gallery/FullscreenViewer.tsx`             | ① 新增 `displayedFile` state + `displayedUrlRef`；② 重构 `:101-121` 换源 effect：`setDisplayUrl(initialUrl)` 不再立即执行，改为缩略图 probe `decode()` 就绪后与原图 probe 并行各走一个回调，每个回调成组 `applySource(url)`（= setDisplayUrl + setDisplayedFile + setImgError(false) + ref 同步）；ref 已显示目标原图时短路跳过全部探测；③ 删除 `:86-88` imgError 复位 effect（迁入 applySource，消灭一帧闪占位）；④ `:436-437` 宽高属性来源 `currentFile` → `displayedFile`；⑤ img `onError` 升级原图时同步 `displayedUrlRef` |
| `src/renderer/components/gallery/SlideshowPlayer.tsx`              | ① img（`:269-275`）加 `width/height` 属性（元数据存在时）；② 新增 `prefetchFiles = useMemo(playOrder 映射)` + `useNeighborPrefetch(prefetchFiles, currentPos, slideshowOpen)`                                                                                                                                                                                                                                                                                                                                                  |
| `src/renderer/components/gallery/FullscreenViewer.jitter.test.tsx` | 新建，6 用例（照 topbarFix.test.tsx 骨架：FakeImage 按 src 匹配 + electronAPI 形状 mock + resetStores + 中文文案断言）                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/renderer/components/gallery/SlideshowPlayer.jitter.test.tsx`  | 新建，3 用例                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 本计划文件                                                         | T0 落盘，执行后文末回写实测读数                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 子任务与验收标准（TDD：先红后绿，每步闭环后才进下一步）

**T0 落盘计划**：写入本文件。验收：文件存在且含依赖声明/启动说明/错误处理/参数校验/基础测试用例五节。

**T1 红灯**：新建 2 个测试文件。FV 用例（每例含至少一个修复前必失败的断言）：①切至新图后、缩略图 decode 就绪前 src 与宽高盒保持旧图不变；②键盘 ArrowRight 同契约；③缩略图就绪时 src 与盒子同帧原子换新图（就绪前先断言持稳）；④A→B 未就绪→回 A 全程 src 保持 A-url 无降级、过期 probe 不回写；⑤缩略图 probe 解码失败仍换源并可经 onError 升级原图（含持稳前置断言）；⑥前图加载失败后翻页错误占位持稳至新图就绪。SP 用例：①图片带原图宽高盒；②按播放顺序（含洗牌）预热相邻原图；③无元数据不设盒、视频邻居不预热、末尾停播不崩溃（含图片邻居预热红灯断言）。验收：`npx vitest run` 两文件 → 9 用例**全部失败**（红灯）。

**T2 绿灯（FullscreenViewer）**：按上表 ①-⑤ 改动。验收：jitter 6 用例全绿；同目录既有 9 个 `FullscreenViewer.*.test.tsx` 全绿——若既有 transition/prefetch 用例因「probe 数量从 1 变 2」而按实例序数取 probe 失败，仅将其引用方式改为按 src 匹配（断言语义不弱化），并在此记录。

**T3 绿灯（SlideshowPlayer）**：按上表 ①-② 改动。验收：SP jitter 3 用例全绿；既有 `SlideshowPlayer.topbarNoDrag.test.tsx` 仍绿。

**T4 全局回归**：`npm test` 全量无新增失败；`npm run verify` 全绿（typecheck/lint/core-gate/format，`[VERIFY] ✓`；format/lint 失败则 `prettier --write`/`lint:fix` 后重跑）。

**T5 真机验证（亲自运行）**：`npm run dev` 实测：图库全屏横竖图交替按方向键/按钮/滚轮/侧键切换——旧画面稳定无变形跳变、缩略图→原图同帧；快速连按无错图死图；幻灯片 fade/slide/none 三过渡翻页无空白撑开；开/关全屏共享元素过渡不回归。实测读数回写本文末尾。

不执行 git commit（工作区尚有 topbar-fix 待提交改动，是否合并提交由用户决定）。

## 基础测试用例（正常/异常/边界）

- 正常：FV①③（按钮/键盘切换原子换源）、SP①②（宽高盒、播放顺序预取）。
- 异常：FV⑤（probe 解码失败降级 + onError 升级链）、FV⑥（加载失败占位持稳）、SP③（视频邻居跳过）。
- 边界：FV④（快速往返零降级、过期 probe 隔离）、FV②（键盘路径）、SP③（无元数据文件、末尾停播、洗牌序）。

## 非目标（明确不做）

键盘连按节流（避免改变手感）、SlideshowPlayer 双缓冲交叉淡入重写（key 重挂载保留，靠盒预成形+预取缓解）、无元数据文件的固有比例硬切（无法预成形）、CHANGELOG 条目（沿 topbar-fix 先例随下轮定版统一补）。

---

## 实测记录（执行后回写）

> 2026-11-01 执行完毕。T1–T4 全部验收通过，T5 真机验证完成主体项（SlideshowPlayer 视频页直测受自动化工具限制以单测兜底，见下）。

### 测试结果（TDD 红绿闭环）

| 阶段        | 结果                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1 红灯     | 新建 2 个测试文件共 **10 用例全部失败**（FV 6：src 提前变新缩略图 / imgError 提前复位；SP 4：无宽高属性 / 零预取），与定位的根因逐一对应                                  |
| T2/T3 绿灯  | FV 9 文件 84 用例全绿（jitter 6 + 既有 78）；SP 6 用例全绿（jitter 4 + topbarNoDrag 2）                                                                                   |
| T4 全局回归 | `npm test` 全量 **463 文件 7271 用例通过**（20 skipped，0 失败，修复后复跑两次均全绿）；`npm run verify` **5/5 全绿**（typecheck / lint / core-gate / format / 相关单测） |

### 计划外发现与修复（执行中定位的真实缺陷，已随本批修复）

1. **SlideshowPlayer 视频页 start/stop 无限拉锯（挂死级，既有缺陷）**：`useSlideshow` 返回对象每次渲染都是新引用，自动启动 effect（deps 含整个对象）每渲染重跑 `start()`，与视频等待 effect 的每渲染 `stop()` 互相拉锯——`skipVideo=false` 且播放位落在视频时**应用冻结**（红绿过程中实测复现为测试挂起）。修复 = 相关 effect 全部改依赖 useCallback 稳定引用（start/stop）与原始值（isPlaying），`videoEndedRef` 反转为「因等待而暂停」标记，视频播完后由 `handleVideoEnded` 恢复自动播放。附带修复：暂停后不再被自动启动 effect 拉回播放（原实现暂停不生效）。真机验证受阻于自动化工具限制，由 jitter 测试 ④（翻到视频→等待→播完→恢复→末尾停播全链路）钉死。
2. **FullscreenViewer.transition.test.tsx 5 处按实例序数取 probe 的引用**因「缩略图先行多发一次 probe」错位——按计划授权改为按 src 匹配（`resolveDecodesFor`），断言语义不弱化。

### 真机实测（npm run dev + 屏幕控制，本机媒体库 29 个文件）

| 验证项            | 结果                                                                                                                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全屏打开          | ✅ 点击卡片打开全屏，共享元素过渡正常                                                                                                                                                                                        |
| 横→竖切换（核心） | ✅ 方向键/按钮切换后旧画面持稳、竖图完整正确显示（2/29），无变形跳变残迹                                                                                                                                                     |
| 连续切换          | ✅ 连切 4 张（含图片→视频跨类型）无卡顿、无错图死图，视频页 VideoPlayer 正常播放                                                                                                                                             |
| 跨类型往返        | ✅ 视频→图片→视频→图片往返全部正确（3/29 竖图特写完整显示）                                                                                                                                                                  |
| FV 自动放映       | ✅ 从 2/29 完整播放至 29/29 自动停止（3s 间隔，跨多个视频页），全程无冻结                                                                                                                                                    |
| 关闭回位          | ✅ 退出全屏回图库，共享元素过渡回位、选中态保留                                                                                                                                                                              |
| SlideshowPlayer   | ✅ 图库工具栏进入放映成功；控制条/播放设置抽屉/跳过视频开关交互正常；自动播放运行正常（观测窗口内无冻结）                                                                                                                    |
| SP 视频页直测     | ⚠ 未完成直接观察：CUA 屏幕控制对 Electron 独立窗口禁用物理输入（键盘/坐标），UIA Invoke 在控制条 3s 自动隐藏（pointer-events:none）后命中失效，且会穿透误触下层元素。由 jitter 测试 ④ 的全链路契约（挂死复现→修复→全绿）兜底 |

### 备注（给用户的收尾说明）

- **实测期间修改过「跳过视频」播放设置并已勾回**：因自动化操作往返，请在 幻灯片播放 → 播放设置 里顺手确认「跳过视频（仅播图片）」为你期望的状态（仓库默认为开启）。
- 实测后应用已重启至干净的图库初始状态（`npm run dev` 仍在后台运行）。
- 改动均为 renderer 组件与测试，不在核心路径保护清单内，无需 `@core-change` 注释；未执行 git commit，工作区改动与本轮 topbar-fix 待提交改动共存，是否合并提交由你决定。
