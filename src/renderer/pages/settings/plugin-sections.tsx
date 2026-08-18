/**
 * 插件管理 Section
 *
 * 设计目标：
 * - 展示已安装插件列表（名称、版本、描述、状态、权限）
 * - 支持启用/禁用、卸载、检查更新、更新操作
 * - 支持从 .tgz 文件或 npm 包名安装插件
 * - 展示插件存储目录路径
 * - 展示插件加载错误信息（init 抛异常时）
 *
 * 复用：
 * - SectionShell / SettingsRow / SettingsCard 共享组件
 * - usePluginStore 集中状态管理
 * - useGlobalToast 错误提示
 */
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SectionShell, SettingsRow, SettingsCard, useGlobalToast } from './shared'
import { usePluginStore } from '../../stores/pluginStore'
import { BaseDialog } from '../../components/common/BaseDialog'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { ErrorBoundary } from '../../components/common/ErrorBoundary'
import { ZoneErrorFallback } from '../../components/common/ErrorFallback'
import type { PluginFullInfo } from '../../../shared/types/plugin'

// ============ 插件管理主 Section ============

export const PluginManageSection: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useGlobalToast()
  const {
    plugins,
    loading,
    error,
    pluginsPath,
    operatingName,
    operatingAction,
    loadPlugins,
    loadPluginsPath,
    togglePlugin,
    uninstallPlugin,
    installPlugin,
    updatePlugin,
    checkUpdate,
    clearError
  } = usePluginStore()

  const [installDialogOpen, setInstallDialogOpen] = useState(false)
  const [uninstallTarget, setUninstallTarget] = useState<PluginFullInfo | null>(null)
  const [detailTarget, setDetailTarget] = useState<PluginFullInfo | null>(null)
  const [updateInfo, setUpdateInfo] = useState<{ name: string; version: string } | null>(null)

  // 首次挂载加载插件列表和路径
  useEffect(() => {
    void loadPlugins()
    void loadPluginsPath()
  }, [loadPlugins, loadPluginsPath])

  // 错误提示（防抖，避免连续错误刷屏）
  useEffect(() => {
    if (error) {
      showMessage(error, 'error')
      const timer = setTimeout(() => clearError(), 100)
      return () => clearTimeout(timer)
    }
  }, [error, showMessage, clearError])

  const handleToggle = async (plugin: PluginFullInfo) => {
    const success = await togglePlugin(plugin.name, !plugin.active)
    if (success) {
      showMessage(
        t(plugin.active ? 'settings.plugin.disabled' : 'settings.plugin.enabled', {
          name: plugin.name
        }),
        'success'
      )
    }
  }

  const handleUninstall = async () => {
    if (!uninstallTarget) return
    const name = uninstallTarget.name
    const success = await uninstallPlugin(name)
    if (success) {
      showMessage(t('settings.plugin.uninstalled', { name }), 'success')
    }
    setUninstallTarget(null)
  }

  const handleCheckUpdate = async (plugin: PluginFullInfo) => {
    const version = await checkUpdate(plugin.name)
    if (version === false) {
      showMessage(t('settings.plugin.noUpdate', { name: plugin.name }), 'info')
    } else {
      setUpdateInfo({ name: plugin.name, version })
    }
  }

  const handleUpdate = async (name: string) => {
    setUpdateInfo(null)
    const success = await updatePlugin(name)
    if (success) {
      showMessage(t('settings.plugin.updated', { name }), 'success')
    }
  }

  const handleInstall = async (specifier: string) => {
    setInstallDialogOpen(false)
    const success = await installPlugin(specifier)
    if (success) {
      showMessage(t('settings.plugin.installed'), 'success')
    }
  }

  return (
    // 区域级 ErrorBoundary：插件面板加载/渲染出错时仅替换该 Section 为小占位块，
    // 设置页左侧导航与其他 Section 不受影响
    <ErrorBoundary fallback={ZoneErrorFallback}>
      <SectionShell
        title={t('settings.sections.pluginManage')}
        description={t('settings.plugin.description')}
      >
        {/* 插件存储目录 */}
        <SettingsRow
          label={t('settings.plugin.storagePath')}
          description={t('settings.plugin.storagePathDesc')}
        >
          <span
            className="text-xs font-mono truncate max-w-[200px] inline-block"
            style={{ color: 'var(--text-tertiary)' }}
            title={pluginsPath}
          >
            {pluginsPath || t('settings.plugin.notAvailable')}
          </span>
        </SettingsRow>

        {/* 操作按钮区 */}
        <div className="flex gap-2">
          <button
            className="btn-primary text-sm"
            onClick={() => setInstallDialogOpen(true)}
            disabled={!!operatingName}
          >
            {t('settings.plugin.install')}
          </button>
          <button
            className="btn-secondary text-sm"
            onClick={() => {
              void loadPlugins()
              void loadPluginsPath()
            }}
            disabled={loading}
          >
            {loading ? t('common.loading') : t('common.refresh')}
          </button>
        </div>

        {/* 插件列表 */}
        <div className="space-y-2">
          {loading && plugins.length === 0 ? (
            <div className="text-center py-8 text-sm" style={{ color: 'var(--text-tertiary)' }}>
              {t('common.loading')}
            </div>
          ) : plugins.length === 0 ? (
            <div className="text-center py-8 text-sm" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.plugin.empty')}
            </div>
          ) : (
            plugins.map((plugin) => (
              <PluginCard
                key={plugin.name}
                plugin={plugin}
                operating={operatingName === plugin.name}
                operatingAction={operatingAction}
                onToggle={() => handleToggle(plugin)}
                onUninstall={() => setUninstallTarget(plugin)}
                onDetail={() => setDetailTarget(plugin)}
                onCheckUpdate={() => handleCheckUpdate(plugin)}
                onUpdate={() => handleUpdate(plugin.name)}
              />
            ))
          )}
        </div>

        {/* 安装对话框 */}
        <InstallPluginDialog
          open={installDialogOpen}
          onClose={() => setInstallDialogOpen(false)}
          onInstall={handleInstall}
        />

        {/* 卸载确认对话框 */}
        <ConfirmDialog
          open={!!uninstallTarget}
          title={t('settings.plugin.uninstallTitle')}
          message={t('settings.plugin.uninstallConfirm', { name: uninstallTarget?.name ?? '' })}
          confirmText={t('settings.plugin.uninstall')}
          cancelText={t('common.cancel')}
          onConfirm={handleUninstall}
          onCancel={() => setUninstallTarget(null)}
        />

        {/* 更新确认对话框 */}
        <ConfirmDialog
          open={!!updateInfo}
          title={t('settings.plugin.updateTitle')}
          message={t('settings.plugin.updateConfirm', {
            name: updateInfo?.name ?? '',
            version: updateInfo?.version ?? ''
          })}
          confirmText={t('settings.plugin.update')}
          cancelText={t('common.cancel')}
          onConfirm={() => updateInfo && handleUpdate(updateInfo.name)}
          onCancel={() => setUpdateInfo(null)}
        />

        {/* 插件详情对话框 */}
        {detailTarget && (
          <PluginDetailDialog plugin={detailTarget} onClose={() => setDetailTarget(null)} />
        )}
      </SectionShell>
    </ErrorBoundary>
  )
}

