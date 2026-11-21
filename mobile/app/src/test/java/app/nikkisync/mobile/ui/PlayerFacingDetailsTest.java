package app.nikkisync.mobile.ui;

import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.storage.EditedVariantStore;
import app.nikkisync.mobile.storage.SavedPhotoStore;
import org.junit.Test;
import static org.junit.Assert.*;

public final class PlayerFacingDetailsTest {
    @Test public void sourcePhotoShowsDateVersionAndLiveWithoutDimensionsOrIds() {
        AssetSummary asset = new AssetSummary("internal-99", "photo", "ready", "2026-09-25T10:20:00Z",
                "12345", 7, 3840, 2160, true, true, null, null, "2.9", "inferred");
        String copy = PlayerFacingDetails.sourcePhoto(asset);
        assertTrue(copy.contains("拍摄时间"));
        assertTrue(copy.contains("游戏版本：2.9"));
        assertTrue(copy.contains("LIVE"));
        assertFalse(copy.contains("3840"));
        assertFalse(copy.contains("internal-99"));
    }

    @Test public void savedPhotoKeepsMissingFileAndRotationButHidesTechnicalFields() {
        SavedPhotoStore.Record record = new SavedPhotoStore.Record("internal-99", "content://saved/1",
                1_790_000_000_000L, false, 90, "2026-09-25T10:20:00Z", "2.9", "image/jpeg");
        String copy = PlayerFacingDetails.savedPhoto(record, true);
        assertTrue(copy.contains("文件不存在"));
        assertTrue(copy.contains("保存时间"));
        assertTrue(copy.contains("拍摄时间"));
        assertTrue(copy.contains("游戏版本：2.9"));
        assertTrue(copy.contains("旋转"));
        assertFalse(copy.contains("internal-99"));
        assertFalse(copy.contains("image/jpeg"));
    }

    @Test public void editedPhotoHidesFileNameMimeAndAssetId() {
        EditedVariantStore.Variant variant = new EditedVariantStore.Variant("v1", "internal-99",
                "content://saved/2", 1_790_000_000_000L, "DSC_1234.jpg", "image/jpeg", "content://saved/1");
        String copy = PlayerFacingDetails.editedPhoto(variant, false);
        assertTrue(copy.contains("关联时间"));
        assertFalse(copy.contains("DSC_1234.jpg"));
        assertFalse(copy.contains("image/jpeg"));
        assertFalse(copy.contains("internal-99"));
    }

    @Test public void unnamedOutfitNeverShowsNumericCode() {
        assertEquals("名称暂缺", PlayerFacingDetails.clothingName("", "104321"));
        assertEquals("名称暂缺", PlayerFacingDetails.clothingName("服装 104321", "104321"));
        assertEquals("名称暂缺", PlayerFacingDetails.clothingName("服装+104321", "104321"));
        assertEquals("星海长裙", PlayerFacingDetails.clothingName("星海长裙", "104321"));
    }

    @Test public void plainScreenshotExplainsMissingDataWithoutClaimingAFormatOrProgram() {
        String notice=PlayerFacingDetails.metadataNotice(null);
        assertTrue(notice.contains("穿搭和拍摄参数"));assertTrue(notice.contains("游戏内相机原图"));
        assertFalse(notice.contains("可能"));assertFalse(notice.contains("损坏"));
        assertEquals(notice,PlayerFacingDetails.metadataNotice("{\"camera\":{},\"dressing\":{\"clothes\":[]}}"));
    }

    @Test public void checkedIndexWithoutParameterMarkerExplainsEvidenceAndNextStep() {
        String notice=PlayerFacingDetails.metadataNotice("{\"raw\":{\"sourceParametersChecked\":true,\"sourceParametersPresent\":false,\"sourceParametersComplete\":false}}");
        assertTrue(notice.contains("没有可用的穿搭和拍摄参数"));
        assertTrue(notice.contains("原图"));
        assertFalse(notice.contains("一定"));
        assertTrue(PlayerFacingDetails.metadataNotice("{\"raw\":{\"sourceParametersPresent\":false}}").contains("没有可显示的"));
    }

    @Test public void screenshotPathGetsSpecificHintButEmbeddedParametersStillUseResolverGuidance() {
        assertTrue(PlayerFacingDetails.isScreenShotPath("D:\\Game\\X6Game\\ScreenShot\\photo.jpg"));
        assertFalse(PlayerFacingDetails.isScreenShotPath("D:\\Game\\ScreenShots\\photo.jpg"));
        String screenshot=PlayerFacingDetails.metadataNotice(null,"D:\\Game\\ScreenShot\\photo.jpg");
        assertTrue(screenshot.contains("来自 ScreenShot"));
        assertTrue(screenshot.contains("游戏内相机原图"));
        assertEquals(screenshot, PlayerFacingDetails.metadataNotice("{\"raw\":{\"sourceParametersChecked\":true,\"sourceParametersPresent\":false}}", "D:/Game/ScreenShot/photo.jpg"));
        String embedded=PlayerFacingDetails.metadataNotice("{\"raw\":{\"sourceParametersPresent\":true,\"resolver\":{\"status\":\"failed\"}}}", "D:/Game/ScreenShot/photo.jpg");
        assertTrue(embedded.contains("尚未解码成功"));
        assertFalse(embedded.contains("来自 ScreenShot"));
    }

