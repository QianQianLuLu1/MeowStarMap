import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SectionShell, SettingsToggle, useGlobalToast } from './shared'
import { extractUserMessage } from '../../../shared/errors/app-error'
import {
  isRemoteImagesEnabled,
  setRemoteImagesEnabled
} from '../../utils/resonance/remote-images-enabled'

const IMAGE_MIRROR_KEY = 'referenceData.imageMirrorBaseUrl'
const MANIFEST_MIRROR_KEY = 'referenceData.manifestBaseUrl'
const REMOTE_IMAGES_KEY = 'referenceData.remoteImagesEnabled'
const AUTO_UPDATE_KEY = 'referenceData.autoUpdate'

/** 图片来源回链：只允许已署名的站点，非法值不渲染 */
const GONGEO_SOURCE_URL = 'https://gongeo.us'
const ALLOWED_SOURCE_HOSTS: ReadonlySet<string> = new Set(['gongeo.us'])

/** 纯函数：回链 URL 判空 / 类型 / 协议 / 主机白名单，任何异常 fail-closed 返回 null */
export function safeSourceUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 256) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && ALLOWED_SOURCE_HOSTS.has(url.hostname)
      ? url.toString()
      : null
  } catch {
    return null
  }
}

// IpcError 不是 AppError 实例，extractUserMessage 对其会回落到开发者 message；
// 此处按约定优先级先取 userMessage 字段（userMessage > message），再走统一兜底。
function errorToastText(err: unknown): string {
  if (err && typeof err === 'object') {
    const userMessage = (err as { userMessage?: unknown }).userMessage
    if (typeof userMessage === 'string' && userMessage.trim()) return userMessage
  }
  return extractUserMessage(err)
}

interface MirrorEntryProps {
  settingKey: string
  label: string
  hint: string
}

