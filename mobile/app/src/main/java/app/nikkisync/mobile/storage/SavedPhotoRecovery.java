package app.nikkisync.mobile.storage;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.MediaStore;

import app.nikkisync.mobile.model.Models.AssetDetail;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.model.Models.MediaResource;
import app.nikkisync.mobile.net.NikkiSyncClient;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

public final class SavedPhotoRecovery {
    public static final class Result {
        private final int recovered, scanned, skippedAmbiguous;

        public Result(int recovered, int scanned, int skippedAmbiguous) {
            this.recovered = recovered;
            this.scanned = scanned;
            this.skippedAmbiguous = skippedAmbiguous;
        }

        public int recovered() { return recovered; }
        public int scanned() { return scanned; }
        public int skippedAmbiguous() { return skippedAmbiguous; }
    }

    private record Candidate(
            AssetSummary asset,
            String displayName,
            String relativePath,
            String format,
            boolean motion
    ) {}

    private record MediaRow(Uri uri, String displayName, String relativePath, long savedAt) {}

    private SavedPhotoRecovery() {}

    public static Result recover(
            Context context,
            NikkiSyncClient client,
            List<AssetSummary> assets,
            SavedPhotoStore store
    ) throws Exception {
        List<MediaRow> rows = scanImages(context.getContentResolver());
        if (rows.isEmpty()) return new Result(0, 0, 0);
        List<Candidate> candidates = buildCandidates(client, assets);

        Map<String, List<Candidate>> candidatesByKey = new HashMap<>();
        for (Candidate candidate : candidates) {
            candidatesByKey.computeIfAbsent(key(candidate.displayName(), candidate.relativePath()), ignored -> new ArrayList<>())
                    .add(candidate);
        }

        Set<String> knownUris = new HashSet<>();
        for (SavedPhotoStore.Record record : store.load()) knownUris.add(record.uri());

        int recovered = 0;
        int ambiguous = 0;
        for (MediaRow row : rows) {
            if (knownUris.contains(row.uri().toString())) continue;
            List<Candidate> matches = candidatesByKey.get(key(row.displayName(), row.relativePath()));
            if (matches == null || matches.isEmpty()) continue;
            if (matches.size() != 1) {
                ambiguous++;
                continue;
            }

            Candidate match = matches.get(0);
            store.recordRecovered(
                    match.asset(),
                    row.uri(),
                    row.savedAt(),
                    match.format()
            );
            knownUris.add(row.uri().toString());
            recovered++;
        }
        return new Result(recovered, rows.size(), ambiguous);
    }

    private static List<Candidate> buildCandidates(NikkiSyncClient client, List<AssetSummary> assets) throws Exception {
        List<Candidate> result = new ArrayList<>();
        for (AssetSummary asset : assets) {
            AssetDetail detail;
            try {
                detail = client.asset(asset.assetId());
            } catch (Exception ignored) {
                continue;
            }
            MediaResource still = detail.originalStill();
            if (still == null || still.fileName() == null || still.fileName().isBlank()) continue;

            String original = still.fileName();
            if (!asset.hasMotion()) {
                result.add(new Candidate(asset, original, "Pictures/NikkiSync/", "历史原始照片", false));
                continue;
            }

            String base = original.replaceFirst("(?i)\\.(jpe?g)$", "");
            result.add(new Candidate(asset, motionName(original), "Pictures/NikkiSync/", "历史 Android Motion Photo", true));
            result.add(new Candidate(asset, base + "_OLIVE.jpg", "DCIM/Camera/", "历史 ColorOS O-Live", true));
            result.add(new Candidate(asset, "MV" + base + ".jpg", "DCIM/Camera/", "历史 Samsung Motion Photo", true));
            result.add(new Candidate(asset, base + "_HUAWEI.jpg", "DCIM/Camera/", "历史 Huawei 动态照片", true));
        }
        return result;
    }

    private static List<MediaRow> scanImages(ContentResolver resolver) {
        List<MediaRow> result = new ArrayList<>();
        String[] projection = {
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.RELATIVE_PATH,
                MediaStore.Images.Media.DATE_ADDED
        };
        String selection = MediaStore.Images.Media.RELATIVE_PATH + "=? OR (" +
                MediaStore.Images.Media.RELATIVE_PATH + "=? AND (" +
                MediaStore.Images.Media.DISPLAY_NAME + " GLOB ? OR " +
                MediaStore.Images.Media.DISPLAY_NAME + " GLOB ? OR " +
                MediaStore.Images.Media.DISPLAY_NAME + " GLOB ?))";
        String[] args = {
                "Pictures/NikkiSync/",
                "DCIM/Camera/",
                "*_OLIVE.jpg",
                "MV*.jpg",
                "*_HUAWEI.jpg"
        };

        try (Cursor cursor = resolver.query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                projection,
                selection,
                args,
                MediaStore.Images.Media.DATE_ADDED + " DESC"
        )) {
            if (cursor == null) return result;
            int idColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID);
            int nameColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME);
            int pathColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.RELATIVE_PATH);
            int dateColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED);

            while (cursor.moveToNext()) {
                long id = cursor.getLong(idColumn);
                String name = cursor.getString(nameColumn);
                String path = cursor.getString(pathColumn);
                long savedAt = cursor.getLong(dateColumn) * 1000L;
                if (name == null || path == null) continue;
                Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
                result.add(new MediaRow(uri, name, path, savedAt));
            }
        } catch (Exception ignored) {
            // Scoped-storage visibility can differ by Android vendor. Recovery is best-effort.
        }
        return result;
    }

    private static String motionName(String original) {
        String base = original == null ? "NikkiSync" : original.replaceFirst("(?i)\\.(jpe?g)$", "");
        if (!base.endsWith("MP")) base += "_MP";
        return base + ".jpg";
    }

    private static String key(String displayName, String relativePath) {
        return relativePath.toLowerCase(Locale.ROOT) + "\u0000" + displayName.toLowerCase(Locale.ROOT);
    }
}
