import React, { useState, useContext, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAutoAnimate } from '@formkit/auto-animate/react'
import {
  IconDouyin,
  IconBilibili,
  IconXiaohongshu,
  IconRotateCw,
  IconGithub,
  IconQQ,
  IconChevronDown
} from '../../icons'
import { SectionShell, GlobalToastContext, SettingsCard } from './shared'

// ============ 关于 ============

const GITHUB_URL = 'https://github.com/QianQianLuLu1/MeowStarMap'
const QQ_GROUP = '635492596'

export const AboutInfoSection: React.FC = () => {
  const { t } = useTranslation()
  // U1：动态读取应用版本号，避免渲染层硬编码
  const [appVersion, setAppVersion] = useState<string>('')
  useEffect(() => {
    let mounted = true
    window.electronAPI?.app
      ?.getVersion?.()
      .then((v) => {
        if (mounted && v) setAppVersion(v)
      })
      .catch(() => {
        if (mounted) setAppVersion('unknown')
      })
    return () => {
      mounted = false
    }
  }, [])
  const handleCheckUpdate = async () => {
    // 优先走应用内自动更新：主进程经 electron-updater 检查 GitHub Release，
    // 结果通过 app:update 推送给 UpdateDialog 弹窗。未打包（开发）或接口不可用时兜底打开仓库。
    try {
      await window.electronAPI?.app?.checkUpdate?.()
    } catch {
      window.electronAPI?.shell?.openExternal?.(GITHUB_URL)
    }
  }

  return (
    <SectionShell title={t('settings.sections.aboutInfo')}>
      <div className="space-y-2 text-sm" style={{ color: 'var(--text-primary)' }}>
        <div className="flex justify-between">
          <span style={{ color: 'var(--text-secondary)' }}>{t('settings.about.appName')}</span>
          <span>{t('settings.about.appValue')}</span>
        </div>
        <div className="flex justify-between">
          <span style={{ color: 'var(--text-secondary)' }}>{t('settings.about.version')}</span>
          <span>{appVersion ? `v${appVersion}` : '—'}</span>
        </div>
        <div className="flex justify-between">
          <span style={{ color: 'var(--text-secondary)' }}>{t('settings.about.developer')}</span>
          <span>QianLu</span>
        </div>
        <div className="flex justify-between">
          <span style={{ color: 'var(--text-secondary)' }}>{t('settings.about.techStack')}</span>
          <span>Electron 28 + React 18 + TypeScript 5.3</span>
        </div>
        <div className="flex justify-between">
          <span style={{ color: 'var(--text-secondary)' }}>{t('settings.about.repo')}</span>
          <a
            className="text-xs font-mono"
            style={{ color: 'var(--accent)' }}
            title={GITHUB_URL}
            onClick={handleCheckUpdate}
          >
            Meow Star Map
          </a>
        </div>
      </div>

      {/* T07：检查更新入口 */}
      <div className="pt-4 space-y-2" style={{ borderTop: '1px solid var(--divider)' }}>
        <button className="btn-primary w-full" onClick={handleCheckUpdate}>
          <span className="flex items-center justify-center gap-2">
            <IconRotateCw size={16} />
            {t('settings.about.checkUpdate')}
          </span>
        </button>
        <p className="text-xs text-center" style={{ color: 'var(--text-tertiary)' }}>
          {t('settings.about.checkUpdateHint')}
        </p>
      </div>

      <div className="pt-4 flex flex-col items-center space-y-2">
        <div className="text-center">
          <p className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>
            {t('settings.about.devCredit')}
          </p>
          <p className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>
            {t('settings.about.alias')}
          </p>
        </div>
      </div>
      <div className="pt-2 text-xs text-center" style={{ color: 'var(--text-tertiary)' }}>
        {t('settings.about.copyright')}
      </div>
    </SectionShell>
  )
}

