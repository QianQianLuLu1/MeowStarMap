import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

/**
 * 出货图标尺寸表。
 * 顺序沿用改造前 png-to-ico 的产出序（48, 32, 16, 256），与已验证可正常出货的
 * installer 图标逐字节同布局，不引入额外行为差异。
 */
export const ICO_SIZES = Object.freeze([48, 32, 16, 256])

/** 最大目标档；主源边长小于它时 lanczos 会放大出糊图，故直接拒绝 */
export const MAX_ICON_SIZE = 256

/**
 * 圆角半径：18.75% 边长，与改造前占位 icon.svg 的 rx=48/256 逐字一致，不新增设计决策。
 * 下界 2 防极小档退化成圆点，上界 size/2 防将来加 512/1024 档变成正圆。
 * @param {number} size 方形边长
 * @returns {number}
 */
export function radiusFor(size) {
  return Math.max(2, Math.min(Math.round((size * 3) / 16), Math.floor(size / 2)))
}

/**
 * 圆角矩形覆盖率图（纯函数，不依赖 sharp / 磁盘）。
 *
 * 中心必须取 w/2、半宽取 w/2 - r，等价于蒙版覆盖 [0,w]×[0,h] 全幅。
 * 若误写成 (w-1)/2 会整体偏 0.5px，使左上角带比右下角带宽——实测在 8/16/32/48/256
 * 五档分别造成 52/92/180/292/1540 处不对称，且蒙版面积比解析值少 14.6~510.7 像素。
 * 该缺陷由 scripts/__tests__/app-icon.test.ts 的对称性与面积两条判据常驻守卫。
 *
 * @param {number} width 边长
 * @param {number} height 边长
 * @param {number} radius 圆角半径
 * @param {number} [ss=4] 每边子采样数（ss² 次 SDF 判定/像素）
 * @returns {Uint8Array} 长度 width*height，0 = 全透明，255 = 不透明
 */
export function roundedRectCoverage(width, height, radius, ss = 4) {
  const out = new Uint8Array(width * height)
  const inv = 1 / ss
  const cx = width / 2
  const cy = height / 2
  const hw = cx - radius
  const hh = cy - radius
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let inside = 0
      for (let j = 0; j < ss; j++) {
        for (let i = 0; i < ss; i++) {
          const px = x + (i + 0.5) * inv - cx
          const py = y + (j + 0.5) * inv - cy
          const dx = Math.abs(px) - hw
          const dy = Math.abs(py) - hh
          const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
          const inside_ = Math.min(Math.max(dx, dy), 0)
          if (outside + inside_ - radius <= 0) inside++
        }
      }
      out[y * width + x] = Math.round((255 * inside) / (ss * ss))
    }
  }
  return out
}

/**
 * 把覆盖率乘进 raw RGBA 的 alpha 通道（就地修改）。
 * @param {Buffer} raw sharp raw() 得到的 RGBA 缓冲
 * @param {Uint8Array} coverage 同宽高的覆盖率图
 * @returns {Buffer} 与入参同一引用，便于断言
 */
export function applyCoverageToAlpha(raw, coverage) {
  for (let i = 0; i < coverage.length; i++) {
    raw[i * 4 + 3] = Math.round((raw[i * 4 + 3] * coverage[i]) / 255)
  }
  return raw
}

/**
 * 主源尺寸校验。
 * png-to-ico 的 imagesToIco 用 height = width * 2 假定正方形，非方图会**静默**产出坏图标；
 * 边长小于最大目标档时 lanczos 变成放大，产出糊图。两者都必须在生成前挡住。
 * @param {number} width 主源宽
 * @param {number} height 主源高
 * @returns {void}
 */
export function assertSquareMaster(width, height) {
  if (width !== height) {
    throw new Error(`主源必须是方形 PNG：${width}×${height}`)
  }
  if (width < MAX_ICON_SIZE) {
    throw new Error(`主源边长必须 ≥ ${MAX_ICON_SIZE}（最大目标档），实际 ${width}`)
  }
}

/**
 * 从主源渲染单个尺寸的圆角 PNG。
 * 每档都直接从主源降采样，不经 256 档中转（会丢信息），也不做逐级 step-down
 * （实测折半链亮度 std 增益 ≤6%，而 sharp 的 resize 内部本就做 shrink-on-integer + reduce）。
 * @param {Buffer} master 主源 PNG
 * @param {number} size 目标边长
 * @returns {Promise<Buffer>} 带 alpha 的 PNG
 */
export async function renderSizedPng(master, size) {
  const { data, info } = await sharp(master)
    // 核只能作为 resize 的 options 传入：本仓装的 sharp 版本没有链式 .kernel()
    .resize(size, size, { kernel: sharp.kernel.lanczos3 })
    // 主源是无 alpha 的 RGB PNG，必须补上才能乘覆盖率
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  applyCoverageToAlpha(data, roundedRectCoverage(info.width, info.height, radiusFor(size)))
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer()
}

async function generateIcon() {
  const root = path.join(import.meta.dirname, '..')
  const masterPath = path.join(root, 'resources', 'icons', 'icon-master.png')
  const icoPath = path.join(root, 'resources', 'icons', 'icon.ico')

  const master = fs.readFileSync(masterPath)
  const meta = await sharp(master).metadata()
  assertSquareMaster(meta.width ?? 0, meta.height ?? 0)

  // 数组形式调用走 png-to-ico 的 imagesToIco 分支，不再用它自带的 bicubic 二次生成小档
  // ——那正是改造前 16×16 档四角 alpha = 6/11/10/15（透明角被抹成半透明）的根因。
  const pngs = await Promise.all(ICO_SIZES.map((size) => renderSizedPng(master, size)))
  fs.writeFileSync(icoPath, await pngToIco(pngs))
  console.log(`Generated icon: ${icoPath}`)
}

// 仅在以脚本方式直接运行（node scripts/generate-icon.js）时生成；被测试导入时不执行
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('generate-icon.js')) {
  generateIcon().catch((err) => {
    console.error('Failed to generate icon:', err)
    process.exit(1)
  })
}
