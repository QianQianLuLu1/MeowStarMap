package app.nikkisync.mobile.protocol;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import app.nikkisync.mobile.model.Models.AssetPage;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.model.Models.ClothingSearchResponse;
import app.nikkisync.mobile.model.Models.ProfileStatsResponse;
import app.nikkisync.mobile.model.Models.SuitSearchResponse;

import org.junit.Test;

public final class JsonCodecTest {
    @Test public void assetPageParsesGameVersionAndDefaultsMissingProvenanceToUnknown() throws Exception {
        String json = "{\"items\":[" +
                "{\"assetId\":\"asset_explicit\",\"type\":\"photo\",\"state\":\"ready\",\"capturedAt\":\"2026-09-01T00:00:00.000Z\",\"revision\":1,\"hasMotion\":false,\"hasMetadata\":true,\"gameVersion\":\"2.9\",\"gameVersionSource\":\"explicit\"}," +
                "{\"assetId\":\"asset_legacy\",\"type\":\"photo\",\"state\":\"ready\",\"revision\":2,\"hasMotion\":false,\"hasMetadata\":false}" +
                "],\"libraryRevision\":2}";

        AssetPage page = JsonCodec.assetPage(json);
        AssetSummary explicit = page.items().get(0);
        AssetSummary legacy = page.items().get(1);

        assertEquals("2.9", explicit.gameVersion());
        assertEquals("explicit", explicit.gameVersionSource());
        assertNull(legacy.gameVersion());
        assertEquals("unknown", legacy.gameVersionSource());
    }

    @Test public void suitSearchParsesPhotosAndMatchedParts() throws Exception {
        String json = "{\"query\":\"天鹅童话\",\"items\":[{" +
                "\"suitId\":\"suit_swan\",\"suitName\":\"天鹅童话\",\"observedPartCount\":2,\"totalPartCount\":9,\"photoCount\":1," +
                "\"photos\":[{\"asset\":{\"assetId\":\"asset_1\",\"type\":\"photo\",\"state\":\"ready\",\"revision\":3,\"hasMotion\":false,\"hasMetadata\":true}," +
                "\"matchedParts\":[{\"clothingId\":\"cloth_dress\",\"name\":\"天鹅之梦\",\"category\":\"dresses\"},{\"clothingId\":\"cloth_shoes\",\"category\":\"shoes\"}]}]}]}";

        SuitSearchResponse response = JsonCodec.suitSearch(json);
        assertEquals(1, response.items().size());
        assertEquals("天鹅童话", response.items().get(0).suitName());
        assertEquals(Integer.valueOf(9), response.items().get(0).totalPartCount());
        assertEquals(1, response.items().get(0).photos().size());
        assertEquals("asset_1", response.items().get(0).photos().get(0).asset().assetId());
        assertEquals("dresses", response.items().get(0).photos().get(0).matchedParts().get(0).category());
        assertEquals("shoes", response.items().get(0).photos().get(0).matchedParts().get(1).category());
    }

    @Test public void clothingSearchParsesPieceMetadataAndPhotos() throws Exception {
        String json = "{\"query\":\"天鹅之梦\",\"items\":[{" +
                "\"clothingId\":\"cloth_dress\",\"name\":\"天鹅之梦\",\"category\":\"dresses\"," +
                "\"suitId\":\"suit_swan\",\"suitName\":\"天鹅童话\",\"photoCount\":1," +
                "\"photos\":[{\"asset\":{\"assetId\":\"asset_2\",\"type\":\"photo\",\"state\":\"ready\",\"revision\":4,\"hasMotion\":true,\"hasMetadata\":true}}]}]}";

        ClothingSearchResponse response = JsonCodec.clothingSearch(json);
        assertEquals(1, response.items().size());
        assertEquals("cloth_dress", response.items().get(0).clothingId());
        assertEquals("天鹅之梦", response.items().get(0).name());
        assertEquals("dresses", response.items().get(0).category());
        assertEquals("天鹅童话", response.items().get(0).suitName());
        assertEquals(1, response.items().get(0).photoCount());
        assertEquals("asset_2", response.items().get(0).photos().get(0).asset().assetId());
    }

    @Test public void profileStatsParsesTrendsAndDictionaryStatus() throws Exception {
        String json = "{\"libraryRevision\":12," +
                "\"dictionary\":{\"provider\":\"nikki-albums\",\"providerVersion\":\"2026.09\",\"gameVersion\":\"2.9\",\"fetchedAt\":\"2026-09-13T00:00:00.000Z\",\"clothingEntries\":2048}," +
                "\"topSuits\":[{\"suitId\":\"suit_swan\",\"suitName\":\"天鹅童话\",\"photoCount\":18}]," +
                "\"topClothing\":[{\"clothingId\":\"cloth_dress\",\"name\":\"天鹅之梦\",\"category\":\"dresses\",\"suitName\":\"天鹅童话\",\"photoCount\":11}]}";

        ProfileStatsResponse response = JsonCodec.profileStats(json);
        assertEquals(12L, response.libraryRevision());
        assertEquals("nikki-albums", response.dictionary().provider());
        assertEquals("2026.09", response.dictionary().providerVersion());
        assertEquals(2048, response.dictionary().clothingEntries());
        assertEquals("天鹅童话", response.topSuits().get(0).suitName());
        assertEquals(18, response.topSuits().get(0).photoCount());
        assertEquals("天鹅之梦", response.topClothing().get(0).name());
        assertEquals("dresses", response.topClothing().get(0).category());
        assertEquals(11, response.topClothing().get(0).photoCount());
    }

}