export const AboutContactSection: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useContext(GlobalToastContext)

  const handleCopyQQGroup = async () => {
    try {
      await navigator.clipboard.writeText(QQ_GROUP)
      showMessage(t('logAction.qqCopied'), 'success')
    } catch {
      showMessage(t('logAction.qqCopyFailed'), 'error')
    }
  }

  return (
    <SectionShell
      title={t('settings.sections.aboutContact')}
      description={t('settings.about.contactDesc')}
    >
      {/* GitHub */}
      <SettingsCard className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <IconGithub size={24} style={{ color: 'var(--text-primary)' }} />
          <div>
            <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
              {t('settings.about.githubRepo')}
            </div>
            <div
              className="text-xs font-mono"
              style={{ color: 'var(--text-tertiary)' }}
              title={GITHUB_URL}
            >
              {GITHUB_URL}
            </div>
          </div>
        </div>
        <button
          className="btn-secondary text-xs px-3 py-1.5 flex-shrink-0"
          onClick={() => window.electronAPI?.shell?.openExternal?.(GITHUB_URL)}
          title={t('settings.about.open')}
        >
          {t('settings.about.open')}
        </button>
      </SettingsCard>

      {/* QQ 群 */}
      <SettingsCard className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <IconQQ size={24} className="text-[#12B7F5]" />
          <div>
            <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
              {t('settings.about.qqGroup')}
            </div>
            <div className="text-xs font-mono" style={{ color: 'var(--text-tertiary)' }}>
              {QQ_GROUP}
            </div>
          </div>
        </div>
        <button
          className="btn-secondary text-xs px-3 py-1.5 flex-shrink-0"
          onClick={handleCopyQQGroup}
          title={t('settings.about.copyGroup')}
        >
          {t('settings.about.copyGroup')}
        </button>
      </SettingsCard>

      {/* 社交媒体 */}
      <div className="pt-3 space-y-2" style={{ borderTop: '1px solid var(--divider)' }}>
        <p className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
          {t('settings.about.socialMedia')}
        </p>
        <div className="flex gap-4 justify-center pt-2">
          <div className="flex flex-col items-center gap-1">
            <button
              className="social-btn"
              onClick={() =>
                window.electronAPI?.shell?.openExternal?.('https://v.douyin.com/XkTzyJeCFIU/')
              }
              title={t('settings.about.douyin')}
              aria-label={t('settings.about.douyin')}
            >
              <IconDouyin size={20} />
            </button>
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {t('settings.about.douyin')}
            </span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <button
              className="social-btn"
              onClick={() => window.electronAPI?.shell?.openExternal?.('https://b23.tv/FtjgFrW')}
              title={t('settings.about.bilibili')}
              aria-label={t('settings.about.bilibili')}
            >
              <IconBilibili size={20} />
            </button>
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {t('settings.about.bilibili')}
            </span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <button
              className="social-btn"
              onClick={() =>
                window.electronAPI?.shell?.openExternal?.('https://xhslink.com/m/AxkdRvT3QsH')
              }
              title={t('settings.about.xiaohongshu')}
              aria-label={t('settings.about.xiaohongshu')}
            >
              <IconXiaohongshu size={20} />
            </button>
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {t('settings.about.xiaohongshu')}
            </span>
          </div>
        </div>
      </div>
    </SectionShell>
  )
}

