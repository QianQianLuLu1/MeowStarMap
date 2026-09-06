// 文件系统类操作 Mock：所有涉及本地文件/原生能力的操作
// 不可用功能抛出 PREVIEW_UNSUPPORTED 错误，组件已有 try/catch + Toast 自动降级

import { unsupported } from './ipc-error'
import i18n from '../../i18n'

// 浏览器原生降级：通过 <a download> 触发下载
function triggerBrowserDownload(
  filename: string,
  dataUrl: string
): { success: boolean; message: string } {
  try {
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    return { success: true, message: i18n.t('mock.message.browserDownloadTriggered') }
  } catch (err) {
    return {
      success: false,
      message: i18n.t('mock.message.downloadFailed', { reason: String(err) })
    }
  }
}

export const filesystemMock = {
  // 扫描器：预览版不支持扫描本地目录
  scanner: {
    start: async () => {
      throw unsupported(i18n.t('mock.feature.fileScan'))
    },
    stop: async () => ({ success: true }),
    status: async () => ({
      isScanning: false,
      filesFound: 0
    })
  },

  // 文件操作：本地文件管理不可用
  file: {
    delete: async () => {
      throw unsupported(i18n.t('mock.feature.fileDelete'))
    },
    deletePermanent: async () => {
      throw unsupported(i18n.t('mock.feature.fileDeletePermanent'))
    },
    copy: async () => {
      throw unsupported(i18n.t('mock.feature.fileCopy'))
    },
    move: async () => {
      throw unsupported(i18n.t('mock.feature.fileMove'))
    },
    rename: async () => {
      throw unsupported(i18n.t('mock.feature.fileRename'))
    },
    batchRename: async () => {
      throw unsupported(i18n.t('mock.feature.batchRename'))
    },
    export: async () => {
      throw unsupported(i18n.t('mock.feature.fileExport'))
    },
    saveAs: async () => {
      throw unsupported(i18n.t('mock.feature.fileSaveAs'))
    },
    getExif: async (_filePath: string) => ({
      // eslint-disable-next-line no-restricted-syntax -- Mock 示例 EXIF 数据值（非 UI 文案）
      camera: '示例相机',
      // eslint-disable-next-line no-restricted-syntax -- Mock 示例 EXIF 数据值（非 UI 文案）
      lens: '示例镜头',
      aperture: 'f/2.8',
      shutter: '1/125',
      iso: 100,
      focal_length: '50mm'
    })
  },

  // 编辑器保存：降级为浏览器下载
  editor: {
    save: async (_filePath: string, dataUrl: string, options?: { fileName?: string }) => {
      const filename = options?.fileName || `wxnn-export-${Date.now()}.jpg`
      return triggerBrowserDownload(filename, dataUrl)
    },
    saveAs: async (dataUrl: string, options?: { fileName?: string }) => {
      const filename = options?.fileName || `wxnn-export-${Date.now()}.jpg`
      return triggerBrowserDownload(filename, dataUrl)
    },
    exportWithMetadata: async () => {
      throw unsupported(i18n.t('mock.feature.exportWithMetadata'))
    },
    batchExportWithMetadata: async () => {
      throw unsupported(i18n.t('mock.feature.batchExportWithMetadata'))
    }
  },

  // 水印应用：文件级处理不可用
  watermark: {
    apply: async () => {
      throw unsupported(i18n.t('mock.feature.watermarkApply'))
    }
  },

  // 视频编辑：无 ffmpeg
  video: {
    export: async () => {
      throw unsupported(i18n.t('mock.feature.videoExport'))
    },
    captureFrame: async () => {
      throw unsupported(i18n.t('mock.feature.videoCaptureFrame'))
    },
    trim: async () => {
      throw unsupported(i18n.t('mock.feature.videoTrim'))
    },
    changeSpeed: async () => {
      throw unsupported(i18n.t('mock.feature.videoSpeed'))
    },
    exportLivePhoto: async () => {
      throw unsupported(i18n.t('mock.feature.livePhotoExport'))
    },
    edit: async () => {
      throw unsupported(i18n.t('mock.feature.videoEdit'))
    },
    editBatch: async () => {
      throw unsupported(i18n.t('mock.feature.videoEditBatch'))
    }
  },

  // 系统调用：浏览器中不可用
  shell: {
    openExternal: async (url: string) => {
      // 唯一可降级的系统调用：用 window.open 替代
      try {
        window.open(url, '_blank', 'noopener,noreferrer')
        return { success: true }
      } catch {
        return { success: false }
      }
    },
    openPath: async () => ({
      success: false,
      message: i18n.t('mock.message.openLocalPath')
    }),
    showItemInFolder: async () => ({
      success: false,
      message: i18n.t('mock.message.showInFolder')
    })
  },

  // 数据清空：危险操作，预览版禁用
  data: {
    clear: async () => {
      throw unsupported(i18n.t('mock.feature.clearDatabase'))
    }
  },

  // 备份恢复：文件系统操作不可用
  backup: {
    create: async () => {
      throw unsupported(i18n.t('mock.feature.createBackup'))
    },
    restore: async () => {
      throw unsupported(i18n.t('mock.feature.restoreBackup'))
    },
    delete: async () => {
      throw unsupported(i18n.t('mock.feature.deleteBackup'))
    },
    setDir: async () => ({
      success: false,
      needRestart: false,
      message: i18n.t('mock.message.unsupportedShort')
    }),
    resetDir: async () => ({
      success: false,
      needRestart: false,
      message: i18n.t('mock.message.unsupportedShort')
    })
  },

  // 日志导出/清理：文件系统操作不可用
  log: {
    openDirectory: async () => ({ success: false, message: i18n.t('mock.message.openDirectory') }),
    exportZip: async () => ({ success: false, message: i18n.t('mock.message.exportLogs') }),
    clear: async () => ({
      success: false,
      message: i18n.t('mock.message.clearLogs'),
      cleared: 0
    }),
    setDir: async () => ({
      success: false,
      needRestart: false,
      message: i18n.t('mock.message.unsupportedShort')
    }),
    resetDir: async () => ({
      success: false,
      needRestart: false,
      message: i18n.t('mock.message.unsupportedShort')
    })
  },

  // 崩溃报告清理：文件系统操作不可用
  crash: {
    openDirectory: async () => ({ success: false, message: i18n.t('mock.message.openDirectory') }),
    clear: async () => ({
      success: false,
      cleared: 0,
      message: i18n.t('mock.message.clearCrashReports')
    }),
    setDir: async () => ({
      success: false,
      needRestart: false,
      message: i18n.t('mock.message.unsupportedShort')
    }),
    resetDir: async () => ({
      success: false,
      needRestart: false,
      message: i18n.t('mock.message.unsupportedShort')
    })
  },

  // 应用重启：浏览器无法重启
  app: {
    relaunch: async () => {
      throw unsupported(i18n.t('mock.feature.appRelaunch'))
    }
  },

  // 任务取消：预览版无后台任务
  task: {
    cancel: async (taskId: string) => ({ cancelled: false, taskId })
  },

  // 文件导入：文件系统操作不可用
  import: {
    preview: async () => ({
      success: false,
      files: [],
      message: i18n.t('mock.message.importPreview')
    }),
    run: async () => ({
      success: false,
      message: i18n.t('mock.message.importFiles'),
      imported: [],
      failed: [],
      skipped: []
    })
  },

  // 解密：无原生 DLL
  decrypt: {
    decodeFile: async () => {
      throw unsupported(i18n.t('mock.feature.decryptFile'))
    },
    encodeCameraParams: async () => {
      throw unsupported(i18n.t('mock.feature.encryptCameraParams'))
    },
    decodeClothDiy: async () => {
      throw unsupported(i18n.t('mock.feature.decodeClothDiy'))
    },
    decodeHomeBuild: async () => {
      throw unsupported(i18n.t('mock.feature.decodeHomeBuild'))
    }
  },

  // 插件管理：无 npm 子进程
  plugin: {
    list: async () => [],
    detail: async () => {
      throw unsupported(i18n.t('mock.feature.pluginDetail'))
    },
    install: async () => {
      throw unsupported(i18n.t('mock.feature.pluginInstall'))
    },
    uninstall: async () => {
      throw unsupported(i18n.t('mock.feature.pluginUninstall'))
    },
    toggleActive: async () => {
      throw unsupported(i18n.t('mock.feature.pluginToggle'))
    },
    checkUpdate: async () => ({ name: '', latestVersion: false }),
    update: async () => ({ name: '', success: false }),
    // eslint-disable-next-line no-restricted-syntax -- 插件路径占位标识（数据值，非 UI 文案）
    getPluginsPath: async () => '预览版',
    reportError: async () => ({ success: true })
  },

  // WiFi 分享：无系统剪贴板文件写入
  share: {
    startWifi: async () => {
      throw unsupported(i18n.t('mock.feature.wifiShare'))
    },
    stopWifi: async () => ({ stopped: false }),
    copyFiles: async () => ({
      success: false,
      message: i18n.t('mock.message.copyToClipboard'),
      count: 0,
      skipped: 0
    }),
    launchApp: async () => ({
      success: false,
      message: i18n.t('mock.message.launchExternalApp')
    })
  }
} as const
