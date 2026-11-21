package app.nikkisync.mobile.storage;

import app.nikkisync.mobile.model.Models.AssetSummary;
import org.junit.Test;
import static org.junit.Assert.*;

public final class FavoritePhotoStoreCodecTest {
    @Test public void snapshotKeepsPreviewVersionAndLiveIdentity() throws Exception {
        AssetSummary original = new AssetSummary("photo", "motion_photo", "ready", "2026-09-01T01:00:00Z",
                "12345", 42L, 1600, 900, true, true, "thumb", "preview", "2.9", "inferred");
        AssetSummary restored = FavoritePhotoStore.decode(FavoritePhotoStore.encode(original));
        assertEquals(original.assetId(), restored.assetId());
        assertEquals(original.capturedAt(), restored.capturedAt());
        assertEquals(original.gameVersionSource(), restored.gameVersionSource());
        assertEquals(original.previewResourceId(), restored.previewResourceId());
        assertEquals(original.width(), restored.width());
        assertTrue(restored.hasMotion());
    }

    @Test public void snapshotDoesNotInventMissingDatesOrVersions() throws Exception {
        AssetSummary original = new AssetSummary("unknown", "photo", "ready", null, null, 0L,
                null, null, false, false, null, null, null, "unknown");
        AssetSummary restored = FavoritePhotoStore.decode(FavoritePhotoStore.encode(original));
        assertNull(restored.capturedAt());
        assertNull(restored.gameVersion());
        assertNull(restored.width());
    }
}
