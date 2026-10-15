import React, { lazy, Suspense, useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { AppShell } from './components/layout/AppShell'
import { FullscreenViewer } from './components/gallery/FullscreenViewer'
import { useUIStore, type ViewLevel } from './stores/uiStore'
import { useThemeStore, applyThemeClass } from './stores/themeStore'
import { type UITheme } from './styles/themes'
import { useRefreshMedia } from './hooks/useRefreshMedia'
import { useFilteredMediaFiles } from './hooks/useFilteredMediaFiles'
import { useGlobalUndo } from './hooks/useGlobalUndo'
import { useOperationHistoryStore } from './stores/operationHistoryStore'
// 全文搜索：在根组件启动 flexsearch 索引初始化 + 订阅 mediaStore 变化触发增量更新
import { useSearchIndex } from './search/use-search-index'
// P1-F5：注册操作历史数据库写入失败回调，在 React 树内桥接到 Toast
import {
  addOperationHistoryErrorHandler,
  removeOperationHistoryErrorHandler
} from './stores/operationHistoryStore'
// P0-3：全局 Toast Provider，覆盖所有页面（不仅限设置页）
import { GlobalToastProvider, useGlobalToast } from './pages/settings/sections'
// 插件系统：渲染进程引导（不阻塞首屏，失败仅记录日志）
import { bootstrapPluginRuntime } from './plugins/plugin-runtime'
// 错误边界：路由级（每页独立 + 切换页面自动重置）+ 区域级（FullscreenViewer 图片/视频渲染）
import { ErrorBoundary } from './components/common/ErrorBoundary'
import { RouteErrorFallback, ZoneErrorFallback } from './components/common/ErrorFallback'
import { UpdateDialog } from './components/common/UpdateDialog'

// P1-路由代码分割：页面组件改为懒加载，仅在首次访问对应视图时才拉取独立 chunk。
// 与下方 keep-alive（非活动页 display:none 保留挂载）天然兼容：懒加载只影响
// "视图第一次进入时拉取 chunk"，visitedViews 加入后组件即保持挂载，后续不重复加载。
// 页面为 named export，需映射到 lazy 要求的 { default } 形态
const GalleryPage = lazy(() =>
  import('./pages/GalleryPage').then((m) => ({ default: m.GalleryPage }))
)
const DetailPage = lazy(() => import('./pages/DetailPage').then((m) => ({ default: m.DetailPage })))
const EditorPage = lazy(() => import('./pages/EditorPage').then((m) => ({ default: m.EditorPage })))
const CategoriesPage = lazy(() =>
  import('./pages/CategoriesPage').then((m) => ({ default: m.CategoriesPage }))
)
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage }))
)
const RecycleBinPage = lazy(() =>
  import('./pages/RecycleBinPage').then((m) => ({ default: m.RecycleBinPage }))
)
const DuplicatesPage = lazy(() =>
  import('./pages/DuplicatesPage').then((m) => ({ default: m.DuplicatesPage }))
)
const ResonanceRecordsPage = lazy(() =>
  import('./pages/ResonanceRecordsPage').then((m) => ({ default: m.ResonanceRecordsPage }))
)
// 阶段 5：同步图库一级入口（内嵌 NikkiSync Runtime 的资产，独立列表状态）
const SyncGalleryPage = lazy(() =>
  import('./pages/sync-gallery/SyncGalleryPage').then((m) => ({ default: m.SyncGalleryPage }))
)

// 浅色轻量 Suspense fallback：仅加载期占位一屏，无毛玻璃无重资源。
// 内联 <style> 只在首次挂载时注入一次，后续复用；避免依赖全局动画类。
// fix-thumbnail-skeleton-reveal N6：背景与 spinner 颜色改用主题变量——
// 硬编码 #fff/#e5e7eb/#94a3b8 在暗色主题下路由首次切换会白屏闪烁
const PageFallback: React.FC = () => (
  <div
    className="h-full w-full"
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg-primary)'
    }}
  >
    <div
      aria-label="loading"
      style={{
        width: 24,
        height: 24,
        borderRadius: '50%',
        border: '2px solid var(--bg-tertiary)',
        borderTopColor: 'var(--text-secondary)',
        animation: 'p1-page-spin 0.7s linear infinite'
      }}
    />
    <style>{`@keyframes p1-page-spin { to { transform: rotate(360deg) } }`}</style>
  </div>
)