// ============ 插件卡片 ============

interface PluginCardProps {
  plugin: PluginFullInfo
  operating: boolean
  operatingAction: string | null
  onToggle: () => void
  onUninstall: () => void
  onDetail: () => void
  onCheckUpdate: () => void
  onUpdate: () => void
}

const PluginCard: React.FC<PluginCardProps> = ({
  plugin,
  operating,
  operatingAction,
  onToggle,
  onUninstall,
  onDetail,
  onCheckUpdate
}) => {
  const { t } = useTranslation()
  const permissions = plugin.nikkiGallery?.permissions ?? []

  return (
    <SettingsCard>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
              {plugin.name}
            </span>
            <span
              className="text-xs px-1.5 py-0.5 rounded"
              style={{
                background: 'var(--bg-quaternary)',
                color: 'var(--text-tertiary)'
              }}
            >
              v{plugin.version}
            </span>
            {plugin.active ? (
              <span
                className="text-xs px-1.5 py-0.5 rounded"
                style={{
                  background: 'rgba(34, 197, 94, 0.15)',
                  color: 'rgb(22, 163, 74)'
                }}
              >
                {t('settings.plugin.statusEnabled')}
              </span>
            ) : (
              <span
                className="text-xs px-1.5 py-0.5 rounded"
                style={{
                  background: 'var(--bg-quaternary)',
                  color: 'var(--text-tertiary)'
                }}
              >
                {t('settings.plugin.statusDisabled')}
              </span>
            )}
            {plugin.error && (
              <span
                className="text-xs px-1.5 py-0.5 rounded"
                style={{
                  background: 'rgba(239, 68, 68, 0.15)',
                  color: 'rgb(220, 38, 38)'
                }}
                title={plugin.error}
              >
                {t('settings.plugin.statusError')}
              </span>
            )}
          </div>
          {plugin.description && (
            <p
              className="text-xs mt-1 truncate"
              style={{ color: 'var(--text-tertiary)' }}
              title={plugin.description}
            >
              {plugin.description}
            </p>
          )}
          {permissions.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {permissions.map((p: string) => (
                <span
                  key={p}
                  className="text-xs px-1.5 py-0.5 rounded font-mono"
                  style={{
                    background: 'var(--bg-quaternary)',
                    color: 'var(--text-tertiary)'
                  }}
                >
                  {p}
                </span>
              ))}
            </div>
          )}
          {plugin.error && (
            <p className="text-xs mt-1.5 font-mono break-all" style={{ color: 'rgb(220, 38, 38)' }}>
              {plugin.error}
            </p>
          )}
        </div>

        {/* 右侧操作区 */}
        <div className="flex flex-col gap-1.5 flex-shrink-0">
          <button
            className="text-xs px-2 py-1 rounded transition-all"
            style={{
              background: plugin.active ? 'var(--bg-quaternary)' : 'var(--accent)',
              color: plugin.active ? 'var(--text-primary)' : 'white',
              opacity: operating ? 0.5 : 1
            }}
            disabled={operating}
            onClick={onToggle}
          >
            {operating && operatingAction === 'toggle'
              ? t('common.processing')
              : plugin.active
                ? t('settings.plugin.disable')
                : t('settings.plugin.enable')}
          </button>
          <button
            className="text-xs px-2 py-1 rounded transition-all"
            style={{
              background: 'var(--bg-quaternary)',
              color: 'var(--text-primary)',
              opacity: operating ? 0.5 : 1
            }}
            disabled={operating}
            onClick={onDetail}
          >
            {t('settings.plugin.detail')}
          </button>
          <button
            className="text-xs px-2 py-1 rounded transition-all"
            style={{
              background: 'var(--bg-quaternary)',
              color: 'var(--text-primary)',
              opacity: operating ? 0.5 : 1
            }}
            disabled={operating}
            onClick={onCheckUpdate}
          >
            {t('settings.plugin.checkUpdate')}
          </button>
          <button
            className="text-xs px-2 py-1 rounded transition-all"
            style={{
              background: 'rgba(239, 68, 68, 0.1)',
              color: 'rgb(220, 38, 38)',
              opacity: operating ? 0.5 : 1
            }}
            disabled={operating}
            onClick={onUninstall}
          >
            {operating && operatingAction === 'uninstall'
              ? t('common.processing')
              : t('settings.plugin.uninstall')}
          </button>
        </div>
      </div>
    </SettingsCard>
  )
}

