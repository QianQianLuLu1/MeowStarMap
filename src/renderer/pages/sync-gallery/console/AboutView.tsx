import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConsoleCard, ConsoleRow, ConsoleSection } from './console-ui'
import { CONSOLE_BRAND_IMAGE } from './brand-assets'
import { useGlobalToast } from '../../../components/common/ToastProvider'
import { useErrorToast } from '../../../hooks/useErrorToast'
import {
  NIKKISYNC_ALIGNED_VERSION,
  NIKKISYNC_ALIGNED_COMMIT
} from '../../../../shared/nikkisync-version'
import {
  UPSTREAM_ANDROID_APK_URL,
  UPSTREAM_QUARK_URL,
  UPSTREAM_BAIDU_URL,
  UPSTREAM_GITHUB_RELEASES_URL,
  UPSTREAM_REPO_LINKS
} from './upstream-links'
import { exportDiagnostics, openUpstreamLink } from './export-diagnostics'

/** 下载渠道四元组（顺序与上游 DesktopPage.ts:99–102 一致）。 */
const DOWNLOAD_CHANNELS = [
  { key: 'cnb', url: UPSTREAM_ANDROID_APK_URL },
  { key: 'quark', url: UPSTREAM_QUARK_URL },
  { key: 'baidu', url: UPSTREAM_BAIDU_URL },
  { key: 'github', url: UPSTREAM_GITHUB_RELEASES_URL }
] as const

/**
 * T11：关于视图——只呈现 NikkiSync 上游内容（版本/下载/仓库/署名）。
 *
 * 与上游的两处刻意差异（宿主语义优先）：
 * - 「检查更新」走宿主 app.checkUpdate 应用内更新通道，不做上游 EXE 自替换；
 * - 「发送诊断」上游 support-submit 通道本仓未装载 ⇒ 诚实置灰 + 说明，不伪造提交。
 */
export const AboutView: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useGlobalToast()
  const { showError } = useErrorToast()
  const [hostVersion, setHostVersion] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  // 宿主版本一次性读回；桥缺席保持 null（显示占位而非臆造版本号）
  useEffect(() => {
    let alive = true
    const getVersion = window.electronAPI?.app?.getVersion
    if (typeof getVersion !== 'function') return
    void getVersion()
      .then((version) => {
        if (alive && typeof version === 'string') setHostVersion(version)
      })
      .catch(() => {
        // 静默：保持占位
      })
    return () => {
      alive = false
    }
  }, [])

  /** T11：检查更新 = 宿主应用内更新通道（typeof 守卫；缺席诚实提示不可用）。 */
  const handleCheckUpdate = async (): Promise<void> => {
    const checkUpdate = window.electronAPI?.app?.checkUpdate
    if (typeof checkUpdate !== 'function') {
      showMessage(t('syncConsole.about.update.unavailable'), 'info')
      return
    }
    setChecking(true)
    try {
      await checkUpdate()
      showMessage(t('syncConsole.about.update.started'), 'info')
    } catch (error) {
      showError(error)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="sc-about">
      {/* 品牌 hero：对齐上游 about-summary（76px 头像 / 24px 标题 / 版本 / 作者 / 署名） */}
      <ConsoleCard className="sc-about-hero" testId="sync-about-hero">
        <div className="sc-about-mark">
          <img
            className="sc-brand-avatar"
            src={CONSOLE_BRAND_IMAGE}
            alt={t('syncConsole.shell.brandAlt')}
            width={76}
            height={76}
          />
        </div>
        <h2>{t('syncConsole.shell.brandName')}</h2>
        <p className="sc-about-version">
          <span>{hostVersion ?? '—'}</span>
          <span> · </span>
          <span>{NIKKISYNC_ALIGNED_VERSION}</span>
          <span> · </span>
          <span>{NIKKISYNC_ALIGNED_COMMIT}</span>
        </p>
        <p className="sc-about-author">{t('syncConsole.about.version.author')}</p>
        <p className="sc-about-lines">{t('syncConsole.about.version.attribution')}</p>
        <p className="sc-about-lines">
          {t('syncConsole.about.version.host')} · {t('syncConsole.about.version.aligned')}
        </p>
      </ConsoleCard>

      {/* 下载与更新：四渠道磁贴（上游 download-link 2 列网格）+ 宿主内更新通道 */}
      <ConsoleSection
        titleAs="h2"
        title={t('syncConsole.about.download.title')}
        description={t('syncConsole.about.download.networkHint')}
      >
        <div className="sc-download-grid">
          {DOWNLOAD_CHANNELS.map((channel) => {
            const label = t(`syncConsole.about.download.${channel.key}`)
            return (
              <a
                key={channel.key}
                href={channel.url}
                aria-label={label}
                className="sc-download-link"
                data-testid={`sync-about-download-${channel.key}`}
                onClick={(event) => {
                  event.preventDefault()
                  void openUpstreamLink(channel.url, showError)
                }}
              >
                <span className="sc-download-label">
                  <span>{t('syncConsole.shell.brandLatin')}</span>
                </span>
                <strong>{label}</strong>
                <small>{t(`syncConsole.about.download.${channel.key}Note`)}</small>
              </a>
            )
          })}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="sync-about-check-update"
            className="btn-primary text-sm"
            disabled={checking}
            onClick={() => void handleCheckUpdate()}
          >
            {t('syncConsole.about.update.check')}
          </button>
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {t('syncConsole.about.update.note')}
          </p>
        </div>
      </ConsoleSection>

      {/* 诊断与反馈：导出走既有 log:exportZip；support-submit 未装载 ⇒ 诚实置灰 */}
      <ConsoleSection titleAs="h2" title={t('syncConsole.about.feedback.title')}>
        <div className="sc-service-rows">
          <ConsoleRow
            label={t('syncConsole.statusBar.export')}
            description={t('syncConsole.about.feedback.exportNote')}
          >
            <button
              type="button"
              data-testid="sync-about-export"
              className="btn-secondary text-xs"
              onClick={() => void exportDiagnostics(t, showMessage, showError)}
            >
              {t('syncConsole.statusBar.export')}
            </button>
          </ConsoleRow>
          <ConsoleRow
            label={t('syncConsole.about.feedback.support')}
            description={t('syncConsole.about.feedback.supportNote')}
          >
            <button type="button" className="btn-secondary text-xs" disabled>
              {t('syncConsole.about.feedback.support')}
            </button>
          </ConsoleRow>
        </div>
      </ConsoleSection>

      {/* 项目仓库与来源：五链（上游六链减去已失效旧址，理由见 upstream-links.ts） */}
      <ConsoleSection titleAs="h2" title={t('syncConsole.about.repos.title')}>
        <div className="sc-service-rows">
          {UPSTREAM_REPO_LINKS.map((repo) => (
            <ConsoleRow
              key={repo.key}
              label={t(`syncConsole.about.repos.${repo.key}`)}
              description={
                repo.key === 'momo' ? repo.url : t(`syncConsole.about.repos.${repo.key}Note`)
              }
            >
              <button
                type="button"
                className="btn-secondary text-xs"
                onClick={() => void openUpstreamLink(repo.url, showError)}
              >
                {t(`syncConsole.about.repos.${repo.key}`)}
              </button>
            </ConsoleRow>
          ))}
        </div>
      </ConsoleSection>
    </div>
  )
}
