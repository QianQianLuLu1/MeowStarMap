// 界面主题命名空间：对应主进程 handlers/theme-handler.ts 注册的 ui-theme:* 通道
import { call } from '../ipc'
import type { UiThemeGetResult } from '../../../shared/types/electron-api'

/** electronAPI.uiTheme：统一主题接口 */
export const uiThemeAPI = {
  get: () => call<UiThemeGetResult>('ui-theme:get'),
  set: (theme: 'default' | 'soft-pink-luxury') => call<{ applied: boolean }>('ui-theme:set', theme)
}
