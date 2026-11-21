package app.nikkisync.mobile.storage;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

public final class SavedPhotoCollection {
    private SavedPhotoCollection() {}

    public static List<SavedPhotoStore.Record> select(
            List<SavedPhotoStore.Record> source,
            int filter,
            int sortMode
    ) {
        List<SavedPhotoStore.Record> result = new ArrayList<>();
        for (SavedPhotoStore.Record item : source) {
            if (filter == SavedViewState.FILTER_MOTION && !item.hasMotion()) continue;
            if (filter == SavedViewState.FILTER_STILL && item.hasMotion()) continue;
            result.add(item);
        }

        if (sortMode == SavedViewState.SORT_CAPTURED) {
            result.sort(Comparator
                    .comparingLong(SavedPhotoCollection::captureTime)
                    .reversed()
                    .thenComparing(Comparator.comparingLong(SavedPhotoStore.Record::savedAt).reversed()));
        } else {
            result.sort(Comparator.comparingLong(SavedPhotoStore.Record::savedAt).reversed());
        }
        return result;
    }

    private static long captureTime(SavedPhotoStore.Record item) {
        String value = item.capturedAt();
        if (value == null || value.isBlank()) return Long.MIN_VALUE;
        try { return Instant.parse(value).toEpochMilli(); }
        catch (Exception ignored) { return Long.MIN_VALUE; }
    }
}