export const AboutLicenseSection: React.FC = () => {
  const { t, i18n } = useTranslation()
  const [expanded, setExpanded] = useState<string | null>(null)
  // P2-1：许可证项展开/折叠时 FLIP 平滑重排
  const [licenseListRef] = useAutoAnimate({ duration: 200, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' })
  // Bug #10-C1：动态读取应用版本号，与 AboutInfoSection 一致，避免 i18n 硬编码漂移
  const [appVersion, setAppVersion] = useState<string>('')
  useEffect(() => {
    let mounted = true
    window.electronAPI?.app
      ?.getVersion?.()
      .then((v) => {
        if (mounted && v) setAppVersion(v)
      })
      .catch(() => {
        if (mounted) setAppVersion('unknown')
      })
    return () => {
      mounted = false
    }
  }, [])

  // 运行时核心依赖（直接影响软件功能）
  const runtimeDeps: {
    name: string
    version: string
    license: string
    descKey: string
    homepage: string
    /** 可选：该条目在当前语言为英文占位时的翻译待办提示 key */
    todoKey?: string
  }[] = [
    {
      name: 'electron',
      version: '28.x',
      license: 'MIT',
      descKey: 'settings.about.depDesc.electron',
      homepage: 'https://www.electronjs.org/'
    },
    {
      name: 'react',
      version: '18.x',
      license: 'MIT',
      descKey: 'settings.about.depDesc.react',
      homepage: 'https://react.dev/'
    },
    {
      name: 'react-dom',
      version: '18.x',
      license: 'MIT',
      descKey: 'settings.about.depDesc.reactDom',
      homepage: 'https://react.dev/'
    },
    {
      name: 'zustand',
      version: '4.x',
      license: 'MIT',
      descKey: 'settings.about.depDesc.zustand',
      homepage: 'https://github.com/pmndrs/zustand'
    },
    {
      name: 'better-sqlite3',
      version: '9.x',
      license: 'MIT',
      descKey: 'settings.about.depDesc.betterSqlite3',
      homepage: 'https://github.com/WiseLibs/better-sqlite3'
    },
    {
      name: 'sharp',
      version: '0.33.x',
      license: 'Apache-2.0',
      descKey: 'settings.about.depDesc.sharp',
      homepage: 'https://sharp.pixelplumbing.com/'
    },
    {
      name: 'ffmpeg-static',
      version: '5.x',
      license: 'GPL-3.0',
      descKey: 'settings.about.depDesc.ffmpegStatic',
      homepage: 'https://github.com/eugeneware/ffmpeg-static'
    },
    {
      name: 'ffprobe-static',
      version: '3.x',
      license: 'GPL-3.0',
      descKey: 'settings.about.depDesc.ffprobeStatic',
      homepage: 'https://github.com/eugeneware/ffprobe-static'
    },
    {
      name: 'fluent-ffmpeg',
      version: '2.x',
      license: 'MIT',
      descKey: 'settings.about.depDesc.fluentFfmpeg',
      homepage: 'https://github.com/fluent-ffmpeg/node-fluent-ffmpeg'
    },
    {
      name: 'exifr',
      version: '7.x',
      license: 'MIT',
      descKey: 'settings.about.depDesc.exifr',
      homepage: 'https://github.com/MikeKovchina/exifr'
    },
    // P1-1：动画库
    {
      name: 'motion',
      version: '12.x',
      license: 'MIT',
      descKey: 'settings.about.depDesc.motion',
      homepage: 'https://motion.dev/'
    },
    // P2-1：列表 FLIP 动画库
    {
      name: '@formkit/auto-animate',
      version: '0.9.x',
      license: 'MIT',
      descKey: 'settings.about.depDesc.autoAnimate',
      homepage: 'https://auto-animate.formkit.com/'
    },
    // 共鸣录板块：逻辑复用自 gongeo.us-nikki-tracker（MIT，已获原作者授权）。
    //homepage 为仓库元数据展示，运行时不发起任何网络请求。
    {
      name: 'gongeo.us-nikki-tracker',
      version: 'master · 2026-08-29',
      license: 'MIT',
      descKey: 'settings.about.depDesc.gongeouNikkiTracker',
      homepage: 'https://github.com/dastrokes/gongeo.us-nikki-tracker',
      todoKey: 'settings.about.depDescTodo.gongeous'
    }
  ]

  // 构建工具链（开发依赖）
  const buildTools: { name: string; license: string; descKey: string }[] = [
    { name: 'Vite', license: 'MIT', descKey: 'settings.about.toolDesc.vite' },
    { name: 'TypeScript', license: 'Apache-2.0', descKey: 'settings.about.toolDesc.typeScript' },
    {
      name: 'electron-builder',
      license: 'MIT',
      descKey: 'settings.about.toolDesc.electronBuilder'
    },
    { name: 'Tailwind CSS', license: 'MIT', descKey: 'settings.about.toolDesc.tailwindCss' },
    { name: 'ESLint', license: 'MIT', descKey: 'settings.about.toolDesc.eslint' },
    { name: 'Vitest', license: 'MIT', descKey: 'settings.about.toolDesc.vitest' }
  ]

  const openUrl = (url: string) => {
    window.electronAPI?.shell?.openExternal?.(url)
  }

  return (
    <SectionShell
      title={t('settings.sections.aboutLicense')}
      description={t('settings.about.licenseDesc')}
    >
      {/* 项目信息 */}
      <div className="p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
        <div className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
          {t('settings.about.appValue')}
        </div>
        <div className="text-xs space-y-1" style={{ color: 'var(--text-secondary)' }}>
          <div>{t('settings.about.versionLabel', { version: appVersion || '—' })}</div>
          <div>{t('settings.about.authorLabel')}</div>
          <div>
            {t('settings.about.repoLabel')}
            <button
              onClick={() => openUrl('https://github.com/QianQianLuLu1/MeowStarMap')}
              className="ml-1 hover:underline"
              style={{ color: 'var(--accent)' }}
            >
              github.com/QianQianLuLu1/MeowStarMap
            </button>
          </div>
          <div className="mt-2 pt-2 border-t" style={{ borderColor: 'var(--divider)' }}>
            {t('settings.about.projectIntro')}
          </div>
        </div>
      </div>

      {/* 运行时依赖 */}
      <div className="space-y-2">
        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {t('settings.about.runtimeDeps')}
        </div>
        <div ref={licenseListRef} className="space-y-1">
          {runtimeDeps.map((dep) => (
            <div
              key={dep.name}
              className="rounded-lg overflow-hidden"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <button
                onClick={() => setExpanded(expanded === dep.name ? null : dep.name)}
                className="w-full flex items-center justify-between gap-3 p-3 text-left hover:bg-opacity-80 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm" style={{ color: 'var(--text-primary)' }}>
                      {dep.name}
                    </span>
                    <span
                      className="text-xs px-1.5 py-0.5 rounded"
                      style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}
                    >
                      {dep.version}
                    </span>
                    <span
                      className="text-xs px-1.5 py-0.5 rounded"
                      style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                    >
                      {dep.license}
                    </span>
                  </div>
                </div>
                <IconChevronDown
                  size={16}
                  style={{
                    color: 'var(--text-tertiary)',
                    transform: expanded === dep.name ? 'rotate(180deg)' : 'none',
                    transition: 'transform 0.2s'
                  }}
                />
              </button>
              {expanded === dep.name && (
                <div
                  className="px-3 pb-3 text-xs space-y-1"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <div>{t(dep.descKey)}</div>
                  {dep.todoKey && i18n.language !== 'zh-CN' && i18n.language !== 'en' && (
                    <div style={{ color: 'var(--text-tertiary)' }}>{t(dep.todoKey)}</div>
                  )}
                  <button
                    onClick={() => openUrl(dep.homepage)}
                    className="hover:underline"
                    style={{ color: 'var(--accent)' }}
                  >
                    {dep.homepage}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 构建工具 */}
      <div className="space-y-2">
        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {t('settings.about.buildTools')}
        </div>
        <div className="flex flex-wrap gap-2">
          {buildTools.map((tool) => (
            <div
              key={tool.name}
              className="px-3 py-2 rounded-lg text-xs"
              style={{ background: 'var(--bg-tertiary)' }}
              title={t(tool.descKey)}
            >
              <span className="font-mono" style={{ color: 'var(--text-primary)' }}>
                {tool.name}
              </span>
              <span className="ml-2" style={{ color: 'var(--text-tertiary)' }}>
                {tool.license}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* License 说明 */}
      <div
        className="p-3 rounded-lg text-xs space-y-2"
        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
      >
        <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
          {t('settings.about.licenseNote')}
        </div>
        <div>{t('settings.about.licenseMit')}</div>
        <div>{t('settings.about.licenseApache')}</div>
        <div>{t('settings.about.licenseGpl')}</div>
      </div>
    </SectionShell>
  )
}

/**
 * 「应用信息与联系方式」合并页：两节都是关于应用的静态信息（版本/开发者/仓库地址
 * 与社交渠道），各自单独占一个导航项过于零碎。开源许可与致谢篇幅长，仍留在独立页。
 * 两节各自保留 SectionShell，本组件只管纵向排布。
 */
export const AboutOverviewSection: React.FC = () => (
  <div className="space-y-4">
    <AboutInfoSection />
    <AboutContactSection />
  </div>
)
