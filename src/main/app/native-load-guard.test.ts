import { describe, it, expect, vi } from 'vitest'
import {
  classifyNativeLoadError,
  verifyCriticalNativeModules,
  CRITICAL_NATIVE_MODULES
} from './native-load-guard'

describe('classifyNativeLoadError', () => {
  it('abi-mismatch: NODE_MODULE_VERSION', () => {
    expect(
      classifyNativeLoadError(
        new Error('The module was compiled against a different version of Node.js')
      )
    ).toBe('abi-mismatch')
  })
  it('abi-mismatch: compiled against a different Electron', () => {
    expect(classifyNativeLoadError(new Error('was compiled against a different Electron'))).toBe(
      'abi-mismatch'
    )
  })
  it('missing-vc-runtime: specified module could not be found', () => {
    expect(classifyNativeLoadError(new Error('The specified module could not be found.'))).toBe(
      'missing-vc-runtime'
    )
  })
  it('missing-vc-runtime: DLL initialization routine failed', () => {
    expect(
      classifyNativeLoadError(
        new Error('A dynamic link library (DLL) initialization routine failed.')
      )
    ).toBe('missing-vc-runtime')
  })
  it('bindings-missing: Could not locate the bindings file', () => {
    expect(classifyNativeLoadError(new Error('Could not locate the bindings file.'))).toBe(
      'bindings-missing'
    )
  })
  it('unknown: 其他错误 / 非 Error', () => {
    expect(classifyNativeLoadError(new Error('something else'))).toBe('unknown')
    expect(classifyNativeLoadError('not an error object')).toBe('unknown')
  })
})

describe('verifyCriticalNativeModules', () => {
  const showErrorBox = vi.fn()

  it('全部加载成功：返回 true 且不弹窗', () => {
    showErrorBox.mockClear()
    const requireImpl = vi.fn(() => ({}))
    const ok = verifyCriticalNativeModules({ requireImpl, showErrorBox })
    expect(ok).toBe(true)
    expect(requireImpl).toHaveBeenCalledTimes(CRITICAL_NATIVE_MODULES.length)
    expect(showErrorBox).not.toHaveBeenCalled()
  })

  it('缺失 VC++ 运行库：弹 VC++ 提示并返回 false', () => {
    showErrorBox.mockClear()
    const requireImpl = vi.fn((id: string) => {
      if (id === 'better-sqlite3') throw new Error('The specified module could not be found.')
      return {}
    })
    const ok = verifyCriticalNativeModules({ requireImpl, showErrorBox })
    expect(ok).toBe(false)
    expect(showErrorBox).toHaveBeenCalledTimes(1)
    const [title, content] = showErrorBox.mock.calls[0]
    expect(String(title)).toContain('VC++')
    expect(String(content)).toContain('Visual C++')
  })

  it('ABI 不匹配：弹“不兼容”提示并返回 false', () => {
    showErrorBox.mockClear()
    const requireImpl = vi.fn((id: string) => {
      if (id === 'koffi') throw new Error('NODE_MODULE_VERSION mismatch')
      return {}
    })
    const ok = verifyCriticalNativeModules({ requireImpl, showErrorBox })
    expect(ok).toBe(false)
    const [title] = showErrorBox.mock.calls[0]
    expect(String(title)).toContain('不兼容')
  })

  it('NIKKI_SKIP_NATIVE_GUARD === "1" 时跳过', () => {
    showErrorBox.mockClear()
    const requireImpl = vi.fn(() => {
      throw new Error('boom')
    })
    const getEnv = () => ({ NIKKI_SKIP_NATIVE_GUARD: '1' }) as NodeJS.ProcessEnv
    const ok = verifyCriticalNativeModules({ requireImpl, showErrorBox, getEnv })
    expect(ok).toBe(true)
    expect(showErrorBox).not.toHaveBeenCalled()
  })

  it('其他环境变量值不跳过', () => {
    showErrorBox.mockClear()
    const requireImpl = vi.fn(() => {
      throw new Error('The specified module could not be found.')
    })
    const getEnv = () => ({ NIKKI_SKIP_NATIVE_GUARD: 'true' }) as NodeJS.ProcessEnv
    const ok = verifyCriticalNativeModules({ requireImpl, showErrorBox, getEnv })
    expect(ok).toBe(false)
    expect(showErrorBox).toHaveBeenCalled()
  })

  it('安装路径含特殊字符：弹提示但仍继续启动', () => {
    showErrorBox.mockClear()
    const requireImpl = vi.fn(() => ({}))
    const getExecPath = () => 'C:\\Users\\用户\\AppData\\Local\\Programs\\app\\app.exe'
    const ok = verifyCriticalNativeModules({ requireImpl, showErrorBox, getExecPath })
    expect(ok).toBe(true)
    expect(showErrorBox).toHaveBeenCalledTimes(1)
    const [title] = showErrorBox.mock.calls[0]
    expect(String(title)).toContain('特殊字符')
  })
})
