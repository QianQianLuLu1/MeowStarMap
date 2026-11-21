#!/usr/bin/env node
// 从桌面端图标母图（resources/icons/icon-master.png）生成 Android 启动图标。
// 复用 scripts/generate-icon.js 的纯函数（方形校验 + lanczos 降采样 + 圆角渲染），
// 不重复实现图像管线。产物覆盖 mobile/app/src/main/res/mipmap-*/。
// 输入非法（缺文件/非方图/边长 <512）时非零退出，禁止静默产出糊图。
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { assertSquareMaster, renderSizedPng } from './generate-icon.js'

// [目录, legacy 图标边长]; 前景画布按 108dp 换算（mdpi=108）
const DENSITIES = Object.freeze([
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192]
])
// adaptive 前景安全区：108dp 画布中可见区域约 72dp，内容缩放至画布 72% 并居中，
// 系统按机型蒙版裁切，因此前景不做预圆角
const FOREGROUND_CONTENT_RATIO = 0.72
const MIN_MASTER_SIZE = 512

const root = path.join(import.meta.dirname, '..')
const masterPath = path.join(root, 'resources', 'icons', 'icon-master.png')
const resDir = path.join(root, 'mobile', 'app', 'src', 'main', 'res')

if (!fs.existsSync(masterPath)) {
  console.error(`图标母图不存在: ${masterPath}`)
  process.exit(1)
}
const master = fs.readFileSync(masterPath)
const meta = await sharp(master).metadata()
assertSquareMaster(meta.width ?? 0, meta.height ?? 0)
if ((meta.width ?? 0) < MIN_MASTER_SIZE) {
  console.error(`图标母图边长必须 ≥ ${MIN_MASTER_SIZE}（Android 各密度档需要），实际 ${meta.width}`)
  process.exit(1)
}

// 背景色取母图边缘像素均值：adaptive 背景应延续母图边缘色而非沿用上游 #FA628A。
// ensureAlpha 固定 4 通道步长；透明样本剔除，全部透明则报错退出（不猜测颜色）。
const { data: edge, info: edgeInfo } = await sharp(master)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true })
const { width: mw, height: mh } = edgeInfo
const pick = (x, y) => {
  const o = (y * mw + x) * 4
  return { rgb: [edge[o], edge[o + 1], edge[o + 2]], alpha: edge[o + 3] }
}
const inset = 2
const samplePoints = [
  [inset, inset], [mw - 1 - inset, inset], [inset, mh - 1 - inset], [mw - 1 - inset, mh - 1 - inset],
  [Math.floor(mw / 2), inset], [Math.floor(mw / 2), mh - 1 - inset], [inset, Math.floor(mh / 2)], [mw - 1 - inset, Math.floor(mh / 2)]
].map(([x, y]) => pick(x, y))
const opaque = samplePoints.filter((s) => s.alpha >= 128)
if (opaque.length === 0) {
  console.error('图标母图边缘全部为透明，无法确定 adaptive 背景色；请提供不透明母图或改用固定色。')
  process.exit(1)
}
const avg = opaque
  .reduce((acc, s) => acc.map((v, i) => v + s.rgb[i]), [0, 0, 0])
  .map((v) => Math.round(v / opaque.length))
const hex = '#' + avg.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
console.log(`母图 ${meta.width}×${meta.height}，四角均值背景色 ${hex}`)

for (const [dir, size] of DENSITIES) {
  const outDir = path.join(resDir, dir)
  fs.mkdirSync(outDir, { recursive: true })
  // legacy 圆角图标（沿用桌面端 18.75% 圆角语言）
  fs.writeFileSync(path.join(outDir, 'ic_launcher.png'), await renderSizedPng(master, size))
  // adaptive 前景：母图缩至画布 72% 居中，四周透明
  const content = Math.round((size * FOREGROUND_CONTENT_RATIO) / 2) * 2
  const pad = (size - content) / 2
  const foreground = await sharp(master)
    .resize(content, content, { kernel: sharp.kernel.lanczos3 })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  fs.writeFileSync(path.join(outDir, 'ic_launcher_foreground.png'), foreground)
  console.log(`✓ ${dir}: ic_launcher.png ${size}px + ic_launcher_foreground.png ${size}px（内容 ${content}px）`)
}

fs.writeFileSync(
  path.join(resDir, 'values', 'launcher_colors.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources><color name="launcher_background">${hex}</color></resources>\n`
)
console.log(`✓ values/launcher_colors.xml → ${hex}`)
console.log('ANDROID ICONS GENERATED')
