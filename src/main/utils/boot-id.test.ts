/**
 * boot-id 叶子模块单测
 *
 * 依赖声明：仅 vitest + node:crypto（被测模块零项目依赖）
 * 启动说明：npx vitest run src/main/utils/boot-id.test.ts
 * 错误处理：模块加载期生成 UUID，无失败分支（crypto.randomUUID 宿主保证）
 * 参数校验：无入参；断言 UUID 格式与短码长度
 * 基础测试用例：正常（格式/短码）/ 边界（单例稳定）
 */
import { describe, it, expect } from 'vitest'
import { BOOT_ID, BOOT_ID_SHORT } from './boot-id'

describe('boot-id', () => {
  it('BOOT_ID 为 UUID 格式', () => {
    expect(BOOT_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })

  it('BOOT_ID_SHORT 为 BOOT_ID 前 8 位', () => {
    expect(BOOT_ID_SHORT).toBe(BOOT_ID.slice(0, 8))
    expect(BOOT_ID_SHORT.length).toBe(8)
  })

  it('单例：重复 import 值稳定（同一次运行可拼接时间线）', async () => {
    const again = await import('./boot-id')
    expect(again.BOOT_ID).toBe(BOOT_ID)
  })
})
