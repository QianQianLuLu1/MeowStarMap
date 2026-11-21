package app.nikkisync.mobile.storage;

import static org.junit.Assert.*;

import android.content.Context;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

@RunWith(RobolectricTestRunner.class)
public final class SavedMetadataSnapshotStoreTest {
    private Context context;
    private SavedMetadataSnapshotStore store;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase("nikkisync-saved-metadata.db");
        store = new SavedMetadataSnapshotStore(context);
    }

    @After public void tearDown() {
        store.close();
    }

    @Test public void snapshotRoundTripsCanonicalMetadata() {
        var input = new SavedMetadataSnapshotStore.Snapshot(
                "asset-a",
                "{\"camera\":{\"focalLength\":50},\"filter\":{\"id\":\"F01\"}}",
                "2026-09-19T10:00:00Z",
                "2.9",
                1000L);
        store.put(input);

        var restored = store.get("asset-a");
        assertNotNull(restored);
        assertEquals(input.metadataJson(), restored.metadataJson());
        assertEquals("2.9", restored.gameVersion());
    }

    @Test public void missingRefreshDoesNotEraseLastSnapshot() {
        store.put(new SavedMetadataSnapshotStore.Snapshot(
                "asset-a", "{\"camera\":{\"focalLength\":50}}", null, "2.9", 1000L));

        assertEquals("{\"camera\":{\"focalLength\":50}}", store.get("asset-a").metadataJson());
    }

    @Test public void newerSnapshotReplacesOlderSnapshotForSameAsset() {
        store.put(new SavedMetadataSnapshotStore.Snapshot(
                "asset-a", "{\"camera\":{\"focalLength\":35}}", null, "2.8", 1000L));
        store.put(new SavedMetadataSnapshotStore.Snapshot(
                "asset-a", "{\"camera\":{\"focalLength\":50}}", "2026-09-19T10:00:00Z", "2.9", 2000L));

        var restored = store.get("asset-a");
        assertEquals(2000L, restored.updatedAt());
        assertEquals("2.9", restored.gameVersion());
        assertTrue(restored.metadataJson().contains("50"));
    }
}
