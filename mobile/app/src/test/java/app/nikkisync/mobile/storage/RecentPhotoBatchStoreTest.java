package app.nikkisync.mobile.storage;

import app.nikkisync.mobile.model.Models.AssetSummary;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import java.util.List;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public final class RecentPhotoBatchStoreTest {
    private RecentPhotoBatchStore store;

    @Before public void prepare() {
        var context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("recent_photo_batches", 0).edit().clear().commit();
        store = new RecentPhotoBatchStore(context);
    }

    @Test public void firstLibraryIsBaselineThenNewPhotosRemainVisibleAcrossRestarts() {
        var first = photo("first", "2026-11-11T10:00:00Z");
        var second = photo("second", "2026-11-11T10:05:00Z");
        assertTrue(store.reconcile("pc", List.of(), false, List.of(first), 100).isEmpty());
        assertEquals(Set.of("second"), store.reconcile("pc", List.of("first"), true, List.of(second, first), 200));
        store = new RecentPhotoBatchStore(RuntimeEnvironment.getApplication());
        assertEquals(Set.of("second"), store.load("pc"));
        assertEquals(Set.of("second"), store.reconcile("pc", List.of("first", "second"), true,
                List.of(second, first), 300));
    }

    @Test public void nearbyCapturesJoinOneBatchAndLaterShootReplacesIt() {
        var a = photo("a", "2026-11-11T10:00:00Z");
        var b = photo("b", "2026-11-11T10:10:00Z");
        var c = photo("c", "2026-11-11T10:20:00Z");
        var d = photo("d", "2026-11-11T12:00:00Z");
        store.reconcile("pc", List.of(), false, List.of(a), 100);
        assertEquals(Set.of("b"), store.reconcile("pc", List.of("a"), true, List.of(b, a), 200));
        assertEquals(Set.of("b", "c"), store.reconcile("pc", List.of("a", "b"), true, List.of(c, b, a), 300));
        assertEquals(Set.of("d"), store.reconcile("pc", List.of("a", "b", "c"), true, List.of(d, c, b, a), 400));
        assertEquals(Set.of("d"), store.load("pc"));
        assertTrue(store.load("other-pc").isEmpty());
        assertTrue(store.reconcile("pc", List.of("a", "b", "c", "d"), true, List.of(c, b, a), 500).isEmpty());
    }

    @Test public void emptyKnownLibraryCanStillDetectFirstNewPhoto() {
        var first = photo("first", "2026-11-11T10:00:00Z");
        assertEquals(Set.of("first"), store.reconcile("empty-pc", List.of(), true, List.of(first), 100));
    }

    private static AssetSummary photo(String id, String time) {
        return new AssetSummary(id, "photo", "ready", time, null, 1,
                100, 100, false, true, null, null, "2.11", "explicit");
    }
}
