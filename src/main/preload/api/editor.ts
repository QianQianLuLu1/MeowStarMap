// 编辑器命名空间：对应主进程 handlers/editor.ts 注册的 editor:* 通道
import { call } from '../ipc'
import type {
  EditorBatchExportWithMetadataResult,
  EditorExportWithMetadataResult,
  EditorLoadPresetsResult,
  EditorMetadata,
  EditorMetadataInput,
  EditorSaveAsResult,
  EditorSaveResult,
  FilterPreset
} from '../../../shared/types/electron-api'

/** electronAPI.editor：编辑保存 / 滤镜预设 / XMP 元数据 */
export const editorAPI = {
  save: (
    filePath: string,
    dataUrl: string,
    options?: { format?: string; quality?: number; params?: string }
  ) => call<EditorSaveResult>('editor:save', filePath, dataUrl, options),
  saveAs: (
    dataUrl: string,
    options?: { directory?: string; fileName?: string; format?: string; quality?: number }
  ) => call<EditorSaveAsResult>('editor:saveAs', dataUrl, options),
  exportPreset: (preset: unknown) => call<{ id: number }>('editor:exportPreset', preset),
  loadPresets: () => call<EditorLoadPresetsResult>('editor:loadPresets'),
  deletePreset: (id: string | number) => call<{ deleted: boolean }>('editor:deletePreset', id),
  exportPresetToFile: (preset: { name: string; category: string; params: unknown }) =>
    call<{ filePath: string }>('editor:exportPresetToFile', preset),
  importPresetFromFile: () =>
    call<{ preset: FilterPreset; filePath: string }>('editor:importPresetFromFile'),
  // XMP 元数据：导出含参数副本（单图）
  exportWithMetadata: (
    sourcePath: string,
    metadata: EditorMetadataInput,
    options?: {
      targetDir?: string
      fileName?: string
      format?: 'jpg' | 'jpeg' | 'png' | 'webp'
      quality?: number
    }
  ) =>
    call<EditorExportWithMetadataResult>(
      'editor:exportWithMetadata',
      sourcePath,
      metadata,
      options
    ),
  // XMP 元数据：批量导出含参数副本
  batchExportWithMetadata: (
    sourcePaths: string[],
    metadata: EditorMetadataInput,
    options: {
      targetDir: string
      format?: 'jpg' | 'jpeg' | 'png' | 'webp'
      quality?: number
    }
  ) =>
    call<EditorBatchExportWithMetadataResult>(
      'editor:batchExportWithMetadata',
      sourcePaths,
      metadata,
      options
    ),
  // XMP 元数据：读取已写入的编辑参数（一键恢复）
  readMetadata: (filePath: string) => call<EditorMetadata | null>('editor:readMetadata', filePath)
}
