import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'

/**
 * 应用图标与 exe 资源编辑守卫。
 *
 * 为什么要有这个文件：本仓原先唯一的图标源是 `resources/icons/icon.svg` 那张蓝色占位方块，
 * 而 `package.json` 的 `build.win` 里写着 `signAndEditExecutable: false` —— 该值会让
 * electron-builder 的 WinPackager 在 signApp 开头直接 return，**同时跳过 PE 资源编辑与签名**。
 * 后果是「换了 `.ico` 也只有安装器图标变，app exe / 桌面快捷方式 / 开始菜单 / 任务栏仍是
 * Electron 默认图标」：NSIS 模板建的快捷方式用 `$appExe 0`、`desktop-shortcut.ts` 用
 * `icon: exePath`、`window-manager.ts` 的 BrowserWindow 干脆没写 `icon`（Windows 下回退 exe 图标），
 * 三处全部跟随 exe 图标。而这条失效在改动前是**静默的**——没有任何用例读过这些字段。
 *
 * 判据全部落在「磁盘产物 + 配置」上，不 import electron、不碰 `release/`（该目录被 gitignore，
 * CI 单测 job 里没有它）。ICO 解析手写：零新依赖，且顺带钉住四档尺寸/深度不被改坏。
 *
 * 根路径刻意走 `new URL(rel, import.meta.url)` 而不是 `path.resolve(dirname(fileURLToPath(...)))`：
 * 后者在 test:posix-host 装置下必崩——该 profile 把 `path` 钉成 posix，而 import.meta.url 是宿主
 * 的 Windows 路径，`posix.dirname('D:\\…')` 返回 '.'，repoRoot 落到盘根后全部读取 ENOENT。
 * 与 `pack-identity-name.test.ts` 同一口径。
 */

const selfUrl = new URL(import.meta.url)
const repoRootUrl = new URL('../../', selfUrl)

const ICO_REL = 'resources/icons/icon.ico'
const MASTER_REL = 'resources/icons/icon-master.png'
const LEGACY_SVG_REL = 'resources/icons/icon.svg'
const GENERATOR_REL = 'scripts/generate-icon.js'

const readRepoFile = (rel: string): Buffer => readFileSync(new URL(rel, repoRootUrl))
const readRepoText = (rel: string): string => readFileSync(new URL(rel, repoRootUrl), 'utf-8')

// ---------------------------------------------------------------------------
// ICO / BMP 解析（仅覆盖本仓图标实际用到的形态：32bpp BMP 负载 + AND 位图）
// ---------------------------------------------------------------------------

interface IcoEntry {
  /** 边长；目录项写 0 表示 256 */
  size: number
  bpp: number
  payloadSize: number
  offset: number
  isPng: boolean
}

function parseIco(ico: Buffer): IcoEntry[] {
  const count = ico.readUInt16LE(4)
  const entries: IcoEntry[] = []
  for (let i = 0; i < count; i++) {
    const d = 6 + i * 16
    const offset = ico.readUInt32LE(d + 12)
    entries.push({
      size: ico[d] || 256,
      bpp: ico.readUInt16LE(d + 6),
      payloadSize: ico.readUInt32LE(d + 8),
      offset,
      isPng: ico.readUInt32LE(offset) === 0x09504e50
    })
  }
  return entries
}

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** BMP 负载：40 字节 BITMAPINFOHEADER + **bottom-up** BGRA 像素 + AND 位图 */
function bmpPixel(ico: Buffer, e: IcoEntry, x: number, y: number): Rgba {
  const pos = e.offset + 40 + ((e.size - y - 1) * e.size + x) * 4
  return { b: ico[pos], g: ico[pos + 1], r: ico[pos + 2], a: ico[pos + 3] }
}