// ============ 安装对话框 ============

interface InstallDialogProps {
  open: boolean
  onClose: () => void
  onInstall: (specifier: string) => void
}

const InstallPluginDialog: React.FC<InstallDialogProps> = ({ open, onClose, onInstall }) => {
  const { t } = useTranslation()
  const [specifier, setSpecifier] = useState('')

  const handleConfirm = () => {
    const trimmed = specifier.trim()
    if (!trimmed) return
    onInstall(trimmed)
    setSpecifier('')
  }

  const handleClose = () => {
    setSpecifier('')
    onClose()
  }

  return (
    <BaseDialog
      open={open}
      onClose={handleClose}
      title={t('settings.plugin.installTitle')}
      size="md"
    >
      <div className="space-y-3">
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {t('settings.plugin.installHint')}
        </p>
        <input
          type="text"
          value={specifier}
          onChange={(e) => setSpecifier(e.target.value)}
          placeholder={t('settings.plugin.installPlaceholder')}
          className="w-full px-3 py-2 text-sm rounded-lg border"
          style={{
            background: 'var(--bg-tertiary)',
            borderColor: 'var(--border-color)',
            color: 'var(--text-primary)'
          }}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleConfirm()
          }}
        />
        <div className="flex justify-end gap-2">
          <button className="btn-secondary text-sm" onClick={handleClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary text-sm"
            onClick={handleConfirm}
            disabled={!specifier.trim()}
          >
            {t('settings.plugin.install')}
          </button>
        </div>
      </div>
    </BaseDialog>
  )
}

