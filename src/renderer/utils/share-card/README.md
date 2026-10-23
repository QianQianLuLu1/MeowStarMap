# 分享图（share-card）移植件

把 NikkiSync **微信小程序**的分享图渲染器移植到喵星图桌面端。上游没有 TypeScript 实现
（`grep -rln ShareCard --include=*.ts apps packages` = 0），只有 Android Java
（`apps/mobile/.../share/`）和小程序 JS（`apps/wechat-mini-program/miniprogram/lib/share-card.js`），
所以这里是**移植**，不是「直接调用上游模块」。

上游依据：`share-card.js` @ NikkiSync commit `d4ca7d7`。逐字副本与哈希钉死在
`__tests__/fixtures/share-card.reference.txt` + `__tests__/shareCardParity.test.ts`。

## 模块划分

| 文件                                     | 职责                                                                | 对应上游                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `shareCardModel.ts`                      | 载荷装配、断行、分页、单位与滑轨归一（纯函数，零 DOM / 零 i18next） | `:2,5,7-51` 的 `clean` / `buildPayload` / `wrap` / `layoutCards` / `parameterPresentation` |
| `shareCardRender.ts`                     | 单页绘制（op 序列与坐标）                                           | `:52-99` 的 `rounded` / `render`                                                           |
| `shareCardInput.ts`                      | 本 App 的 `GameParamsData` → 载荷                                   | 替代上游 `channel.metadata` / `channel.outfit`                                             |
| `shareCardJob.ts`                        | 出图编排（canvas 与导出注入式，取消在每个检查点生效）               | `:101-173` 的 `createShareCardJob`（去掉临时文件与网络超时治理）                           |
| `../components/sync/ShareCardDialog.tsx` | 真 canvas、进度、保存、入口接线                                     | 小程序侧查看器 + `saveShareCard`                                                           |

## `wx.*` → Electron 映射

| 小程序侧                                                         | 桌面端                                     | 说明                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `channel.metadata(id, cb)`                                       | `useGameParams` → `decrypt:decodeFile`     | 上游只回 12 行且 `playerMetadata` 未从包里导出；本仓给得更全                              |
| `channel.outfit(id, offset, cb)`                                 | 一次取全 `dressing.clothes.slice(0, 100)`  | 本地拿得到就不需要分页协议；100 上限照抄                                                  |
| `channel.icon(id, key, cb)`                                      | **不移植**                                 | 图标只存在于远端字典写入的 `metadata.dressing.clothes[].thumbnail`，内嵌 Runtime 不接字典 |
| `channel.original(id, cb)`                                       | `file_path` 经 `media://`                  | 阶段 5 · C1 之后， NikkiSync 资产路径在读通道同样被授权                                   |
| `canvas.createImage()`                                           | `new Image()` + `crossOrigin='anonymous'`  | 沿用 `utils/imageProcessor.ts` 既有链路                                                   |
| `wx.createOffscreenCanvas({type:'2d'})`                          | `document.createElement('canvas')`         | 尺寸公式 `min(360/w, 900/h)` 保留                                                         |
| `wx.canvasToTempFilePath({fileType:'png'})`                      | `canvas.toDataURL('image/png')`            | 不落临时文件                                                                              |
| `getFileSystemManager().writeFile/unlink` + `owned/pinned/waits` | 删除                                       | 内存 blob 直接交 `editor:saveAs`                                                          |
| 150s `request()` 超时                                            | 删除                                       | 本机读取不存在传输超时                                                                    |
| `saveShareCard` + `scope.writePhotosAlbum`                       | `editor:saveAs` + `shell.showItemInFolder` | 桌面端「保存到相册」= 保存到导出目录                                                      |

## 文案注入

上游把「穿搭 / 拍摄参数 / 图标暂缺 / 分类示意 / 暂无穿搭数据 / 无限暖暖摄影」等中文写死在
`fillText` 里。本仓的渲染层硬 lint 禁止中文字面量，因此：

- 图上文案（`shareCard.card.*`）**只在 `zh-CN.json` 落真实值**，其余 11 个语言包留空串；
- 读取侧 `ShareCardDialog` 用 `i18n.t(key, { lng: 'zh-CN' })` 钉死，
  所以导出的图**不随 App 界面语言变化**——与 Android/小程序两端保持同一版式。
  分享图是独立的位图产物，本就不该被 App 主题/语言重新着色或改写。
- 焦距/光圈/晕影/柔光四枚的「XX调节」展示名，由 `copy.parameterLabels` 承担（上游写在 `:89`）。

## 已知非等价项（登记于 `docs/archive/plans/2026-10-15-sync-gallery-share-card-metadata.md`）

| 项               | 原因                                                                                         | 处置                                                          |
| ---------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 字体像素差异     | 小程序 Skia vs Chromium Skia 的字形 hinting 与字体装载不同                                   | 判据只到「几何等价」；像素仅人工并排目测，不设数值门槛        |
| 参数覆盖度更高   | 本地解密链给出 镜头旋转 / 景深 / 高光 / 阴影 / 柔光范围 等，上游 `playerMetadata` 只给 12 行 | 有意超集；对拍时在参考侧不喂多余键                            |
| 穿搭名解析率更高 | 本地 7369 条 `cloth-names.json` vs 上游「名称待解析」占位                                    | 有意超集；对拍时构造同一份已解析/未解析输入                   |
| 单品图标恒缺     | 图标 URL 只存在于远端字典写入的 metadata 列                                                  | 恒走上游 `图标暂缺` 分支，`missingIcons` 如实上报并在面板提示 |
| 实况照片不出图   | 上游对 LIVE 另有一套 `live-gallery.js`                                                       | 本阶段拒绝出图并给明确文案                                    |

## 为什么能声称「与原生一致」

`__tests__/shareCardParity.test.ts` 把**同一个录制型假 ctx** 先交给参考实现（中文 label 行），
再交给本仓实现（规范键 + zh 注入文案），断言 `fillRect/fillText/drawImage/arc/路径` 的
op 序列与坐标**逐项相等**，覆盖四组场景：参数齐备单页、旋转 90°、无穿搭无参数的降级页、
穿搭超界的多页。夹具本体被一条 sha256 断言钉住，改动副本即红。