/** AND 位图：1 = 该像素被掩掉（Windows 按透明画）；行按 32 位对齐 */
function bmpAndBit(ico: Buffer, e: IcoEntry, x: number, y: number): number {
  const stride = e.size % 32 === 0 ? e.size / 8 : 4 * (Math.floor(e.size / 32) + 1)
  const start = e.offset + 40 + e.size * e.size * 4
  return (ico[start + y * stride + (x >> 3)] >> (7 - (x % 8))) & 1
}

const CORNERS = (size: number): Array<[number, number]> => [
  [0, 0],
  [size - 1, 0],
  [0, size - 1],
  [size - 1, size - 1]
]

/** 逐像素比对主色不可靠（小尺寸档经重采样已混色），故用聚合统计做判据 */
function colorStats(ico: Buffer, e: IcoEntry): { blueDominantRatio: number; meanRMinusB: number } {
  let opaque = 0
  let blueDominant = 0
  let sumR = 0
  let sumB = 0
  const total = e.size * e.size
  for (let y = 0; y < e.size; y++) {
    for (let x = 0; x < e.size; x++) {
      const p = bmpPixel(ico, e, x, y)
      sumR += p.r
      sumB += p.b
      if (p.a > 0) {
        opaque++
        if (p.b - p.r > 30) blueDominant++
      }
    }
  }
  return {
    blueDominantRatio: opaque === 0 ? 1 : blueDominant / opaque,
    meanRMinusB: (sumR - sumB) / total
  }
}

const EXPECTED_SIZES = [16, 32, 48, 256]

describe('应用图标产物（resources/icons/icon.ico）', () => {
  const ico = readRepoFile(ICO_REL)
  const entries = parseIco(ico)

  // 回归守卫：改造生成链路时最容易漏档或漏深度，改前即绿，不作为红灯
  it('四档齐全、均为 32bpp BMP 负载且含 256 档', () => {
    expect(entries.map((e) => e.size).sort((a, b) => a - b)).toEqual(EXPECTED_SIZES)
    for (const e of entries) {
      expect(e.bpp).toBe(32)
      expect(e.isPng).toBe(false)
    }
    expect(entries.some((e) => e.size === 256)).toBe(true)
  })

  it('每档四角 alpha 为 0 且 AND 位为 1（圆角蒙版真正落到每一档）', () => {
    // 只断 256 档会得到假红灯：占位 SVG 自带 rx="48"，旧 ico 的 256/48/32 三档四角本来就是 0。
    // 真正失效的是 16 档——它由 png-to-ico 单参分支的二次 bicubic 生成，透明角被抹成半透明。
    for (const e of entries) {
      const alphas = CORNERS(e.size).map(([x, y]) => bmpPixel(ico, e, x, y).a)
      const andBits = CORNERS(e.size).map(([x, y]) => bmpAndBit(ico, e, x, y))
      expect(alphas, `${e.size}x${e.size} 四角 alpha`).toEqual([0, 0, 0, 0])
      expect(andBits, `${e.size}x${e.size} 四角 AND 位`).toEqual([1, 1, 1, 1])
    }
  })

  // 回归守卫：防半径公式误写成 size/2 之类把主体中心挖空
  it('每档中心像素保持不透明', () => {
    for (const e of entries) {
      const mid = e.size >> 1
      expect(bmpPixel(ico, e, mid, mid).a).toBe(255)
    }
  })

  it('配色已是新主源而非蓝色占位图（蓝主导占比 + 红蓝均值差双判据）', () => {
    for (const e of entries) {
      const s = colorStats(ico, e)
      expect(s.blueDominantRatio, `${e.size}x${e.size} 蓝主导占比`).toBeLessThan(0.05)
      expect(s.meanRMinusB, `${e.size}x${e.size} meanR-meanB`).toBeGreaterThan(10)
    }
  })
})

