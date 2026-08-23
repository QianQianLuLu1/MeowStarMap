/**
 * 共享测试 mock：logger（src/main/utils/logger.ts）
 *
 * logger 真实导出形状（见 src/main/utils/logger.ts 末尾）：
 *   { info, warn, error, debug, fault }（fault 即 logFault）
 *
 * 用法（vi.mock 工厂会被提升，须配合 vi.hoisted）：
 * ```ts
 * const { loggerMock } = vi.hoisted(() => ({ loggerMock: createLoggerMock() }))
 * vi.mock('@main/utils/logger', () => ({ logger: loggerMock.logger }))
 *
 * // 断言
 * expect(loggerMock.logFault).toHaveBeenCalledWith(...)
 * ```
 */
import { vi } from 'vitest'

/**
 * 测试 mock 函数类型：与 vi.fn() 返回值结构兼容。
 * 不直接使用 `ReturnType<typeof vi.fn>`（其解析为 `Mock<any[], unknown>`，
 * 与带具体参数/返回类型的 mock 实例在 strict 下互不兼容），
 * 故采用结构化类型描述常用断言面。
 */
export interface MockFn {
  (...args: unknown[]): unknown
  mock: {
    calls: unknown[][]
    results: unknown[]
  }
  mockClear(): MockFn
  mockReset(): MockFn
  mockImplementation(fn: (...args: unknown[]) => unknown): MockFn
  mockReturnValue(value: unknown): MockFn
  mockResolvedValue(value: unknown): MockFn
  mockRejectedValue(value: unknown): MockFn
}

/** 与真实 logger 导出同形状的 mock 对象 */
export interface LoggerMock {
  info: MockFn
  warn: MockFn
  error: MockFn
  debug: MockFn
  fault: MockFn
}

/** createLoggerMock 返回的可断言句柄 */
export interface LoggerMockHandle {
  /** 直接喂给 vi.mock 工厂的 logger 对象：`{ logger: handle.logger }` */
  logger: LoggerMock
  /** 独立的 fault 句柄：logger.fault 的每次调用都会转发到这里，两处均可断言 */
  logFault: MockFn
}

/**
 * 创建 logger mock。
 * 所有方法均为 vi.fn()；`logger.fault` 委托到返回句柄的 `logFault`，
 * 测试可任选其一进行断言。
 */
export function createLoggerMock(): LoggerMockHandle {
  const logFault = vi.fn()
  const logger: LoggerMock = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fault: vi.fn((...args: unknown[]) => logFault(...args))
  }
  return { logger, logFault }
}
