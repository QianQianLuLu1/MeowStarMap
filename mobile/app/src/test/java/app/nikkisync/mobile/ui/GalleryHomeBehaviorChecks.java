package app.nikkisync.mobile.ui;

import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;

/** Also runnable without Android/JUnit so the same assertions can be verified offline. */
public final class GalleryHomeBehaviorChecks {
    private static int checks;
    private static final ZoneId ZONE = ZoneId.of("Asia/Singapore");
    private static final Map<String, String> TITLES = Map.of("2.9", "向晴空绽放");

    public static void main(String[] args) { run(); }

    public static void run() {
        checks = 0;
        var a = entry("a", "2026-09-01T13:00:00Z", "2.9");
        var b = entry("b", "2026-08-31T17:00:00Z", "v2.9");
        var c = entry("c", "2026-08-31T12:00:00Z", "2.8");
        var source = List.of(c, b, a);
        var groups = GalleryTimeline.group(source, GalleryTimeline.ALL, Map.of(), ZONE, 2026, TITLES);
        equal(2, groups.size(), "calendar days must be grouped in the display timezone");
        equal(List.of("a", "b"), groups.get(0).assetIds(), "capture instants must sort newest first");
        equal("9月1日 丨 2.9版本 向晴空绽放", groups.get(0).title(), "date/version/title heading");
        equal("8月31日 丨 2.8版本", groups.get(1).title(), "unknown titles must not be fabricated");
        equal("c", source.get(0).assetId(), "projection must not mutate the library");

        var mixed = GalleryTimeline.group(List.of(a,
                entry("x", "2026-09-01T12:00:00Z", "2.8"),
                entry("y", "2026-09-01T11:00:00Z", "2.9")), GalleryTimeline.ALL, Map.of(), ZONE, 2026, TITLES);
        equal(List.of("a", "x", "y"), mixed.stream().flatMap(g -> g.assetIds().stream()).toList(),
                "day/version headings must never reorder interleaved explicit versions");

        var filtered = GalleryTimeline.group(source, "2.8", Map.of(), ZONE, 2026, TITLES);
        equal(List.of("c"), filtered.get(0).assetIds(), "version filter must not include other versions");
        equal(List.of("2.10", "2.9", "2.8"), GalleryTimeline.versions(List.of(a, c,
                entry("v", null, "2.10"), entry("dupe", null, "2.9.0"))), "numeric version ordering and aliases");

        var unknown = GalleryTimeline.group(List.of(entry("bad", "invalid", null), a),
                GalleryTimeline.ALL, Map.of(), ZONE, 2026, TITLES);
        equal("日期未知 丨 版本未知", unknown.get(1).title(), "invalid capture time stays last and explicit");
        var crossYear = GalleryTimeline.group(List.of(entry("old", "2025-08-31T17:00:00Z", "2.0")),
                GalleryTimeline.ALL, Map.of(), ZONE, 2026, TITLES);
        equal("2025年9月1日 丨 2.0版本", crossYear.get(0).title(), "cross-year headings include year");

        long today = Instant.parse("2026-09-15T01:00:00Z").toEpochMilli();
        long yesterday = Instant.parse("2026-09-14T01:00:00Z").toEpochMilli();
        var favorites = Map.of("c", today, "a", yesterday, "b", today + 1);
        var fg = GalleryTimeline.group(source, GalleryTimeline.FAVORITES, favorites, ZONE, 2026, TITLES);
        equal("9月15日 收藏", fg.get(0).title(), "favorites group by favorite date, not capture date");
        equal(List.of("b", "c"), fg.get(0).assetIds(), "same-day favorites mix versions and sort by favorite instant");
        equal(List.of(), GalleryTimeline.group(source, GalleryTimeline.FAVORITES, Map.of(), ZONE, 2026, TITLES),
                "empty favorites must not display the whole library");

        var start = Map.of("a", yesterday);
        var added = FavoriteSelection.apply(start, List.of("a", "b", "b"), today);
        equal(yesterday, added.get("a"), "mixed favorite add preserves existing time");
        equal(today, added.get("b"), "new favorites use action timestamp");
        equal(2, added.size(), "duplicate selected IDs do not create duplicates");
        equal(1, start.size(), "favorite action does not mutate its input snapshot");
        equal(Map.of(), FavoriteSelection.apply(added, List.of("a", "b"), today + 1),
                "all-favorite selection removes favorite flags only");
        equal(start, FavoriteSelection.apply(start, List.of(), today), "empty selection is a no-op");
        var removed = FavoriteSelection.apply(start, List.of("a"), today);
        equal(today + 10, FavoriteSelection.apply(removed, List.of("a"), today + 10).get("a"),
                "remove and re-add creates a new favorite time");
        equal(false, FavoriteSelection.allFavorited(start, List.of()), "no vacuous remove action on empty selection");

        equal(0f, GalleryGlassGeometry.alphaAt(1f), "blur edge must finish completely transparent");
        equal(1f, GalleryGlassGeometry.alphaAt(0f), "status-bar backdrop must stay fully sampled");
        float previous = 1;
        for (int i = 0; i <= 100; i++) {
            float alpha = GalleryGlassGeometry.alphaAt(i / 100f);
            if (alpha > previous || alpha < 0 || alpha > 1) throw new AssertionError("non-monotonic blur fade");
            previous = alpha;
        }
        checks++;
        equal(90f, GalleryGlassGeometry.overscan(30f), "blur kernel bottom overscan");
        System.out.println("Gallery home behavior: " + checks + " checks PASS");
    }

    private static GalleryTimeline.Entry entry(String id, String captured, String version) {
        return new GalleryTimeline.Entry(id, captured, version);
    }
    private static void equal(Object expected, Object actual, String label) {
        if (!expected.equals(actual)) throw new AssertionError(label + ": expected=" + expected + " actual=" + actual);
        checks++;
    }
}
