import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const required = [
  'app/src/main/java/app/nikkisync/mobile/ui/chrome/HomeTabPager.java',
  'app/src/main/java/app/nikkisync/mobile/inspiration/InspirationPage.java',
  'app/src/main/java/app/nikkisync/mobile/inspiration/InspirationEditorForm.java',
  'app/src/main/java/app/nikkisync/mobile/share/ShareCardIconBatch.java',
  'app/src/main/java/app/nikkisync/mobile/ui/OperationProgressDialog.java',
  'app/src/main/java/app/nikkisync/mobile/util/TaskProgress.java',
  'app/src/main/java/app/nikkisync/mobile/ui/chrome/BackPreviewState.java',
  'app/src/main/java/app/nikkisync/mobile/ui/chrome/ChromeHost.java',
  'app/src/main/java/app/nikkisync/mobile/ui/chrome/ChromeNavigationHost.java',
  'app/src/main/java/app/nikkisync/mobile/ui/chrome/ChromePage.java',
  'app/src/main/java/app/nikkisync/mobile/ui/chrome/ChromeSheetLayout.java',
  'app/src/main/java/app/nikkisync/mobile/ui/chrome/ChromeTokens.java',
  'app/src/main/java/app/nikkisync/mobile/ui/chrome/ContentBackdrop.java',
  'app/src/main/java/app/nikkisync/mobile/ui/chrome/LiquidGlassDockView.java',
  'app/src/main/java/app/nikkisync/mobile/ui/chrome/LiquidGlassGeometry.java',
  'app/src/main/java/app/nikkisync/mobile/ui/chrome/MonetAnalyzer.java',
  'app/src/main/java/app/nikkisync/mobile/ui/chrome/MonetBackgroundController.java',
  'app/src/main/java/app/nikkisync/mobile/ui/chrome/MonetBackgroundView.java',
  'app/src/main/java/app/nikkisync/mobile/ui/chrome/MonetPalette.java',
  'app/src/main/java/app/nikkisync/mobile/ui/chrome/MonetPaletteCache.java',
  'app/src/main/java/app/nikkisync/mobile/ui/chrome/MonetTileRenderer.java',
  'app/src/main/java/app/nikkisync/mobile/ui/chrome/PhotoLayoutDock.java',
  'app/src/main/java/app/nikkisync/mobile/ui/chrome/PhotoViewerPage.java',
  'app/src/main/java/app/nikkisync/mobile/ui/chrome/ProgressiveTopBlurView.java',
  'app/src/main/java/app/nikkisync/mobile/ui/PlayerFacingDetails.java',
  'app/src/main/java/app/nikkisync/mobile/ui/SavedFilterSheet.java',
  'app/src/main/java/app/nikkisync/mobile/net/ConnectionState.java',
  'settings.gradle.kts',
  'build.gradle.kts',
  'app/build.gradle.kts',
  'app/src/main/AndroidManifest.xml',
  'app/src/main/java/app/nikkisync/mobile/MainActivity.java',
  'app/src/main/java/app/nikkisync/mobile/PairQrScannerActivity.java',
  'app/src/main/java/app/nikkisync/mobile/model/Models.java',
  'app/src/main/java/app/nikkisync/mobile/protocol/JsonCodec.java',
  'app/src/main/java/app/nikkisync/mobile/ui/GalleryAdapter.java',
  'app/src/main/java/app/nikkisync/mobile/ui/GalleryUxStyle.java',
  'app/src/main/java/app/nikkisync/mobile/ui/GalleryVersionGroups.java',
  'app/src/main/java/app/nikkisync/mobile/ui/SavedPhotoAdapter.java',
  'app/src/main/java/app/nikkisync/mobile/ui/SuitSearchDialog.java',
  'app/src/main/java/app/nikkisync/mobile/ui/SuitSearchGrid.java',
  'app/src/main/java/app/nikkisync/mobile/ui/ClothingSearchGrid.java',
  'app/src/main/java/app/nikkisync/mobile/ui/SuitSearchHistory.java',
  'app/src/main/res/drawable/bg_glass_card.xml',
  'app/src/main/res/drawable/bg_glass_chip.xml',
  'app/src/main/res/drawable/bg_selected_glass.xml',
  'app/src/main/res/drawable/bg_gallery_photo.xml',
  'app/src/main/res/drawable/bg_suit_coverage_track.xml',
  'app/src/main/res/drawable/bg_suit_coverage_fill.xml',
  'app/src/main/res/values/dimens_gallery_ux.xml',
  'app/src/main/java/app/nikkisync/mobile/net/NikkiSyncClient.java',
  'app/src/main/java/app/nikkisync/mobile/net/SignedHttpClient.java',
  'app/src/main/java/app/nikkisync/mobile/net/RealtimeWebSocket.java',
  'app/src/main/java/app/nikkisync/mobile/net/NsdDiscovery.java',
  'app/src/main/java/app/nikkisync/mobile/security/DeviceIdentity.java',
  'app/src/main/java/app/nikkisync/mobile/security/PinnedTls.java',
  'app/src/main/java/app/nikkisync/mobile/storage/SavedPhotoStore.java',
  'app/src/main/java/app/nikkisync/mobile/storage/SavedPhotoRecovery.java',
  'app/src/main/java/app/nikkisync/mobile/storage/SavedPhotoHealthStore.java',
  'app/src/main/java/app/nikkisync/mobile/storage/SavedPhotoVerifier.java',
  'app/src/main/java/app/nikkisync/mobile/storage/SavedPhotoCollection.java',
  'app/src/main/java/app/nikkisync/mobile/storage/SavedViewState.java',
  'app/src/main/java/app/nikkisync/mobile/storage/EditedVariantStore.java',
  'app/src/main/java/app/nikkisync/mobile/storage/SavedMetadataSnapshotStore.java',
  'app/src/main/java/app/nikkisync/mobile/storage/SavedPhotoGroups.java',
  'app/src/main/java/app/nikkisync/mobile/storage/EditedMediaAccess.java',
  'app/src/main/java/app/nikkisync/mobile/ui/SavedMetadataText.java',
  'app/src/main/java/app/nikkisync/mobile/share/ShareCardPayload.java',
  'app/src/main/java/app/nikkisync/mobile/share/ShareCardPayloadBuilder.java',
  'app/src/main/java/app/nikkisync/mobile/share/ShareCardExporter.java',
  'app/src/main/java/app/nikkisync/mobile/share/ShareCardExportCoordinator.java',
  'app/src/main/java/app/nikkisync/mobile/share/ShareCardLayout.java',
  'app/src/main/java/app/nikkisync/mobile/share/ShareCardPreparation.java',
  'app/src/main/java/app/nikkisync/mobile/share/ShareCardPreviewDialog.java',
  'app/src/main/java/app/nikkisync/mobile/media/ImageLoader.java',
  'app/src/main/java/app/nikkisync/mobile/media/OriginalSaver.java',
  'app/src/main/java/app/nikkisync/mobile/media/OriginalVideoSaver.java',
  'app/src/main/java/app/nikkisync/mobile/media/MotionPhotoSaver.java',
  'app/src/main/java/app/nikkisync/mobile/media/OppoLivePhotoSaver.java',
  'app/src/main/java/app/nikkisync/mobile/media/SamsungMotionPhotoSaver.java',
  'app/src/main/java/app/nikkisync/mobile/media/VivoLivePhotoSaver.java',
  'app/src/main/java/app/nikkisync/mobile/media/HuaweiMovingPhotoSaver.java'
]

