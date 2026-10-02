// 收藏夹命名空间：对应主进程 handlers/favorites-handler.ts 注册的 favorites:* 通道
import { call } from '../ipc'
import type { FavoriteItem } from '../../../shared/types/electron-api'

/** electronAPI.favorites：收藏夹管理 */
export const favoritesAPI = {
  list: () => call<{ favorites: FavoriteItem[] }>('favorites:list'),
  add: (mediaId: number) => call<{ id: number }>('favorites:add', mediaId),
  remove: (mediaId: number) => call<{ removed: boolean }>('favorites:remove', mediaId)
}
