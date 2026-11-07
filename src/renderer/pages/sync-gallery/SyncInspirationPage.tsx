import React from 'react'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '../../components/common/PageHeader'
import { SyncInspirationPanel } from './SyncInspirationPanel'
import { IconStar } from '../../icons'

/**
 * 灵感库二级子页（层级 2，视图 ID `sync-inspiration`）：N4 面板从 `SyncServicePage`
 * 迁出后的独立承载页。与「同步服务」同口径——入口在同步图库工具栏（纯导航，不承载
 * 任何服务启停语义）、不进侧边栏、返回走 viewStack `goBack`。
 *
 * 页面壳零 IPC：面板本体（`SyncInspirationPanel`）自带折叠态不发拉取、桥缺失静默隐藏、
 * `onLibraryChanged` 事件订阅等全部行为契约，本页不做任何门控或状态管理。
 * 能力位观测行（`syncService.status.inspirationV1`）仍留在 `SyncServicePage`——那是服务
 * 状态总览的一部分，依赖该页自身的 2s `getServerStatus` 轮询，与本页无关。
 */
export const SyncInspirationPage: React.FC = () => {
  const { t } = useTranslation()

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t('syncGallery.inspiration.title')} icon={<IconStar size={20} />} />
      {/* 沿用 SyncServicePage 的滚动容器与 max-w-2xl 列宽，板块内二级页观感一致 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        <div className="mx-auto max-w-2xl">
          <SyncInspirationPanel />
        </div>
      </div>
    </div>
  )
}
