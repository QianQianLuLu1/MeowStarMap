import { describe, expect, it } from 'vitest'
import { pickDefaultSelectedPaths } from './scan-exclusions'

/**
 * 复现「概率性 Maximum call stack size exceeded」：
 * pickDefaultSelectedPaths 内部 Math.max(...pool.map(c => c.mtimeMs)) 在大候选集下
 * 因展开为函数实参超出 V8 调用栈上限而抛栈溢出。本用例用 N=200000 候选稳定复现。
 */
describe('pickDefaultSelectedPaths 超大候选集', () => {
  it('N=200000 候选不应触发 Maximum call stack size exceeded', () => {
    const N = 200_000
    const candidates: Array<{ path: string; mtimeMs: number; hasGamePlayPhotos: boolean }> = []
    for (let i = 0; i < N; i++) {
      candidates.push({
        path: `/dir${i}`,
        // 仅最后一个候选的 mtimeMs 最大，用于校验聚合正确性
        mtimeMs: i === N - 1 ? 10 : 5,
        hasGamePlayPhotos: true
      })
    }

    const selected = pickDefaultSelectedPaths(candidates)

    expect(selected instanceof Set).toBe(true)
    expect(selected.size).toBe(1)
    expect(selected.has('/dir199999')).toBe(true)
  })
})
