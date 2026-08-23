// 文件操作命名空间：对应主进程 handlers/file.ts 注册的 file:* 通道
import { call } from '../ipc'
import type { ExportOptions, FileOpResult } from '../../../shared/types/electron-api'

/** electronAPI.file：物理文件的删除 / 复制 / 移动 / 重命名 / 导出 */
export const fileAPI = {
  delete: (filePaths: string[]) => call<FileOpResult>('file:delete', filePaths),
  deletePermanent: (filePaths: string[]) => call<FileOpResult>('file:deletePermanent', filePaths),
  copy: (sourcePaths: string[], targetDir: string) =>
    call<FileOpResult>('file:copy', sourcePaths, targetDir),
  move: (sourcePaths: string[], targetDir: string) =>
    call<FileOpResult>('file:move', sourcePaths, targetDir),
  rename: (oldPath: string, newName: string) => call<FileOpResult>('file:rename', oldPath, newName),
  // T12：批量重命名，返回每条操作的详细结果
  batchRename: (operations: { oldPath: string; newName: string }[]) =>
    call<FileOpResult>('file:batchRename', operations),
  export: (filePaths: string[], targetDir: string, options?: ExportOptions) =>
    call<FileOpResult>('file:export', filePaths, targetDir, options),
  saveAs: (filePath: string, targetDir: string, newName?: string) =>
    call<FileOpResult>('file:saveAs', filePath, targetDir, newName),
  getExif: (filePath: string) => call<Record<string, unknown>>('file:getExif', filePath)
}
