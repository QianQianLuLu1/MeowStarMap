import type { TaskStage, TaskStageStatus } from '../types/progress'

/** 将百分比钳制到 [0, 100]（参数校验：非法输入回退为 0） */
export const clampPercent = (n: number): number => {
  if (!Number.isFinite(n)) return 0
  return Math.min(100, Math.max(0, n))
}

/**
 * 由文案数组构造阶段步骤列表
 * @param labels 非空阶段文案数组
 * @throws 当 labels 非数组或为空时抛错（参数校验）
 */
export function createStages(labels: string[]): TaskStage[] {
  if (!Array.isArray(labels) || labels.length === 0) {
    throw new Error('createStages: labels must be a non-empty array')
  }
  return labels.map((label, i) => ({
    id: String(i),
    label,
    status: i === 0 ? 'active' : 'pending'
  }))
}

/** 返回将第 index 个阶段置为指定状态（可选 detail）的新数组，原数组不变 */
export function setStageStatus(
  stages: TaskStage[] | undefined,
  index: number,
  status: TaskStageStatus,
  detail?: string
): TaskStage[] | undefined {
  if (!stages) return stages
  return stages.map((s, i) => (i === index ? { ...s, status, detail: detail ?? s.detail } : s))
}