function text(relative) { return readFileSync(path.join(root, relative), 'utf8') }
function expect(value, message) { if (!value) throw new Error(message) }

for (const relative of required) expect(existsSync(path.join(root, relative)), `missing M2 source: ${relative}`)

const manifest = text('app/src/main/AndroidManifest.xml')
expect(manifest.includes('android:usesCleartextTraffic="false"'), 'cleartext transport must stay disabled')
expect(manifest.includes('android:scheme="nikki-sync"'), 'pairing deep link is missing')
expect(manifest.includes('android.permission.NEARBY_WIFI_DEVICES'), 'nearby Wi-Fi permission is missing')
expect(manifest.includes('android.permission.CAMERA'), 'in-app pairing scanner camera permission is missing')

const scanner = text('app/src/main/java/app/nikkisync/mobile/PairQrScannerActivity.java')
expect(scanner.includes('nikki-sync://pair?'), 'in-app QR scanner must accept NikkiSync pairing QR data')
expect(scanner.includes('DecoratedBarcodeView'), 'in-app production barcode scanner is missing')

const pairing = text('app/src/main/java/app/nikkisync/mobile/protocol/PairingUri.java')
for (const key of ['serverId', 'host', 'port', 'token', 'protocol', 'expiresAt', 'tls']) {
  expect(pairing.includes(`"${key}"`), `pairing URI field missing: ${key}`)
}

const models = text('app/src/main/java/app/nikkisync/mobile/model/Models.java')
expect(models.includes('gameVersion') && models.includes('gameVersionSource'), 'M2.3.1 AssetSummary game-version fields are missing')

const jsonCodec = text('app/src/main/java/app/nikkisync/mobile/protocol/JsonCodec.java')
expect(jsonCodec.includes('optionalString(row, "gameVersion")'), 'M2.3.1 gameVersion JSON parsing is missing')
expect(jsonCodec.includes('optionalString(row, "gameVersionSource")'), 'M2.3.1 gameVersionSource JSON parsing is missing')
expect(jsonCodec.includes('gameVersionSource = "unknown"'), 'legacy clients must default missing game-version provenance to unknown')

const versionGroups = text('app/src/main/java/app/nikkisync/mobile/ui/GalleryVersionGroups.java')
expect(versionGroups.includes('版本未知'), 'M2.3.1 unknown-version bucket is missing')
expect(versionGroups.includes('compareSemanticVersions'), 'M2.3.1 semantic-version ordering is missing')
expect(versionGroups.includes('gameVersionSource'), 'M2.3.1 grouping must retain version provenance')
expect(versionGroups.includes('allMatch'), 'M2.3.1 inferred label must only apply when the whole group is inferred')

