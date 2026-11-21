package app.nikkisync.mobile.storage;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

/** Last-known canonical source metadata for offline Saved-photo details. */
public final class SavedMetadataSnapshotStore extends SQLiteOpenHelper {
    public record Snapshot(
            String assetId,
            String metadataJson,
            String capturedAt,
            String gameVersion,
            long updatedAt
    ) {}

    public SavedMetadataSnapshotStore(Context context) {
        super(context.getApplicationContext(), "nikkisync-saved-metadata.db", null, 1);
    }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("""
                CREATE TABLE snapshots (
                  asset_id TEXT PRIMARY KEY,
                  metadata_json TEXT NOT NULL,
                  captured_at TEXT,
                  game_version TEXT,
                  updated_at INTEGER NOT NULL
                )
                """);
    }

    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        throw new IllegalStateException("Unsupported saved metadata schema upgrade: " + oldVersion + " -> " + newVersion);
    }

    public synchronized void put(Snapshot snapshot) {
        if (snapshot == null) throw new IllegalArgumentException("snapshot is required");
        String assetId = clean(snapshot.assetId());
        String metadataJson = clean(snapshot.metadataJson());
        if (assetId == null) throw new IllegalArgumentException("assetId is required");
        if (metadataJson == null) throw new IllegalArgumentException("metadataJson is required");

        ContentValues values = new ContentValues();
        values.put("asset_id", assetId);
        values.put("metadata_json", metadataJson);
        putNullable(values, "captured_at", clean(snapshot.capturedAt()));
        putNullable(values, "game_version", clean(snapshot.gameVersion()));
        values.put("updated_at", Math.max(1L, snapshot.updatedAt()));
        getWritableDatabase().insertWithOnConflict(
                "snapshots",
                null,
                values,
                SQLiteDatabase.CONFLICT_REPLACE
        );
    }

    public synchronized Snapshot get(String assetId) {
        String normalized = clean(assetId);
        if (normalized == null) return null;
        try (Cursor cursor = getReadableDatabase().query(
                "snapshots",
                new String[]{"asset_id", "metadata_json", "captured_at", "game_version", "updated_at"},
                "asset_id = ?",
                new String[]{normalized},
                null,
                null,
                null,
                "1"
        )) {
            if (!cursor.moveToFirst()) return null;
            return new Snapshot(
                    cursor.getString(0),
                    cursor.getString(1),
                    nullable(cursor, 2),
                    nullable(cursor, 3),
                    cursor.getLong(4)
            );
        }
    }

    private static String nullable(Cursor cursor, int index) {
        return cursor.isNull(index) ? null : cursor.getString(index);
    }

    private static void putNullable(ContentValues values, String key, String value) {
        if (value == null) values.putNull(key);
        else values.put(key, value);
    }

    private static String clean(String value) {
        if (value == null) return null;
        String cleaned = value.trim();
        return cleaned.isEmpty() ? null : cleaned;
    }
}
