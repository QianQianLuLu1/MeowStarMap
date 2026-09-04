/**
 * 相似图片 BK-tree 检索（在 media-worker 进程内执行）。
 *
 * 把 pHash 检索从主进程 O(n²) 双重循环下放到 worker，用纯 JS BK-tree（见 ./bktree-js）
 * 做半径检索，将相似召回从 O(n²) 降到约 O(n log n)。
 *
 * BK-tree 是集合语义、不存 value，因此用 hashToIds 把 hex hash 映射回行索引
 * （相同 pHash 可对应多张图）。
 *
 * 正确性护栏：bruteForcePairs 用 O(n²) 求候选边集，仅供测试与 buildAndSearch 对照，
 * 不进入生产路径。
 */
import { hammingDistance } from '../utils/phash'
import { BKHammingTree } from './bktree-js'
import type { SimilarRowMeta } from './worker-protocol'

/** 建树/检索用的行：协议 SimilarRowMeta 之外需要 phash 字段 */
export type BkRow = SimilarRowMeta & { phash: string }

/** 候选边：media id 对 + 汉明距离（仅 a < b，去重） */
export interface SimilarCandidate {
  a: number
  b: number
  dist: number
}

/** 64 字符 '0'/'1' pHash → 16 字符十六进制串（BK-tree 需要 hex，且 bits=64） */
function phashToHex(p: string): string {
  let hex = ''
  for (let i = 0; i < 64; i += 4) {
    const nibble =
      ((p.charCodeAt(i) - 48) << 3) |
      ((p.charCodeAt(i + 1) - 48) << 2) |
      ((p.charCodeAt(i + 2) - 48) << 1) |
      (p.charCodeAt(i + 3) - 48)
    hex += nibble.toString(16)
  }
  return hex
}

export interface BuildAndSearchDeps {
  rows: BkRow[]
  threshold: number
  shouldStop: () => boolean
  onCandidates: (batch: SimilarCandidate[]) => void
  onProgress: (scanned: number, total: number, candidates: number) => void
}

/**
 * 建 BK-tree 并对每条记录做半径检索，收集候选边（a<b，仅记录一次）。
 * 边以 media id 表示，主进程据 id 映射回行索引做 Union-Find。
 * @returns rows / totalCandidates / cancelled（边已全部通过 onCandidates 分批回传）
 */
export function buildAndSearch(deps: BuildAndSearchDeps): {
  rows: BkRow[]
  totalCandidates: number
  cancelled: boolean
} {
  const { rows, threshold, shouldStop, onCandidates, onProgress } = deps
  const total = rows.length
  if (total < 2) {
    return { rows, totalCandidates: 0, cancelled: false }
  }

  const tree = new BKHammingTree(64)

  // hex hash → 行索引列表（相同 pHash 对应多张图）
  const hashToIds = new Map<string, number[]>()
  for (let i = 0; i < total; i++) {
    const hex = phashToHex(rows[i].phash)
    const list = hashToIds.get(hex)
    if (list) list.push(i)
    else hashToIds.set(hex, [i])
  }
  // 建树只加去重后的 hex（集合，重复 add 无效）
  for (const hex of hashToIds.keys()) tree.add(hex)

  const BATCH = 5000
  let batch: SimilarCandidate[] = []
  let totalCandidates = 0

  for (let i = 0; i < total; i++) {
    if (shouldStop()) {
      if (batch.length > 0) onCandidates(batch)
      return { rows, totalCandidates, cancelled: true }
    }
    const hex = phashToHex(rows[i].phash)
    const aId = rows[i].id
    tree.query(hex, threshold, (foundKey: string, distance: number) => {
      const ids = hashToIds.get(foundKey)
      if (!ids) return
      for (const j of ids) {
        if (j === i) continue
        const bId = rows[j].id
        // 以 media id 去重，保证每条无序边只记录一次（a<b）
        if (bId <= aId) continue
        batch.push({ a: aId, b: bId, dist: distance })
        totalCandidates++
      }
    })
    if (batch.length >= BATCH) {
      onCandidates(batch)
      batch = []
    }
    onProgress(i + 1, total, totalCandidates)
  }
  if (batch.length > 0) onCandidates(batch)
  return { rows, totalCandidates, cancelled: false }
}

/**
 * O(n²) 参照实现（仅测试用）：返回所有 a<b 且汉明距离 ≤ threshold 的候选边。
 * 与 buildAndSearch 的结果应逐条一致（忽略顺序）。
 */
export function bruteForcePairs(rows: BkRow[], threshold: number): SimilarCandidate[] {
  const n = rows.length
  const edges: SimilarCandidate[] = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dist = hammingDistance(rows[i].phash, rows[j].phash)
      if (dist >= 0 && dist <= threshold) edges.push({ a: rows[i].id, b: rows[j].id, dist })
    }
  }
  return edges
}
