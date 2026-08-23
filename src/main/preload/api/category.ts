// 分类命名空间：对应主进程 handlers/category-handler.ts 注册的 category:* 通道
import { call } from '../ipc'

/** electronAPI.category：自定义分类树管理 */
export const categoryAPI = {
  create: (name: string, options?: { icon?: string; color?: string; parentId?: number }) =>
    call<{ id: number }>('category:create', name, options),
  update: (
    id: number,
    updates: { name?: string; icon?: string; color?: string; parent_id?: number | null }
  ) => call<{ updated: boolean }>('category:update', id, updates),
  delete: (id: number) => call<{ deleted: boolean }>('category:delete', id),
  reorder: (orders: Array<{ id: number; sort_order: number; parent_id?: number }>) =>
    call<{ reordered: boolean }>('category:reorder', orders),
  list: () => call<unknown[]>('category:list')
}
