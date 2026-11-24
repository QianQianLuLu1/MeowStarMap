/**
 * 共鸣录身份门外跳目标（gongeo.us 官网）。
 *
 * 放置说明：共鸣录域（components/resonance、utils/resonance、ResonanceRecordsPage 等）
 * 受 offline-guard 零联网静态扫描约束，源码不得出现 http(s):// 字面量（豁免仅
 * cdn.gongeo.us 图片主机）。浏览器外跳不加载任何资源进应用，属热链规范排除项，
 * 故 URL 常量置于 utils 根——与 world-map-tile-host.ts 的域外注册表模式一致。
 */
export const GONGEO_SITE_URL = 'https://gongeo.us'
