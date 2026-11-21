import React from 'react'
import { useUIStore } from '../../../stores/uiStore'
import { SyncInspirationPanel } from '../SyncInspirationPanel'
import { SYNC_CONSOLE_HOST_VIEW } from './console-views'

/**
 * T1/T8：控制台灵感库视图——复用 SyncInspirationPanel（面板本体与宿主共用同一实现）。
 *
 * 自动刷新门控：面板缺省按宿主视图判可见；控制台内嵌时显式传前台态
 * （keep-alive 下切走即停刷）。
 */
export const InspirationView: React.FC = () => {
  const currentView = useUIStore((s) => s.currentView)
  return (
    <div className="sc-inspiration">
      <SyncInspirationPanel autoRefreshVisible={currentView === SYNC_CONSOLE_HOST_VIEW} embedded />
    </div>
  )
}
