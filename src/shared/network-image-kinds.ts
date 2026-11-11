/**
 * 参考数据网络图片类别：跨进程单一真相源。
 *
 * 本文件为纯常量与纯函数模块，不依赖任何 Node.js / Electron API（见 src/shared/AGENTS.md），
 * 可安全被主进程、preload 与渲染进程同时导入。
 *
 * 10 个类别与 v1.db 的 Nuan5NetworkImage 字段一一对应。此前同一份清单在
 * nuan5-config-proto.ts（运行时数组）、electron-api.ts（手写联合）各存一份，
 * 新增类别时易漏改；现在统一由此派生，消费侧只 re-export 或引用类型。
 *
 * 注意：类别「存在」不等于「已获授权」。cloth / clothOutfit 不在 nikki_albums#20
 * 授权范围，实际取图由 services/reference-data/image-url.ts 的封闭主机注册表
 * fail-closed 判定，本文件不含任何授权语义。
 */

/** 全部类别（顺序固定：新增只能追加，不得插入或重排，避免影响缓存键与模板索引） */
export const NETWORK_IMAGE_KINDS = [
  'light',
  'filter',
  'momoPose',
  'cloth',
  'clothOutfit',
  'diyPattern',
  'clothType',
  'clothProp',
  'clothTag',
  'nikkiPose'
] as const

/** 图片类别类型：由常量派生，杜绝手写联合漂移 */
export type NetworkImageTemplateKind = (typeof NETWORK_IMAGE_KINDS)[number]

const KIND_SET: ReadonlySet<string> = new Set(NETWORK_IMAGE_KINDS)

/**
 * fail-closed 类型守卫：只有精确命中常量的字符串才算合法类别。
 * 外部输入（v1.db 解码结果、IPC 入参、用户配置）一律先过此守卫。
 */
export function isNetworkImageTemplateKind(value: unknown): value is NetworkImageTemplateKind {
  return typeof value === 'string' && KIND_SET.has(value)
}
