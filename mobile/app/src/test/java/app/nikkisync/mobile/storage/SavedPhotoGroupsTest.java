package app.nikkisync.mobile.storage;

import static org.junit.Assert.*;

import java.util.List;

import org.junit.Test;

public final class SavedPhotoGroupsTest {
    @Test public void sameAssetIsOneContiguousGroupWithOriginalsBeforeEdits() {
        var originals = List.of(
                original("asset-a", "content://original/new", 3000L, true, "2026-09-18T00:00:00Z"),
                original("asset-a", "content://original/old", 1000L, true, "2026-09-18T00:00:00Z"));
        var edits = List.of(
                edit("e1", "asset-a", "content://edit/1", 5000L),
                edit("e2", "asset-a", "content://edit/2", 4000L));

        var groups = SavedPhotoGroups.select(originals, edits, SavedViewState.FILTER_ALL, SavedViewState.SORT_SAVED);
        assertEquals(1, groups.size());
        assertEquals(List.of(
                SavedPhotoGroups.MemberKind.ORIGINAL,
                SavedPhotoGroups.MemberKind.ORIGINAL,
                SavedPhotoGroups.MemberKind.EDITED,
                SavedPhotoGroups.MemberKind.EDITED
        ), groups.get(0).members().stream().map(SavedPhotoGroups.Member::kind).toList());
        assertEquals("content://original/new", groups.get(0).members().get(0).uri());
        assertEquals("content://edit/1", groups.get(0).members().get(2).uri());
    }

    @Test public void newlyLinkedEditMovesGroupToTopForRecentActivity() {
        var originals = List.of(
                original("asset-a", "content://original/a", 1000L, false, "2026-09-17T00:00:00Z"),
                original("asset-b", "content://original/b", 8000L, false, "2026-09-18T00:00:00Z"));
        var edits = List.of(edit("e1", "asset-a", "content://edit/a", 9000L));

        var groups = SavedPhotoGroups.select(originals, edits, SavedViewState.FILTER_ALL, SavedViewState.SORT_SAVED);
        assertEquals("asset-a", groups.get(0).assetId());
        assertEquals(9000L, groups.get(0).activityAt());
    }

    @Test public void liveFilterUsesSourceOriginalTypeNotEditedMimeType() {
        var originals = List.of(original("live", "content://original/live", 1000L, true, "2026-09-18T00:00:00Z"));
        var edits = List.of(edit("e1", "live", "content://edit/flattened.jpg", 2000L));

        var motion = SavedPhotoGroups.select(originals, edits, SavedViewState.FILTER_MOTION, SavedViewState.SORT_SAVED);
        var still = SavedPhotoGroups.select(originals, edits, SavedViewState.FILTER_STILL, SavedViewState.SORT_SAVED);

        assertEquals(1, motion.size());
        assertEquals(2, motion.get(0).members().size());
        assertTrue(still.isEmpty());
    }

    @Test public void groupSurvivesMissingOriginalWhenVariantExists() {
        var groups = SavedPhotoGroups.select(
                List.of(),
                List.of(edit("e1", "missing-source", "content://edit/orphaned-original", 5000L)),
                SavedViewState.FILTER_ALL,
                SavedViewState.SORT_SAVED);

        assertEquals(1, groups.size());
        assertEquals("missing-source", groups.get(0).assetId());
        assertEquals(SavedPhotoGroups.MemberKind.EDITED, groups.get(0).members().get(0).kind());
    }

    @Test public void captureSortUsesSourceCaptureTimeAndKeepsGroupMembersTogether() {
        var originals = List.of(
                original("older", "content://original/older", 9000L, false, "2026-09-17T00:00:00Z"),
                original("newer", "content://original/newer", 1000L, false, "2026-09-19T00:00:00Z"));
        var edits = List.of(edit("e1", "older", "content://edit/older", 10000L));

        var groups = SavedPhotoGroups.select(originals, edits, SavedViewState.FILTER_ALL, SavedViewState.SORT_CAPTURED);
        assertEquals(List.of("newer", "older"), groups.stream().map(SavedPhotoGroups.Group::assetId).toList());
        assertEquals(2, groups.get(1).members().size());
    }

    private static SavedPhotoStore.Record original(
            String assetId, String uri, long savedAt, boolean motion, String capturedAt) {
        return new SavedPhotoStore.Record(assetId, uri, savedAt, motion, 0, capturedAt, "2.9", "原始照片");
    }

    private static EditedVariantStore.Variant edit(String variantId, String assetId, String uri, long linkedAt) {
        return new EditedVariantStore.Variant(
                variantId, assetId, uri, linkedAt, null, "image/jpeg", "content://original/" + assetId);
    }
}
