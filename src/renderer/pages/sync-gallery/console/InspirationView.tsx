import React from 'react'
import { useUIStore } from '../../../stores/uiStore'
import { SyncInspirationPanel } from '../SyncInspirationPanel'

/**
 * T1/T8：控制台灵感库视图——复用 SyncInspirationPanel（独立 sync-inspiration
 * ViewLevel 保留深链兼容，两处共用同一面板实现）。
 *
 * 自动刷新门控：面板缺省按 currentView==='sync-inspiration' 判可见；
 * 控制台内嵌时显式传 sync-service 前台态（keep-alive 下切走即停刷）。
 */
export const InspirationView: React.FC = () => {
  const currentView = useUIStore((s) => s.currentView)
  return (
    <div className="sc-inspiration">
      <SyncInspirationPanel autoRefreshVisible={currentView === 'sync-service'} embedded />
    </div>
  )
}
