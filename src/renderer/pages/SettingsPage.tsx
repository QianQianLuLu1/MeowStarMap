import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  GeneralStartupSection,
  GeneralFileOpsSection,
  GeneralExportSection,
  LanguageSection,
  AppearanceThemeDisplaySection,
  ScanDirectoriesSection,
  ScanOptionsSection,
  ProfileManageSection,
  DataBackupSection,
  DataCacheClearSection,
  DiagnosticsLogsSection,
  DiagnosticsCrashSection,
  ScanLogDiagnosticSection,
  AboutOverviewSection,
  AboutLicenseSection,
  ToolsShareCodeSection,
  PluginManageSection
} from './settings/sections'

// ============ 设置导航结构 ============
// 二级分类 → 三级页面。2026-10-16 导航精简：9 组 23 节 → 8 组 17 节，
// 把同一业务域的功能聚到同一屏（详见 docs/plans/2026-10-16-settings-nav-consolidation.md）。
// 分组与章节名通过 i18n key 动态翻译，支持多语言。

interface SectionDef {
  id: string
  nameKey: string
  component: React.FC
}

interface GroupDef {
  id: string
  nameKey: string
  sections: SectionDef[]
}

const SETTINGS_GROUPS: GroupDef[] = [
  {
    id: 'general',
    nameKey: 'settings.groups.general',
    sections: [
      {
        id: 'general-startup',
        nameKey: 'settings.sections.startup',
        component: GeneralStartupSection
      },
      {
        id: 'general-fileops',
        nameKey: 'settings.sections.fileops',
        component: GeneralFileOpsSection
      },
      {
        id: 'general-export',
        nameKey: 'settings.sections.exportWorkflow',
        component: GeneralExportSection
      },
      // P2-01：语言设置区块，归类到"通用"分组下
      { id: 'general-language', nameKey: 'settings.sections.language', component: LanguageSection }
    ]
  },
  {
    id: 'appearance',
    nameKey: 'settings.groups.appearance',
    sections: [
      // 主题节原本只有一个下拉框，与显示节聚到一屏
      {
        id: 'appearance-theme-display',
        nameKey: 'settings.sections.themeDisplay',
        component: AppearanceThemeDisplaySection
      }
    ]
  },
  {
    id: 'scan',
    nameKey: 'settings.groups.scan',
    sections: [
      // 原 scan-paths / scan-game-roots / scan-import-roots / scan-fallback 四节
      // 全在管"哪些目录参与扫描"，合并为一页（需求三.3 与需求六的能力逐块保留）
      {
        id: 'scan-directories',
        nameKey: 'settings.sections.scanDirectories',
        component: ScanDirectoriesSection
      },
      {
        id: 'scan-options',
        nameKey: 'settings.sections.scanOptions',
        component: ScanOptionsSection
      }
    ]
  },
  {
    id: 'profile',
    nameKey: 'settings.groups.profile',
    sections: [
      {
        id: 'profile-manage',
        nameKey: 'settings.sections.profileManage',
        component: ProfileManageSection
      }
    ]
  },
  {
    id: 'data',
    nameKey: 'settings.groups.data',
    sections: [
      { id: 'data-backup', nameKey: 'settings.sections.dataBackup', component: DataBackupSection },
      // 清缓存与清库记录同属破坏性数据维护动作，聚到一屏
      {
        id: 'data-cache-clear',
        nameKey: 'settings.sections.cacheCleanup',
        component: DataCacheClearSection
      }
    ]
  },
  // 同步服务（开关/状态/配对/设备管理）已随「同步图库」板块化从本表移除，
  // 现由 pages/sync-gallery/SyncServicePage.tsx 承载，入口在同步图库工具栏。
  {
    id: 'diagnostics',
    nameKey: 'settings.groups.diagnostics',
    sections: [
      {
        id: 'diagnostics-scan',
        nameKey: 'settings.sections.scanDiagnostic',
        component: ScanLogDiagnosticSection
      },
      {
        id: 'diagnostics-logs',
        nameKey: 'settings.sections.diagnosticsLogs',
        component: DiagnosticsLogsSection
      },
      {
        id: 'diagnostics-crash',
        nameKey: 'settings.sections.diagnosticsCrash',
        component: DiagnosticsCrashSection
      }
    ]
  },
  {
    id: 'about',
    nameKey: 'settings.groups.about',
    sections: [
      // 应用信息与联系方式同属静态关于信息；开源许可篇幅长，仍独立成页
      {
        id: 'about-overview',
        nameKey: 'settings.sections.aboutOverview',
        component: AboutOverviewSection
      },
      {
        id: 'about-license',
        nameKey: 'settings.sections.aboutLicense',
        component: AboutLicenseSection
      }
    ]
  },
  // 原 tools 与 plugins 两个单节分组并成一个，两节功能不变
  {
    id: 'tools-plugins',
    nameKey: 'settings.groups.toolsPlugins',
    sections: [
      {
        id: 'tools-sharecode',
        nameKey: 'settings.sections.shareCode',
        component: ToolsShareCodeSection
      },
      {
        id: 'plugins-manage',
        nameKey: 'settings.sections.pluginManage',
        component: PluginManageSection
      }
    ]
  }
]

