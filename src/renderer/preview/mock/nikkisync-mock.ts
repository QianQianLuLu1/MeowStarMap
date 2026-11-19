// N6：预览版 nikkisync 命名空间 Mock（空/桩数据）。
// 预览版没有内嵌 NikkiSync Runtime：查询面提供结构正确的空数据，让「同步图库」
// 菜单与页面可渲染为空态，不伪造任何真实资产字节。
// T12 例外：灵感库给纯元数据示例条目（data/inspirations.json，images 恒空、不伪造
// 图片字节），让控制台的过滤/状态/分享码交互在预览版可演示；其余写入面仍为空结果。
// 约定：src/** 禁止硬编码中文字符串与 console.log；桩内不产生错误文案（全部方法
// 返回空结果），如后续需要错误文案一律用 ASCII；注释可用中文（示例文案放 JSON 数据文件）。

import inspirationSeeds from './data/inspirations.json'

// 通用空返回工厂：查询面在无数据时给空集合 / 空对象 / 布尔 / 数值。
const emptyList = (): unknown[] => []
const emptyRecord = (): Record<string, never> => ({})
const emptyPage = (): {
  items: unknown[]
  nextCursor: null
  libraryRevision: number
  hasMore: boolean
} => ({ items: [], nextCursor: null, libraryRevision: 0, hasMore: false })
const noop = (): void => {}

// 运行时状态：预览版未装配 runtime，available/running 均为 false。
// state / linkReady 为对齐协议 DTO 的可读占位，值为空态。
const runtimeStatus = {
  available: false,
  running: false,
  state: 'idle',
  linkReady: false
}

// 同步服务状态：协议注释约定「句柄未装配时 { available: false }（不抛）」。
const serverStatus = { available: false }

// 目录面空态：directories / automaticRoots 为空，busy 为 false。
const emptyDirectories = (): {
  directories: unknown[]
  automaticRoots: unknown[]
  busy: boolean
} => ({ directories: [], automaticRoots: [], busy: false })

// 账号作用域空态：无分组、默认「全部」。
const emptyAccounts = (): { accounts: unknown[]; all: boolean } => ({ accounts: [], all: true })

export const nikkisyncMock: Record<string, unknown> = {
  // ---- 运行时 / 扫描 ----
  getRuntimeStatus: async () => runtimeStatus,
  startScan: async () => emptyRecord(),
  // ---- 资产只读查询 ----
  getAssets: async () => emptyPage(),
  getAssetDetail: async () => emptyRecord(),
  getResource: async () => emptyRecord(),
  getResourceRecords: async () => emptyRecord(),
  getChanges: async () => ({ items: [], fullResyncRequired: false }),
  // ---- 搜索 / 统计（F21：与上游响应同形 {query, items} / ProfileStatsResponse）----
  searchSuits: async () => ({ query: '', items: [] }),
  searchClothing: async () => ({ query: '', items: [] }),
  profileStats: async () => ({ libraryRevision: 0, topSuits: [], topClothing: [] }),
  // ---- 局域网同步服务 ----
  getServerStatus: async () => serverStatus,
  startServer: async () => serverStatus,
  stopServer: async () => serverStatus,
  // T12：重启与 start/stop 同形（句柄未装配 ⇒ { available: false }，不抛）
  restartServer: async () => serverStatus,
  getPairingCode: async () => emptyRecord(),
  getPairedDevices: async () => emptyList(),
  revokeDevice: async () => emptyList(),
  // ---- T12：同步控制台新增六通道（形状对齐 shared/types/electron-api.ts）----
  // 资产总览：预览版无 PC 服务 ⇒ available:false（协议约定不抛），
  // ConnectView 据此渲染「资产总览不可用」空态而非伪造统计。
  getLibraryOverview: async () => ({ available: false }),
  // 网络权限 / 冲突修复 / 热点：预览版无主进程能力且 opt-in 默认关闭 ⇒ disabled
  //（与真实 handler「opt-in 关闭 ⇒ disabled（零子进程）」的降级语义一致）。
  networkAuth: async () => ({
    status: 'disabled',
    ruleGroup: 'MomoCamera LAN Authorization v1'
  }),
  networkConflict: async () => ({ status: 'disabled', conflicts: [], canRestore: false }),
  hotspotControl: async () => ({
    status: 'disabled',
    state: { active: false, startedHere: false }
  }),
  // 系统热点设置页：预览版运行在浏览器，无法拉起 ms-settings: ⇒ opened:false
  openHotspotSettings: async () => ({ opened: false }),
  // ---- 在线解析同意 / 游戏版本 ----
  getMetadataConsent: async () => ({ enabled: false }),
  setMetadataConsent: async () => ({ enabled: false }),
  resolveGameVersion: async () => emptyRecord(),
  // ---- 照片目录（K6 / gameRoot）----
  getExtraDirectories: async () => emptyDirectories(),
  inspectExtraDirectory: async () => emptyRecord(),
  addExtraDirectory: async () => emptyDirectories(),
  removeExtraDirectory: async () => emptyDirectories(),
  setExtraDirectorySource: async () => emptyDirectories(),
  rescanExtraDirectories: async () => emptyDirectories(),
  // F21：字段与真实契约同形——get → {gameRoot}；set/reset → 生效结果（preview 无
  // Runtime，applyError 如实给 runtime-unavailable，needRestart=false 不弹重启询问）
  getGameRoot: async () => ({ gameRoot: '' }),
  setGameRoot: async () => ({
    gameRoot: '',
    writable: false,
    applied: false,
    needRestart: false,
    applyError: 'runtime-unavailable'
  }),
  resetGameRoot: async () => ({
    applied: false,
    needRestart: false,
    applyError: 'runtime-unavailable'
  }),
  admitDirectory: async () => emptyRecord(),
  // ---- 账号作用域（K9）----
  getSyncAccounts: async () => emptyAccounts(),
  previewSyncAccount: async () => emptyRecord(),
  setSyncAccountSelection: async () => emptyAccounts(),
  // ---- 整理队列（K8；F4：契约是 {items, activity}，不是 {list}）----
  getOrganizerQueue: async () => ({ items: [], activity: null }),
  decideOrganizerItem: async () => emptyList(),
  approveOrganizerItems: async () => ({ items: [], approved: 0, skipped: 0 }),
  // ---- N4：灵感库（F20：四通道最小合法形状）----
  // T12：列表给示例元数据（8 条，覆盖五态/多分类/多标签/有无分享码），供控制台
  // 过滤与分享码识别演示；images 恒空，getInspirationImage 仍返回 null（不伪造字节）。
  listInspirations: async () => inspirationSeeds,
  saveInspiration: async () => ({ revision: 0, entry: null }),
  putInspirationImage: async () => ({ ok: true }),
  getInspirationImage: async () => null,
  // ---- N7：PC 端控制页 / 微信画廊（F20：四通道最小合法形状）----
  desktopOpen: async () => ({ url: '' }),
  wechatStart: async () => ({ status: null, qrSvg: '' }),
  wechatStop: async () => ({ status: null }),
  wechatStatus: async () => ({ status: null }),
  // ---- 订阅：同步返回退订函数（与 preload 的 subscribe 一致，不能是 Promise）----
  onLibraryChanged: () => noop
}