    @Test public void knownNativeDataAndResolverFailureAreUnparsedRatherThanLost() {
        for(String raw:new String[]{"{\"nativeParamToken\":\"private-token\"}","{\"sourceParametersPresent\":true}","{\"resolver\":{\"status\":\"failed\",\"error\":\"private-error\"}}"}) {
            String notice=PlayerFacingDetails.metadataNotice("{\"raw\":"+raw+"}");
            assertTrue(notice.contains("尚未解码成功"));assertTrue(notice.contains("参数解析状态"));
            assertFalse(notice.contains("缺少原始数据"));assertFalse(notice.contains("private"));
        }
    }

    @Test public void partiallyDecodedMetadataKeepsTheCorrectExplanation() {
        String notice=PlayerFacingDetails.metadataNotice("{\"camera\":{\"focalLength\":50},\"raw\":{\"resolver\":{\"status\":\"resolved\"}}}");
        assertTrue(notice.startsWith("穿搭数据未能完整读取"));assertFalse(notice.contains("联网"));assertFalse(notice.contains("缺少原始数据"));
        String partial=PlayerFacingDetails.metadataNotice("{\"dressing\":{\"clothes\":[{\"id\":\"123\"}]}}");
        assertTrue(partial.startsWith("部分拍摄参数"));
    }

    @Test public void incompleteEnvelopeAndMissingUidGetSpecificActionableGuidance() {
        String partial=PlayerFacingDetails.metadataNotice("{\"raw\":{\"sourceParametersPresent\":true,\"sourceParametersComplete\":false}}");
        assertTrue(partial.contains("原始数据不完整"));assertTrue(partial.contains("原图"));
        String noUid=PlayerFacingDetails.metadataNotice("{\"identity\":{},\"raw\":{\"sourceParametersPresent\":true,\"sourceParametersComplete\":true}}");
        assertTrue(noUid.contains("未识别到所属 UID"));assertTrue(noUid.contains("重新扫描"));
    }

    @Test public void decodedIdsWithoutNamesOrIconsAreNotMissingOutfitData() {
        assertEquals("",PlayerFacingDetails.metadataNotice("{\"camera\":{\"exposure\":0},\"dressing\":{\"clothes\":[{\"id\":\"123\"}]}}"));
    }

    @Test public void corruptMetadataOffersResyncRatherThanAFalseMissingSourceDiagnosis() {
        String notice=PlayerFacingDetails.metadataNotice("{broken");assertTrue(notice.contains("重新同步"));assertFalse(notice.contains("普通截图"));
    }

    @Test public void indexedLiveWithoutParametersHasOneDirectReason() {
        AssetSummary live=new AssetSummary("live","photo","ready",null,null,1,100,100,true,false,null,null,null,null);
        String notice=PlayerFacingDetails.metadataNoticeForAsset(live,null);
        assertEquals("这张是 LIVE 照片，不带穿搭和拍摄参数。", notice);
        assertEquals(notice, PlayerFacingDetails.metadataNoticeForAsset(null, null, true));
        assertFalse(notice.contains("普通截图"));assertFalse(notice.contains("可能"));
    }

    @Test public void explicitCollageStickerAndGroupSourcesExplainTheTypeUnlessActualParametersExist() {
        AssetSummary original=new AssetSummary("special","photo","ready",null,null,1,100,100,false,true,null,null,null,null);
        String checked="{\"raw\":{\"sourceParametersChecked\":true,\"sourceParametersPresent\":false}}";
        for (String[] pair : new String[][]{{"Collage/HighQuality", "拼图"}, {"贴图", "贴图"}, {"GroupPhotos", "双人合照"}}) {
            String folder="D:/Game/ScreenShot/"+pair[0];
            AssetSummary asset=original.withSource(folder+"/photo.jpg",folder,null);
            assertEquals("这张是"+pair[1]+"，不带穿搭和拍摄参数。", PlayerFacingDetails.metadataNoticeForAsset(asset,checked));
            assertEquals("", PlayerFacingDetails.metadataNoticeForAsset(asset,
                    "{\"camera\":{\"exposure\":0},\"dressing\":{\"clothes\":[{\"id\":\"123\"}]}}"));
        }
    }

    @Test public void screenshotFolderAndNativeResolverEvidenceTakeDifferentPaths() {
        AssetSummary screenshot=new AssetSummary("screen","photo","ready",null,null,1,100,100,false,false,null,null,null,null);
        screenshot=screenshot.withSource("D:/Game/ScreenShot/photo.jpg","ScreenShot",null);
        assertTrue(PlayerFacingDetails.metadataNoticeForAsset(screenshot,null).contains("来自 ScreenShot"));
        String embedded=PlayerFacingDetails.metadataNoticeForAsset(screenshot,"{\"raw\":{\"sourceParametersPresent\":true,\"resolver\":{\"status\":\"failed\"}}}");
        assertTrue(embedded.contains("尚未解码成功"));assertFalse(embedded.contains("来自 ScreenShot"));
    }
}