/** 单个镜像入口行：挂载回填已持久化值，保存失败回滚到已持久化值（不留从未生效的串） */
const MirrorEntry: React.FC<MirrorEntryProps> = ({ settingKey, label, hint }) => {
  const { t } = useTranslation()
  const showMessage = useGlobalToast()
  const [value, setValue] = useState('')
  const persistedRef = useRef('')

  useEffect(() => {
    const settings = window.electronAPI?.settings
    if (!settings) return
    let cancelled = false
    settings
      .get(settingKey, '')
      .then((stored) => {
        if (cancelled) return
        const text = typeof stored === 'string' ? stored : ''
        persistedRef.current = text
        setValue(text)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [settingKey])

  const save = async (): Promise<void> => {
    const settings = window.electronAPI?.settings
    if (!settings) return
    // 空串是合法值（= 未配置，走原始/官方地址），不做脏检查、不跳过提交
    const next = value.trim()
    try {
      await settings.set(settingKey, next)
      persistedRef.current = next
      setValue(next)
      showMessage(t('settings.referenceData.saved'))
    } catch (err) {
      setValue(persistedRef.current)
      showMessage(errorToastText(err), 'error')
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <input
          type="text"
          className="input-field flex-1 text-sm"
          aria-label={label}
          value={value}
          spellCheck={false}
          placeholder="https://"
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          type="button"
          className="btn-primary flex-shrink-0"
          aria-label={`${t('settings.referenceData.save')} ${label}`}
          onClick={() => void save()}
        >
          {t('settings.referenceData.save')}
        </button>
      </div>
      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        {hint}
      </p>
    </div>
  )
}

/**
 * 外部图片来源与权利声明（gongeo #218 授权条件）：
 * 应用内明确标注 gongeo.us 来源并附回链、保留 Infold 等权利方商标声明、
 * 明确第三方资产的用途限制（不用于 AI 训练或商业用途；不适用于本项目 MIT 源代码）。
 */
const ImageSourceNotice: React.FC = () => {
  const { t } = useTranslation()
  const link = safeSourceUrl(GONGEO_SOURCE_URL)
  return (
    <div
      className="p-3 rounded-lg text-xs space-y-2"
      style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
    >
      <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
        {t('settings.referenceData.imageSourceLabel')}
      </div>
      <div>{t('settings.referenceData.imageSourceNotice')}</div>
      {link && (
        <button
          type="button"
          className="hover:underline"
          style={{ color: 'var(--accent)' }}
          onClick={() => window.electronAPI?.shell?.openExternal?.(link)}
        >
          gongeo.us
        </button>
      )}
      <div>{t('settings.referenceData.trademarkNotice')}</div>
      <div>{t('settings.referenceData.usageNotice')}</div>
    </div>
  )
}

/** 外部图片总开关：关闭后两条链路零网络，且设置持久化（重启后仍生效） */
const RemoteImagesToggle: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useGlobalToast()
  const [enabled, setEnabled] = useState(() => isRemoteImagesEnabled())
  const persistedRef = useRef(enabled)

  useEffect(() => {
    const settings = window.electronAPI?.settings
    if (!settings) return
    let cancelled = false
    settings
      .get(REMOTE_IMAGES_KEY, true)
      .then((stored) => {
        if (cancelled) return
        // 非法值按安全默认关闭并记明确错误，不静默吞掉
        const next = typeof stored === 'boolean' ? stored : null
        setRemoteImagesEnabled(next)
        persistedRef.current = isRemoteImagesEnabled()
        setEnabled(persistedRef.current)
      })
      .catch((err) => {
        console.error('[remoteImages] failed to read switch, keeping current state', err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const onChange = async (next: boolean): Promise<void> => {
    const settings = window.electronAPI?.settings
    if (!settings) return
    try {
      await settings.set(REMOTE_IMAGES_KEY, next)
      setRemoteImagesEnabled(next)
      persistedRef.current = next
      setEnabled(next)
      showMessage(t('settings.referenceData.saved'))
    } catch (err) {
      // 保存失败回滚到已持久化值，界面不留从未生效的开关态
      setEnabled(persistedRef.current)
      setRemoteImagesEnabled(persistedRef.current)
      showMessage(errorToastText(err), 'error')
    }
  }

  return (
    <SettingsToggle
      label={t('settings.referenceData.remoteImagesEnabledLabel')}
      description={t('settings.referenceData.remoteImagesEnabledHint')}
      checked={enabled}
      onChange={(next) => void onChange(next)}
    />
  )
}

/**
 * 启动自动检查开关（总计划 T1.4「用户可配自动更新」）：主进程 lifecycle 按该键
 * 决定是否注册启动延迟检查；关闭后仅手动刷新触发。保存失败回滚到已持久化值。
 */
const AutoUpdateToggle: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useGlobalToast()
  const [enabled, setEnabled] = useState(true)
  const persistedRef = useRef(true)

  useEffect(() => {
    const settings = window.electronAPI?.settings
    if (!settings) return
    let cancelled = false
    settings
      .get(AUTO_UPDATE_KEY, true)
      .then((stored) => {
        if (cancelled) return
        // 脏值（非布尔）按默认开启显示，不静默写库；主进程侧对脏值另有安全关闭诊断
        const next = typeof stored === 'boolean' ? stored : true
        persistedRef.current = next
        setEnabled(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const onChange = async (next: boolean): Promise<void> => {
    const settings = window.electronAPI?.settings
    if (!settings) return
    try {
      await settings.set(AUTO_UPDATE_KEY, next)
      persistedRef.current = next
      setEnabled(next)
      showMessage(t('settings.referenceData.saved'))
    } catch (err) {
      setEnabled(persistedRef.current)
      showMessage(errorToastText(err), 'error')
    }
  }

  return (
    <SettingsToggle
      label={t('settings.referenceData.autoUpdateLabel')}
      description={t('settings.referenceData.autoUpdateHint')}
      checked={enabled}
      onChange={(next) => void onChange(next)}
    />
  )
}

/**
 * 手动检查更新（总计划「设置页手动刷新」）：调 refdata:refresh（绕过失败冷却）。
 * 通道 fail-soft 永不 reject——失败语义在 status.lastError，只进 console 供排查，
 * UI 用通用文案（不铺技术细节）；busy 门防连点放大请求量（#20 条款 4 禁高频）。
 */
const RefreshReferenceDataButton: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useGlobalToast()
  const [busy, setBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    const api = window.electronAPI?.referenceData
    if (!api || busy) return
    setBusy(true)
    try {
      const status = await api.refresh()
      if (status.available) {
        showMessage(t('settings.referenceData.refreshSuccess'))
      } else {
        console.error('[referenceData] manual refresh degraded:', status.lastError)
        showMessage(t('settings.referenceData.refreshFailed'), 'error')
      }
    } catch (err) {
      console.error('[referenceData] manual refresh failed:', err)
      showMessage(t('settings.referenceData.refreshFailed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <button
        type="button"
        className="btn-secondary"
        disabled={busy}
        onClick={() => void refresh()}
      >
        {t('settings.referenceData.refreshLabel')}
      </button>
    </div>
  )
}

/**
 * 外部参考数据设置节：两个用户自填入口各自独立持久化、语义互不串用。
 * - 图片加速入口（referenceData.imageMirrorBaseUrl）：仅替换已授权图片资源的访问入口；
 * - 参考数据镜像站点（referenceData.manifestBaseUrl）：热更 manifest 站点。
 * 应用不内置、不代建任何加速节点；留空走原始/官方地址。
 */
export const ReferenceDataMirrorSection: React.FC = () => {
  const { t } = useTranslation()
  return (
    <SectionShell
      title={t('settings.sections.referenceData')}
      description={t('settings.referenceData.description')}
    >
      <div className="space-y-4">
        <MirrorEntry
          settingKey={IMAGE_MIRROR_KEY}
          label={t('settings.referenceData.imageMirrorLabel')}
          hint={t('settings.referenceData.imageMirrorHint')}
        />
        <MirrorEntry
          settingKey={MANIFEST_MIRROR_KEY}
          label={t('settings.referenceData.manifestMirrorLabel')}
          hint={t('settings.referenceData.manifestMirrorHint')}
        />
        <AutoUpdateToggle />
        <RefreshReferenceDataButton />
        <RemoteImagesToggle />
        <ImageSourceNotice />
      </div>
    </SectionShell>
  )
}
