// 事件订阅 Mock：preload.ts 中 5 个 onXxx 订阅方法
// 预览版不触发任何事件，返回空取消函数满足契约

export const eventMock = {
  scanner: {
    onProgress: (_callback: (progress: unknown) => void) => () => {},
    onComplete: (_callback: (result: unknown) => void) => () => {}
  },
  watermark: {
    onProgress: (_callback: (progress: { current: number; total: number }) => void) => () => {}
  },
  media: {
    onUpdated: (_callback: () => void) => () => {}
  },
  task: {
    onProgress: (_callback: (progress: unknown) => void) => () => {}
  },
  import: {
    onProgress: (_callback: (progress: { current: number; total: number }) => void) => () => {}
  }
} as const