describe('图标主源与生成器', () => {
  it('主源存在、方形且边长不小于最大目标档', () => {
    expect(existsSync(new URL(MASTER_REL, repoRootUrl)), `${MASTER_REL} 缺失`).toBe(true)
    const png = readRepoFile(MASTER_REL)
    // PNG IHDR：8 字节签名 + 4 字节长度 + 4 字节类型，宽高各 4 字节大端
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(256)
    expect(png.readUInt32BE(16)).toBe(png.readUInt32BE(20))
  })

  it('蓝色占位 SVG 已退役，不再生成图标', () => {
    expect(existsSync(new URL(LEGACY_SVG_REL, repoRootUrl)), '占位 SVG 应已删除').toBe(false)
    const gen = readRepoText(GENERATOR_REL)
    // 判据取「带引号的路径字面量」而非裸子串：注释里作为历史叙述提到 icon.svg 是允许的，
    // 只要不再把它当输入源。改造前是 path.join(..., 'icon.svg')，命中本判据。
    expect(gen, '生成器仍把 icon.svg 当输入源').not.toMatch(/['"`]icon\.svg['"`]/)
    // 正向锁：主源必须是那张方形 PNG，防止将来有人换回别的输入而绕开上面那条
    expect(gen).toMatch(/['"`]icon-master\.png['"`]/)
  })
})

describe('electron-builder 的 PE 资源编辑开关', () => {
  interface WinConfig {
    signExecutable?: boolean
    signAndEditExecutable?: boolean
    icon?: string
  }
  const win = (JSON.parse(readRepoText('package.json')).build as { win?: WinConfig }).win

  it('已启用资源编辑且仍不签名（否则 exe / 快捷方式 / 任务栏图标全部失效）', () => {
    expect(win, 'build.win 缺失').toBeDefined()
    expect(win!.signExecutable, '应显式关闭签名').toBe(false)
    // 反向锁不可省：只断 signExecutable 的话，将来有人把 signAndEditExecutable: false
    // 加回来仍然满足前者，而那个值才是让 signApp 提前 return 的开关。
    expect(
      'signAndEditExecutable' in win!,
      'signAndEditExecutable 必须整键移除，false 会跳过 PE 资源编辑'
    ).toBe(false)
    expect(win!.icon).toBe('resources/icons/icon.ico')
  })
})

describe('生成器纯函数', () => {
  interface GeneratorModule {
    ICO_SIZES?: readonly number[]
    radiusFor?: (size: number) => number
    roundedRectCoverage?: (width: number, height: number, radius: number, ss?: number) => Uint8Array
    applyCoverageToAlpha?: (raw: Buffer, coverage: Uint8Array) => Buffer
    assertSquareMaster?: (width: number, height: number) => void
  }

  it('导出圆角几何与主源校验的纯函数', async () => {
    const gen = (await import('../generate-icon.js')) as unknown as GeneratorModule
    expect(typeof gen.radiusFor, 'radiusFor 未导出').toBe('function')
    expect(typeof gen.roundedRectCoverage, 'roundedRectCoverage 未导出').toBe('function')
    expect(typeof gen.applyCoverageToAlpha, 'applyCoverageToAlpha 未导出').toBe('function')
    expect(typeof gen.assertSquareMaster, 'assertSquareMaster 未导出').toBe('function')
    expect(gen.ICO_SIZES).toEqual([48, 32, 16, 256])
  })

  it('半径逐档取值，并被上下界夹住', async () => {
    const gen = (await import('../generate-icon.js')) as unknown as GeneratorModule
    expect(gen.radiusFor!(16)).toBe(3)
    expect(gen.radiusFor!(32)).toBe(6)
    expect(gen.radiusFor!(48)).toBe(9)
    expect(gen.radiusFor!(256)).toBe(48)
    // 下界：极小档不退化成圆点；上界：将来加 512/1024 档也不会变成正圆
    expect(gen.radiusFor!(4)).toBe(2)
    expect(gen.radiusFor!(1024)).toBe(192)
  })

  it('圆角蒙版对称且面积吻合解析式（半像素陷阱的常驻守卫）', async () => {
    const gen = (await import('../generate-icon.js')) as unknown as GeneratorModule
    // 判据取自圆角矩形的两条几何性质，而不是硬编码某个像素值：
    // ① 蒙版必须关于中心严格对称——SDF 中心若误写成 (w−1)/2 会整体偏 0.5px，
    //    使左上角带比右下角带宽，实测在 8/16/32/48/256 五档分别造成 52/92/180/292/1540 处不对称；
    // ② 覆盖率之和（折算成像素数）必须等于圆角矩形面积 w·h − 4r² + πr²，
    //    正确实现各档偏差 ≤0.73，误写中心则达 −14.6 至 −510.7。
    const cases: Array<[number, number]> = [
      [8, 2],
      [16, 3],
      [48, 9],
      [256, 48]
    ]
    for (const [n, r] of cases) {
      const cov = gen.roundedRectCoverage!(n, n, r)
      expect(cov.length, `${n}x${n} 长度`).toBe(n * n)

      let asymmetric = 0
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          if (cov[y * n + x] !== cov[y * n + (n - 1 - x)]) asymmetric++
          if (cov[y * n + x] !== cov[(n - 1 - y) * n + x]) asymmetric++
        }
      }
      expect(asymmetric, `${n}x${n} r=${r} 对称性违例数`).toBe(0)

      let sum = 0
      for (const v of cov) sum += v
      const exactArea = n * n - 4 * r * r + Math.PI * r * r
      expect(Math.abs(sum / 255 - exactArea), `${n}x${n} r=${r} 蒙版面积偏差`).toBeLessThan(1.5)
    }
  })

  it('生产档位四角全透明、四边中点与中心满覆盖', async () => {
    const gen = (await import('../generate-icon.js')) as unknown as GeneratorModule
    // 8×8 不在此列：r=2 时角像素离圆心最近处已在圆内，实测覆盖率为 96 而非 0。
    // 真正要钉的是出货的四个尺寸，它们与 roundedRectCoverage 一起构成 exe 图标的透明角保证。
    for (const n of [16, 32, 48, 256]) {
      const cov = gen.roundedRectCoverage!(n, n, gen.radiusFor!(n))
      const mid = n >> 1
      expect([cov[0], cov[n - 1], cov[(n - 1) * n], cov[n * n - 1]], `${n} 四角`).toEqual([
        0, 0, 0, 0
      ])
      expect(
        [cov[mid], cov[(n - 1) * n + mid], cov[mid * n], cov[mid * n + n - 1]],
        `${n} 四边中点`
      ).toEqual([255, 255, 255, 255])
      expect(cov[mid * n + mid], `${n} 中心`).toBe(255)
    }
  })

  it('主源非方形 / 边长不足时拒绝，而不是静默产出坏图标', async () => {
    const gen = (await import('../generate-icon.js')) as unknown as GeneratorModule
    // png-to-ico 的 imagesToIco 用 height = width * 2 假定正方形，非方图会静默产出坏图标
    expect(() => gen.assertSquareMaster!(8, 4)).toThrow(/8×4/)
    expect(() => gen.assertSquareMaster!(128, 128)).toThrow(/256/)
    expect(() => gen.assertSquareMaster!(256, 256)).not.toThrow()
  })

  it('被 import 时不写产物（防测试覆写 icon.ico 这种非幂等隐患）', async () => {
    const before = statSync(new URL(ICO_REL, repoRootUrl)).mtimeMs
    await import('../generate-icon.js')
    // 旧实现是模块顶层直调 generateIcon() 且不 await，写入会在随后任意时刻落地
    await new Promise((resolve) => setTimeout(resolve, 200))
    const after = statSync(new URL(ICO_REL, repoRootUrl)).mtimeMs
    expect(after, 'import 生成器导致 icon.ico 被覆写').toBe(before)
  })
})
