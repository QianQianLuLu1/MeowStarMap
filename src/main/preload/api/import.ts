// 文件导入命名空间：对应主进程 handlers/import-handler.ts 注册的 import:* 通道
import { call, subscribe } from '../ipc'
import type { ImportPreviewResult, ImportRunResult } from '../../../shared/types/electron-api'

/** electronAPI.import：T14 文件导入向导 */
export const importAPI = {
  preview: (sourceDir: string) => call<ImportPreviewResult>('import:preview', sourceDir),
  run: (
    sourcePaths: string[],
    targetBaseDir: string,
    options: {
      namingRule: 'keep' | 'date' | 'seq'
      categorize: 'flat' | 'byDate' | 'byMonth'
      conflictStrategy: 'skip' | 'rename' | 'overwrite'
      seqStart?: number
    }
  ) => call<ImportRunResult>('import:run', sourcePaths, targetBaseDir, options),
  onProgress: (callback: (progress: { current: number; total: number }) => void) =>
    subscribe('import:progress', callback)
}
