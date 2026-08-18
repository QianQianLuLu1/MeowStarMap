/**
 * NikkiGallery 插件系统共享类型定义
 *
 * 设计目标：
 * - 集中定义插件 package.json 的 nikkiGallery 字段结构
 * - 集中定义 6 个业务扩展点常量与扩展响应类型
 * - 集中定义能力桥权限清单
 * - 主进程 / 渲染进程 / preload 共享
 *
 * 兼容性：不修改任何现有类型，仅新增
 */

/**
 * 插件 package.json 的 nikkiGallery 字段
 *
 * 用于声明插件的能力权限、扩展点、引擎版本等元信息
 */
export interface NikkiGalleryManifest {
  /** 兼容的 NikkiGallery 版本范围（semver） */
  engines: string
  /** 申请的能力权限清单 */
  permissions: PluginPermission[]
  /** 声明将注册的扩展点，用于权限审计 */
  extensionPoints?: string[]
  /** 国际化资源目录相对路径 */
  i18n?: string
  /** 进程类型，默认 renderer */
  type?: 'renderer' | 'main-process'
}

/**
 * 插件能力权限清单
 *
 * 能力桥 IPC 在调用前校验插件是否声明了对应权限
 */
export type PluginPermission =
  | 'media:read'
  | 'media:write'
  | 'media:delete'
  | 'db:query'
  | 'fs:read'
  | 'fs:write'
  | 'watermark:apply'
  | 'task:progress'
  | 'ui:sidebar'
  | 'ui:menu'
  | 'ui:editor'
  | 'ipc:register'

/**
 * 6 个业务扩展点常量
 *
 * 在 NikkiGallery 现有组件中消费，插件可注册扩展响应
 */
export const EXTENSION_POINTS = {
  /** 媒体读取器扩展（GalleryPage 消费） */
  MEDIA_READER: 'media.reader',
  /** 媒体写入器扩展（导出/分享消费） */
  MEDIA_WRITER: 'media.writer',
  /** 编辑面板扩展（EditorTabs 消费） */
  EDITOR_PANEL: 'editor.panel',
  /** 侧边栏自定义项（Sidebar 消费） */
  SIDEBAR_ITEM: 'sidebar.item',
  /** 上下文菜单项扩展（ContextMenu 消费） */
  MENU_CONTEXT: 'menu.context',
  /** 水印模板扩展（WatermarkPanel 消费） */
  WATERMARK_TEMPLATE: 'watermark.template'
} as const

export type ExtensionPointName = (typeof EXTENSION_POINTS)[keyof typeof EXTENSION_POINTS]

/**
 * 插件水印模板响应结构（watermark.template 扩展点）
 *
 * 插件 init 函数中通过 extensionPoints.register 注册的响应函数返回此结构
 */
export interface PluginWatermarkTemplate {
  /** 模板唯一 ID（建议插件名前缀，避免冲突） */
  id: string
  /** 模板显示名 */
  name: string
  /** 模板类型 */
  type: 'text' | 'image'
  /** 文字水印内容（type=text 时必填） */
  text?: string
  /** 字体（type=text 时可选） */
  font?: string
  /** 字号（type=text 时可选） */
  fontSize?: number
  /** 文字颜色（type=text 时可选） */
  color?: string
  /** 图片水印路径（type=image 时必填，绝对路径或 file:// URL） */
  imagePath?: string
  /** 位置 */
  position?:
    | 'topLeft'
    | 'topCenter'
    | 'topRight'
    | 'centerLeft'
    | 'center'
    | 'centerRight'
    | 'bottomLeft'
    | 'bottomCenter'
    | 'bottomRight'
  /** 不透明度 0-1 */
  opacity?: number
  /** 缩放比例 0-1（仅图片水印） */
  scale?: number
  /** 模板分类，插件模板固定为 custom */
  category: 'custom'
}

/**
 * 侧边栏项扩展响应结构（sidebar.item 扩展点）
 */
export interface PluginSidebarItem {
  /** 项唯一 ID */
  id: string
  /** 显示文本 */
  label: string
  /** 图标（SVG 字符串或图标名） */
  icon?: string
  /** 点击后切换到的视图标识 */
  view?: string
  /** 排序权重，数字越小越靠前 */
  order?: number
}

/**
 * 上下文菜单项扩展响应结构（menu.context 扩展点）
 */
export interface PluginContextMenuItem {
  /** 项唯一 ID */
  id: string
  /** 显示文本 */
  label: string
  /** 仅在选中 N 项时显示，默认任意数量 */
  visibleWhen?: (selectedCount: number, fileType?: string) => boolean
  /** 点击回调返回的操作类型 */
  action?: 'export' | 'delete' | 'custom'
}

/**
 * 编辑面板扩展响应结构（editor.panel 扩展点）
 *
 * 注意：render 字段在主进程/共享层定义为 unknown，
 * 渲染进程消费时再断言为 (filePath: string) => React.ReactNode
 */
export interface PluginEditorPanel {
  /** 面板唯一 ID */
  id: string
  /** 显示文本 */
  label: string
  /** 面板渲染函数（接收当前编辑的文件路径），由渲染进程消费时具体化 */
  render?: unknown
}

/**
 * 渲染进程插件 facade 返回的 Plugin 对象（slim 版本）
 *
 * 与 pluggable-electron/renderer 的 Plugin 类对应
 */
export interface PluginFacade {
  name: string
  url: string
  activationPoints: string[]
  active: boolean
}

/**
 * 插件完整元信息（包含 package.json 字段）
 *
 * 用于插件详情对话框展示
 */
export interface PluginFullInfo {
  name: string
  version: string
  description?: string
  author?: string | { name: string; email?: string; url?: string }
  license?: string
  main: string
  activationPoints: string[]
  active: boolean
  nikkiGallery?: NikkiGalleryManifest
  /** 插件加载错误信息（init 函数抛异常时填充） */
  error?: string
}

/**
 * 能力桥 pluginAPI 接口定义
 *
 * 通过 preload 暴露给渲染进程插件，所有方法返回 Promise
 */
export interface PluginAPI {
  media: {
    /** 读取单个媒体文件元数据 */
    read(filePath: string): Promise<Record<string, unknown> | null>
    /** 列出媒体文件 */
    list(filter?: {
      accountUid?: string
      albumType?: string
      limit?: number
      offset?: number
    }): Promise<Array<Record<string, unknown>>>
    /** 写入/导出媒体文件到指定目录 */
    write(targetDir: string, data: ArrayBuffer | string, fileName: string): Promise<string>
    /** 删除媒体文件（走回收站） */
    delete(filePaths: string[]): Promise<void>
  }
  db: {
    /** 受限数据库查询：仅允许 SELECT，且表名在白名单内 */
    query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>
  }
  fs: {
    /** 受 pathGuard 白名单约束的文件读取 */
    read(filePath: string): Promise<ArrayBuffer>
    /** 受 pathGuard 白名单约束的文件写入 */
    write(filePath: string, data: ArrayBuffer | string): Promise<void>
  }
  watermark: {
    /** 应用水印到指定文件列表 */
    apply(
      config: unknown,
      filePaths: string[],
      targetDir: string
    ): Promise<{ success: boolean; processed: number; failed?: number; message?: string }>
  }
  task: {
    /** 上报任务进度（接入 TaskScheduler 统一进度推送） */
    progress(taskId: string, current: number, total: number, phase?: string): Promise<void>
  }
  i18n: {
    /** 翻译键值（复用 i18next 实例） */
    t(key: string, options?: Record<string, unknown>): string
  }
}