const galleryAdapter = text('app/src/main/java/app/nikkisync/mobile/ui/GalleryAdapter.java')
expect(galleryAdapter.includes('RecyclerView.Adapter'), 'M2.3.1 gallery must use the recyclable sectioned list implementation')
expect(galleryAdapter.includes('GalleryVersionGroups.group'), 'M2.3.1 adapter must render version groups')
expect(galleryAdapter.includes('TYPE_HEADER') && galleryAdapter.includes('TYPE_PHOTO'), 'M2.3.1 section header/photo row types are missing')
expect(galleryAdapter.includes('label(16, true') && !galleryAdapter.includes('titleBox'), 'Version headers must preserve the restored compact album layout')
expect(galleryAdapter.includes('GalleryUxStyle.glassChip'), 'M2.3.2 gallery badges must use the shared glass chip style')
expect(galleryAdapter.includes('selectedOverlay'), 'M2.3.2 selection state must use a visible overlay instead of dimming the whole cell')
expect(galleryAdapter.includes('setClipToOutline(true)'), 'M2.3.2 thumbnails must keep rounded clipping')
expect(!galleryAdapter.includes('setAlpha(isSelected ? 0.72f'), 'M2.3.2 selection must not dim the photo itself')

const galleryUxStyle = text('app/src/main/java/app/nikkisync/mobile/ui/GalleryUxStyle.java')
expect(galleryUxStyle.includes('bg_glass_card'), 'M2.3.2 shared sampled glass card is not wired')
expect(galleryUxStyle.includes('bg_glass_chip'), 'M2.3.2 shared sampled glass chip is not wired')
expect(galleryAdapter.includes('selectedOverlay.setBackgroundResource(R.drawable.bg_selected_glass)'), 'M2.3.2 selected overlay resource is not wired')

const savedPhotoStore = text('app/src/main/java/app/nikkisync/mobile/storage/SavedPhotoStore.java')
expect(savedPhotoStore.includes('assetId') && savedPhotoStore.includes('uri') && savedPhotoStore.includes('savedAt'), 'M2.4 saved provenance fields are missing')
expect(savedPhotoStore.includes('rotationDegrees') && savedPhotoStore.includes('format'), 'M2.4 saved export presentation metadata is missing')
expect(savedPhotoStore.includes('LIMIT = 2000'), 'M2.4 saved history must stay bounded')

const savedPhotoAdapter = text('app/src/main/java/app/nikkisync/mobile/ui/SavedPhotoAdapter.java')
expect(savedPhotoAdapter.includes('loadThumbnail'), 'M2.4 Saved grid must load MediaStore thumbnails off the main UI path')
expect(savedPhotoAdapter.includes('"LIVE"') && savedPhotoAdapter.includes('"原图"'), 'M2.4 Saved grid state badges are missing')

const savedHealthStore = text('app/src/main/java/app/nikkisync/mobile/storage/SavedPhotoHealthStore.java')
expect(savedHealthStore.includes('ACTIVE') && savedHealthStore.includes('MISSING'), 'M2.4.1 Saved health states are missing')
expect(savedHealthStore.includes('lastCheckedAt'), 'M2.4.1 Saved health timestamps are missing')

const savedVerifier = text('app/src/main/java/app/nikkisync/mobile/storage/SavedPhotoVerifier.java')
expect(savedVerifier.includes('openFileDescriptor'), 'M2.4.1 MediaStore existence verification is missing')
expect(savedVerifier.includes('SavedPhotoHealthStore.State.MISSING'), 'M2.4.1 missing-file state is not persisted')

const savedCollection = text('app/src/main/java/app/nikkisync/mobile/storage/SavedPhotoCollection.java')
expect(savedCollection.includes('FILTER_MOTION') && savedCollection.includes('FILTER_STILL'), 'M2.4.1 Saved filters are missing')
expect(savedCollection.includes('SORT_CAPTURED') && savedCollection.includes('captureTime'), 'M2.4.1 Saved capture-time sorting is missing')

const savedRecovery = text('app/src/main/java/app/nikkisync/mobile/storage/SavedPhotoRecovery.java')
expect(savedRecovery.includes('Pictures/NikkiSync/') && savedRecovery.includes('DCIM/Camera/'), 'M2.4.2 historical recovery paths are missing')
expect(savedRecovery.includes('matches.size() != 1'), 'M2.4.2 ambiguous historical matches must be skipped')
expect(savedRecovery.includes('recordRecovered'), 'M2.4.2 recovered exports must preserve provenance')

const auth = text('app/src/main/java/app/nikkisync/mobile/net/SignedHttpClient.java')
for (const header of ['X-NikkiSync-Device-Id', 'X-NikkiSync-Timestamp', 'X-NikkiSync-Nonce', 'X-NikkiSync-Signature']) {
  expect(auth.includes(header), `signed request header missing: ${header}`)
}
expect(auth.includes('SHA-256'), 'signed request body hash is missing')

