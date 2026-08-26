import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  GeneralStartupSection,
  GeneralFileOpsSection,
  GeneralExportSection,
  AppearanceThemeSection,
  AppearanceDisplaySection,
  ScanPathsSection,
  ScanOptionsSection,
  ImportRootsSection,
  ProfileManageSection,
  DataBackupSection,
  DataCacheSection,
  DataClearSection,
  DiagnosticsLogsSection,
  DiagnosticsCrashSection,
  ScanLogDiagnosticSection,
  AboutInfoSection,
  AboutContactSection,
  AboutLicenseSection,
  LanguageSection,
  ToolsShareCodeSection,
  PluginManageSection
} from './settings/sections'

// ============ 设置导航结构 ============
// 二级分类 → 三级页面，按 T06 层级树设计
// P2-01：分组与章节名通过 i18n key 动态翻译，支持多语言

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

// P2-01：分组与章节定义使用 i18n key，渲染时通过 t() 翻译
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
      // P2-01：新增语言设置区块，归类到"通用"分组下
      { id: 'general-language', nameKey: 'settings.sections.language', component: LanguageSection }
    ]
  },
  {
    id: 'appearance',
    nameKey: 'settings.groups.appearance',
    sections: [
      {
        id: 'appearance-theme',
        nameKey: 'settings.sections.theme',
        component: AppearanceThemeSection
      },
      {
        id: 'appearance-display',
        nameKey: 'settings.sections.display',
        component: AppearanceDisplaySection
      }
    ]
  },
  {
    id: 'scan',
    nameKey: 'settings.groups.scan',
    sections: [
      {
        id: 'scan-paths',
        nameKey: 'settings.sections.scanPaths',
        component: ScanPathsSection
      },
      {
        id: 'scan-options',
        nameKey: 'settings.sections.scanOptions',
        component: ScanOptionsSection
      },
      {
        id: 'scan-import-roots',
        nameKey: 'settings.sections.importRoots',
        component: ImportRootsSection
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
      { id: 'data-cache', nameKey: 'settings.sections.dataCache', component: DataCacheSection },
      { id: 'data-clear', nameKey: 'settings.sections.dataClear', component: DataClearSection }
    ]
  },
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
      { id: 'about-info', nameKey: 'settings.sections.aboutInfo', component: AboutInfoSection },
      {
        id: 'about-contact',
        nameKey: 'settings.sections.aboutContact',
        component: AboutContactSection
      },
      {
        id: 'about-license',
        nameKey: 'settings.sections.aboutLicense',
        component: AboutLicenseSection
      }
    ]
  },
  {
    id: 'tools',
    nameKey: 'settings.groups.tools',
    sections: [
      {
        id: 'tools-sharecode',
        nameKey: 'settings.sections.shareCode',
        component: ToolsShareCodeSection
      }
    ]
  },
  {
    id: 'plugins',
    nameKey: 'settings.groups.plugins',
    sections: [
      {
        id: 'plugins-manage',
        nameKey: 'settings.sections.pluginManage',
        component: PluginManageSection
      }
    ]
  }
]

const DEFAULT_SECTION = 'general-startup'

export const SettingsPage: React.FC = () => {
  const { t } = useTranslation()
  // 持久化当前选中的 section，切换页面再回来时保持位置
  const [activeSection, setActiveSection] = useState<string>(() => {
    return localStorage.getItem('settings-active-section') || DEFAULT_SECTION
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
                          background: isActive ? 'var(--bg-tertiary)' : 'transparent',
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
