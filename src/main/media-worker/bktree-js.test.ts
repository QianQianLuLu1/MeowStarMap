/**
 * BKHammingTree（纯 JS BK-tree）单元测试。
 *
 * 覆盖：
 * - 构造校验：keyBits 必须是 64 的倍数
 * - add / size 增长 / 重复 key 集合语义 / 批量 add
 * - padKey（左补 0）与 distance（汉明距离）的边界，经公开 API 间接验证
 * - query / find / has 半径检索：精确匹配、半径边界包含与排除、空树检索
 * - walk 遍历
 *
 * 与 bktree-index.test.ts 的等价性测试互补：此处聚焦树本身的单元行为。
 */
import { describe, it, expect, vi } from 'vitest'
import { BKHammingTree } from './bktree-js'

const ZERO = '0'.repeat(16) // 64 位全 0 pHash（16 个 hex 字符）
const ALL_F = 'f'.repeat(16) // 64 位全 1（与全 0 距离 64）

/** 在 hex 串的第 pos 个二进制位翻转（pos 0 为最高位），返回等长 hex 串 */
function flipBit(hex: string, pos: number): string {
  const bits = BigInt(`0x${hex}`) ^ (1n << BigInt(hex.length * 4 - 1 - pos))
  return bits.toString(16).padStart(hex.length, '0')
}

describe('BKHammingTree - 构造校验', () => {
  it('keyBits 非 64 倍数时抛错', () => {
    expect(() => new BKHammingTree(32)).toThrow('Key size must be a multiple of 64, got 32')
    expect(() => new BKHammingTree(65)).toThrow('Key size must be a multiple of 64, got 65')
    expect(() => new BKHammingTree(1)).toThrow('Key size must be a multiple of 64, got 1')
  })

  it('keyBits 为 64 / 128 等 64 倍数时正常构造', () => {
    expect(new BKHammingTree(64).size).toBe(0)
    expect(new BKHammingTree(128).size).toBe(0)
  })
})

describe('BKHammingTree - distance（经公开 API 间接验证 bitCount / padKey）', () => {
  it('相同 key 距离为 0', () => {
    const tree = new BKHammingTree(64)
    expect(tree.distance(ZERO, ZERO)).toBe(0)
    expect(tree.distance(ALL_F, ALL_F)).toBe(0)
  })

  it('全 0 与全 1 距离为 64（跨 32 位分块累加 popcount）', () => {
    const tree = new BKHammingTree(64)
    expect(tree.distance(ZERO, ALL_F)).toBe(64)
  })

  it('单比特翻转距离为 1（覆盖高/中/低三个 32 位分块位置）', () => {
    const tree = new BKHammingTree(64)
    expect(tree.distance(ZERO, flipBit(ZERO, 0))).toBe(1) // 最高位
    expect(tree.distance(ZERO, flipBit(ZERO, 33))).toBe(1) // 跨入低 32 位块
    expect(tree.distance(ZERO, flipBit(ZERO, 63))).toBe(1) // 最低位
  })

  it('多比特翻转距离为翻转位数', () => {
    const tree = new BKHammingTree(64)
    const three = flipBit(flipBit(flipBit(ZERO, 2), 20), 50)
    expect(tree.distance(ZERO, three)).toBe(3)
  })

  it('128 位 key 距离正确（padKey 补 0 到 32 hex，循环两个 32 位块）', () => {
    const tree = new BKHammingTree(128)
    const a = 'f'.repeat(32) // 每个 hex 'f' = 4 位，共 128 位
    const b = '0'.repeat(32)
    expect(tree.distance(a, b)).toBe(128)
    expect(tree.distance(a, a)).toBe(0)
  })
})

describe('BKHammingTree - add 与 size', () => {
  it('空树 size 为 0，逐个 add 后 size 增长', () => {
    const tree = new BKHammingTree(64)
    expect(tree.size).toBe(0)
    tree.add(ZERO)
    expect(tree.size).toBe(1)
    tree.add(flipBit(ZERO, 1), flipBit(ZERO, 5))
    expect(tree.size).toBe(3)
  })

  it('重复 key 不重复计数（集合语义）', () => {
    const tree = new BKHammingTree(64)
    tree.add(ZERO)
    tree.add(ZERO)
    tree.add([ZERO, ZERO])
    expect(tree.size).toBe(1)
  })

  it('支持批量 add（数组参数 flat 展开）', () => {
    const tree = new BKHammingTree(64)
    tree.add([ZERO, flipBit(ZERO, 1)], flipBit(ZERO, 2))
    expect(tree.size).toBe(3)
  })

  it('add 返回 this 可链式调用', () => {
    const tree = new BKHammingTree(64)
    expect(tree.add(ZERO)).toBe(tree)
  })

  it('padKey：短 key 左补 0 后与完整 key 等价（同一节点）', () => {
    const tree = new BKHammingTree(64)
    tree.add('f') // 补 0 后 = '000000000000000f'
    tree.add('000000000000000f')
    expect(tree.size).toBe(1)
    expect(tree.has('f')).toBe(true)
    expect(tree.has('000000000000000f')).toBe(true)
  })
})

