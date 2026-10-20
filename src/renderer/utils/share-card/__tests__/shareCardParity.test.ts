import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import vm from 'node:vm'
import { buildShareCardPayload, layoutShareCards, type ShareCardPayload } from '../shareCardModel'
import { renderShareCardPage, type ShareCardCopy } from '../shareCardRender'

/**
 * 阶段 5 · B3：参考实现 vs 本仓实现的对拍。
 *
 * 这是「分享图与 NikkiSync 原生效果一致」这条验收项**唯一可证的形态**：
 * `fixtures/share-card.reference.txt` 是上游 `share-card.js`（commit d4ca7d7）的逐字节副本，
 * 本用例把**同一个录制型假 ctx** 先喂给参考实现（中文 label 行），再喂给本仓实现
 * （规范键 + 注入的 zh-CN 文案），断言两者的 canvas op 序列与坐标逐项相等。
 *
 * 对拍覆盖的是**几何等价 / 语义等价 / 降级等价**三条；字体像素渲染不在范围内
 * （小程序 Skia 与 Chromium Skia 的字形 hinting 不同），理由见
 * docs/plans/2026-10-15-sync-gallery-share-card-metadata.md §0.2。
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/share-card.reference.txt', import.meta.url))
/**
 * 上游 NikkiSync @ d4ca7d7 的该文件哈希；副本被改动即在此处红。
 *
 * 值是**行尾归一为 LF 之后**的 sha256：本仓不设 `.gitattributes`（AGENTS.md §5 明令），
 * 开发机 `core.autocrlf=true` 会把工作副本存成 CRLF，而 CI checkout 出来是 LF，
 * 直接散列工作区字节会让同一条守卫只在某一侧成立（2026-10-19 CI 即为此红）。
 * 归一后散列的就是**被跟踪的内容本身**，与上游 git blob 逐字对齐。
 * 取证：`git show HEAD:<fixture>` 的 blob 散列 = 本机 LF 归一散列 = CI 收到的值。
 */
const REFERENCE_SHA256 = 'c4f076d99c72282a5bf9a6f5f7411de6cab48e14638cdceb1bcce185bb8df1bc'

/** 读夹具字节并把行尾归一为 LF（见上注）；除此之外不改内容，任何字节改动仍然会红。 */
function readFixtureBytes(): Buffer {
  return Buffer.from(fs.readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n'), 'utf8')
}

// —— 两套输入：同一份数据，上游用中文 label，本仓用规范键 ————————————————————
// 说明：本仓的中文硬编码护栏不作用于测试文件，故这里的中文无需 eslint-disable。

// —— 录制型假 ctx ————————————————————————————————————————————————
type Op = [string, ...(string | number | null)[]]

function createRecorder(): {
  ctx: never
  ops: Op[]
  reset: () => void
} {
  const ops: Op[] = []
  const normalize = (value: unknown): string | number | null => {
    if (value === null || value === undefined) return null
    if (typeof value === 'object') return '<obj>'
    if (typeof value === 'function') return '<fn>'
    return typeof value === 'number' || typeof value === 'string' ? value : String(value)
  }
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      ops.push([name, ...args.map(normalize)])
      if (name === 'measureText') return { width: String(args[0] ?? '').length * 20 }
      return undefined
    }
  const target: Record<string, unknown> = {}
  const methods = [
    'fillRect',
    'fillText',
    'drawImage',
    'save',
    'restore',
    'translate',
    'rotate',
    'beginPath',
    'moveTo',
    'lineTo',
    'quadraticCurveTo',
    'closePath',
    'fill',
    'stroke',
    'arc',
    'measureText'
  ]
  for (const name of methods) target[name] = record(name)
  const handler = {
    set(obj: Record<string, unknown>, prop: string, value: unknown): boolean {
      ops.push(['set:' + prop, normalize(value)])
      obj[prop] = value
      return true
    }
  }
  const ctx = new Proxy(target, handler) as unknown
  return { ctx: ctx as never, ops, reset: () => ops.splice(0, ops.length) }
}