const tls = text('app/src/main/java/app/nikkisync/mobile/security/PinnedTls.java')
expect(tls.includes('fingerprint mismatch'), 'TLS fingerprint enforcement is missing')

const identity = text('app/src/main/java/app/nikkisync/mobile/security/DeviceIdentity.java')
expect(identity.includes('KeyPermanentlyInvalidatedException'), 'Android Keystore invalidation recovery is missing')
expect(identity.includes('resetWrappingKeyAndBlobs'), 'invalid wrapping-key reset path is missing')
expect(identity.includes('new ServerStore(context).clear()'), 'stale pairing credentials must be cleared after identity recovery')

const nsd = text('app/src/main/java/app/nikkisync/mobile/net/NsdDiscovery.java')
expect(nsd.includes('_nikkisync._tcp.'), 'mDNS service type is missing')
expect(nsd.includes('serverId'), 'mDNS server identity matching is missing')

const websocket = text('app/src/main/java/app/nikkisync/mobile/net/RealtimeWebSocket.java')
expect(websocket.includes('/ws/v1'), 'WebSocket v1 route is missing')

const saver = text('app/src/main/java/app/nikkisync/mobile/media/OriginalSaver.java')
expect(saver.includes('X-NikkiSync-SHA256'), 'original download hash verification is missing')
expect(saver.includes('MediaStore.Images'), 'MediaStore original export is missing')
expect(saver.includes('IS_PENDING'), 'atomic MediaStore write is missing')
expect(saver.includes('rotationDegrees'), 'ordinary-photo export must accept the selected rotation')
expect(saver.includes('ExifInterface.ORIENTATION_ROTATE_90'), '90-degree JPEG orientation export is missing')
expect(saver.includes('ExifInterface.ORIENTATION_ROTATE_180'), '180-degree JPEG orientation export is missing')
expect(saver.includes('ExifInterface.ORIENTATION_ROTATE_270'), '270-degree JPEG orientation export is missing')

const motionSaver = text('app/src/main/java/app/nikkisync/mobile/media/MotionPhotoSaver.java')
expect(motionSaver.includes('Camera:MotionPhoto'), 'Motion Photo camera XMP metadata is missing')
expect(motionSaver.includes('Item:Semantic=\\"MotionPhoto\\"'), 'Motion Photo container directory is missing')
expect(motionSaver.includes('video/mp4'), 'Motion Photo MP4 item is missing')

const savedMetadataText = text('app/src/main/java/app/nikkisync/mobile/ui/SavedMetadataText.java')
const playerFacingDetails = text('app/src/main/java/app/nikkisync/mobile/ui/PlayerFacingDetails.java')
const mainActivity = text('app/src/main/java/app/nikkisync/mobile/MainActivity.java')
expect(!mainActivity.includes('编辑照片参数'), 'player-facing photo details must not expose numeric metadata editing')
expect(!savedMetadataText.includes('nativeParamToken') && !savedMetadataText.includes(' · ID '), 'player-facing outfit copy must not expose internal metadata')
expect(mainActivity.includes('PlayerFacingDetails.sourcePhoto(asset)'), 'source photo must use concise player-facing details')
expect(mainActivity.includes('PlayerFacingDetails.savedPhoto(record, missing)') && mainActivity.includes('PlayerFacingDetails.editedPhoto(variant, missing)'), 'Saved details must use concise player-facing copy')
expect(mainActivity.includes('renderClothingSection'), 'M4.2.8 clothing detail renderer is missing')
expect(mainActivity.includes('穿搭 · '), 'M4.2.8 clothing section heading is missing')
expect(mainActivity.includes('baseMakeup') && mainActivity.includes('底妆'), 'M4.2.8 clothing category labels are missing')
expect(mainActivity.includes('new ScrollView(this)'), 'photo detail must remain scrollable when clothing rows are present')
expect(mainActivity.includes('rotationByAssetId'), 'ordinary-photo rotation state must survive until batch save')
expect(mainActivity.includes('左转 90°') && mainActivity.includes('右转 90°'), 'photo viewer rotation controls are missing')
expect(mainActivity.includes('asset.hasMotion()'), 'rotation UI must keep Live Photo separate from ordinary JPEG export')
expect(
  /originalSaver\.save\(this,\s*current,\s*asset,\s*(savedRotation|rotationDegrees)\s*[,)]/.test(mainActivity),
  'selected ordinary-photo rotation is not wired into export'
)
const dockSource = text('app/src/main/java/app/nikkisync/mobile/ui/chrome/PhotoLayoutDock.java')
expect(mainActivity.includes('OperationProgressDialog') && mainActivity.includes('shareWorker'), 'share generation and photo saves need visible progress and an independent share queue')
expect(text('app/src/main/java/app/nikkisync/mobile/share/ShareCardPreparation.java').includes('ShareCardIconBatch.load'), 'share icon downloads must use the bounded parallel loader')
const savedFilterSheet = text('app/src/main/java/app/nikkisync/mobile/ui/SavedFilterSheet.java')
expect(dockSource.includes('"图库"') && dockSource.includes('"已保存"') && dockSource.includes('"我的"') && mainActivity.includes('navigationDock'), 'M2.3.1 three-tab bottom navigation is missing')
expect(mainActivity.includes('"暖暖相册"'), 'M2.3.2 gallery shell title is missing')
expect(mainActivity.includes('bg_glass_card')
  && savedFilterSheet.includes('surface.setColor(0xF7FFF8FA)')
  && savedFilterSheet.includes('navigation.showSheetWithOwnControls(this)'),
  'M2.3.2 gallery shell or readable filter surface is missing')
