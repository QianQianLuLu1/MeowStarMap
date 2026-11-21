package app.nikkisync.mobile.storage;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.util.Log;

import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.ui.FavoriteSelection;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Local user-owned favorites. This repository never touches source media or MediaStore. */
public final class FavoritePhotoStore extends SQLiteOpenHelper {
    public record Snapshot(Map<String, Long> times, List<AssetSummary> assets) {
        public static Snapshot empty() { return new Snapshot(Map.of(), List.of()); }
    }
    public record Change(Snapshot snapshot, int count, boolean removed) {}

    public FavoritePhotoStore(Context context) {
        super(context.getApplicationContext(), "nikkisync-favorites.db", null, 1);
    }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE favorites (server_id TEXT NOT NULL, asset_id TEXT NOT NULL, "
                + "favorited_at INTEGER NOT NULL, summary_json TEXT NOT NULL, "
                + "PRIMARY KEY(server_id, asset_id))");
        db.execSQL("CREATE INDEX favorites_chronology ON favorites(server_id, favorited_at DESC)");
    }

    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        throw new IllegalStateException("Unsupported favorites schema upgrade: " + oldVersion + " -> " + newVersion);
    }

    public synchronized Snapshot load(String serverId) {
        if (serverId == null || serverId.isBlank()) return Snapshot.empty();
        return read(getReadableDatabase(), serverId);
    }

    /** Must run on a worker thread. Duplicate adds keep their original timestamp. */
    public synchronized Change changeSelection(String serverId, List<AssetSummary> selected, long now) throws Exception {
        if (serverId == null || serverId.isBlank()) throw new IllegalArgumentException("A paired PC identity is required");
        Map<String, AssetSummary> unique = new LinkedHashMap<>();
        for (AssetSummary asset : selected) {
            if (asset != null && asset.assetId() != null && !asset.assetId().isBlank()) unique.put(asset.assetId(), asset);
        }
        SQLiteDatabase db = getWritableDatabase();
        boolean removed;
        int count = 0;
        db.beginTransaction();
        try {
            Snapshot before = read(db, serverId);
            List<String> ids = new ArrayList<>(unique.keySet());
            removed = FavoriteSelection.allFavorited(before.times(), ids);
            Map<String, Long> nextTimes = FavoriteSelection.apply(before.times(), ids, Math.max(1L, now));
            for (AssetSummary asset : unique.values()) {
                if (removed) {
                    count += db.delete("favorites", "server_id = ? AND asset_id = ?", new String[]{serverId, asset.assetId()});
                } else {
                    ContentValues values = new ContentValues();
                    values.put("server_id", serverId);
                    values.put("asset_id", asset.assetId());
                    values.put("favorited_at", nextTimes.get(asset.assetId()));
                    values.put("summary_json", encode(asset).toString());
                    if (db.insertWithOnConflict("favorites", null, values, SQLiteDatabase.CONFLICT_IGNORE) != -1) count++;
                    // Refresh metadata for an existing favorite without touching favorited_at.
                    ContentValues summary = new ContentValues();
                    summary.put("summary_json", encode(asset).toString());
                    db.update("favorites", summary, "server_id = ? AND asset_id = ?", new String[]{serverId, asset.assetId()});
                }
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        return new Change(read(db, serverId), count, removed);
    }

    private static Snapshot read(SQLiteDatabase db, String serverId) {
        Map<String, Long> times = new LinkedHashMap<>();
        List<AssetSummary> assets = new ArrayList<>();
        try (Cursor cursor = db.query("favorites", new String[]{"asset_id", "favorited_at", "summary_json"},
                "server_id = ?", new String[]{serverId}, null, null, "favorited_at DESC, asset_id ASC")) {
            while (cursor.moveToNext()) {
                String id = cursor.getString(0);
                long time = cursor.getLong(1);
                try {
                    AssetSummary asset = decode(new JSONObject(cursor.getString(2)));
                    if (!id.equals(asset.assetId())) throw new IllegalArgumentException("Favorite identity mismatch");
                    times.put(id, time);
                    assets.add(asset);
                } catch (Exception ignored) {
                    // Keep the database row so an incompatible/corrupt snapshot is never silently deleted.
                    Log.w("FavoritePhotoStore", "An unreadable favorite snapshot was retained");
                }
            }
        }
        return new Snapshot(Map.copyOf(times), List.copyOf(assets));
    }

    static JSONObject encode(AssetSummary asset) throws Exception {
        JSONObject row = new JSONObject();
        row.put("assetId", asset.assetId());
        row.put("type", asset.type()); row.put("state", asset.state());
        row.put("capturedAt", asset.capturedAt()); row.put("uid", asset.uid());
        row.put("revision", asset.revision()); row.put("width", asset.width()); row.put("height", asset.height());
        row.put("hasMotion", asset.hasMotion()); row.put("hasMetadata", asset.hasMetadata());
        row.put("thumbnailResourceId", asset.thumbnailResourceId()); row.put("previewResourceId", asset.previewResourceId());
        row.put("gameVersion", asset.gameVersion()); row.put("gameVersionSource", asset.gameVersionSource());
        row.put("thumbnailSha256",asset.thumbnailSha256());row.put("previewSha256",asset.previewSha256());
        row.put("fullPreviewResourceId",asset.fullPreviewResourceId());row.put("fullPreviewSha256",asset.fullPreviewSha256());
        row.put("mediaFingerprint",asset.mediaFingerprint());
        row.put("sourcePath",asset.sourcePath());row.put("sourceFolder",asset.sourceFolder());row.put("sizeBytes",asset.sizeBytes());
        return row;
    }

    static AssetSummary decode(JSONObject row) throws Exception {
        return new AssetSummary(row.getString("assetId"), row.getString("type"), row.getString("state"),
                optional(row, "capturedAt"), optional(row, "uid"), row.optLong("revision", 0),
                number(row, "width"), number(row, "height"), row.optBoolean("hasMotion", false),
                row.optBoolean("hasMetadata", false), optional(row, "thumbnailResourceId"), optional(row, "previewResourceId"),
                optional(row, "gameVersion"), row.optString("gameVersionSource", "unknown"),
                optional(row,"thumbnailSha256"),optional(row,"previewSha256"),
                optional(row,"fullPreviewResourceId"),optional(row,"fullPreviewSha256"),optional(row,"mediaFingerprint")).withSource(optional(row,"sourcePath"),optional(row,"sourceFolder"),row.has("sizeBytes")&&!row.isNull("sizeBytes")?row.getLong("sizeBytes"):null);
    }

    private static String optional(JSONObject row, String key) {
        return !row.has(key) || row.isNull(key) ? null : row.optString(key, null);
    }
    private static Integer number(JSONObject row, String key) {
        return !row.has(key) || row.isNull(key) ? null : row.optInt(key);
    }
}
