/**
 * koffi FFI 库的类型声明（简化版）
 * 完整 API 见 https://koffi.dev/
 */
declare module 'koffi' {
  /** 加载动态库 */
  export function load(path: string): IKoffiLib

  /** 定义 C 结构体 */
  export function struct(name: string, fields: Record<string, unknown>): unknown

  /** 定义指针类型 */
  export function pointer(type: string): unknown

  /** 从 C 指针解码数据 */
  export function decode(pointer: PointerObject, type: string, length: number): unknown

  /** 已加载的库 */
  export interface IKoffiLib {
    /** 绑定 C 函数 */
    func(name: string, returns: unknown, args: unknown[]): KoffiFunction
    /** 卸载库 */
    unload(): void
  }

  /** 绑定的 C 函数 */
  export interface KoffiFunction {
    (...args: unknown[]): unknown
  }

  /** 指针对象 */
  export interface PointerObject {
    address?: number
  }
}