expect(mainActivity.includes('"已同步 "'), 'M2.3.2 gallery sync-count copy is missing')
expect(mainActivity.includes('SuitSearchDialog.show'), 'M2.3.3 gallery suit-search entry is missing')
expect(mainActivity.includes('"搜索套装或散件"'), 'M2.3.4 unified search copy is missing')
expect(mainActivity.includes('GridLayoutManager') && mainActivity.includes('adapter.isHeader(position) ? 3 : 1'), 'M2.3.1 full-width RecyclerView version headers are missing')
expect(mainActivity.includes('savedList') && mainActivity.includes('SavedPhotoAdapter'), 'M2.4 Saved tab must use a real saved-photo grid')
expect(mainActivity.includes('savedPhotoStore.record'), 'M2.4 successful exports must retain source provenance')
expect(mainActivity.includes('"在系统相册打开"') && mainActivity.includes('"查看源照片"'), 'M2.4 saved-photo detail actions are missing')
expect(mainActivity.includes('SavedPhotoCollection.select') || mainActivity.includes('SavedPhotoGroups.select'), 'M2.4.1 Saved filter/sort application is missing')
expect(mainActivity.includes('SavedPhotoVerifier.verify'), 'M2.4.1 Saved MediaStore health refresh is missing')
expect(playerFacingDetails.includes('文件不存在'), 'M2.4.1 missing saved-file detail state is missing')
expect(mainActivity.includes('"仅移除 NikkiSync 记录"'), 'M2.4.1 local record removal action is missing')
expect(savedFilterSheet.includes('"全部"') && savedFilterSheet.includes('"LIVE"') && savedFilterSheet.includes('"普通"'), 'M2.4.1 Saved filter controls are missing')
expect(savedFilterSheet.includes('"最近保存"') && savedFilterSheet.includes('"拍摄时间"'), 'M2.4.1 Saved sort controls are missing')
expect(savedFilterSheet.includes('"找回历史保存"') && mainActivity.includes('SavedPhotoRecovery.recover'), 'M2.4.2 historical recovery action is missing')
expect(mainActivity.includes('散件') && mainActivity.includes('套装'), 'M2.3 unified search copy is missing')
expect(mainActivity.includes('refreshMyPage()') && mainActivity.includes('myContent'), 'M2.5 real My page is missing')
expect(mainActivity.includes('asset.uid()') && mainActivity.includes('"搭配师 UID"') && mainActivity.includes('addStylistCard(uidCounts)'), 'M2.5 UID aggregation is missing')
expect(mainActivity.includes('settingsButton.setVisibility(my ? View.VISIBLE : View.GONE)') && mainActivity.includes('refreshSettingsPage()'), 'My page settings entrance is missing')
expect(mainActivity.includes('"图库概况"') && mainActivity.includes('LIVE：') && mainActivity.includes('已保存：'), 'M2.5 player-facing library counts are missing')
expect(mainActivity.includes('"同步与设备"') && mainActivity.includes('pairedServer.serverName()'), 'M2.5 paired PC summary is missing')
expect(mainActivity.includes('"复制 UID"') && mainActivity.includes('copyText('), 'M2.5.1 UID copy action is missing')
expect(!mainActivity.includes('"版本分布"') && !mainActivity.includes('metadataPercent'), 'My page must not show technical version/coverage diagnostics')
expect(mainActivity.includes('"常用套装"') && mainActivity.includes('"常用散件"'), 'M2.5.1 top outfit summaries are missing')
expect(!mainActivity.includes('"数据源状态"') && !mainActivity.includes('providerVersion()'), 'My page must not show dictionary internals')
expect(mainActivity.includes('current.profileStats()'), 'M2.5.1 remote profile stats loading is missing')
expect(mainActivity.includes('openProfileSearch(') && mainActivity.includes('addMyLinkCard('), 'M2.5.2 profile trend links are missing')
expect(mainActivity.includes('switchTab(TAB_GALLERY)') && mainActivity.includes('SuitSearchDialog.showSuit') && mainActivity.includes('SuitSearchDialog.showClothing'), 'M2.5.2 profile trends must deep-link into gallery search')


