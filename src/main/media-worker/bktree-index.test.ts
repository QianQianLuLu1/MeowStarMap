/**
 * bktree-index 等价性测试。
 *
 * 核心断言：buildAndSearch（BK-tree 半径检索）与 bruteForcePairs（O(n²) 参照）
 * 在同一份数据集 + 同一阈值下，产出的候选边集完全一致（按 (min(a,b), max(a,b)) 归一化后比较）。
 *
 * 这是替换 bktree-fast 原生模块为纯 JS BK-tree 后的正确性护栏，
 * 覆盖阈值 0 / 2 / 5 / 10，以及边界 pHash（全 0、全 1、仅最高位为 1、仅最低位为 1）。
 */
import { describe, it, expect } from 'vitest'
import { buildAndSearch, bruteForcePairs, type BkRow, type SimilarCandidate } from './bktree-index'

function makeRow(id: number, phash: string): BkRow {
  return {
    id,
    file_path: `/${id}.jpg`,
    file_name: `${id}.jpg`,
    file_type: 'image/jpeg',
    file_size: 0,
    modified_at: '2024-01-01T00:00:00Z',
    width: 100,
    height: 100,
    is_favorite: 0,
    rating: 0,
    phash
  }
}

function flipBit(hash: string, pos: number): string {
  // pos 限定在 [0, hash.length)，避免外部传越界值
  if (pos < 0 || pos >= hash.length) return hash
  const chars = hash.split('')
  chars[pos] = chars[pos] === '0' ? '1' : '0'
  return chars.join('')
}

/** 归一化候选边：每条无序边用 (min,max) 表示，附距离，排序后逐条比较 */
function normalize(edges: SimilarCandidate[]): string[] {
  return edges.map((e) => `${Math.min(e.a, e.b)},${Math.max(e.a, e.b)}:${e.dist}`).sort()
}

/** 跑 buildAndSearch 收集所有分批候选边 */
function runBuild(rows: BkRow[], threshold: number): SimilarCandidate[] {
  const batches: SimilarCandidate[][] = []
  const result = buildAndSearch({
    rows,
    threshold,
    shouldStop: () => false,
    onCandidates: (batch) => batches.push(batch),
    onProgress: () => {}
  })
  expect(result.cancelled).toBe(false)
  return batches.flat()
}

describe('bktree-index - buildAndSearch 与 bruteForcePairs 等价', () => {
  const thresholds = [0, 2, 5, 10]

  // 固定种子可重复：用确定性的合成数据集（边界 + 随机 + 近邻 + 重复）
  const rows: BkRow[] = (() => {
    const out: BkRow[] = []
    let id = 1
    // 边界 pHash（覆盖 popcount 高位 / 低位场景）
    out.push(makeRow(id++, '0'.repeat(64)))
    out.push(makeRow(id++, '1'.repeat(64)))
    out.push(makeRow(id++, '1' + '0'.repeat(63))) // 仅最高位 1 → hex 0x8000000000000000
    out.push(makeRow(id++, '0' + '1'.repeat(63))) // 仅最高位 0
    // 与「仅最高位 1」距离 1 的近邻（翻转第 1 位）
    out.push(makeRow(id++, flipBit('1' + '0'.repeat(63), 1)))
    // 与全 0 距离 1 的近邻
    out.push(makeRow(id++, flipBit('0'.repeat(64), 0)))
    out.push(makeRow(id++, flipBit('0'.repeat(64), 63)))
    // 随机 base + 1~2 位翻转的近邻簇
    let seed = 12345
    const rand = () => {
      // 简单 LCG，避免依赖 Math.random 导致等价性偶发误判
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let i = 0; i < 25; i++) {
      let base = ''
      for (let k = 0; k < 64; k++) base += rand() < 0.5 ? '0' : '1'
      out.push(makeRow(id++, base))
      out.push(makeRow(id++, flipBit(base, Math.floor(rand() * 64))))
      if (rand() < 0.5) {
        out.push(makeRow(id++, flipBit(base, Math.floor(rand() * 64))))
      }
    }
    // 重复 pHash（与第一条全 0 相同，验证集合语义 + hashToIds 多对一）
    out.push(makeRow(id++, out[0].phash))
    return out
  })()

  for (const t of thresholds) {
    it(`阈值 ${t}：候选边集与 O(n²) 参照逐条一致`, () => {
      const built = runBuild(rows, t)
      const brute = bruteForcePairs(rows, t)
      expect(normalize(built), `threshold=${t}`).toEqual(normalize(brute))
    })
  }

  it('buildAndSearch 的 totalCandidates 等于实际候选边数', () => {
    const batches: SimilarCandidate[][] = []
    const result = buildAndSearch({
      rows,
      threshold: 5,
      shouldStop: () => false,
      onCandidates: (batch) => batches.push(batch),
      onProgress: () => {}
    })
    const flat = batches.flat()
    expect(result.totalCandidates).toBe(flat.length)
    expect(result.cancelled).toBe(false)
  })

  it('数据不足 2 行时直接返回空候选', () => {
    const result = buildAndSearch({
      rows: [makeRow(1, '0'.repeat(64))],
      threshold: 5,
      shouldStop: () => false,
      onCandidates: () => {},
      onProgress: () => {}
    })
    expect(result.totalCandidates).toBe(0)
    expect(result.cancelled).toBe(false)
  })

  it('shouldStop 中途取消：回传已累积批次并标记 cancelled', () => {
    const batches: SimilarCandidate[][] = []
    let calls = 0
    const result = buildAndSearch({
      rows,
      threshold: 10,
      // 第二次进度回调后取消（确保至少跑过一轮再停）
      shouldStop: () => {
        calls++
        return calls > 2
      },
      onCandidates: (batch) => batches.push(batch),
      onProgress: () => {}
    })
    expect(result.cancelled).toBe(true)
    // 取消时已回传的批次合并长度应等于 totalCandidates
    expect(batches.flat().length).toBe(result.totalCandidates)
  })
})
