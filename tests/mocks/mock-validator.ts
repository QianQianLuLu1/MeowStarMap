/**
 * 共享测试 mock：validator（src/main/ipc/validator.ts）
 *
 * 各 IPC handler 测试此前内联 vi.mock('../validator', () => ({ ... })) 工厂高度重复，
 * 统一收敛到此模块，行为与原内联实现逐字一致：
 * - wrapHandler / wrapHandlerRaw：忽略 zod schema（不做校验），解包参数元组后调用 handler；
 * - wrapHandlerNoArgs：直接调用 handler；
 * - 成功返回 { success: true, data }；AppError 转 e.toIpcError()，
 *   其余异常兜底 { code: 'IPC_INTERNAL_ERROR', message }。
 * - schemas 为链式 Proxy（覆盖任意键，含 mediaIdArrayBulk / shortId），仅被透传不被校验。
 * - pathGuard / ok / fail 为超集导出，防止被测模块导入时报 "No X export is defined on the mock"。
 *
 * 用法（vi.mock 按解析后的模块 ID 匹配，同一真实模块的不同相对路径写法均可命中）：
 * ```ts
 * vi.mock('../validator', async () => await import('../../../../tests/mocks/mock-validator'))
 *
 * // 需要断言 / 控制 mock 时，从被 mock 的模块路径导入（得到的就是本模块的 vi.fn 实例）：
 * import { assertFileWritePath } from '../validator'
 * vi.mocked(assertFileWritePath).mockImplementationOnce(() => {
 *   throw AppError.forbidden('不允许写入该路径')
 * })
 * ```
 *
 * 注意：vitest 按测试文件隔离模块注册表，本模块的 vi.fn 实例在每个测试文件中相互独立。
 */
import { vi } from 'vitest'
import { AppError } from '../../src/shared/errors/app-error'
import type { Chainable } from '../../src/main/ipc/handlers/_test-helpers'

// 链式 mock：支持任意属性访问与方法调用，返回值仍可继续链式调用
const makeChainable = (): Chainable => {
  const fn = (): Chainable => makeChainable()
  return new Proxy(fn, {
    get: (_t, prop) => {
      if (prop === 'then') return undefined
      if (typeof prop === 'symbol') return undefined
      return () => makeChainable()
    }
  }) as unknown as Chainable
}

/** schemas 占位：任意属性访问均返回可链式调用的函数，覆盖全部 schema 键 */
const schemasProxy: Chainable = new Proxy(
  {},
  {
    get: (_, prop) => {
      if (typeof prop === 'symbol') return undefined
      return makeChainable()
    }
  }
) as unknown as Chainable

// 测试约定：handler 调用时第一个实参为参数元组，需解包为 zod parseResult.data 形式
const unwrap = (args: unknown[]) => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args)

// AppError → toIpcError；其余异常兜底 IPC_INTERNAL_ERROR（与原内联实现一致）
const toErrorResponse = (e: unknown) =>
  e instanceof AppError
    ? { success: false as const, error: e.toIpcError() }
    : {
        success: false as const,
        error: { code: 'IPC_INTERNAL_ERROR', message: e instanceof Error ? e.message : String(e) }
      }

export const wrapHandler = vi.fn(
  (_ctx: unknown, _schema: unknown, handler: (args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      try {
        const data = await handler(unwrap(args))
        return { success: true as const, data }
      } catch (e) {
        return toErrorResponse(e)
      }
    }
)

export const wrapHandlerNoArgs = vi.fn((_ctx: unknown, handler: () => unknown) => async () => {
  try {
    const data = await handler()
    return { success: true as const, data }
  } catch (e) {
    return toErrorResponse(e)
  }
})

// 与 wrapHandler 同理解包参数，并向 handler 追传 ctx（scanner-handler / settings-handler
// 的 raw handler 签名为 (args, ctx)，需与二者的原内联实现保持一致）
export const wrapHandlerRaw = vi.fn(
  (ctx: unknown, handler: (args: unknown[], ctx?: unknown) => unknown) =>
    async (...args: unknown[]) => {
      try {
        const data = await handler(unwrap(args), ctx)
        return { success: true as const, data }
      } catch (e) {
        return toErrorResponse(e)
      }
    }
)

export const schemas = schemasProxy

export const assertFileReadPath = vi.fn()

export const assertFileWritePath = vi.fn()

/**
 * pathGuard 超集：真实方法（register / registerRoots / assertAllowed / isAllowed /
 * initUserDataDir / size / registerUserPicked / isUserPicked）
 * + 个别测试内联 mock 曾额外提供的 setRootMediaDir。
 */
export const pathGuard = {
  register: vi.fn(),
  registerRoots: vi.fn(),
  registerUserPicked: vi.fn(),
  isUserPicked: vi.fn(),
  assertAllowed: vi.fn(),
  isAllowed: vi.fn(),
  initUserDataDir: vi.fn(),
  size: vi.fn(),
  setRootMediaDir: vi.fn()
}

export const ok = vi.fn((data?: unknown) => ({ success: true as const, data }))

export const fail = vi.fn((code = 'IPC_INTERNAL_ERROR', message = '', details?: unknown) => ({
  success: false as const,
  error: { code, message, details }
}))
