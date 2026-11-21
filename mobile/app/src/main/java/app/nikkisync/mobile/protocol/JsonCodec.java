package app.nikkisync.mobile.protocol;

import app.nikkisync.mobile.model.Models.AssetDetail;
import app.nikkisync.mobile.model.Models.AssetPage;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.model.Models.Change;
import app.nikkisync.mobile.model.Models.Changes;
import app.nikkisync.mobile.model.Models.ClothingSearchPhoto;
import app.nikkisync.mobile.model.Models.ClothingSearchResponse;
import app.nikkisync.mobile.model.Models.ClothingSearchResult;
import app.nikkisync.mobile.model.Models.MediaResource;
import app.nikkisync.mobile.model.Models.ProfileClothingStat;
import app.nikkisync.mobile.model.Models.ProfileDictionaryStatus;
import app.nikkisync.mobile.model.Models.ProfileStatsResponse;
import app.nikkisync.mobile.model.Models.ProfileSuitStat;
import app.nikkisync.mobile.model.Models.SuitSearchPart;
import app.nikkisync.mobile.model.Models.SuitSearchPhoto;
import app.nikkisync.mobile.model.Models.SuitSearchResponse;
import app.nikkisync.mobile.model.Models.SuitSearchResult;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public final class JsonCodec {
    private JsonCodec() {}

    public static AssetPage assetPage(String json) throws Exception {
        JSONObject root = new JSONObject(json);
        JSONArray rows = root.getJSONArray("items");
        List<AssetSummary> items = new ArrayList<>(rows.length());
        for (int i = 0; i < rows.length(); i++) items.add(assetSummary(rows.getJSONObject(i)));
        return new AssetPage(items, optionalString(root, "nextCursor"), root.getLong("libraryRevision"));
    }

    public static AssetDetail assetDetail(String json) throws Exception {
        JSONObject asset = new JSONObject(json).getJSONObject("asset");
        JSONArray rows = asset.getJSONArray("resources");
        List<MediaResource> resources = new ArrayList<>(rows.length());
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            resources.add(new MediaResource(
                    row.getString("resourceId"), row.getString("role"), row.getString("fileName"),
                    row.getString("mimeType"), row.getString("fileExt"), row.getLong("sizeBytes"),
                    row.getString("sha256"), optionalInt(row, "width"), optionalInt(row, "height"),
                    optionalLong(row, "durationMs")
            ));
        }
        JSONObject motion = asset.optJSONObject("motion");
        return new AssetDetail(asset.getString("assetId"), asset.getString("type"), asset.getString("state"),
                resources, motion != null,
                motion == null ? null : optionalString(motion, "stillResourceId"),
                motion == null ? null : optionalString(motion, "motionResourceId"),
                motion == null ? null : optionalLong(motion, "presentationTimestampUs"),
                asset.has("metadata") && !asset.isNull("metadata") ? asset.getJSONObject("metadata").toString() : null);
    }

    public static SuitSearchResponse suitSearch(String json) throws Exception {
        JSONObject root = new JSONObject(json);
        JSONArray rows = root.getJSONArray("items");
        List<SuitSearchResult> items = new ArrayList<>(rows.length());
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            JSONArray photoRows = row.getJSONArray("photos");
            List<SuitSearchPhoto> photos = new ArrayList<>(photoRows.length());
            for (int p = 0; p < photoRows.length(); p++) {
                JSONObject photo = photoRows.getJSONObject(p);
                JSONArray partRows = photo.getJSONArray("matchedParts");
                List<SuitSearchPart> parts = new ArrayList<>(partRows.length());
                for (int k = 0; k < partRows.length(); k++) {
                    JSONObject part = partRows.getJSONObject(k);
                    parts.add(new SuitSearchPart(
                            part.getString("clothingId"),
                            optionalString(part, "name"),
                            optionalString(part, "category")
                    ));
                }
                photos.add(new SuitSearchPhoto(assetSummary(photo.getJSONObject("asset")), parts));
            }
            items.add(new SuitSearchResult(
                    optionalString(row, "suitId"),
                    row.getString("suitName"),
                    row.getInt("observedPartCount"),
                    optionalInt(row, "totalPartCount"),
                    row.getInt("photoCount"),
                    photos
            ));
        }
        return new SuitSearchResponse(root.optString("query", ""), items);
    }

    public static ClothingSearchResponse clothingSearch(String json) throws Exception {
        JSONObject root = new JSONObject(json);
        JSONArray rows = root.getJSONArray("items");
        List<ClothingSearchResult> items = new ArrayList<>(rows.length());
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            JSONArray photoRows = row.getJSONArray("photos");
            List<ClothingSearchPhoto> photos = new ArrayList<>(photoRows.length());
            for (int p = 0; p < photoRows.length(); p++) {
                JSONObject photo = photoRows.getJSONObject(p);
                photos.add(new ClothingSearchPhoto(assetSummary(photo.getJSONObject("asset"))));
            }
            items.add(new ClothingSearchResult(
                    row.getString("clothingId"),
                    optionalString(row, "name"),
                    optionalString(row, "category"),
                    optionalString(row, "suitId"),
                    optionalString(row, "suitName"),
                    row.getInt("photoCount"),
                    photos
            ));
        }
        return new ClothingSearchResponse(root.optString("query", ""), items);
    }

    public static ProfileStatsResponse profileStats(String json) throws Exception {
        JSONObject root = new JSONObject(json);

        ProfileDictionaryStatus dictionary = null;
        JSONObject dictionaryRow = root.optJSONObject("dictionary");
        if (dictionaryRow != null) {
            dictionary = new ProfileDictionaryStatus(
                    dictionaryRow.getString("provider"),
                    dictionaryRow.getString("providerVersion"),
                    optionalString(dictionaryRow, "gameVersion"),
                    optionalString(dictionaryRow, "fetchedAt"),
                    dictionaryRow.optInt("clothingEntries", 0)
            );
        }

        JSONArray suitRows = root.getJSONArray("topSuits");
        List<ProfileSuitStat> topSuits = new ArrayList<>(suitRows.length());
        for (int i = 0; i < suitRows.length(); i++) {
            JSONObject row = suitRows.getJSONObject(i);
            topSuits.add(new ProfileSuitStat(
                    optionalString(row, "suitId"),
                    row.getString("suitName"),
                    row.getInt("photoCount")
            ));
        }

        JSONArray clothingRows = root.getJSONArray("topClothing");
        List<ProfileClothingStat> topClothing = new ArrayList<>(clothingRows.length());
        for (int i = 0; i < clothingRows.length(); i++) {
            JSONObject row = clothingRows.getJSONObject(i);
            topClothing.add(new ProfileClothingStat(
                    row.getString("clothingId"),
                    optionalString(row, "name"),
                    optionalString(row, "category"),
                    optionalString(row, "suitName"),
                    row.getInt("photoCount")
            ));
        }

        return new ProfileStatsResponse(
                root.getLong("libraryRevision"),
                dictionary,
                topSuits,
                topClothing
        );
    }

    public static Changes changes(String json) throws Exception {
        JSONObject root = new JSONObject(json);
        JSONArray rows = root.getJSONArray("changes");
        List<Change> items = new ArrayList<>(rows.length());
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            items.add(new Change(row.getLong("revision"), row.getString("type"), row.getString("assetId"),
                    row.getString("occurredAt")));
        }
        return new Changes(items, root.getLong("libraryRevision"), root.optBoolean("fullResyncRequired", false));
    }

    private static AssetSummary assetSummary(JSONObject row) throws Exception {
        String gameVersionSource = optionalString(row, "gameVersionSource");
        if (gameVersionSource == null || gameVersionSource.isBlank()) gameVersionSource = "unknown";
        return new AssetSummary(
                row.getString("assetId"),
                row.getString("type"),
                row.getString("state"),
                optionalString(row, "capturedAt"),
                optionalString(row, "uid"),
                row.getLong("revision"),
                optionalInt(row, "width"),
                optionalInt(row, "height"),
                row.optBoolean("hasMotion", false),
                row.optBoolean("hasMetadata", false),
                optionalString(row, "thumbnailResourceId"),
                optionalString(row, "previewResourceId"),
                optionalString(row, "gameVersion"),
                gameVersionSource,
                optionalString(row,"thumbnailSha256"), optionalString(row,"previewSha256"),
                optionalString(row,"fullPreviewResourceId"), optionalString(row,"fullPreviewSha256"),optionalString(row,"mediaFingerprint")
        ).withSource(optionalString(row,"sourcePath"),optionalString(row,"sourceFolder"),row.has("sizeBytes")&&!row.isNull("sizeBytes")?row.getLong("sizeBytes"):null);
    }

    private static String optionalString(JSONObject object, String key) {
        return object.has(key) && !object.isNull(key) ? object.optString(key, null) : null;
    }

    private static Integer optionalInt(JSONObject object, String key) {
        Object value = object.opt(key);
        return value instanceof Number ? ((Number) value).intValue() : null;
    }

    private static Long optionalLong(JSONObject object, String key) {
        Object value = object.opt(key);
        return value instanceof Number ? ((Number) value).longValue() : null;
    }
}