// 修复 U-S2：原 PageTransition 使用 key={currentView} 强制重挂载，
// 导致视图切换丢失滚动位置与组件内部状态、重复触发 fetchMediaFromDatabase。
// 改为 keep-alive 模式：已访问过的页面保持挂载，仅用 display:none 隐藏非活动页面。
const ALL_VIEWS: ViewLevel[] = [
  'gallery',
  'detail',
  'editor',
  'categories',
  'settings',
  'recycle-bin',
  'favorites',
  'duplicates',
  'launcher-cache',
  'resonance-records',
  'screenshots',
  'sync-gallery'
]

// C 阶段：界面层级映射，用于毛玻璃分层应用
// 一级界面不强化毛玻璃，二/三/四级界面逐级降低不透明度让模糊更可见
const VIEW_LEVEL_MAP: Record<ViewLevel, number> = {
  gallery: 1,
  categories: 1,
  settings: 1,
  'recycle-bin': 1,
  favorites: 1,
  duplicates: 1,
  'launcher-cache': 1,
  'resonance-records': 1,
  screenshots: 1,
  'sync-gallery': 1,
  detail: 2,
  editor: 3
}

/**
 * P1-F5：操作历史数据库错误桥接组件
 * 在 GlobalToastProvider 内部渲染（不输出 DOM），将 store 的错误回调注册到 Toast
 * zustand store 在 React 树外无法调用 useGlobalToast，通过此桥接组件注入
 */
const OperationHistoryErrorBridge: React.FC = () => {
  const showMessage = useGlobalToast()
  useEffect(() => {
    // P1-U8：使用 add/remove 订阅模式，支持多订阅者
    const handler = (msg: string) => showMessage(msg, 'error')
    addOperationHistoryErrorHandler(handler)
    return () => removeOperationHistoryErrorHandler(handler)
  }, [showMessage])
  return null
}

/**
 * R9：备份恢复后置修复桥接组件
 * 订阅主进程 backup:restored 事件，显示"已从备份恢复，正在校验数据"提示。
 * 在 GlobalToastProvider 内部渲染（不输出 DOM），通过 useGlobalToast 注入 Toast。
 */
const BackupRestoredBridge: React.FC = () => {
  const showMessage = useGlobalToast()
  const { t } = useTranslation()
  useEffect(() => {
    if (!window.electronAPI?.backup?.onRestored) return
    const unsubscribe = window.electronAPI.backup.onRestored(() => {
      // 备份恢复后主进程会异步触发 phash 重算 + duplicate 重新标记
      // 此处仅提示用户，校验完成后 media:updated 事件会自动刷新图库
      showMessage(t('toast.backup.restored'), 'info')
    })
    return () => {
      if (unsubscribe) unsubscribe()
    }
  }, [showMessage, t])
  return null
}

/**
 * R12：扫描半可见性提示桥接组件
 * 订阅主进程 scanner:interrupted 事件，显示"上次扫描未完成，部分文件可能未入库"提示。
 * 主进程在启动时检测 scan_history 中 status='interrupted' 的记录后广播此事件。
 */
const InterruptedScanBridge: React.FC = () => {
  const showMessage = useGlobalToast()
  const { t } = useTranslation()
  useEffect(() => {
    if (!window.electronAPI?.scanner?.onInterrupted) return
    const unsubscribe = window.electronAPI.scanner.onInterrupted(() => {
      showMessage(t('toast.scanInterrupted'), 'info')
    })
    return () => {
      if (unsubscribe) unsubscribe()
    }
  }, [showMessage, t])
  return null
}