// —— 参考实现加载（CommonJS + node:vm，与上游 render-share-preview.mjs 同法）———
// 上游 `share-card.js:178` 只导出了 buildPayload/layoutCards/createShareCardJob/saveShareCard，
// `render` 与 `rounded` 是模块内私有函数。夹具必须保持逐字节副本（哈希被上面那条用例钉住），
// 所以在这里**加载时**追加一行导出，而不是改动夹具本体。
const EXPORT_TAIL =
  '\nmodule.exports.render=render;module.exports.rounded=rounded;module.exports.parameterPresentation=parameterPresentation;'

function loadReference(): {
  buildPayload: (input: unknown) => unknown
  layoutCards: (ctx: unknown, payload: unknown) => unknown[]
  render: (...args: unknown[]) => void
} {
  const source = fs.readFileSync(FIXTURE, 'utf8') + EXPORT_TAIL
  const moduleShim = { exports: {} as Record<string, unknown> }
  const sandbox = {
    module: moduleShim,
    exports: moduleShim.exports,
    require: (name: string) => {
      throw new Error(`reference fixture must not require ${name}`)
    },
    console,
    Error,
    Math,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    Promise,
    RegExp,
    JSON,
    Boolean,
    Date,
    isNaN,
    parseInt,
    parseFloat,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    Uint8Array
  }
  vm.runInNewContext(source, sandbox, { filename: 'share-card.reference.txt' })
  return moduleShim.exports as ReturnType<typeof loadReference>
}

// —— 两套输入：同一份数据，上游用中文 label，本仓用规范键 ————————————————————
const CHINESE_ROWS: { label: string; value: string }[] = [
  { label: '游戏版本', value: '1.3.2' },
  { label: '焦距', value: '50' },
  { label: '镜头旋转', value: '12' },
  { label: '光圈', value: '2.8' },
  { label: '景深', value: '3' },
  { label: '晕影', value: '20' },
  { label: '柔光强度', value: '35' },
  { label: '柔光范围', value: '0.4' },
  { label: '曝光', value: '-0.3' },
  { label: '亮度', value: '10' },
  { label: '对比度', value: '-0.2' },
  { label: '饱和度', value: '0.5' },
  { label: '鲜艳度', value: '0.1' },
  { label: '高光', value: '-0.5' },
  { label: '阴影', value: '0.6' },
  { label: '动作', value: '奔跑' },
  { label: '光照', value: '黄昏' },
  { label: '滤镜', value: '柔雾' },
  { label: '地点', value: '誓言泉' }
]

const CANONICAL_KEYS: string[] = [
  'gameVersion',
  'focalLength',
  'rotation',
  'aperture',
  'depthOfField',
  'vignette',
  'bloomStrength',
  'bloomRange',
  'exposure',
  'brightness',
  'contrast',
  'saturation',
  'vibrance',
  'highlights',
  'shadows',
  'action',
  'lighting',
  'filter',
  'location'
]

const OUTFITS = [
  { name: '星尘旅人外套', iconSource: 'item', hasIcon: false },
  { name: '誓言裙摆', iconSource: 'category', hasIcon: false },
  { name: '晨光发饰', iconSource: 'item', hasIcon: false },
  { name: '', iconSource: 'item', hasIcon: false }
]

/** 与 zh-CN 语言包逐字一致的注入文案（上游 render 里的中文全在这里）。 */
const ZH_COPY: ShareCardCopy = {
  brand: 'NikkiSync',
  fallbackTitle: '无限暖暖摄影',
  outfitHeading: '穿搭',
  parameterHeading: '拍摄参数',
  iconMissing: '图标暂缺',
  categoryBadge: '分类示意',
  noOutfit: '暂无穿搭数据',
  footer: 'NikkiSync · 穿搭与摄影记录',
  parameterLabels: {
    focalLength: '焦距调节',
    aperture: '光圈调节',
    vignette: '晕影调节',
    bloom: '柔光强度',
    bloomRange: '柔光范围',
    brightness: '亮度',
    exposure: '曝光',
    contrast: '对比度',
    saturation: '饱和度',
    naturalSaturation: '自然饱和',
    highlights: '高光',
    shadows: '阴影',
    rotation: '镜头旋转',
    depthOfField: '景深',
    action: '动作',
    lighting: '光照',
    filter: '滤镜',
    location: '地点'
  },
  effectLabels: { action: '动作', lighting: '光照', filter: '滤镜', location: '地点' }
}

/** 参考实现 layoutCards 的返回页：只需要 render 会读到的那几个字段。 */
type ReferencePage = { height: number; outfit: unknown[]; parameters: unknown[] }

