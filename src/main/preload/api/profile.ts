// 角色档案命名空间：对应主进程 handlers/profile-handler.ts 注册的 profile:* 通道
import { call } from '../ipc'
import type { ProfileRow, ProfileStats } from '../../../shared/types/electron-api'

/** electronAPI.profile：P0-02 角色档案管理 */
export const profileAPI = {
  list: () => call<ProfileRow[]>('profile:list'),
  add: (uid: string, nickname: string, avatar?: string) =>
    call<{ added: boolean }>('profile:add', uid, nickname, avatar),
  update: (uid: string, nickname?: string, avatar?: string) =>
    call<{ updated: boolean }>('profile:update', uid, nickname, avatar),
  delete: (uid: string) => call<{ deleted: boolean }>('profile:delete', uid),
  setCurrent: (uid: string) => call<{ set: boolean }>('profile:setCurrent', uid),
  getStats: (uid: string) => call<ProfileStats>('profile:getStats', uid),
  // P1-04：跨档案转移——批量更新 media_files.account_uid
  transferFiles: (mediaIds: number[], targetUid: string) =>
    call<{ transferred: number }>('profile:transferFiles', mediaIds, targetUid)
}