const DEFAULT_SECTION = 'general-startup'

/**
 * 导航合并掉的旧节 id（闭合联合类型：漏配或将来改名即 tsc 报错，
 * 不让迁移表退化成一组散落字符串）。
 */
type LegacySectionId =
  | 'appearance-theme'
  | 'appearance-display'
  | 'scan-paths'
  | 'scan-game-roots'
  | 'scan-import-roots'
  | 'scan-fallback'
  | 'data-cache'
  | 'data-clear'
  | 'about-info'
  | 'about-contact'

/** 旧 id → 合并后的新页 id，用于迁移老用户 localStorage 里的选中位置 */
const LEGACY_SECTION_ALIASES: Record<LegacySectionId, string> = {
  'appearance-theme': 'appearance-theme-display',
  'appearance-display': 'appearance-theme-display',
  'scan-paths': 'scan-directories',
  'scan-game-roots': 'scan-directories',
  'scan-import-roots': 'scan-directories',
  'scan-fallback': 'scan-directories',
  'data-cache': 'data-cache-clear',
  'data-clear': 'data-cache-clear',
  'about-info': 'about-overview',
  'about-contact': 'about-overview'
}

/** 收集当前导航树里的全部节 id */
const collectSectionIds = (): Set<string> =>
  new Set(SETTINGS_GROUPS.flatMap((group) => group.sections.map((s) => s.id)))

/**
 * 归一化持久化的选中节 id：
 * ① 无记录 → 默认节；② 命中合并前的旧 id → 迁移到新宿主页；
 * ③ 仍在当前树中 → 原样保留；④ 其余（含已整体移除的 'sync-service'）→ 首组首节。
 *
 * 必须在 useState 初值里调用而不是只靠渲染期的兜底：兜底只影响"渲染哪个组件"，
 * 脏 id 仍会被 useEffect 原样写回 localStorage，导致导航永远没有高亮。
 */
export const resolveActiveSection = (raw: string | null): string => {
  if (!raw) return DEFAULT_SECTION
  const aliased = LEGACY_SECTION_ALIASES[raw as LegacySectionId]
  if (aliased) return aliased
  if (collectSectionIds().has(raw)) return raw
  return SETTINGS_GROUPS[0].sections[0].id
}

export const SettingsPage: React.FC = () => {
  const { t } = useTranslation()
  // 持久化当前选中的 section，切换页面再回来时保持位置
  const [activeSection, setActiveSection] = useState<string>(() => {
    // 归一化必须在初值阶段完成：只靠渲染期的 findSection 兜底，脏 id 仍会被下面的
    // useEffect 原样写回 localStorage，于是下次进来照旧落回默认节、导航也无高亮。
    return resolveActiveSection(localStorage.getItem('settings-active-section'))
  })

  useEffect(() => {
    localStorage.setItem('settings-active-section', activeSection)
  }, [activeSection])

  // 查找当前 section 定义
  const findSection = (id: string): SectionDef | undefined => {
    for (const group of SETTINGS_GROUPS) {
      const found = group.sections.find((s) => s.id === id)
      if (found) return found
    }
    return undefined
  }

  const currentSection = findSection(activeSection) || SETTINGS_GROUPS[0].sections[0]
  const CurrentComponent = currentSection.component

  return (
    // P0-3：GlobalToastProvider 已提升到 App.tsx 根节点，此处不再需要包裹
    <div className="h-full flex flex-col">
      <h2 className="text-2xl font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
        {t('settings.title')}
      </h2>
      <div className="flex gap-6 flex-1 min-h-0">
        {/* 左侧导航：二级分类 + 三级页面列表 */}
        <nav
          className="w-48 flex-shrink-0 overflow-y-auto"
          aria-label={t('settings.navigation.ariaLabel')}
        >
          <div className="space-y-4">
            {SETTINGS_GROUPS.map((group) => (
              <div key={group.id}>
                <div
                  className="text-xs font-medium mb-2 px-2"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  {t(group.nameKey)}
                </div>
                <div className="space-y-1">
                  {group.sections.map((section) => {
                    const isActive = section.id === activeSection
                    return (
                      <button
                        key={section.id}
                        className="w-full text-left px-3 py-2 text-sm rounded-lg transition-all"
                        style={{
                          // 视觉体系 v3：激活态与 Sidebar 一致（accent-soft 底 + accent 字）
                          background: isActive ? 'var(--accent-soft)' : 'transparent',
                          color: isActive ? 'var(--accent)' : 'var(--text-primary)',
                          fontWeight: isActive ? 500 : 400
                        }}
                        onClick={() => setActiveSection(section.id)}
                      >
                        {t(section.nameKey)}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </nav>

        {/* 右侧内容区：当前选中的三级页面 */}
        <div className="flex-1 min-w-0 overflow-y-auto max-w-2xl">
          <CurrentComponent />
        </div>
      </div>
    </div>
  )
}
