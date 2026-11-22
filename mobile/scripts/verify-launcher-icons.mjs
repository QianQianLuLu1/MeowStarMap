#!/usr/bin/env node
// 安卓启动图标一致性验收：静态断言 mipmap 产物与桌面端母图同源、同规格。
// 断言依据 generate-android-icons.mjs 的生成契约（尺寸档位 / 前景 72% 安全区留白 / 背景色=母图边缘均值），
// 不凭肉眼判断；任一断言失败即非零退出并指明档位。
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'

const root = path.join(import.meta.dirname, '..', '..')
const resDir = path.join(root, 'mobile', 'app', 'src', 'main', 'res')
const masterPath = path.join(root, 'resources', 'icons', 'icon-master.png')

const DENSITIES = Object.freeze([
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192]
])
const FOREGROUND_CONTENT_RATIO = 0.72
const RATIO_TOLERANCE = 0.02
const CENTER_TOLERANCE_RATIO = 0.03

let failed = 0
const fail = (label, detail) => { console.error(`✗ ${label} — ${detail}`); failed++ }
const pass = (label, detail = '') => console.log(`✓ ${label}${detail ? `  ${detail}` : ''}`)

const readPng = async (file) => {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, channels: info.channels }
}

// 与 generate-android-icons.mjs 相同的母图边缘均值算法（8 采样点，剔透明）
const masterEdgeColor = async () => {
  const { data, width, height } = await readPng(masterPath)
  const inset = 2
  const pick = (x, y) => { const o = (y * width + x) * 4; return { rgb: [data[o], data[o + 1], data[o + 2]], alpha: data[o + 3] } }
  const points = [
    [inset, inset], [width - 1 - inset, inset], [inset, height - 1 - inset], [width - 1 - inset, height - 1 - inset],
    [Math.floor(width / 2), inset], [Math.floor(width / 2), height - 1 - inset], [inset, Math.floor(height / 2)], [width - 1 - inset, Math.floor(height / 2)]
  ].map(([x, y]) => pick(x, y))
  const opaque = points.filter((s) => s.alpha >= 128)
  if (opaque.length === 0) throw new Error('母图边缘全部透明，无法重算背景色')
  return '#' + opaque.reduce((acc, s) => acc.map((v, i) => v + s.rgb[i]), [0, 0, 0])
    .map((v) => Math.round(v / opaque.length).toString(16).padStart(2, '0')).join('').toUpperCase()
}

const opaqueBBox = ({ data, width, height, channels }) => {
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * channels + 3] < 128) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return maxX < 0 ? null : { w: maxX - minX + 1, h: maxY - minY + 1, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
}

// 1) 母图存在且为方图（生成链路的输入前提）
if (!fs.existsSync(masterPath)) { fail('桌面端母图', `缺失: ${masterPath}`); process.exit(1) }
const masterMeta = await sharp(masterPath).metadata()
if (masterMeta.width !== masterMeta.height) fail('桌面端母图', `${masterMeta.width}×${masterMeta.height} 非方图`)
else pass('桌面端母图', `${masterMeta.width}×${masterMeta.height}`)

// 2) 五档双图存在、尺寸精确、目录内无未引用旧图
for (const [dir, size] of DENSITIES) {
  const outDir = path.join(resDir, dir)
  for (const name of ['ic_launcher.png', 'ic_launcher_foreground.png']) {
    const file = path.join(outDir, name)
    if (!fs.existsSync(file)) { fail(`${dir}/${name}`, '文件缺失'); continue }
    const meta = await sharp(file).metadata()
    if (meta.width !== size || meta.height !== size) fail(`${dir}/${name}`, `${meta.width}×${meta.height}，期望 ${size}×${size}`)
    else pass(`${dir}/${name}`, `${size}×${size}`)
  }
  const others = fs.readdirSync(outDir).filter((n) => n !== 'ic_launcher.png' && n !== 'ic_launcher_foreground.png')
  if (others.length > 0) fail(`${dir}`, `存在未引用旧图: ${others.join(', ')}`)
}

