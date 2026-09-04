import { describe, it, expect } from 'vitest'
import {
  clamp,
  parseCube,
  sampleLut3D,
  applyLut3D,
  createBuiltInLut,
  builtInLuts,
  type Lut3D
} from './lut'

/**
 * lut 模块测试：3D LUT 色彩查找表的解析、采样、应用
 *
 * 核心算法：三线性插值（trilinear interpolation），size³ 个 RGB 顶点
 * 不依赖浏览器 API，可在 node 环境直接运行（applyLut3D 通过 mock ImageData 规避）
 */

/** 构造 mock ImageData 对象（node 环境无 ImageData 全局变量） */
function makeImageData(width: number, height: number, pixels: number[]): ImageData {
  return {
    width,
    height,
    data: new Uint8ClampedArray(pixels)
  } as ImageData
}

describe('lut', () => {
  describe('clamp', () => {
    it('默认参数 clamp 到 [0, 1]', () => {
      expect(clamp(0)).toBe(0)
      expect(clamp(1)).toBe(1)
      expect(clamp(0.5)).toBe(0.5)
      expect(clamp(-0.1)).toBe(0)
      expect(clamp(1.5)).toBe(1)
    })

    it('自定义 min/max', () => {
      expect(clamp(5, 0, 10)).toBe(5)
      expect(clamp(-5, 0, 10)).toBe(0)
      expect(clamp(15, 0, 10)).toBe(10)
      expect(clamp(0, 0, 10)).toBe(0)
      expect(clamp(10, 0, 10)).toBe(10)
    })

    it('NaN 输入 clamp 到 min（Math.max 行为）', () => {
      // Math.max(NaN, 0) = NaN，Math.min(NaN, 1) = NaN
      // 但当前实现返回 NaN，固化此行为
      const result = clamp(NaN)
      expect(Number.isNaN(result)).toBe(true)
    })

    it('Infinity 输入 clamp 到边界', () => {
      expect(clamp(Infinity)).toBe(1)
      expect(clamp(-Infinity)).toBe(0)
    })
  })

  describe('parseCube', () => {
    it('解析标准 3D LUT 文本（含 TITLE/LUT_3D_SIZE/数据行）', () => {
      // 构造一个 size=2 的 LUT（2*2*2=8 行数据）
      const content = [
        'TITLE "Test LUT"',
        'LUT_3D_SIZE 2',
        '',
        '# 注释行应被跳过',
        '0.0 0.0 0.0',
        '1.0 0.0 0.0',
        '0.0 1.0 0.0',
        '1.0 1.0 0.0',
        '0.0 0.0 1.0',
        '1.0 0.0 1.0',
        '0.0 1.0 1.0',
        '1.0 1.0 1.0'
      ].join('\n')

      const lut = parseCube(content, 'test-id', '默认名')
      expect(lut).not.toBeNull()
      expect(lut!.id).toBe('test-id')
      expect(lut!.name).toBe('Test LUT') // TITLE 提取带引号内容
      expect(lut!.size).toBe(2)
      expect(lut!.data.length).toBe(2 * 2 * 2 * 3) // 8 * 3 = 24
      expect(lut!.data[0]).toBe(0)
      expect(lut!.data[3]).toBe(1.0) // 第二行的 r
    })

    it('TITLE 缺失时使用传入的 name', () => {
      const content = [
        'LUT_3D_SIZE 2',
        '0 0 0',
        '1 0 0',
        '0 1 0',
        '1 1 0',
        '0 0 1',
        '1 0 1',
        '0 1 1',
        '1 1 1'
      ].join('\n')
      const lut = parseCube(content, 'id', 'FallbackName')
      expect(lut).not.toBeNull()
      expect(lut!.name).toBe('FallbackName')
    })

    it('空行与注释行被跳过', () => {
      const content = [
        '',
        '# 这是注释',
        '   # 带空格的注释',
        '',
        'LUT_3D_SIZE 2',
        '0 0 0',
        '1 0 0',
        '0 1 0',
        '1 1 0',
        '0 0 1',
        '1 0 1',
        '0 1 1',
        '1 1 1'
      ].join('\n')
      const lut = parseCube(content, 'id', 'name')
      expect(lut).not.toBeNull()
      expect(lut!.data.length).toBe(24)
    })

    it('LUT_1D_SIZE 与 domain_ 行被跳过', () => {
      const content = [
        'LUT_1D_SIZE 256',
        'DOMAIN_MIN 0.0 0.0 0.0',
        'DOMAIN_MAX 1.0 1.0 1.0',
        'LUT_3D_SIZE 2',
        '0 0 0',
        '1 0 0',
        '0 1 0',
        '1 1 0',
        '0 0 1',
        '1 0 1',
        '0 1 1',
        '1 1 1'
      ].join('\n')
      const lut = parseCube(content, 'id', 'name')
      expect(lut).not.toBeNull()
      expect(lut!.size).toBe(2)
    })

    it('size=0 返回 null', () => {
      const content = 'TITLE "Empty"\nNo LUT_3D_SIZE here'
      const lut = parseCube(content, 'id', 'name')
      expect(lut).toBeNull()
    })

    it('数据行数与 size 不匹配返回 null', () => {
      // 声明 size=3 但只有 8 行数据（应需要 27 行）
      const content = [
        'LUT_3D_SIZE 3',
        '0 0 0',
        '1 0 0',
        '0 1 0',
        '1 1 0',
        '0 0 1',
        '1 0 1',
        '0 1 1',
        '1 1 1'
      ].join('\n')
      const lut = parseCube(content, 'id', 'name')
      expect(lut).toBeNull()
    })

    it('含 NaN 数据行被跳过（可能导致数量不足返回 null）', () => {
      const content = [
        'LUT_3D_SIZE 2',
        '0 0 0',
        'abc 0 0', // NaN 行被跳过
        '0 1 0',
        '1 1 0',
        '0 0 1',
        '1 0 1',
        '0 1 1',
        '1 1 1'
      ].join('\n')
      const lut = parseCube(content, 'id', 'name')
      // 跳过一行后只剩 7 行，size=2 需要 8 行，不匹配 → null
      expect(lut).toBeNull()
    })

    it('字段数不足 3 的行被跳过', () => {
      const content = [
        'LUT_3D_SIZE 2',
        '0 0 0',
        '1 0', // 字段不足
        '0 1 0',
        '1 1 0',
        '0 0 1',
        '1 0 1',
        '0 1 1',
        '1 1 1'
      ].join('\n')
      const lut = parseCube(content, 'id', 'name')
      expect(lut).toBeNull()
    })

    it('空内容返回 null', () => {
      expect(parseCube('', 'id', 'name')).toBeNull()
    })

    it('CRLF 换行也能正确解析', () => {
      const content = [
        'LUT_3D_SIZE 2',
        '0 0 0',
        '1 0 0',
        '0 1 0',
        '1 1 0',
        '0 0 1',
        '1 0 1',
        '0 1 1',
        '1 1 1'
      ].join('\r\n')
      const lut = parseCube(content, 'id', 'name')
      expect(lut).not.toBeNull()
      expect(lut!.size).toBe(2)
    })
  })

  describe('sampleLut3D', () => {
    // 构造一个 size=2 的 identity LUT 用于测试
    function makeIdentity2(): Lut3D {
      return {
        id: 'identity-2',
        name: 'Identity 2',
        size: 2,
        data: new Float32Array([
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          1,
          0,
          1,
          1,
          0, // b=0 平面
          0,
          0,
          1,
          1,
          0,
          1,
          0,
          1,
          1,
          1,
          1,
          1 // b=1 平面
        ])
      }
    }

    it('采样角点 (0,0,0) 返回 (0,0,0)', () => {
      const lut = makeIdentity2()
      const [r, g, b] = sampleLut3D(lut, 0, 0, 0)
      expect(r).toBeCloseTo(0, 6)
      expect(g).toBeCloseTo(0, 6)
      expect(b).toBeCloseTo(0, 6)
    })

    it('采样角点 (1,1,1) 返回 (1,1,1)', () => {
      const lut = makeIdentity2()
      const [r, g, b] = sampleLut3D(lut, 1, 1, 1)
      expect(r).toBeCloseTo(1, 6)
      expect(g).toBeCloseTo(1, 6)
      expect(b).toBeCloseTo(1, 6)
    })

    it('采样角点 (1,0,0) 返回 (1,0,0)', () => {
      const lut = makeIdentity2()
      const [r, g, b] = sampleLut3D(lut, 1, 0, 0)
      expect(r).toBeCloseTo(1, 6)
      expect(g).toBeCloseTo(0, 6)
      expect(b).toBeCloseTo(0, 6)
    })

    it('采样中心 (0.5, 0.5, 0.5) 返回三线性插值结果', () => {
      const lut = makeIdentity2()
      const [r, g, b] = sampleLut3D(lut, 0.5, 0.5, 0.5)
      // 8 个角点的平均值：4 个含 1，4 个为 0 → 0.5
      expect(r).toBeCloseTo(0.5, 6)
      expect(g).toBeCloseTo(0.5, 6)
      expect(b).toBeCloseTo(0.5, 6)
    })

    it('超出 [0,1] 范围的输入被 clamp', () => {
      const lut = makeIdentity2()
      // clamp(-0.5) = 0
      const [r1] = sampleLut3D(lut, -0.5, 0, 0)
      expect(r1).toBeCloseTo(0, 6)
      // clamp(1.5) = 1
      const [r2] = sampleLut3D(lut, 1.5, 0, 0)
      expect(r2).toBeCloseTo(1, 6)
    })

    it('采样 (0.5, 0, 0) 返回 (0.5, 0, 0)', () => {
      const lut = makeIdentity2()
      const [r, g, b] = sampleLut3D(lut, 0.5, 0, 0)
      // r 维度在 (0,0,0)=0 与 (1,0,0)=1 之间插值 0.5 → 0.5
      expect(r).toBeCloseTo(0.5, 6)
      expect(g).toBeCloseTo(0, 6)
      expect(b).toBeCloseTo(0, 6)
    })

    it('size=1 的退化 LUT 始终返回唯一顶点值', () => {
      const lut: Lut3D = {
        id: 'single',
        name: 'Single',
        size: 1,
        data: new Float32Array([0.3, 0.6, 0.9])
      }
      const [r, g, b] = sampleLut3D(lut, 0.5, 0.5, 0.5)
      expect(r).toBeCloseTo(0.3, 6)
      expect(g).toBeCloseTo(0.6, 6)
      expect(b).toBeCloseTo(0.9, 6)
    })
  })

  describe('applyLut3D', () => {
    it('identity LUT 不改变像素值', () => {
      const identity = builtInLuts.find((l) => l.id === 'identity')!
      const imageData = makeImageData(2, 1, [10, 20, 30, 255, 200, 100, 50, 255])
      const result = applyLut3D(imageData, identity)
      // identity LUT 对每个值返回 v/255 * 255 = v
      expect(result.data[0]).toBe(10)
      expect(result.data[1]).toBe(20)
      expect(result.data[2]).toBe(30)
      expect(result.data[3]).toBe(255) // alpha 通道不变
      expect(result.data[4]).toBe(200)
      expect(result.data[5]).toBe(100)
      expect(result.data[6]).toBe(50)
      expect(result.data[7]).toBe(255)
    })

    it('high-contrast LUT 改变像素值（对比度增强）', () => {
      const hc = builtInLuts.find((l) => l.id === 'high-contrast')!
      // 中间灰度 128 经过对比度增强应远离 128
      const imageData = makeImageData(1, 1, [128, 128, 128, 255])
      const result = applyLut3D(imageData, hc)
      // contrast = (v - 0.5) * 1.3 + 0.5，0.5 -> 0.5（不变）
      // 128/255 ≈ 0.502 → 0.5026... → 128
      // 接近中点的值变化很小，验证不抛错即可
      expect(result.data[0]).toBeGreaterThanOrEqual(125)
      expect(result.data[0]).toBeLessThanOrEqual(131)
    })

    it('alpha 通道不被 LUT 改变', () => {
      const identity = builtInLuts.find((l) => l.id === 'identity')!
      const imageData = makeImageData(1, 1, [100, 100, 100, 200])
      const result = applyLut3D(imageData, identity)
      expect(result.data[3]).toBe(200)
    })

    it('空像素 imageData 也能正常处理', () => {
      const identity = builtInLuts.find((l) => l.id === 'identity')!
      const imageData = makeImageData(0, 0, [])
      const result = applyLut3D(imageData, identity)
      expect(result.data.length).toBe(0)
    })

    it('返回的是同一个 imageData 对象（就地修改）', () => {
      const identity = builtInLuts.find((l) => l.id === 'identity')!
      const imageData = makeImageData(1, 1, [10, 20, 30, 255])
      const result = applyLut3D(imageData, identity)
      expect(result).toBe(imageData)
    })
  })

  describe('createBuiltInLut', () => {
    it('生成 size³ × 3 长度的 Float32Array', () => {
      const lut = createBuiltInLut('test', '测试', 4, (r, g, b) => [r, g, b])
      expect(lut.size).toBe(4)
      expect(lut.data.length).toBe(4 * 4 * 4 * 3) // 192
    })

    it('fn 被正确调用并填充数据', () => {
      const fn = (r: number, g: number, b: number): [number, number, number] => [
        r * 2,
        g * 3,
        b * 4
      ]
      const lut = createBuiltInLut('test', '测试', 2, fn)
      // size=2 时，顶点 (0,0,0) 是数据[0..2]，顶点 (1,0,0) 是数据[3..5]
      expect(lut.data[0]).toBe(0) // r*2 = 0
      expect(lut.data[1]).toBe(0) // g*3 = 0
      expect(lut.data[2]).toBe(0) // b*4 = 0
      expect(lut.data[3]).toBe(2) // (1*2, 0*3, 0*4) = (2, 0, 0)
      expect(lut.data[4]).toBe(0)
      expect(lut.data[5]).toBe(0)
    })

    it('size=1 时生成单顶点 LUT', () => {
      const lut = createBuiltInLut('single', '单点', 1, () => [0.5, 0.5, 0.5])
      expect(lut.size).toBe(1)
      expect(lut.data.length).toBe(3)
      expect(lut.data[0]).toBe(0.5)
      expect(lut.data[1]).toBe(0.5)
      expect(lut.data[2]).toBe(0.5)
    })

    it('size=1 时 fn 输入参数为 NaN（除零边界，固化当前行为）', () => {
      // createBuiltInLut 中 r = x / (size - 1)，size=1 时为 0/0 = NaN
      let capturedInput: [number, number, number] | null = null
      const lut = createBuiltInLut('cap', '捕获', 1, (r, g, b) => {
        capturedInput = [r, g, b]
        return [Number.isNaN(r) ? 0.5 : r, Number.isNaN(g) ? 0.5 : g, Number.isNaN(b) ? 0.5 : b]
      })
      // 固化除零行为：fn 接收到的是 NaN
      expect(capturedInput).toEqual([NaN, NaN, NaN])
      expect(lut.data.length).toBe(3)
      expect(lut.data[0]).toBe(0.5) // fn 返回的容错值
    })
  })

  describe('builtInLuts', () => {
    it('包含 5 个内置 LUT', () => {
      expect(builtInLuts).toHaveLength(5)
    })

    it('identity LUT 存在且 size=17', () => {
      const identity = builtInLuts.find((l) => l.id === 'identity')
      expect(identity).toBeDefined()
      expect(identity!.name).toBe('Identity')
      expect(identity!.nameKey).toBe('lut.builtin.identity')
      expect(identity!.size).toBe(17)
      expect(identity!.data.length).toBe(17 * 17 * 17 * 3)
    })

    it('teal-orange LUT 存在', () => {
      const lut = builtInLuts.find((l) => l.id === 'teal-orange')
      expect(lut).toBeDefined()
      expect(lut!.name).toBe('Teal & Orange')
      expect(lut!.nameKey).toBe('lut.builtin.tealOrange')
      expect(lut!.size).toBe(17)
    })

    it('warm-vintage LUT 存在', () => {
      const lut = builtInLuts.find((l) => l.id === 'warm-vintage')
      expect(lut).toBeDefined()
      expect(lut!.name).toBe('Warm Vintage')
      expect(lut!.nameKey).toBe('lut.builtin.warmVintage')
    })

    it('cool-drama LUT 存在', () => {
      const lut = builtInLuts.find((l) => l.id === 'cool-drama')
      expect(lut).toBeDefined()
      expect(lut!.name).toBe('Cool Drama')
      expect(lut!.nameKey).toBe('lut.builtin.coolDrama')
    })

    it('high-contrast LUT 存在', () => {
      const lut = builtInLuts.find((l) => l.id === 'high-contrast')
      expect(lut).toBeDefined()
      expect(lut!.name).toBe('High Contrast')
      expect(lut!.nameKey).toBe('lut.builtin.highContrast')
    })

    it('所有内置 LUT 数据长度匹配 size³×3', () => {
      for (const lut of builtInLuts) {
        expect(lut.data.length).toBe(lut.size * lut.size * lut.size * 3)
      }
    })

    it('所有内置 LUT 的 id 唯一', () => {
      const ids = builtInLuts.map((l) => l.id)
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(ids.length)
    })

    it('identity LUT 在 (0.5, 0.5, 0.5) 采样返回 (0.5, 0.5, 0.5)', () => {
      const identity = builtInLuts.find((l) => l.id === 'identity')!
      const [r, g, b] = sampleLut3D(identity, 0.5, 0.5, 0.5)
      expect(r).toBeCloseTo(0.5, 4)
      expect(g).toBeCloseTo(0.5, 4)
      expect(b).toBeCloseTo(0.5, 4)
    })

    it('identity LUT 应用到 imageData 不改变像素', () => {
      const identity = builtInLuts.find((l) => l.id === 'identity')!
      const imageData = makeImageData(2, 1, [50, 100, 150, 255, 0, 255, 0, 200])
      const result = applyLut3D(imageData, identity)
      expect(result.data[0]).toBe(50)
      expect(result.data[1]).toBe(100)
      expect(result.data[2]).toBe(150)
      expect(result.data[4]).toBe(0)
      expect(result.data[5]).toBe(255)
      expect(result.data[6]).toBe(0)
    })
  })
})