const App: React.FC = () => {
  const { t } = useTranslation()
  const currentView = useUIStore((state) => state.currentView)
  const refreshMedia = useRefreshMedia()
  const theme = useThemeStore((state) => state.theme)
  // C-O5：在 App 顶层计算一次 filteredFiles 并传给 FullscreenViewer
  // （hook 内部有 module-level 缓存，GalleryPage/DetailPage 各自调用时不会重复计算）
  const filteredFiles = useFilteredMediaFiles()
  // F-S8：注册全局撤销快捷键（Ctrl+Z / Cmd+Z）
  useGlobalUndo()
  // 全文搜索：启动 flexsearch 索引（init + 增量更新订阅）
  useSearchIndex()

  // 建议改#9：应用启动时从数据库加载操作历史，支持跨重启撤销
  useEffect(() => {
    void useOperationHistoryStore.getState().loadFromDatabase()
  }, [])

  // 跟踪已访问过的视图，未访问的视图不挂载（避免 EditorPage 等在启动时空挂载）
  const [visitedViews, setVisitedViews] = useState<Set<ViewLevel>>(new Set([currentView]))
  useEffect(() => {
    setVisitedViews((prev) => {
      if (prev.has(currentView)) return prev
      const next = new Set(prev)
      next.add(currentView)
      return next
    })
  }, [currentView])

  // P2-U14：动画结束后移除 page-enter 类，释放 will-change 和 transform 残留
  // 否则合成层持续存在，破坏子元素 backdrop-filter 的实时采样，导致"动画结束后依然模糊"
  // 改用 onAnimationEnd 替代 setTimeout(280ms)，避免动画时长调整时需同步修改定时器
  const [enteringView, setEnteringView] = useState<ViewLevel | null>(null)
  useEffect(() => {
    setEnteringView(currentView)
  }, [currentView])

  useEffect(() => {
    refreshMedia()
  }, [refreshMedia])

  // 启动时应用持久化的主题类，防止 SSR/FOUC 后样式闪烁
  useEffect(() => {
    applyThemeClass(theme)
  }, [theme])

  // 插件系统引导：异步非阻塞，失败仅记录日志，不影响主程序
  // facade 未就绪（如 preload 加载失败）时 doBootstrap 内部会跳过
  useEffect(() => {
    void bootstrapPluginRuntime().catch((err) => {
      console.error(t('app.log.pluginBootstrapFailed'), err)
    })
  }, [t])

  // 启动时应用字体与显示偏好（字号、紧凑模式、动效减弱）
  useEffect(() => {
    const applyDisplayPrefs = async () => {
      if (!window.electronAPI?.settings?.get) return
      try {
        const html = document.documentElement
        // 字号
        const size = (await window.electronAPI.settings.get('display.fontSize', 'normal')) as string
        html.classList.remove(
          'font-size-small',
          'font-size-normal',
          'font-size-large',
          'font-size-xlarge'
        )
        html.classList.add(`font-size-${size || 'normal'}`)
        // 紧凑模式
        const compact = (await window.electronAPI.settings.get(
          'display.compactMode',
          false
        )) as boolean
        html.classList.toggle('compact-mode', compact)
        // 动效减弱
        const motion = (await window.electronAPI.settings.get(
          'display.reduceMotion',
          false
        )) as boolean
        html.classList.toggle('reduce-motion', motion)
        // 玻璃效果档位：rich（默认，明显流动感）| lite（轻度增强）；非法值按 rich 处理
        const glass = (await window.electronAPI.settings.get(
          'display.glassEffect',
          'rich'
        )) as string
        html.classList.toggle('glass-lite', glass === 'lite')
        // 视觉体系 v3：氛围层细项开关（默认开启，关闭时挂对应根类隐藏）
        const ambientGrain = (await window.electronAPI.settings.get(
          'display.ambientGrain',
          true
        )) as boolean
        html.classList.toggle('grain-off', ambientGrain === false)
        const ambientShapes = (await window.electronAPI.settings.get(
          'display.ambientShapes',
          true
        )) as boolean
        html.classList.toggle('shapes-off', ambientShapes === false)
      } catch {
        // 预览版无 IPC，静默忽略
      }
    }
    applyDisplayPrefs()
  }, [])

  // 与主进程设置保持同步（设置数据库为最终持久化源）
  useEffect(() => {
    const sync = async () => {
      if (!window.electronAPI?.uiTheme?.get) return
      try {
        const res = await window.electronAPI.uiTheme.get()
        const remoteTheme = (res.theme as UITheme) || 'default'
        if (remoteTheme !== theme) {
          useThemeStore.getState().setTheme(remoteTheme)
        }
      } catch {
        // 预览版无 IPC，静默忽略
      }
    }
    sync()
  }, [theme])

  const renderPage = useCallback((view: ViewLevel): React.ReactNode => {
    switch (view) {
      case 'gallery':
        return <GalleryPage />
      case 'detail':
        return <DetailPage />
      case 'editor':
        return <EditorPage />
      case 'categories':
        return <CategoriesPage />
      case 'settings':
        return <SettingsPage />
      case 'recycle-bin':
        return <RecycleBinPage />
      case 'favorites':
        // F-S10：收藏夹视图复用 GalleryPage，由其内部根据 currentView 筛选 is_favorite
        return <GalleryPage />
      case 'launcher-cache':
        // 启动器缓存视图复用 GalleryPage，mediaStore 根据 currentView 自动过滤 media_source='launcher'
        return <GalleryPage />
      case 'resonance-records':
        // 共鸣录：即将上线占位页，无媒体数据
        return <ResonanceRecordsPage />
      case 'screenshots':
        // 截图视图复用 GalleryPage，mediaStore 根据 currentView 自动过滤 media_source='local_screenshot'
        return <GalleryPage />
      case 'duplicates':
        // F-S10：重复文件检测独立视图
        return <DuplicatesPage />
      case 'sync-gallery':
        // 阶段 5：同步图库是**独立页面**，不复用 GalleryPage——本 switch 有 default 兜到
        // GalleryPage，漏写这个 case 不会编译失败，只会静默把图库渲染两遍。
        return <SyncGalleryPage />
      default:
        return <GalleryPage />
    }
  }, [])

  // Suspense 放在 ErrorBoundary 内层：fallback 只负责 chunk 加载期占位，
  // 加载失败的错误仍由 ErrorBoundary 兜底，互不干扰。
  const renderView = useCallback(
    (view: ViewLevel): React.ReactNode => {
      return <Suspense fallback={<PageFallback />}>{renderPage(view)}</Suspense>
    },
    [renderPage]
  )

  return (
    // P0-3：GlobalToastProvider 提升到 App 根节点，所有页面共享 Toast 实例
    <GlobalToastProvider>
      {/* P1-F5：桥接 operationHistoryStore 的数据库错误到 Toast（在 Provider 内才能调用 useGlobalToast） */}
      <OperationHistoryErrorBridge />
      {/* R9：桥接 backup:restored 事件到 Toast，显示"已从备份恢复，正在校验数据" */}
      <BackupRestoredBridge />
      {/* R12：桥接 scanner:interrupted 事件到 Toast，显示"上次扫描未完成" */}
      <InterruptedScanBridge />
      {/* 自动更新弹窗：复用 electron-updater，全局常驻订阅 app:update 推送 */}
      <UpdateDialog />
      <AppShell>
        {/* keep-alive：已访问的页面保持挂载，仅隐藏非活动页面，保留滚动位置与组件状态 */}
        {ALL_VIEWS.map((view) => {
          if (!visitedViews.has(view)) return null
          const isActive = view === currentView
          // P2-U14：动画结束后移除 page-enter 类，避免 will-change 和 transform 残留
          const showEnter = isActive && enteringView === view
          return (
            <div
              key={view}
              className={showEnter ? 'h-full page-enter' : 'h-full'}
              style={{ display: isActive ? 'block' : 'none' }}
              data-view-level={VIEW_LEVEL_MAP[view]}
              onAnimationEnd={() => {
                if (enteringView === view) setEnteringView(null)
              }}
            >
              {/*
                路由级 ErrorBoundary：每个 view 独立边界，一处出错只影响该页内容区，
                侧边栏/顶部栏/状态栏不受影响。resetKeys=[currentView] 让切换页面时
                所有 view 的边界自动重置，避免回到曾出错的页面仍卡在错误态。
              */}
              <ErrorBoundary resetKeys={[currentView]} fallback={RouteErrorFallback}>
                {renderView(view)}
              </ErrorBoundary>
            </div>
          )
        })}
      </AppShell>
      {/* 区域级 ErrorBoundary：FullscreenViewer 直接渲染原图/视频，解码失败概率高，
          包边界后单张媒体出错只显示小占位块，不波及整个图库页面 */}
      <ErrorBoundary fallback={ZoneErrorFallback}>
        <FullscreenViewer filteredFiles={filteredFiles} />
      </ErrorBoundary>
    </GlobalToastProvider>
  )
}

export default App