// 3) 前景不透明主体落在生成契约的居中安全区（≈72% 画布，容差带）
for (const [dir, size] of DENSITIES) {
  const file = path.join(resDir, dir, 'ic_launcher_foreground.png')
  if (!fs.existsSync(file)) continue
  const png = await readPng(file)
  const bbox = opaqueBBox(png)
  if (!bbox) { fail(`${dir}/foreground`, '前景全部透明'); continue }
  const ratio = Math.max(bbox.w, bbox.h) / size
  if (Math.abs(ratio - FOREGROUND_CONTENT_RATIO) > RATIO_TOLERANCE) fail(`${dir}/foreground`, `主体占比 ${(ratio * 100).toFixed(1)}%，期望 ≈${FOREGROUND_CONTENT_RATIO * 100}%`)
  const cxOff = Math.abs(bbox.cx - size / 2) / size
  const cyOff = Math.abs(bbox.cy - size / 2) / size
  if (cxOff > CENTER_TOLERANCE_RATIO || cyOff > CENTER_TOLERANCE_RATIO) fail(`${dir}/foreground`, `主体偏移 (${(cxOff * 100).toFixed(1)}%, ${(cyOff * 100).toFixed(1)}%)，期望居中`)
  else pass(`${dir}/foreground 主体`, `占比 ${(ratio * 100).toFixed(1)}%，居中`)
}

// 4) adaptive 引用成对：anydpi-v26 XML 与 launcher_colors.xml 背景色
const adaptiveXml = path.join(resDir, 'mipmap-anydpi-v26', 'ic_launcher.xml')
if (!fs.existsSync(adaptiveXml)) fail('mipmap-anydpi-v26/ic_launcher.xml', '文件缺失')
else {
  const xml = fs.readFileSync(adaptiveXml, 'utf8')
  const bgOk = xml.includes('@color/launcher_background')
  const fgOk = xml.includes('@mipmap/ic_launcher_foreground')
  if (!bgOk || !fgOk) fail('mipmap-anydpi-v26/ic_launcher.xml', `background/foreground 引用不成对 (bg=${bgOk}, fg=${fgOk})`)
  else pass('mipmap-anydpi-v26/ic_launcher.xml', '@color/launcher_background + @mipmap/ic_launcher_foreground')
}

const colorsXml = path.join(resDir, 'values', 'launcher_colors.xml')
if (!fs.existsSync(colorsXml)) fail('values/launcher_colors.xml', '文件缺失')
else {
  const xmlColor = (fs.readFileSync(colorsXml, 'utf8').match(/launcher_background">#([0-9A-Fa-f]{6})</) || [])[1]
  const expected = (await masterEdgeColor()).slice(1)
  if (!xmlColor) fail('values/launcher_colors.xml', '未解析到 launcher_background 色值')
  else if (xmlColor.toUpperCase() !== expected.toUpperCase()) fail('values/launcher_colors.xml', `#${xmlColor} 与母图边缘均值 #${expected} 不一致`)
  else pass('values/launcher_colors.xml', `#${xmlColor} = 母图边缘均值`)
}

// 5) Manifest 图标引用在位
const manifest = fs.readFileSync(path.join(resDir, '..', 'AndroidManifest.xml'), 'utf8')
const iconOk = manifest.includes('android:icon="@mipmap/ic_launcher"')
const roundOk = manifest.includes('android:roundIcon="@mipmap/ic_launcher"')
if (!iconOk || !roundOk) fail('AndroidManifest.xml', `icon/roundIcon 引用缺失 (icon=${iconOk}, round=${roundOk})`)
else pass('AndroidManifest.xml', 'icon/roundIcon → @mipmap/ic_launcher')

if (failed > 0) {
  console.error(`\nLAUNCHER ICONS: ${failed} 项不符 —— 图标与桌面端母图同源契约漂移`)
  process.exit(1)
}
console.log('\nLAUNCHER ICONS: 全部断言通过')