const chromeHost = text('app/src/main/java/app/nikkisync/mobile/ui/chrome/ChromeHost.java')
const topBlur = text('app/src/main/java/app/nikkisync/mobile/ui/chrome/ProgressiveTopBlurView.java')
const photoViewer = text('app/src/main/java/app/nikkisync/mobile/ui/chrome/PhotoViewerPage.java')
const navigationHost = text('app/src/main/java/app/nikkisync/mobile/ui/chrome/ChromeNavigationHost.java')
expect(mainActivity.includes('new ChromeNavigationHost(this)') && mainActivity.includes('navigation.bind(this)'), 'restored predictive navigation must be active')
expect(mainActivity.includes('PhotoViewerPage dialog') && mainActivity.includes('dialog.setPaging('), 'restored viewer must preserve paging and gestures')
expect(photoViewer.includes('ScaleGestureDetector') && photoViewer.includes('animateZoom(') && photoViewer.includes('navigation.progress('), 'pinch, double tap and animated dismiss must stay implemented')
expect(navigationHost.includes('handleOnBackProgressed') && navigationHost.includes('handleOnBackCancelled'), 'predictive back progress and cancellation must stay implemented')
expect(chromeHost.includes('backdrop.record(') && topBlur.includes('RenderEffect.createBlurEffect'), 'app blur must use restored GPU content sampling')
expect(!mainActivity.includes('GalleryGlassBackdrop') && mainActivity.includes('bg_gallery_ambient'), 'CPU blur must not replace restored GPU chrome or pink ambient')
expect(manifest.includes('enableOnBackInvokedCallback="true"'), 'predictive back must remain enabled')
expect(mainActivity.includes('LivePhotoExporter.save') && mainActivity.includes('LivePhotoControls.attach'), 'latest LIVE pipeline must survive UI recovery')
expect(mainActivity.includes('writeExif') && text('app/src/main/java/app/nikkisync/mobile/net/NikkiSyncClient.java').includes('exportStill('), 'export settings must survive UI recovery')
const client = text('app/src/main/java/app/nikkisync/mobile/net/NikkiSyncClient.java')
expect(client.includes('PATCH'), 'M4 signed metadata update request is missing')
expect(client.includes('/metadata'), 'M4 metadata route is missing')
expect(client.includes('/clothing/'), 'M4.2.8 clothing thumbnail must be requested through the paired PC')
expect(client.includes('/v1/search/suits?q='), 'M2.3.3 suit search must use the paired PC search endpoint')
expect(client.includes('/v1/search/clothing?q='), 'M2.3.4 clothing search must use the paired PC search endpoint')
expect(client.includes('/v1/profile/stats'), 'M2.5.1 profile stats must use the paired PC endpoint')

const suitSearchDialog = text('app/src/main/java/app/nikkisync/mobile/ui/SuitSearchDialog.java')
expect(suitSearchDialog.includes('observedPartCount') && suitSearchDialog.includes('totalPartCount'), 'M2.3.3 suit coverage summary is missing')
expect(suitSearchDialog.includes('"图库覆盖 "'), 'M2.3.3 suit coverage percentage is missing')
expect(suitSearchDialog.includes('bg_suit_coverage_track') && suitSearchDialog.includes('bg_suit_coverage_fill'), 'M2.3.3 suit coverage bar is missing')
expect(suitSearchDialog.includes('MODE_ALL') && suitSearchDialog.includes('MODE_SUIT') && suitSearchDialog.includes('MODE_CLOTHING'), 'M2.3.4 all/suit/clothing search modes are missing')
expect(suitSearchDialog.includes('client.searchClothing'), 'M2.3.4 clothing query path is not wired into the search UI')
expect(suitSearchDialog.includes('ClothingSearchGrid.create'), 'M2.3.4 clothing results are not rendered')
expect(suitSearchDialog.includes('"最近搜索"') && suitSearchDialog.includes('SuitSearchHistory.record'), 'M2.3.3 recent suit search UX is missing')
expect(suitSearchDialog.includes('listener::onPhotoClick'), 'M2.3.3 photo viewer must preserve search results behind it')
expect(suitSearchDialog.includes('showSuit(') && suitSearchDialog.includes('showClothing('), 'M2.5.2 search deep-link entry points are missing')
expect(suitSearchDialog.includes('initialQuery') && suitSearchDialog.includes('autoSearch'), 'M2.5.2 deep-link search must prefill and auto-run')
expect(!suitSearchDialog.includes('private static LinearLayout photoRow'), 'M2.3.3 legacy vertical result renderer must stay removed')

const suitSearchHistory = text('app/src/main/java/app/nikkisync/mobile/ui/SuitSearchHistory.java')
expect(suitSearchHistory.includes('LIMIT = 5'), 'M2.3.3 recent suit search history must stay bounded')
expect(suitSearchHistory.includes('SharedPreferences'), 'M2.3.3 recent suit searches must persist locally')

const suitSearchGrid = text('app/src/main/java/app/nikkisync/mobile/ui/SuitSearchGrid.java')
expect(suitSearchGrid.includes('for (int column = 0; column < 3; column++)'), 'M2.3.3 suit results must use a three-column album grid')
expect(suitSearchGrid.includes('"全部 " + item.photoCount()'), 'M2.3.3 suit results must provide an all-photo filter')
expect(suitSearchGrid.includes('countCategories') && suitSearchGrid.includes('hasCategory'), 'M2.3.3 suit results must support part/category filtering')
expect(suitSearchGrid.includes('compactPartText') && suitSearchGrid.includes('matchedParts'), 'M2.3.3 photo cells must label matched suit slots')
expect(suitSearchGrid.includes('"LIVE"'), 'M2.3.3 search grid must retain Live Photo visibility')
expect(suitSearchGrid.includes('CATEGORY_ORDER'), 'M2.3.3 part filters must use a stable Infinity Nikki slot order')

