// Storybook 环境下的 window.electronAPI 安全桩
//
// 参考 tests/setup.ts 的 Proxy 占位写法：组件统一以可选链
// `window.electronAPI?.xxx.yyy()` 访问 IPC，桩对所有命名空间下的方法调用
// 默认 console.debug 提示并 resolve(undefined)，保证故事可渲染、不抛错。
//
// 订阅语义例外：以 `on` 开头的方法（如 `scanner.onProgress` / `app.onUpdate`）
// 组件会把返回值当作取消订阅函数缓存并在卸载时调用，故返回无操作取消函数 `() => {}`
// 而非 Promise，避免组件对返回值调用时报错。
//
// 单 story 覆盖方式：在 stories 文件的 beforeEach 中整体替换 window.electronAPI
// （桩是双层 Proxy，无 set trap，直接对其写属性不生效），并在清理函数中还原：
//   beforeEach(() => {
//     const prev = window.electronAPI
//     window.electronAPI = { gallery: { ... } } as never
//     return () => { window.electronAPI = prev }
//   })
// 参考：src/renderer/components/common/UpdateDialog.stories.tsx。
// installElectronApiMock() 只在 electronAPI 缺失时挂载，不会覆盖已有注入。

type AnyRecord = Record<string, unknown>

export function createElectronApiMock(): AnyRecord {
  return new Proxy<AnyRecord>(
    {},
    {
      get(target, prop) {
        if (typeof prop === 'symbol') return target[prop]
        const namespace = String(prop)
        // 二级 Proxy：namespace 下的任意方法调用 → console.debug + resolve(undefined)
        return new Proxy<AnyRecord>(
          {},
          {
            get(_inner, method) {
              if (typeof method === 'symbol') return undefined
              const methodName = String(method)
              // 订阅语义（`on` 前缀）：返回无操作取消订阅函数，而非 Promise；
              // 已「整体替换」桩的自定义故事（如 UpdateDialog）不受本分支影响。
              if (methodName.startsWith('on')) {
                return (...args: unknown[]) => {
                  console.debug(
                    `[storybook] electronAPI.${namespace}.${methodName}() subscription stub`,
                    args
                  )
                  return () => {}
                }
              }
              return (...args: unknown[]) => {
                console.debug(`[storybook] electronAPI.${namespace}.${methodName}() called`, args)
                return Promise.resolve(undefined)
              }
            }
          }
        )
      }
    }
  )
}

export function installElectronApiMock(): void {
  if (typeof window === 'undefined') return
  const w = window as Window & { electronAPI?: AnyRecord }
  if (w.electronAPI) return
  w.electronAPI = createElectronApiMock()
}
