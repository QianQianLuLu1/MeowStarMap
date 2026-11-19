/**
 * T3/T11：上游 NikkiSync PC 端外链常量（逐字对齐，禁止改写）。
 * 真相源：NikkiSync/apps/pc-companion/src/desktop/DesktopPage.ts（基准 6bdab4b4 / v1.0.41-public-beta.2）。
 * 这些链接是上游发布渠道的授权合同的一部分：改动须与上游同步，不得自造镜像/加速节点。
 */

/** Android APK 直链（上游 DesktopPage.ts:52 与 :99 逐字）。 */
export const UPSTREAM_ANDROID_APK_URL =
  'https://cnb.cool/nikkisync/icon-packs/-/releases/download/android-update-test/MomoCamera-Android-1.0.39.apk'

/** 夸克网盘（上游 DesktopPage.ts:56 与 :100 逐字）。 */
export const UPSTREAM_QUARK_URL = 'https://pan.quark.cn/s/3d5a764a196c'

/** 百度网盘（上游 DesktopPage.ts:56 与 :101 逐字）。 */
export const UPSTREAM_BAIDU_URL = 'https://pan.baidu.com/s/5bb_o2A8iJ2MR4f_hRBlPCw'

/** GitHub Releases（上游 DesktopPage.ts:102 逐字）。 */
export const UPSTREAM_GITHUB_RELEASES_URL = 'https://github.com/ToStardust/NikkiSync/releases'

/** 项目仓库与来源六链（上游 DesktopPage.ts:111 逐字，顺序一致）。
 * 内部键 nuannuanStudio 对应上游 data-project="nikkiGallery"：旧名不得入语包键/值
 * （ui-brand-name 守卫），URL 属上游逐字契约保持不动（旧名台账已登记豁免）。 */
export const UPSTREAM_REPO_LINKS = [
  { key: 'momo', url: 'https://github.com/ToStardust/NikkiSync' },
  { key: 'nuannuanStudio', url: 'https://github.com/QianQianLuLu1/NikkiGallery' },
  { key: 'nikkiAlbums', url: 'https://github.com/RanAxro/nikki_albums' },
  { key: 'meowStarMap', url: 'https://github.com/QianQianLuLu1/MeowStarMap' },
  { key: 'nuan5', url: 'https://nuan5.pro/' },
  { key: 'gongeo', url: 'https://gongeo.us/' }
] as const