// ============ 插件详情对话框 ============

interface DetailDialogProps {
  plugin: PluginFullInfo
  onClose: () => void
}

const PluginDetailDialog: React.FC<DetailDialogProps> = ({ plugin, onClose }) => {
  const { t } = useTranslation()
  const permissions = plugin.nikkiGallery?.permissions ?? []
  const extPoints = plugin.nikkiGallery?.extensionPoints ?? []
  const author = typeof plugin.author === 'string' ? plugin.author : (plugin.author?.name ?? '')

  return (
    <BaseDialog
      open
      onClose={onClose}
      title={t('settings.plugin.detailTitle', { name: plugin.name })}
      size="lg"
    >
      <div className="space-y-3 text-sm" style={{ color: 'var(--text-primary)' }}>
        <DetailRow label={t('settings.plugin.fieldVersion')} value={plugin.version} />
        {plugin.description && (
          <DetailRow label={t('settings.plugin.fieldDescription')} value={plugin.description} />
        )}
        {author && <DetailRow label={t('settings.plugin.fieldAuthor')} value={author} />}
        {plugin.license && (
          <DetailRow label={t('settings.plugin.fieldLicense')} value={plugin.license} />
        )}
        <DetailRow label={t('settings.plugin.fieldMain')} value={plugin.main} />
        <DetailRow
          label={t('settings.plugin.fieldActive')}
          value={plugin.active ? t('common.yes') : t('common.no')}
        />
        <DetailRow
          label={t('settings.plugin.fieldActivationPoints')}
          value={plugin.activationPoints.length > 0 ? plugin.activationPoints.join(', ') : '-'}
        />
        {permissions.length > 0 && (
          <div>
            <div className="text-xs font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.plugin.fieldPermissions')}
            </div>
            <div className="flex flex-wrap gap-1">
              {permissions.map((p: string) => (
                <span
                  key={p}
                  className="text-xs px-1.5 py-0.5 rounded font-mono"
                  style={{
                    background: 'var(--bg-tertiary)',
                    color: 'var(--text-secondary)'
                  }}
                >
                  {p}
                </span>
              ))}
            </div>
          </div>
        )}
        {extPoints.length > 0 && (
          <div>
            <div className="text-xs font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.plugin.fieldExtensionPoints')}
            </div>
            <div className="flex flex-wrap gap-1">
              {extPoints.map((p: string) => (
                <span
                  key={p}
                  className="text-xs px-1.5 py-0.5 rounded font-mono"
                  style={{
                    background: 'var(--bg-tertiary)',
                    color: 'var(--text-secondary)'
                  }}
                >
                  {p}
                </span>
              ))}
            </div>
          </div>
        )}
        {plugin.error && (
          <div>
            <div className="text-xs font-medium mb-1" style={{ color: 'rgb(220, 38, 38)' }}>
              {t('settings.plugin.fieldError')}
            </div>
            <pre
              className="text-xs p-2 rounded font-mono break-all whitespace-pre-wrap"
              style={{
                background: 'rgba(239, 68, 68, 0.08)',
                color: 'rgb(220, 38, 38)'
              }}
            >
              {plugin.error}
            </pre>
          </div>
        )}
        <div className="flex justify-end pt-2">
          <button className="btn-primary text-sm" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </BaseDialog>
  )
}

const DetailRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3">
    <span className="text-xs flex-shrink-0 w-20" style={{ color: 'var(--text-tertiary)' }}>
      {label}
    </span>
    <span className="text-xs flex-1 break-all" style={{ color: 'var(--text-primary)' }}>
      {value}
    </span>
  </div>
)
