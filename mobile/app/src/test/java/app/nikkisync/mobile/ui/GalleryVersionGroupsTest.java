package app.nikkisync.mobile.ui;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import app.nikkisync.mobile.model.Models.AssetSummary;

import org.junit.Test;

import java.util.List;
import java.util.Set;

public final class GalleryVersionGroupsTest {
    @Test public void versionGroupsFollowNewestServerOrderInsteadOfSemanticVersionOrder() {
        List<GalleryVersionGroups.Group> groups = GalleryVersionGroups.group(List.of(
                asset("unknown-newest", "2026-09-12T10:00:00.000Z", null, "unknown"),
                asset("v29", "2026-09-10T10:00:00.000Z", "2.9", "inferred"),
                asset("v28", "2026-08-10T10:00:00.000Z", "2.8", "inferred")
        ));

        assertEquals(3, groups.size());
        assertNull(groups.get(0).version());
        assertEquals("版本未知", groups.get(0).versionLabel());
        assertEquals("2.9", groups.get(1).version());
        assertEquals("2.8", groups.get(2).version());
    }

    @Test public void photosInsideVersionPreserveServerNewestFirstOrderEvenWithoutCapturedAt() {
        List<GalleryVersionGroups.Group> groups = GalleryVersionGroups.group(List.of(
                asset("z-newest-from-server", null, "2.9", "inferred"),
                asset("a-older-from-server", null, "2.9", "inferred"),
                asset("middle", "2026-08-30T10:00:00.000Z", "2.9", "inferred")
        ));

        assertEquals(
                List.of("z-newest-from-server", "a-older-from-server", "middle"),
                groups.get(0).items().stream().map(AssetSummary::assetId).toList()
        );
    }

    @Test public void inferredLabelOnlyAppliesWhenWholeVersionGroupIsInferred() {
        List<GalleryVersionGroups.Group> mixed = GalleryVersionGroups.group(List.of(
                asset("explicit", "2026-08-12T10:00:00.000Z", "2.9", "explicit"),
                asset("inferred", "2026-08-11T10:00:00.000Z", "2.9", "inferred")
        ));
        List<GalleryVersionGroups.Group> inferredOnly = GalleryVersionGroups.group(List.of(
                asset("a", "2026-08-12T10:00:00.000Z", "2.8", "inferred"),
                asset("b", "2026-08-11T10:00:00.000Z", "2.8", "inferred")
        ));

        assertFalse(mixed.get(0).inferred());
        assertTrue(inferredOnly.get(0).inferred());
    }

    @Test public void recentBatchIsFirstAndDoesNotRepeatInsideVersionSections() {
        var recent = asset("recent", "2026-11-11T10:00:00Z", "2.11", "explicit");
        var older = asset("older", "2026-11-10T10:00:00Z", "2.11", "explicit");
        var otherVersion = asset("other", "2026-10-01T10:00:00Z", "2.10", "explicit");
        var groups = GalleryVersionGroups.group(List.of(recent, older, otherVersion), Set.of("recent"));
        assertEquals("最近拍摄", groups.get(0).versionLabel());
        assertEquals(List.of("recent"), groups.get(0).items().stream().map(AssetSummary::assetId).toList());
        assertEquals(List.of("older"), groups.get(1).items().stream().map(AssetSummary::assetId).toList());
        assertEquals(List.of("other"), groups.get(2).items().stream().map(AssetSummary::assetId).toList());
    }

    private static AssetSummary asset(String id, String capturedAt, String version, String source) {
        return new AssetSummary(
                id, "photo", "ready", capturedAt, null, 1,
                100, 100, false, version != null,
                null, null, version, source
        );
    }
}