describe('BKHammingTree - query / find / has 半径检索', () => {
  function buildClusterTree(): BKHammingTree {
    // 以 ZERO 为中心：距离 0/1/2/3 各一个节点（彼此间距离 ≥ 中心距离差，半径检索唯一命中目标）
    const tree = new BKHammingTree(64)
    tree.add(ZERO)
    tree.add(flipBit(ZERO, 0)) // 距 ZERO 1
    tree.add(flipBit(flipBit(ZERO, 1), 2)) // 距 ZERO 2
    tree.add(flipBit(flipBit(flipBit(ZERO, 3), 4), 5)) // 距 ZERO 3
    return tree
  }

  it('空树检索：不调用回调，find 返回空数组，has 为 false', () => {
    const tree = new BKHammingTree(64)
    const cb = vi.fn()
    expect(tree.query(ZERO, 5, cb)).toBe(tree)
    expect(cb).not.toHaveBeenCalled()
    expect(tree.find(ZERO, 5)).toEqual([])
    expect(tree.has(ZERO)).toBe(false)
  })

  it('半径 0：仅命中精确匹配，且回调距离为 0', () => {
    const tree = buildClusterTree()
    const cb = vi.fn()
    tree.query(ZERO, 0, cb)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith('0'.repeat(16), 0)
    expect(tree.has(ZERO)).toBe(true)
  })

  it('半径边界包含：距离恰好等于 maxDist 的节点被命中', () => {
    const tree = buildClusterTree()
    const found = tree.find(ZERO, 2)
    expect(found.map((r) => r.distance).sort()).toEqual([0, 1, 2])
  })

  it('半径边界排除：距离为 maxDist + 1 的节点不被命中', () => {
    const tree = buildClusterTree()
    const found = tree.find(ZERO, 2)
    expect(found.some((r) => r.distance === 3)).toBe(false)
    expect(
      tree
        .find(ZERO, 1)
        .map((r) => r.distance)
        .sort()
    ).toEqual([0, 1])
  })

  it('大半径命中全部节点', () => {
    const tree = buildClusterTree()
    expect(tree.find(ZERO, 64)).toHaveLength(4)
  })

  it('find 结果按距离升序', () => {
    const tree = buildClusterTree()
    const found = tree.find(ZERO, 3)
    const dists = found.map((r) => r.distance)
    expect(dists).toEqual([...dists].sort((a, b) => a - b))
    expect(dists).toEqual([0, 1, 2, 3])
  })

  it('查询短 key 时同样经 padKey 对齐后检索', () => {
    const tree = new BKHammingTree(64)
    tree.add('000000000000000f')
    const found = tree.find('f', 0)
    expect(found).toHaveLength(1)
    expect(found[0].distance).toBe(0)
  })

  it('has：不存在的 key 返回 false', () => {
    const tree = new BKHammingTree(64)
    tree.add(ZERO)
    expect(tree.has(flipBit(ZERO, 7))).toBe(false)
  })
})

describe('BKHammingTree - walk', () => {
  it('空树遍历不触发回调', () => {
    const tree = new BKHammingTree(64)
    const cb = vi.fn()
    tree.walk(cb)
    expect(cb).not.toHaveBeenCalled()
  })

  it('遍历输出全部 key，根节点深度为 0', () => {
    const tree = new BKHammingTree(64)
    const keys = [ZERO, flipBit(ZERO, 0), flipBit(ZERO, 63), ALL_F]
    tree.add(keys)
    const visited: Array<{ key: string; depth: number }> = []
    tree.walk((key, depth) => visited.push({ key, depth }))
    expect(visited).toHaveLength(keys.length)
    expect(new Set(visited.map((v) => v.key))).toEqual(new Set(keys))
    expect(visited[0].depth).toBe(0) // 首个访问的必为根
  })
})
