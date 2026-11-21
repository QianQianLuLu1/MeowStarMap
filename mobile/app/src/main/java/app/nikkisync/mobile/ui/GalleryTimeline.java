package app.nikkisync.mobile.ui;

import java.math.BigInteger;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/** Pure, non-destructive projection of gallery items. Version inference stays on the PC. */
public final class GalleryTimeline {
    public static final String ALL = "__all__";
    public static final String FAVORITES = "__favorites__";
    public static final String UNKNOWN = "__unknown__";

    public record Entry(String assetId, String capturedAt, String version) {}
    public record Section(String key, String title, String version, List<String> assetIds) {}
    private record Timed(Entry entry, long epoch, LocalDate date, String version) {}

    private GalleryTimeline() {}

    public static List<Section> group(List<Entry> entries, String filter, Map<String, Long> favorites,
            ZoneId zone, int year, Map<String, String> titles) {
        boolean favoriteMode = FAVORITES.equals(filter);
        String versionFilter = normalizeVersion(filter);
        Map<String, Timed> unique = new LinkedHashMap<>();
        for (Entry entry : entries) {
            if (entry == null || entry.assetId() == null || entry.assetId().isBlank()) continue;
            String version = normalizeVersion(entry.version());
            if (favoriteMode && !favorites.containsKey(entry.assetId())) continue;
            if (!favoriteMode && !ALL.equals(filter)
                    && !(UNKNOWN.equals(filter) ? version == null : versionFilter != null && versionFilter.equals(version))) continue;
            long epoch = favoriteMode ? favorites.get(entry.assetId()) : captureEpoch(entry.capturedAt(), zone);
            LocalDate date = null;
            try { if (epoch != Long.MIN_VALUE) date = Instant.ofEpochMilli(epoch).atZone(zone).toLocalDate(); }
            catch (DateTimeException ignored) { epoch = Long.MIN_VALUE; }
            unique.putIfAbsent(entry.assetId(), new Timed(entry, epoch, date, version));
        }
        List<Timed> ordered = new ArrayList<>(unique.values());
        ordered.sort(Comparator.comparingLong(Timed::epoch).reversed().thenComparing(t -> t.entry().assetId()));

        List<Section> result = new ArrayList<>();
        String previousKey = null, title = null, sectionVersion = null;
        List<String> ids = new ArrayList<>();
        for (Timed item : ordered) {
            String key = (item.date() == null ? UNKNOWN : item.date().toString())
                    + (favoriteMode ? "" : "|" + item.version());
            if (!key.equals(previousKey)) {
                if (!ids.isEmpty()) result.add(new Section(previousKey + "|" + ids.get(0), title, sectionVersion, List.copyOf(ids)));
                ids.clear();
                previousKey = key;
                sectionVersion = item.version();
                title = dayLabel(item.date(), year);
                if (favoriteMode) title += " 收藏";
                else if (item.version() == null) title += " 丨 版本未知";
                else {
                    title += " 丨 " + item.version() + "版本";
                    String name = titles.get(item.version());
                    if (name != null && !name.isBlank()) title += " " + name.trim();
                }
            }
            ids.add(item.entry().assetId());
        }
        if (!ids.isEmpty()) result.add(new Section(previousKey + "|" + ids.get(0), title, sectionVersion, List.copyOf(ids)));
        return List.copyOf(result);
    }

    public static List<String> versions(List<Entry> entries) {
        TreeSet<String> versions = new TreeSet<>((a, b) -> compareVersions(b, a));
        for (Entry entry : entries) {
            String version = normalizeVersion(entry.version());
            if (version != null) versions.add(version);
        }
        return List.copyOf(versions);
    }

    public static String normalizeVersion(String raw) {
        if (raw == null) return null;
        String value = raw.trim().replaceFirst("^[vV]\\s*", "");
        if (value.length() > 64 || !value.matches("[0-9]+(?:\\.[0-9]+)+")) return null;
        String[] parts = value.split("\\.");
        List<String> normalized = new ArrayList<>();
        for (String part : parts) normalized.add(new BigInteger(part).toString());
        while (normalized.size() > 2 && "0".equals(normalized.get(normalized.size() - 1))) normalized.remove(normalized.size() - 1);
        return String.join(".", normalized);
    }

    private static int compareVersions(String a, String b) {
        String[] left = a.split("\\."), right = b.split("\\.");
        for (int i = 0; i < Math.max(left.length, right.length); i++) {
            BigInteger l = i < left.length ? new BigInteger(left[i]) : BigInteger.ZERO;
            BigInteger r = i < right.length ? new BigInteger(right[i]) : BigInteger.ZERO;
            int difference = l.compareTo(r);
            if (difference != 0) return difference;
        }
        return 0;
    }

    private static long captureEpoch(String raw, ZoneId zone) {
        if (raw == null || raw.isBlank()) return Long.MIN_VALUE;
        String value = raw.trim();
        try { return Instant.parse(value).toEpochMilli(); } catch (DateTimeException | ArithmeticException ignored) {}
        try { return OffsetDateTime.parse(value).toInstant().toEpochMilli(); } catch (DateTimeException | ArithmeticException ignored) {}
        try { return LocalDateTime.parse(value.replace(' ', 'T')).atZone(zone).toInstant().toEpochMilli(); }
        catch (DateTimeException | ArithmeticException ignored) { return Long.MIN_VALUE; }
    }

    private static String dayLabel(LocalDate date, int currentYear) {
        if (date == null) return "日期未知";
        return (date.getYear() == currentYear ? "" : date.getYear() + "年")
                + date.getMonthValue() + "月" + date.getDayOfMonth() + "日";
    }
}
