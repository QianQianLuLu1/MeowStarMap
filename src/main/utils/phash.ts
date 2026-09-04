/**
 * T05：感知哈希（pHash）计算工具
 * 基于 8x8 DCT 的 64 位 hash，用于相似图片查找
 *
 * 算法步骤：
 * 1. 缩放到 32x32 灰度图
 * 2. 计算 32x32 的二维 DCT-II
 * 3. 取左上 8x8 低频系数（共 64 个值）
 * 4. 计算均值（排除 DC 分量 [0][0]）
 * 5. 每位与均值比较生成 64 字符 0/1 串
 */
import sharp from 'sharp'
import { logger } from './logger'

const HASH_SIZE = 8 // 输出 8x8 = 64 位
const DCT_SIZE = 32 // DCT 计算尺寸

// 预计算 DCT-II 余弦矩阵：cosMatrix[k][n] = cos(π/N * (n+0.5) * k)
const cosMatrix: number[][] = []
for (let k = 0; k < DCT_SIZE; k++) {
  const row: number[] = []
  for (let n = 0; n < DCT_SIZE; n++) {
    row.push(Math.cos((Math.PI / DCT_SIZE) * (n + 0.5) * k))
  }
  cosMatrix.push(row)
}

/**
 * 计算二维 DCT-II
 * 先对每行做一维 DCT，再对每列做一维 DCT
 */
function dct2d(matrix: number[][]): number[][] {
  const N = DCT_SIZE
  // 行变换
  const rowTransformed: number[][] = []
  for (let i = 0; i < N; i++) {
    const row = matrix[i]
    const transformed: number[] = new Array(N)
    for (let k = 0; k < N; k++) {
      let sum = 0
      for (let n = 0; n < N; n++) {
        sum += row[n] * cosMatrix[k][n]
      }
      transformed[k] = sum
    }
    rowTransformed.push(transformed)
  }
  // 列变换
  const result: number[][] = []
  for (let j = 0; j < N; j++) {
    const col: number[] = new Array(N)
    for (let i = 0; i < N; i++) col[i] = rowTransformed[i][j]
    const transformed: number[] = new Array(N)
    for (let k = 0; k < N; k++) {
      let sum = 0
      for (let n = 0; n < N; n++) {
        sum += col[n] * cosMatrix[k][n]
      }
      transformed[k] = sum
    }
    result.push(transformed)
  }
  return result
}

/**
 * 计算图片的 pHash
 * @param filePath 图片文件路径
 * @returns 64 字符 0/1 串；计算失败返回 null
 */
export async function calculatePHash(filePath: string): Promise<string | null> {
  try {
    // 缩放到 32x32 灰度图，获取原始像素数据
    const { data, info } = await sharp(filePath)
      .greyscale()
      .resize(DCT_SIZE, DCT_SIZE, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true })

    // 将一维 buffer 转为 32x32 二维数组
    // greyscale 后 channels=1，每个像素 1 字节；stride 等于 width
    const stride = info.width
    const pixels: number[][] = []
    for (let y = 0; y < DCT_SIZE; y++) {
      const row: number[] = []
      for (let x = 0; x < DCT_SIZE; x++) {
        row.push(data[y * stride + x])
      }
      pixels.push(row)
    }

    // 计算 DCT
    const dct = dct2d(pixels)

    // 取左上 8x8 低频系数
    const lowFreq: number[] = []
    for (let y = 0; y < HASH_SIZE; y++) {
      for (let x = 0; x < HASH_SIZE; x++) {
        lowFreq.push(dct[y][x])
      }
    }

    // 计算均值（排除 DC 分量 [0][0]）
    const sum = lowFreq.slice(1).reduce((a, b) => a + b, 0)
    const avg = sum / (lowFreq.length - 1)

    // 生成 64 位 hash（DC 分量固定为 0，避免它影响相似度判断）
    let hash = ''
    for (let i = 0; i < lowFreq.length; i++) {
      if (i === 0) {
        hash += '0'
      } else {
        hash += lowFreq[i] >= avg ? '1' : '0'
      }
    }
    return hash
  } catch (error) {
    logger.warn(`[pHash] 计算失败: ${filePath}`, error)
    return null
  }
}

/**
 * 计算两个 pHash 的汉明距离
 * @param hash1 64 字符 0/1 串
 * @param hash2 64 字符 0/1 串
 * @returns 不同位的数量；长度不一致返回 -1
 */
export function hammingDistance(hash1: string, hash2: string): number {
  if (hash1.length !== hash2.length || hash1.length === 0) return -1
  let distance = 0
  for (let i = 0; i < hash1.length; i++) {
    if (hash1[i] !== hash2[i]) distance++
  }
  return distance
}