function referencePages(
  reference: ReturnType<typeof loadReference>,
  ctx: unknown,
  payload: unknown
): ReferencePage[] {
  return reference.layoutCards(ctx, payload) as ReferencePage[]
}

function referencePayload(reference: ReturnType<typeof loadReference>): ShareCardPayload {
  return reference.buildPayload({
    date: '2026-10-15',
    rows: CHINESE_ROWS,
    outfits: OUTFITS.map((item, index) => ({ ...item, key: `k${index}`, iconPath: '' }))
  }) as unknown as ShareCardPayload
}

function minePayload(): ShareCardPayload {
  return buildShareCardPayload({
    date: '2026-10-15',
    rows: CHINESE_ROWS.map((row, index) => ({ key: CANONICAL_KEYS[index], value: row.value })),
    outfits: OUTFITS.map((item, index) => ({ ...item, key: `k${index}` }))
  })
}

describe('B3 参考实现来源', () => {
  it('夹具与上游 share-card.js@d4ca7d7 内容一致（行尾归一后逐字节）', () => {
    const digest = crypto.createHash('sha256').update(readFixtureBytes()).digest('hex')
    expect(digest).toBe(REFERENCE_SHA256)
  })

  it('异常：夹具内容被改动一个字符即判红（归一行尾没有弱化守卫）', () => {
    const tampered = Buffer.from(
      readFixtureBytes().toString('utf8').replace('share', 'shaxe'),
      'utf8'
    )
    const digest = crypto.createHash('sha256').update(tampered).digest('hex')
    expect(digest).not.toBe(REFERENCE_SHA256)
  })
})

describe('B3 对拍：载荷语义等价', () => {
  it('两套实现产出的 payload 结构等价（date/version/outfit/camera/effects）', () => {
    const reference = loadReference()
    const a = referencePayload(reference)
    const b = minePayload()
    expect(b.date).toBe(a.date)
    expect(b.version).toBe(a.version)
    // 穿搭名：上游靠中文占位正则判空，本仓靠结构判据；同一输入下结果必须一致
    expect(b.outfit.map((item) => [item.value, item.iconSource])).toEqual(
      a.outfit.map((item) => [item.value, item.iconSource])
    )
    expect(b.camera.length).toBe(a.camera.length)
    expect(b.effects.length).toBe(a.effects.length)
  })
})

