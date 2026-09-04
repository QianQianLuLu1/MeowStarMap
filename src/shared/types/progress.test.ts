import { describe, it, expect } from 'vitest'
import type { TaskProgress, TaskStage } from './progress'
import { clampPercent, createStages, setStageStatus } from '../utils/taskStages'

describe('progress.ts / TaskStage 协议', () => {
  it('TaskProgress 兼容旧字段且可选 stages', () => {
    const p: TaskProgress = {
      taskId: 't-1',
      taskType: 'batch',
      phase: 'processing',
      current: 1,
      total: 3,
      percent: 33,
      startedAt: 0,
      canCancel: true
    }
    expect(p.stages).toBeUndefined()
    expect(p.taskId).toBe('t-1')
  })

  it('stages 字段可被附加且类型正确', () => {
    const stages: TaskStage[] = [
      { id: '0', label: 'a', status: 'done' },
      { id: '1', label: 'b', status: 'active' }
    ]
    const p: TaskProgress = {
      taskId: 't-2',
      taskType: 'batch',
      phase: 'processing',
      current: 1,
      total: 2,
      percent: 50,
      startedAt: 0,
      canCancel: true,
      stages
    }
    expect(p.stages?.[1].status).toBe('active')
  })
})

describe('taskStages 纯函数', () => {
  it('clampPercent 钳制范围', () => {
    expect(clampPercent(-5)).toBe(0)
    expect(clampPercent(50)).toBe(50)
    expect(clampPercent(150)).toBe(100)
    expect(clampPercent(NaN)).toBe(0)
  })

  it('createStages 首阶段 active 其余 pending', () => {
    const s = createStages(['准备', '处理', '收尾'])
    expect(s).toHaveLength(3)
    expect(s[0].status).toBe('active')
    expect(s[1].status).toBe('pending')
    expect(s[2].status).toBe('pending')
  })

  it('createStages 拒绝空数组（参数校验）', () => {
    expect(() => createStages([])).toThrow()
    // @ts-expect-error 故意传非数组以验证校验
    expect(() => createStages('x')).toThrow()
  })

  it('setStageStatus 不可变且正确置状态', () => {
    const s = createStages(['a', 'b'])
    const next = setStageStatus(s, 1, 'done', 'ok')
    expect(next?.[1].status).toBe('done')
    expect(next?.[1].detail).toBe('ok')
    expect(s[1].status).toBe('pending') // 原数组不变
    expect(setStageStatus(undefined, 0, 'active')).toBeUndefined()
  })
})
