/**
 * 外部图片运行时总开关（渲染进程侧模块级状态）。
 *
 * 用途：gongeo #218 承诺「改动独立、回滚成本很低」。关闭后既有的 gongeo 热链
 * 与新接入的 refdata 图片链路一律不再产生地址 / IPC，由视图回退占位。
 * 主进程 refdata:resolve-image 另有一道独立短路（见 reference-data-handler.ts），
 * 两层互不依赖：渲染层 flag 管展示面，主进程读设置管请求面。
 *
 * 约定：
 * - 默认 true（保持既有行为不回归）；键缺失时 settings:get 的 fallback 亦为 true。
 * - 非 boolean 输入按安全默认 false 处理，并打印明确错误，禁止静默吞掉。
 * - 仅供渲染进程使用，不引入 Node / Electron 依赖。
 */

let enabled = true

/** 安全默认：非法输入一律关闭并记错，避免把不可信值当成"开启" */
export function setRemoteImagesEnabled(value: unknown): void {
  if (typeof value !== 'boolean') {
    console.error('[remoteImages] non-boolean switch value, falling back to disabled', value)
    enabled = false
    return
  }
  enabled = value
}

export function isRemoteImagesEnabled(): boolean {
  return enabled
}

/** 仅供测试与设置页重新同步：恢复默认开启态 */
export function resetRemoteImagesEnabled(): void {
  enabled = true
}
