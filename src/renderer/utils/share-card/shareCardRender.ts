import { SHARE_CARD_WIDTH, type ShareCardPage, type ShareCardPayload } from './shareCardModel'

/**
 * 阶段 5 · B2：分享图绘制层。
 *
 * 坐标、字号、圆角、透明度、op 调用顺序**逐字照抄**上游
 * `share-card.js:52-99`（`rounded` / `render`），一个像素都不改；唯一的结构性差别是
 * 所有出现在 `fillText` 里的中文都改为从 `copy` 注入（渲染层硬 lint 拦中文字面量），
 * 于是「与原生一致」这件事由 B3 的对拍测试在**同一份录制型假 ctx** 上证明，
 * 而不是靠人眼比对截图。
 *
 * 色值说明（编码约定 3 的明示例外）：本文件的 `#FFF8F0` / `rgba(...)` 是 Canvas 绘图的
 * 内部色彩，不属于「组件样式里的硬编码色值」——分享图是一份独立的位图渲染器，必须与
 * 主题系统解耦（上游 Android/小程序两端同样如此），因此这些字面量必须保持定值，
 * 不随 App 主题变化。影响面仅限导出的 PNG；回滚方案是把这些常量收敛成一张调色板对象。
 */

/** 注入的文案：各语言由 `t('shareCard.*')` 组装后传入。 */
export interface ShareCardCopy {
  brand: string
  fallbackTitle: string
  outfitHeading: string
  parameterHeading: string
  iconMissing: string
  categoryBadge: string
  noOutfit: string
  footer: string
  /** 规范键 → 展示名。焦距/光圈/晕影/柔光四枚在此完成上游的「XX调节」改写 */
  parameterLabels: Record<string, string>
  /** 效果区键 → 展示名（上游取其首字画在方框里） */
  effectLabels: Record<string, string>
}

export interface ShareCardDrawable {
  width: number
  height: number
}

export interface RenderShareCardArgs {
  image: ShareCardDrawable
  soft?: ShareCardDrawable | null
  page: ShareCardPage
  payload: ShareCardPayload
  index: number
  total: number
  rotation: number
  copy: ShareCardCopy
  icons: Map<string, ShareCardDrawable>
}

/** 上游 `rounded()`：手搓圆角矩形路径后 `fill()`（不用 roundRect，两端行为才有保证）。 */
export function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
  ctx.fill()
}

/**
 * 绘制一整页。`ctx` 用最小面（fillRect/fillText/drawImage/path 系列），
 * 真实 Canvas 与测试期录制假件都满足，故这里直接吃 CanvasRenderingContext2D。
 */
