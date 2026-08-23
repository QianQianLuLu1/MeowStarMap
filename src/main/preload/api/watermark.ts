// 水印命名空间：对应主进程 handlers/watermark.ts 注册的 watermark:* 通道
import { call, subscribe } from '../ipc'
import type { WatermarkApplyResult, WatermarkTemplateRow } from '../../../shared/types/electron-api'

/** electronAPI.watermark：水印应用与模板管理 */
export const watermarkAPI = {
  apply: (config: unknown, filePaths: string[], targetDir: string) =>
    call<WatermarkApplyResult>('watermark:apply', config, filePaths, targetDir),
  saveTemplate: (name: string, config: unknown) =>
    call<{ id: number }>('watermark:saveTemplate', name, config),
  loadTemplates: () => call<WatermarkTemplateRow[]>('watermark:loadTemplates'),
  deleteTemplate: (id: number) => call<{ deleted: boolean }>('watermark:deleteTemplate', id),
  onProgress: (callback: (progress: { current: number; total: number }) => void) =>
    subscribe('watermark:progress', callback)
}
