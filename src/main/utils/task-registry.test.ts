/**
 * @layer L1
 * @module src/main/utils/task-registry
 * @coverage TaskRegistry.register/cancel/isCancelled/unregister/size/cancelAll + taskRegistry 单例
 * @dependencies 无（纯类，仅依赖 Node.js 原生 AbortController）
 * @remarks 任务注册表纯逻辑测试，不依赖任何外部模块
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { TaskRegistry, taskRegistry } from './task-registry'

describe('TaskRegistry', () => {
  let registry: TaskRegistry

  beforeEach(() => {
    registry = new TaskRegistry()
  })

  describe('register', () => {
    it('首次注册返回 AbortController，signal.aborted === false', () => {
      const controller = registry.register('task-1')
      expect(controller).toBeInstanceOf(AbortController)
      expect(controller.signal.aborted).toBe(false)
    })

    it('同 taskId 再次注册：旧 controller 被 abort，新 controller 不受影响', () => {
      const old = registry.register('task-1')
      const next = registry.register('task-1')
      expect(old.signal.aborted).toBe(true)
      expect(next.signal.aborted).toBe(false)
      expect(next).not.toBe(old)
    })

    it('同 taskId 再次注册且旧 controller 已 abort：不再二次 abort，新 controller 正常返回', () => {
      const old = registry.register('task-1')
      old.abort()
      const next = registry.register('task-1')
      // 旧 controller 已 abort，注册流程不应抛错
      expect(old.signal.aborted).toBe(true)
      expect(next.signal.aborted).toBe(false)
    })

    it('注册多个不同 taskId：互不影响', () => {
      const c1 = registry.register('task-1')
      const c2 = registry.register('task-2')
      expect(c1.signal.aborted).toBe(false)
      expect(c2.signal.aborted).toBe(false)
      expect(c1).not.toBe(c2)
    })
  })

  describe('cancel', () => {
    it('已注册任务：返回 true，signal.aborted === true', () => {
      const controller = registry.register('task-1')
      expect(registry.cancel('task-1')).toBe(true)
      expect(controller.signal.aborted).toBe(true)
    })

    it('不存在 taskId：返回 false', () => {
      expect(registry.cancel('nonexistent')).toBe(false)
    })

    it('已取消任务再次 cancel：返回 false（幂等）', () => {
      registry.register('task-1')
      expect(registry.cancel('task-1')).toBe(true)
      expect(registry.cancel('task-1')).toBe(false)
    })
  })

  describe('isCancelled', () => {
    it('已注册未取消：返回 false', () => {
      registry.register('task-1')
      expect(registry.isCancelled('task-1')).toBe(false)
    })

    it('已注册已取消：返回 true', () => {
      registry.register('task-1')
      registry.cancel('task-1')
      expect(registry.isCancelled('task-1')).toBe(true)
    })

    it('不存在 taskId：返回 false（视为不可取消）', () => {
      expect(registry.isCancelled('nonexistent')).toBe(false)
    })

    it('unregister 后再查询：返回 false', () => {
      registry.register('task-1')
      registry.cancel('task-1')
      registry.unregister('task-1')
      expect(registry.isCancelled('task-1')).toBe(false)
    })
  })

  describe('unregister', () => {
    it('已注册任务：删除后 size() 减 1', () => {
      registry.register('task-1')
      expect(registry.size()).toBe(1)
      registry.unregister('task-1')
      expect(registry.size()).toBe(0)
    })

    it('不存在 taskId：size() 不变（无错误）', () => {
      expect(registry.size()).toBe(0)
      expect(() => registry.unregister('nonexistent')).not.toThrow()
      expect(registry.size()).toBe(0)
    })

    it('取消后 unregister：彻底清理，后续 cancel 返回 false', () => {
      registry.register('task-1')
      registry.cancel('task-1')
      registry.unregister('task-1')
      expect(registry.cancel('task-1')).toBe(false)
      expect(registry.isCancelled('task-1')).toBe(false)
    })
  })

  describe('size', () => {
    it('空 Map：返回 0', () => {
      expect(registry.size()).toBe(0)
    })

    it('注册 N 个：返回 N', () => {
      registry.register('task-1')
      registry.register('task-2')
      registry.register('task-3')
      expect(registry.size()).toBe(3)
    })

    it('unregister 后正确递减', () => {
      registry.register('task-1')
      registry.register('task-2')
      registry.unregister('task-1')
      expect(registry.size()).toBe(1)
    })

    it('同 taskId 重复注册不增加 size', () => {
      registry.register('task-1')
      registry.register('task-1')
      expect(registry.size()).toBe(1)
    })
  })

  describe('cancelAll', () => {
    it('多个活动任务：全部 aborted，size() === 0', () => {
      const c1 = registry.register('task-1')
      const c2 = registry.register('task-2')
      const c3 = registry.register('task-3')
      registry.cancelAll()
      expect(c1.signal.aborted).toBe(true)
      expect(c2.signal.aborted).toBe(true)
      expect(c3.signal.aborted).toBe(true)
      expect(registry.size()).toBe(0)
    })

    it('已 cancel 的任务再次 cancelAll：不抛错', () => {
      registry.register('task-1')
      registry.cancel('task-1')
      expect(() => registry.cancelAll()).not.toThrow()
    })

    it('空 Map：no-op', () => {
      expect(() => registry.cancelAll()).not.toThrow()
      expect(registry.size()).toBe(0)
    })

    it('cancelAll 后 register 行为正常（无残留状态）', () => {
      registry.register('task-1')
      registry.cancelAll()
      const controller = registry.register('task-2')
      expect(controller.signal.aborted).toBe(false)
      expect(registry.size()).toBe(1)
    })
  })

  describe('单例 taskRegistry', () => {
    // 单例测试可能产生跨用例副作用，每个用例自行清理
    afterEach(() => {
      taskRegistry.cancelAll()
    })

    it('模块导入即获得 TaskRegistry 实例', () => {
      expect(taskRegistry).toBeInstanceOf(TaskRegistry)
    })

    it('与 new TaskRegistry() 行为一致', () => {
      const fresh = new TaskRegistry()
      const c1 = taskRegistry.register('singleton-test')
      const c2 = fresh.register('singleton-test')
      expect(c1).toBeInstanceOf(AbortController)
      expect(c2).toBeInstanceOf(AbortController)
      // 同 taskId 重注册触发旧 controller abort
      const c1Again = taskRegistry.register('singleton-test')
      expect(c1.signal.aborted).toBe(true)
      expect(c1Again.signal.aborted).toBe(false)
    })
  })
})