const clothingSearchGrid = text('app/src/main/java/app/nikkisync/mobile/ui/ClothingSearchGrid.java')
expect(clothingSearchGrid.includes('for (int column = 0; column < 3; column++)'), 'M2.3.4 clothing results must use a three-column photo grid')
expect(clothingSearchGrid.includes('categoryLabel'), 'M2.3.4 clothing results must expose the clothing slot')
expect(clothingSearchGrid.includes('"LIVE"'), 'M2.3.4 clothing search must retain Live Photo visibility')

expect(models.includes('ClothingSearchResult') && models.includes('ClothingSearchResponse'), 'M2.3.4 Android clothing search models are missing')
expect(jsonCodec.includes('clothingSearch(String json)'), 'M2.3.4 clothing search JSON decoder is missing')
expect(models.includes('ProfileStatsResponse') && models.includes('ProfileDictionaryStatus'), 'M2.5.1 Android profile stats models are missing')
expect(jsonCodec.includes('profileStats(String json)'), 'M2.5.1 profile stats JSON decoder is missing')

const imageLoader = text('app/src/main/java/app/nikkisync/mobile/media/ImageLoader.java')
expect(imageLoader.includes('loadClothingThumbnail'), 'M4.2.8 clothing thumbnail loader is missing')
expect(imageLoader.includes('showClothingPlaceholder'), 'missing clothing thumbnails must degrade to a visible placeholder instead of a blank tile')
expect(!imageLoader.includes('https://images.'), 'mobile image loader must not embed a third-party clothing image host')

const huaweiSaver = text('app/src/main/java/app/nikkisync/mobile/media/HuaweiMovingPhotoSaver.java')
expect(huaweiSaver.includes('Environment.DIRECTORY_DCIM + "/Camera"'), 'Huawei adapter must publish to Camera')
expect(huaweiSaver.includes('copy(video, output)'), 'Huawei adapter must append the MP4 payload')

const allJava = required.filter((x) => x.endsWith('.java')).map(text).join('\n').toLowerCase()
for (const forbidden of ['firebase', 'retrofit', 'okhttp', 'cloudinary', 's3.amazonaws']) {
  expect(!allJava.includes(forbidden), `M2 local-only mobile unexpectedly references ${forbidden}`)
}

const mobileGradle = text('app/build.gradle.kts')
const editedMediaAccess = text('app/src/main/java/app/nikkisync/mobile/storage/EditedMediaAccess.java')
expect(mobileGradle.includes('androidx.activity:activity:1.10.1'), 'edited-photo linking needs stable AndroidX Activity Photo Picker support')
expect(mainActivity.includes('PickMultipleVisualMedia'), 'Saved edited variants must use the system multi-photo picker')
expect(mainActivity.includes('PickVisualMedia.ImageOnly'), 'edited-variant picker must accept images only')
expect(editedMediaAccess.includes('takePersistableUriPermission'), 'selected edit URIs must request persistent read access')
expect(!manifest.includes('READ_MEDIA_IMAGES'), 'manual edit linking must not request broad gallery read permission')

expect(savedPhotoAdapter.includes('TYPE_HEADER') && savedPhotoAdapter.includes('TYPE_MEDIA'),
  'Saved edited media must render grouped source rows')
expect(savedPhotoAdapter.includes('SavedPhotoGroups.Group'),
  'Saved adapter must consume source groups')
expect(savedPhotoAdapter.includes('"修图"'),
  'Saved edited variants need a compact 修图 badge')
expect(mainActivity.includes('savedAdapter.isHeader(position) ? 3 : 1'),
  'Saved group headers must span the full three-column grid')
expect(mainActivity.includes('SavedPhotoGroups.select'),
  'Saved refresh must combine original records and edited variants')

expect(mainActivity.includes('"关联修图"'), 'Saved original detail needs edited-photo linking action')
expect(mainActivity.includes('"解除关联"'), 'edited variant detail needs unlink action')
expect(mainActivity.includes('"查看原始保存图"'), 'edited variant must link back to an original Saved item')
expect(mainActivity.includes('SavedMetadataSnapshotStore'), 'Saved details need offline metadata snapshots')
expect(!mainActivity.includes('getContentResolver().delete('), 'unlinking an edit must never delete system-gallery media')

