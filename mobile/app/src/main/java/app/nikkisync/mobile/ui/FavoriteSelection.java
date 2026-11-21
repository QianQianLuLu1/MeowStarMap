package app.nikkisync.mobile.ui;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Batch semantics: mixed selection adds only missing favorites; all-favorite selection removes. */
public final class FavoriteSelection {
    private FavoriteSelection() {}
    public static boolean allFavorited(Map<String, Long> current, List<String> ids) {
        Set<String> selected = validIds(ids);
        return !selected.isEmpty() && current.keySet().containsAll(selected);
    }
    public static Map<String, Long> apply(Map<String, Long> current, List<String> ids, long now) {
        Map<String, Long> next = new LinkedHashMap<>(current);
        boolean remove = allFavorited(current, ids);
        for (String id : validIds(ids)) {
            if (remove) next.remove(id);
            else next.putIfAbsent(id, now);
        }
        return Map.copyOf(next);
    }
    private static Set<String> validIds(List<String> ids) {
        Set<String> result = new LinkedHashSet<>();
        for (String id : ids) if (id != null && !id.isBlank()) result.add(id);
        return result;
    }
}
