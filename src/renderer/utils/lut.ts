export interface Lut3D {
  id: string
  name: string
  /** i18n key，内置 LUT 用此字段渲染中文名；自定义 LUT 缺省，回退用 name */
  nameKey?: string
  size: number
  data: Float32Array
  // P1-U11：自定义 LUT 导入时保留原始 .cube 文本，用于持久化序列化
  __rawContent?: string
}

export function clamp(v: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, v))
}

export function parseCube(content: string, id: string, name: string): Lut3D | null {
  const lines = content.split(/\r?\n/)
  let size = 0
  let title = name
  const values: number[] = []

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.toLowerCase().startsWith('title')) {
      const m = line.match(/"([^"]*)"/)
      if (m) title = m[1]
      continue
    }
    if (line.toLowerCase().startsWith('lut_3d_size')) {
      const parts = line.split(/\s+/)
      size = parseInt(parts[1], 10)
      continue
    }
    if (line.toLowerCase().startsWith('lut_1d_size') || line.toLowerCase().startsWith('domain_')) {
      // 1D LUT and domain metadata not supported in this simplified parser
      continue
    }
    // U14：parseCube 容错——空行/注释行/字段数不足 3 或含 NaN 时自动跳过；末尾校验 size 与 values 数量匹配
    const parts = line.split(/\s+/).map(Number)
    if (parts.length >= 3 && parts.every((n) => !isNaN(n))) {
      values.push(parts[0], parts[1], parts[2])
    }
  }

  if (size <= 0 || values.length !== size * size * size * 3) {
    return null
  }

  return {
    id,
    name: title || name,
    size,
    data: new Float32Array(values)
  }
}

export function sampleLut3D(lut: Lut3D, r: number, g: number, b: number): [number, number, number] {
  const { size, data } = lut
  const maxIndex = size - 1

  const rPos = clamp(r) * maxIndex
  const gPos = clamp(g) * maxIndex
  const bPos = clamp(b) * maxIndex

  const rLow = Math.floor(rPos)
  const gLow = Math.floor(gPos)
  const bLow = Math.floor(bPos)
  const rHigh = Math.min(rLow + 1, maxIndex)
  const gHigh = Math.min(gLow + 1, maxIndex)
  const bHigh = Math.min(bLow + 1, maxIndex)

  const rFrac = rPos - rLow
  const gFrac = gPos - gLow
  const bFrac = bPos - bLow

  function get(x: number, y: number, z: number, c: number): number {
    const index = ((z * size + y) * size + x) * 3 + c
    return data[index]
  }

  const out: number[] = []
  for (let c = 0; c < 3; c++) {
    const c000 = get(rLow, gLow, bLow, c)
    const c100 = get(rHigh, gLow, bLow, c)
    const c010 = get(rLow, gHigh, bLow, c)
    const c110 = get(rHigh, gHigh, bLow, c)
    const c001 = get(rLow, gLow, bHigh, c)
    const c101 = get(rHigh, gLow, bHigh, c)
    const c011 = get(rLow, gHigh, bHigh, c)
    const c111 = get(rHigh, gHigh, bHigh, c)

    const c00 = c000 + (c100 - c000) * rFrac
    const c10 = c010 + (c110 - c010) * rFrac
    const c01 = c001 + (c101 - c001) * rFrac
    const c11 = c011 + (c111 - c011) * rFrac

    const c0 = c00 + (c10 - c00) * gFrac
    const c1 = c01 + (c11 - c01) * gFrac

    out.push(c0 + (c1 - c0) * bFrac)
  }

  return [out[0], out[1], out[2]]
}

export function applyLut3D(imageData: ImageData, lut: Lut3D): ImageData {
  const { data } = imageData
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255
    const g = data[i + 1] / 255
    const b = data[i + 2] / 255
    const [nr, ng, nb] = sampleLut3D(lut, r, g, b)
    data[i] = clamp(nr * 255, 0, 255)
    data[i + 1] = clamp(ng * 255, 0, 255)
    data[i + 2] = clamp(nb * 255, 0, 255)
  }
  return imageData
}

export function createBuiltInLut(
  id: string,
  name: string,
  size: number,
  fn: (r: number, g: number, b: number) => [number, number, number],
  nameKey?: string
): Lut3D {
  const data = new Float32Array(size * size * size * 3)
  let idx = 0
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const r = x / (size - 1)
        const g = y / (size - 1)
        const b = z / (size - 1)
        const [nr, ng, nb] = fn(r, g, b)
        data[idx++] = nr
        data[idx++] = ng
        data[idx++] = nb
      }
    }
  }
  return { id, name, size, data, nameKey }
}

export const builtInLuts: Lut3D[] = [
  createBuiltInLut('identity', 'Identity', 17, (r, g, b) => [r, g, b], 'lut.builtin.identity'),
  createBuiltInLut(
    'teal-orange',
    'Teal & Orange',
    17,
    (r, g, b) => {
      const nr = r * 0.9 + g * 0.1
      const ng = g * 0.85 + b * 0.15
      const nb = b * 0.75 + g * 0.25
      return [clamp(nr), clamp(ng), clamp(nb)]
    },
    'lut.builtin.tealOrange'
  ),
  createBuiltInLut(
    'warm-vintage',
    'Warm Vintage',
    17,
    (r, g, b) => {
      return [clamp(r * 1.1), clamp(g * 0.95 + r * 0.05), clamp(b * 0.85)]
    },
    'lut.builtin.warmVintage'
  ),
  createBuiltInLut(
    'cool-drama',
    'Cool Drama',
    17,
    (r, g, b) => {
      return [clamp(r * 0.9), clamp(g * 0.95), clamp(b * 1.1)]
    },
    'lut.builtin.coolDrama'
  ),
  createBuiltInLut(
    'high-contrast',
    'High Contrast',
    17,
    (r, g, b) => {
      const contrast = (v: number) => clamp((v - 0.5) * 1.3 + 0.5)
      return [contrast(r), contrast(g), contrast(b)]
    },
    'lut.builtin.highContrast'
  )
]