describe('B3 对拍：布局与绘制的 op 序列等价', () => {
  it('单页（4 条穿搭 + 12 参数 + 2 追加 + 4 效果）op 序列逐项相等', () => {
    const reference = loadReference()
    const refRecorder = createRecorder()
    const refPayload = referencePayload(reference)
    const refPages = referencePages(reference, refRecorder.ctx, refPayload)
    refRecorder.reset()
    for (let index = 0; index < refPages.length; index++) {
      reference.render(
        refRecorder.ctx,
        { width: 2000, height: 1200 },
        refPages[index],
        refPayload,
        index,
        refPages.length,
        0,
        null,
        new Map()
      )
    }

    const mineRecorder = createRecorder()
    const myPayload = minePayload()
    const myPages = layoutShareCards(mineRecorder.ctx as never, myPayload)
    mineRecorder.reset()
    for (let index = 0; index < myPages.length; index++) {
      renderShareCardPage(mineRecorder.ctx as never, {
        image: { width: 2000, height: 1200 },
        soft: null,
        page: myPages[index],
        payload: myPayload,
        index,
        total: myPages.length,
        rotation: 0,
        copy: ZH_COPY,
        icons: new Map()
      })
    }

    expect(refPages.length).toBe(myPages.length)
    expect(mineRecorder.ops).toEqual(refRecorder.ops)
  })

  it('旋转 90 度时照片变换一致', () => {
    const reference = loadReference()
    const refRecorder = createRecorder()
    const refPayload = referencePayload(reference)
    const refPages = referencePages(reference, refRecorder.ctx, refPayload)
    refRecorder.reset()
    reference.render(
      refRecorder.ctx,
      { width: 1200, height: 2000 },
      refPages[0],
      refPayload,
      0,
      1,
      90,
      null,
      new Map()
    )

    const mineRecorder = createRecorder()
    const myPayload = minePayload()
    const myPages = layoutShareCards(mineRecorder.ctx as never, myPayload)
    mineRecorder.reset()
    renderShareCardPage(mineRecorder.ctx as never, {
      image: { width: 1200, height: 2000 },
      soft: null,
      page: myPages[0],
      payload: myPayload,
      index: 0,
      total: 1,
      rotation: 90,
      copy: ZH_COPY,
      icons: new Map()
    })
    expect(mineRecorder.ops).toEqual(refRecorder.ops)
  })

  it('降级等价：无穿搭、无参数时两侧都走空态与全破折号分支', () => {
    const reference = loadReference()
    const refRecorder = createRecorder()
    const refPayload = reference.buildPayload({ date: '', rows: [], outfits: [] }) as never
    const refPages = referencePages(reference, refRecorder.ctx, refPayload)
    refRecorder.reset()
    reference.render(
      refRecorder.ctx,
      { width: 800, height: 600 },
      refPages[0],
      refPayload,
      0,
      1,
      0,
      null,
      new Map()
    )

    const mineRecorder = createRecorder()
    const myPayload = buildShareCardPayload({ date: '', rows: [], outfits: [] })
    const myPages = layoutShareCards(mineRecorder.ctx as never, myPayload)
    mineRecorder.reset()
    renderShareCardPage(mineRecorder.ctx as never, {
      image: { width: 800, height: 600 },
      soft: null,
      page: myPages[0],
      payload: myPayload,
      index: 0,
      total: 1,
      rotation: 0,
      copy: ZH_COPY,
      icons: new Map()
    })
    expect(myPages[0].height).toBe(refPages[0].height)
    expect(mineRecorder.ops).toEqual(refRecorder.ops)
  })

  it('多页分页时两页的 op 序列都相等', () => {
    const reference = loadReference()
    const many = Array.from({ length: 60 }, (_, i) => ({
      name: `名称${i}`,
      iconSource: 'item',
      hasIcon: false,
      key: `k${i}`,
      iconPath: ''
    }))
    const refRecorder = createRecorder()
    const refPayload = reference.buildPayload({
      date: '2026-10-15',
      rows: CHINESE_ROWS.slice(0, 6),
      outfits: many
    }) as never
    const refPages = referencePages(reference, refRecorder.ctx, refPayload)
    expect(refPages.length).toBeGreaterThan(1)
    refRecorder.reset()
    refPages.forEach((page, index) =>
      reference.render(
        refRecorder.ctx,
        { width: 900, height: 900 },
        page,
        refPayload,
        index,
        refPages.length,
        0,
        null,
        new Map()
      )
    )

    const mineRecorder = createRecorder()
    const myPayload = buildShareCardPayload({
      date: '2026-10-15',
      rows: CHINESE_ROWS.slice(0, 6).map((row, index) => ({
        key: CANONICAL_KEYS[index],
        value: row.value
      })),
      outfits: many
    })
    const myPages = layoutShareCards(mineRecorder.ctx as never, myPayload)
    mineRecorder.reset()
    myPages.forEach((page, index) =>
      renderShareCardPage(mineRecorder.ctx as never, {
        image: { width: 900, height: 900 },
        soft: null,
        page,
        payload: myPayload,
        index,
        total: myPages.length,
        rotation: 0,
        copy: ZH_COPY,
        icons: new Map()
      })
    )
    expect(myPages.length).toBe(refPages.length)
    expect(mineRecorder.ops).toEqual(refRecorder.ops)
  })
})

describe('rotation 归一化（阶段 5 参数校验：只接受 {0,90,180,270}，其余归一为 0）', () => {
  it('非法角度 45 不得产生 45° 旋转 op', () => {
    const recorder = createRecorder()
    const payload = minePayload()
    const pages = layoutShareCards(recorder.ctx as never, payload)
    recorder.reset()
    renderShareCardPage(recorder.ctx as never, {
      image: { width: 900, height: 900 },
      soft: null,
      page: pages[0],
      payload,
      index: 0,
      total: 1,
      rotation: 45,
      copy: ZH_COPY,
      icons: new Map()
    })
    const rotateOp = recorder.ops.find((op) => op[0] === 'rotate')
    expect(rotateOp).toBeDefined()
    expect(rotateOp?.[1]).toBe(0)
  })
})
