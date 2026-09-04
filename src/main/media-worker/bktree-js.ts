/**
 * 纯 JS BK-tree（基于汉明距离的半径检索）。
 *
 * 源自 npm 包 bktree-fast 的 base.js + hamming.js + javascript.js 三文件合并：
 * - 去掉 require('lodash')，_.flatten 改为 Array.prototype.flat；
 * - CJS module.exports 改为 ESM export；
 * - 补 TypeScript 类型，调用处无需再写类型断言。
 *
 * 原作者 Andy Armstrong，MIT 许可。选型与改动范围见 docs/archive/BKTREE-REPLACE-PLAN.md。
 *
 * 为什么不用 mnemonist 或修补原生 C 编译链：前者 API 适配成本高且引入新依赖，
 * 后者需把 bktree-fast 纳入 electron-rebuild / asarUnpack，投入产出比极低。
 * 本实现 API 与原 bktree-fast 完全对齐，buildAndSearch 的建树/检索逻辑零改动。
 */

interface BKTreeNode {
  key: string
  // 稀疏数组：children[distance - 1]，缺位为 undefined
  children: (BKTreeNode | undefined)[]
}

export class BKHammingTree {
  private root: BKTreeNode | undefined
  private _size = 0
  private readonly keyBits: number

  /** @param keyBits hash 位数，必须是 64 的倍数（64 位 pHash → 64） */
  constructor(keyBits: number) {
    if (keyBits % 64 !== 0) {
      throw new Error(`Key size must be a multiple of 64, got ${keyBits}`)
    }
    this.keyBits = keyBits
  }

  get size(): number {
    return this._size
  }

  /** 左侧补 0 到 keyBits/4 位 hex（每 4 位一个 hex 字符） */
  private padKey(key: string): string {
    return key.padStart(this.keyBits / 4, '0')
  }

  /** 32 位 popcount（位计数） */
  private static bitCount(input: number): number {
    let n = input
    n = n - ((n >> 1) & 0x55555555)
    n = (n & 0x33333333) + ((n >> 2) & 0x33333333)
    return (((n + (n >> 4)) & 0xf0f0f0f) * 0x1010101) >> 24
  }

  /** 两个等长 hex 串的汉明距离：按 8 字符（32 位）分块异或后累加 popcount */
  distance(a: string, b: string): number {
    if (a === b) return 0
    let dist = 0
    for (let i = 0; i < a.length; i += 8) {
      const va = parseInt(a.slice(i, i + 8), 16)
      const vb = parseInt(b.slice(i, i + 8), 16)
      dist += BKHammingTree.bitCount(va ^ vb)
    }
    return dist
  }

  /** 加入一个或多个 hex hash（集合语义，重复 add 无效） */
  add(...keys: Array<string | string[]>): this {
    const addOne = (node: BKTreeNode | undefined, key: string): BKTreeNode => {
      if (!node) {
        this._size++
        return { key, children: [] }
      }
      const dist = this.distance(node.key, key) - 1
      if (dist < 0) return node // 已存在
      node.children[dist] = addOne(node.children[dist], key)
      return node
    }
    const padded = keys.flat().map((k) => this.padKey(k))
    this.root = padded.reduce(addOne, this.root)
    return this
  }

  /** 半径检索：回调所有汉明距离 ≤ maxDist 的 key 及其距离 */
  query(key: string, maxDist: number, cb: (key: string, distance: number) => void): this {
    if (!this.root) return this
    const padded = this.padKey(key)
    const visit = (node: BKTreeNode): void => {
      const dist = this.distance(node.key, padded)
      if (dist <= maxDist) {
        cb(node.key, dist)
        if (maxDist === 0) return
      }
      const min = Math.max(1, dist - maxDist)
      const max = dist + maxDist
      // children 下标 = distance - 1，故遍历 [min-1, max) 区间
      for (let i = min - 1; i < max; i++) {
        const child = node.children[i]
        if (child) visit(child)
      }
    }
    visit(this.root)
    return this
  }

  /** 遍历所有 key 及其深度 */
  walk(cb: (key: string, depth: number) => void): this {
    if (!this.root) return this
    const visit = (node: BKTreeNode, depth: number): void => {
      cb(node.key, depth)
      for (const child of node.children) {
        if (child) visit(child, depth + 1)
      }
    }
    visit(this.root, 0)
    return this
  }

  /** 半径检索：返回 { key, distance } 数组，按距离升序 */
  find(key: string, maxDist: number): Array<{ key: string; distance: number }> {
    const found: Array<{ key: string; distance: number }> = []
    this.query(key, maxDist, (k, d) => found.push({ key: k, distance: d }))
    return found.sort((a, b) => a.distance - b.distance)
  }

  /** 是否包含某 hash（distance === 0 即存在） */
  has(key: string): boolean {
    return this.find(key, 0).length > 0
  }
}