export function renderShareCardPage(
  ctx: CanvasRenderingContext2D,
  args: RenderShareCardArgs
): void {
  const { image, soft, page, payload, index, total, copy, icons } = args
  // 阶段 5 参数校验：rotation 只接受 {0,90,180,270}，其余归一为 0——任意角度会让
  // swap 域判断失真、scale 覆盖不足露出底色（调用方目前恒传 0，契约仍须落实）
  const rotation =
    args.rotation === 90 || args.rotation === 180 || args.rotation === 270 ? args.rotation : 0
  const WIDTH = SHARE_CARD_WIDTH
  const height = page.height

  ctx.fillStyle = '#FFF8F0'
  ctx.fillRect(0, 0, WIDTH, height)

  // 照片经细 translucent 面板透出，与游戏内参数浮层一致
  const source = soft ?? image
  const w = source.width || 1
  const h = source.height || 1
  ctx.save()
  ctx.translate(WIDTH / 2, height / 2)
  ctx.rotate((rotation * Math.PI) / 180)
  const swap = rotation === 90 || rotation === 270
  const areaW = swap ? height : WIDTH
  const areaH = swap ? WIDTH : height
  const scale = Math.max(areaW / w, areaH / h)
  ctx.drawImage(source as never, (-w * scale) / 2, (-h * scale) / 2, w * scale, h * scale)
  ctx.restore()

  ctx.fillStyle = 'rgba(34,28,38,0.48)'
  ctx.fillRect(0, 0, WIDTH, height)
  ctx.fillStyle = '#FFF8F0'
  ctx.font = '48px sans-serif'
  ctx.fillText(copy.brand, 60, 98)
  ctx.font = '25px sans-serif'
  ctx.fillStyle = 'rgba(255,248,240,.8)'
  ctx.fillText(
    [payload.date || copy.fallbackTitle, payload.version].filter(Boolean).join(' · '),
    60,
    146
  )
  ctx.fillStyle = '#F6BCC0'
  roundedRectPath(ctx, 60, 170, 96, 4, 2)

  const panel = (x: number, panelWidth: number): void => {
    ctx.fillStyle = 'rgba(244,224,232,.16)'
    roundedRectPath(ctx, x, 218, panelWidth, height - 284, 22)
    ctx.strokeStyle = 'rgba(255,248,240,.52)'
    ctx.lineWidth = 2
    ctx.stroke()
  }
  panel(60, 440)
  panel(536, 844)

  ctx.fillStyle = '#FFF8F0'
  ctx.font = '30px sans-serif'
  ctx.fillText(copy.outfitHeading, 90, 272)
  ctx.fillText(copy.parameterHeading, 570, 272)

  for (const item of page.outfit) {
    const x = 86 + item.column * 200
    const y = 310 + item.y
    const size = 178
    ctx.fillStyle = 'rgba(255,248,240,.12)'
    roundedRectPath(ctx, x, y, size, size, 18)
    ctx.strokeStyle = 'rgba(255,248,240,.3)'
    ctx.lineWidth = 1
    ctx.stroke()
    const icon = icons.get(item.iconPath)
    if (icon) {
      const iconScale = Math.min(162 / icon.width, 162 / icon.height)
      ctx.drawImage(
        icon as never,
        x + (size - icon.width * iconScale) / 2,
        y + (size - icon.height * iconScale) / 2,
        icon.width * iconScale,
        icon.height * iconScale
      )
    } else {
      ctx.fillStyle = 'rgba(255,248,240,.58)'
      ctx.font = '20px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(copy.iconMissing, x + size / 2, y + size / 2 + 7)
      ctx.textAlign = 'left'
    }
    ctx.fillStyle = '#FFF8F0'
    ctx.font = '23px sans-serif'
    ctx.textAlign = 'center'
    item.lines.forEach((line, n) => ctx.fillText(line, x + size / 2, y + size + 30 + n * 29))
    if (item.iconSource === 'category') {
      ctx.font = '18px sans-serif'
      ctx.fillStyle = 'rgba(255,248,240,.6)'
      ctx.fillText(copy.categoryBadge, x + size / 2, y + size + 30 + item.lines.length * 29)
    }
    ctx.textAlign = 'left'
  }
  if (!page.outfit.length) {
    ctx.fillStyle = 'rgba(255,248,240,.65)'
    ctx.font = '24px sans-serif'
    ctx.fillText(copy.noOutfit, 90, 360)
  }

  let y = 348
  let firstEffect = true
  for (const parameter of page.parameters) {
    const label = parameter.key ? (copy.parameterLabels[parameter.key] ?? parameter.key) : ''
    if (parameter.effect) {
      if (firstEffect) {
        ctx.strokeStyle = 'rgba(255,248,240,.5)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(570, y - 22)
        ctx.lineTo(1346, y - 22)
        ctx.stroke()
        firstEffect = false
        y += 16
      }
      ctx.fillStyle = 'rgba(255,248,240,.76)'
      ctx.font = '27px sans-serif'
      ctx.fillText(label, 574, y + 24)
      ctx.fillStyle = 'rgba(246,188,192,.15)'
      roundedRectPath(ctx, 728, y - 8, 64, 64, 14)
      ctx.strokeStyle = 'rgba(246,188,192,.55)'
      ctx.stroke()
      ctx.fillStyle = '#F6BCC0'
      ctx.font = '27px sans-serif'
      ctx.fillText(label.slice(0, 1), 747, y + 32)
      ctx.fillStyle = '#FFF8F0'
      ctx.font = '28px sans-serif'
      parameter.lines.forEach((line, n) => ctx.fillText(line, 816, y + 26 + n * 34))
      y += parameter.height
      continue
    }
    ctx.fillStyle = parameter.missing ? 'rgba(255,248,240,.42)' : '#FFF8F0'
    ctx.font = '29px sans-serif'
    ctx.fillText(label, 570, y)
    ctx.fillStyle = parameter.missing ? 'rgba(255,248,240,.16)' : 'rgba(255,248,240,.50)'
    roundedRectPath(ctx, 748, y - 18, 374, 10, 5)
    if (parameter.ratio !== null) {
      const knobX = 748 + 374 * parameter.ratio
      ctx.fillStyle = 'rgba(246,188,192,.2)'
      ctx.beginPath()
      ctx.arc(knobX, y - 13, 25, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#FFF8F0'
      ctx.beginPath()
      ctx.arc(knobX, y - 13, 18, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.fillStyle = parameter.missing ? 'rgba(255,248,240,.42)' : '#FFF8F0'
    ctx.font = '29px sans-serif'
    ctx.fillText(parameter.displayValue, 1150, y)
    y += parameter.height
    if (parameter.key === 'aperture') {
      ctx.strokeStyle = 'rgba(255,248,240,.36)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(570, y - 40)
      ctx.lineTo(1346, y - 40)
      ctx.stroke()
    }
  }

  // 角星代替大块不透明色块，避免挡住照片
  for (const [starX, starY] of [
    [1364, 208],
    [1390, height - 78]
  ]) {
    ctx.strokeStyle = 'rgba(255,248,240,.65)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(starX, starY - 18)
    ctx.lineTo(starX + 6, starY - 5)
    ctx.lineTo(starX + 18, starY)
    ctx.lineTo(starX + 6, starY + 5)
    ctx.lineTo(starX, starY + 18)
    ctx.lineTo(starX - 6, starY + 5)
    ctx.lineTo(starX - 18, starY)
    ctx.lineTo(starX - 6, starY - 5)
    ctx.closePath()
    ctx.stroke()
  }

  ctx.fillStyle = 'rgba(255,248,240,.7)'
  ctx.font = '20px sans-serif'
  ctx.fillText(copy.footer + (total > 1 ? ` · ${index + 1} / ${total}` : ''), 60, height - 26)
}
