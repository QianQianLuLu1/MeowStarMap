/**
 * N2：上游品牌资源在宿主构建期的静态导入。
 *
 * 侧栏头像只有 42×42，直接 import 上游 1.6MB 原图会把 renderer 产物白白撑大
 * （同一张图还会作为 extraResources 进安装包，等于出厂两份）。这里改用一个派生的
 * 96×96（2×）缩略图，体积 7KB 量级：
 *
 *   node -e "require('sharp')('resources/nikkisync/pc/momo-camera.png')
 *     .resize(96,96,{fit:'cover'}).png({compressionLevel:9,palette:true})
 *     .toFile('src/renderer/assets/sync-console-brand.png')"
 *
 * 微信小程序入口码仍需原图（扫码可靠性），继续直接引用 resources 下的原文件。
 * 两者缺失时由调用方回退图标/占位。
 */
import momoCameraThumbUrl from '../../../assets/sync-console-brand.png?url'
import wechatMiniEntryUrl from '../../../../../resources/nikkisync/pc/wechat-mini-entry.png?url'

export const CONSOLE_BRAND_IMAGE = momoCameraThumbUrl
export const WECHAT_MINI_ENTRY_IMAGE = wechatMiniEntryUrl