const shareCardPayloadBuilder = text('app/src/main/java/app/nikkisync/mobile/share/ShareCardPayloadBuilder.java')
const shareCardExporter = text('app/src/main/java/app/nikkisync/mobile/share/ShareCardExporter.java')
const shareCardCoordinator = text('app/src/main/java/app/nikkisync/mobile/share/ShareCardExportCoordinator.java')
const shareCardPreparation = text('app/src/main/java/app/nikkisync/mobile/share/ShareCardPreparation.java')
const shareCardPreview = text('app/src/main/java/app/nikkisync/mobile/share/ShareCardPreviewDialog.java')
expect(mainActivity.includes('ShareCardExportCoordinator'), 'share-card UI must use the presentation coordinator boundary')
expect(!mainActivity.includes('import app.nikkisync.mobile.share.ShareCardExporter;'), 'MainActivity must not own share-card rendering/export internals')
expect(!mainActivity.includes('import app.nikkisync.mobile.share.ShareCardPayloadBuilder;'), 'MainActivity must not build share-card payloads directly')
expect(/exportRemoteShareCard\(shareCard\s*,\s*current\s*,\s*asset\s*,\s*detail\.metadataJson\(\)\)/.test(mainActivity), 'source-photo share-card entry is missing')
expect(mainActivity.includes('shareSaved') && mainActivity.includes('record.mediaUri()'), 'Saved original share-card entry is missing')
expect(mainActivity.includes('shareEdited') && mainActivity.includes('Uri.parse(variant.uri())'), 'edited-variant share-card entry is missing')
expect(shareCardPreview.includes('保存分享图') && shareCardPreview.includes('保存原图+分享图') && shareCardPreview.includes('关闭'), 'share-card preview must expose the requested three save/close actions')
expect(shareCardPreview.includes('navigation.push(host') && shareCardPreview.includes('host.addDockEffect'), 'share preview must use in-app predictive return and GPU glass controls')
expect(shareCardCoordinator.includes('exportRemote(') && shareCardCoordinator.includes('exportLocal('), 'share-card coordinator must support remote and local media')
expect(shareCardPayloadBuilder.includes('dressing') && shareCardPayloadBuilder.includes('camera'), 'share-card payload must include outfit and camera metadata')
expect(shareCardPayloadBuilder.includes('lighting') && shareCardPayloadBuilder.includes('filter'), 'share-card payload must include lighting/filter metadata')
expect(
  shareCardPreparation.includes('Environment.DIRECTORY_PICTURES+"/NikkiSync/Share Cards"'),
  'share cards must stay in the dedicated MediaStore folder'
)
expect(shareCardPreparation.includes('Bitmap.CompressFormat.PNG'), 'share-card pages should use lossless PNG')
expect(shareCardPreparation.includes('inSampleSize=sample'), 'share-card decoding must stay bounded')
expect(shareCardPreparation.includes('detail.originalStill()') && shareCardPreparation.includes('SHA-256'), 'remote share-card background must use a verified original')
expect(shareCardPreview.includes('coordinator.save(') && shareCardCoordinator.includes('cancel()'), 'preview, explicit save and cancellation must stay separate')
expect(!shareCardExporter.includes('import android.graphics.RenderEffect;'), 'off-screen share-card export must not depend on RenderEffect')
expect(!shareCardExporter.includes('.setRenderEffect('), 'off-screen share-card export must not call View/RenderNode-only RenderEffect APIs')

console.log('M2 mobile source contract: OK')
console.log(`validated files: ${required.length}`)
console.log('transport: pinned HTTPS + Ed25519 signed requests + mDNS + WebSocket')
console.log('original export: MediaStore + SHA-256 verification + selected JPEG rotation')
console.log('clothing detail: canonical metadata + paired-PC thumbnail proxy + visible fallback')
console.log('M2.3.1 UX: three-tab shell + RecyclerView version-first gallery contract')
console.log('M2.3.2 UX: glass shell + rounded thumbnails + non-dimming selection contract')
console.log('M2.3.2D share cards: two-column icons + bounded PNG pages + preview before explicit save + offline Saved/edit export')
console.log('M2.3.3 search: ranked suit lookup + coverage + filters + history + preserved viewer context')
console.log('M2.3.4 search: unified all/suit/clothing lookup + clothing photo grid contract')
console.log('M2.4 Saved: local export provenance + three-column MediaStore history contract')
console.log('M2.4.1 Saved: MediaStore health + filters + sorting + safe local record removal')
console.log('M2.4.2 Saved: high-confidence historical export recovery')
console.log('M2.4.3 Saved: grouped originals + manually linked edited variants + offline metadata snapshots')
console.log('M2.5 profile: UID + library + paired-device summary')
console.log('M2.5.1 profile: UID copy + useful counts + connection state + named top outfits')
console.log('M2.5.2 profile: clickable top outfit trends deep-link into gallery search')

expect(
  mainActivity.indexOf('io.shutdownNow()') < mainActivity.indexOf('editedVariantStore.close()')
    && mainActivity.indexOf('io.shutdownNow()') < mainActivity.indexOf('savedMetadataSnapshotStore.close()'),
  'Saved stores must close only after background work is stopped'
)

expect(
  mainActivity.includes('new ActivityResultContracts.PickMultipleVisualMedia()') && !mainActivity.includes('MediaStore.getPickImagesMaxLimit()'),
  'multi-photo picker must use the Java maxItems constructor'
)
