package app.nikkisync.mobile.storage;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** User-owned links between Saved source assets and retouched system-gallery images. */
public final class EditedVariantStore extends SQLiteOpenHelper {
    public enum LinkStatus { ADDED, DUPLICATE, CONFLICT }

    public record Variant(
            String variantId,
            String assetId,
            String uri,
            long linkedAt,
            String displayName,
            String mimeType,
            String sourceSavedUri
    ) {}

    public record LinkResult(LinkStatus status, Variant variant, String conflictingAssetId) {}

    public EditedVariantStore(Context context) {
        super(context.getApplicationContext(), "nikkisync-edited-variants.db", null, 2);
    }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("""
                CREATE TABLE edited_variants (
                  variant_id TEXT PRIMARY KEY,
                  asset_id TEXT NOT NULL,
                  uri TEXT NOT NULL UNIQUE,
                  linked_at INTEGER NOT NULL,
                  display_name TEXT,
                  mime_type TEXT,
                  source_saved_uri TEXT,
                  selected_uri TEXT
                )
                """);
        db.execSQL("CREATE INDEX edited_variants_asset_time ON edited_variants(asset_id, linked_at DESC)");
    }

    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if(oldVersion<2){db.execSQL("ALTER TABLE edited_variants ADD COLUMN selected_uri TEXT");
            db.execSQL("UPDATE edited_variants SET selected_uri = uri");}
    }

    public synchronized LinkResult link(
            String assetId,
            String sourceSavedUri,
            String uri,
            long linkedAt,
            String displayName,
            String mimeType
    ) {
        return linkSelected(assetId,sourceSavedUri,uri,uri,linkedAt,displayName,mimeType);
    }

    public synchronized LinkResult linkSelected(String assetId,String sourceSavedUri,String uri,String selectedUri,long linkedAt,String displayName,String mimeType) {
        String normalizedAsset = requireValue(assetId, "assetId");
        String normalizedUri = requireValue(uri, "uri");
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            Variant existing = findByUri(db, normalizedUri);
            if(existing==null)existing=findByUri(db,requireValue(selectedUri,"selectedUri"));
            if (existing != null) {
                LinkResult result = existing.assetId().equals(normalizedAsset)
                        ? new LinkResult(LinkStatus.DUPLICATE, existing, null)
                        : new LinkResult(LinkStatus.CONFLICT, existing, existing.assetId());
                db.setTransactionSuccessful();
                return result;
            }

            Variant variant = new Variant(
                    UUID.randomUUID().toString(),
                    normalizedAsset,
                    normalizedUri,
                    Math.max(1L, linkedAt),
                    clean(displayName),
                    clean(mimeType),
                    clean(sourceSavedUri)
            );
            ContentValues values = values(variant);
            values.put("selected_uri",requireValue(selectedUri,"selectedUri"));
            long inserted = db.insertOrThrow("edited_variants", null, values);
            if (inserted < 0) throw new IllegalStateException("Unable to persist edited variant");
            db.setTransactionSuccessful();
            return new LinkResult(LinkStatus.ADDED, variant, null);
        } finally {
            db.endTransaction();
        }
    }

    public synchronized List<Variant> loadAll() {
        return query(null, null, "linked_at DESC, variant_id ASC");
    }

    public synchronized List<Variant> loadForAsset(String assetId) {
        if (assetId == null || assetId.isBlank()) return List.of();
        return query("asset_id = ?", new String[]{assetId.trim()}, "linked_at DESC, variant_id ASC");
    }

    public synchronized Variant findByUri(String uri) {
        if (uri == null || uri.isBlank()) return null;
        return findByUri(getReadableDatabase(), uri.trim());
    }

    public synchronized boolean unlink(String variantId) {
        if (variantId == null || variantId.isBlank()) return false;
        return getWritableDatabase().delete(
                "edited_variants",
                "variant_id = ?",
                new String[]{variantId.trim()}
        ) > 0;
    }

    /** Re-linking an old selection upgrades its EXIF copy while preserving its source/variant identity. */
    public synchronized boolean replaceMedia(String variantId,String uri) {
        ContentValues values=new ContentValues();values.put("uri",requireValue(uri,"uri"));
        return getWritableDatabase().update("edited_variants",values,"variant_id = ?",new String[]{variantId})==1;
    }

    private List<Variant> query(String selection, String[] args, String orderBy) {
        List<Variant> result = new ArrayList<>();
        try (Cursor cursor = getReadableDatabase().query(
                "edited_variants",
                columns(),
                selection,
                args,
                null,
                null,
                orderBy
        )) {
            while (cursor.moveToNext()) result.add(read(cursor));
        }
        return List.copyOf(result);
    }

    private static Variant findByUri(SQLiteDatabase db, String uri) {
        try (Cursor cursor = db.query(
                "edited_variants",
                columns(),
                "uri = ? OR selected_uri = ?",
                new String[]{uri,uri},
                null,
                null,
                null,
                "1"
        )) {
            return cursor.moveToFirst() ? read(cursor) : null;
        }
    }

    private static String[] columns() {
        return new String[]{
                "variant_id",
                "asset_id",
                "uri",
                "linked_at",
                "display_name",
                "mime_type",
                "source_saved_uri"
        };
    }

    private static Variant read(Cursor cursor) {
        return new Variant(
                cursor.getString(0),
                cursor.getString(1),
                cursor.getString(2),
                cursor.getLong(3),
                nullable(cursor, 4),
                nullable(cursor, 5),
                nullable(cursor, 6)
        );
    }

    private static String nullable(Cursor cursor, int index) {
        return cursor.isNull(index) ? null : cursor.getString(index);
    }

    private static ContentValues values(Variant variant) {
        ContentValues values = new ContentValues();
        values.put("variant_id", variant.variantId());
        values.put("asset_id", variant.assetId());
        values.put("uri", variant.uri());
        values.put("linked_at", variant.linkedAt());
        putNullable(values, "display_name", variant.displayName());
        putNullable(values, "mime_type", variant.mimeType());
        putNullable(values, "source_saved_uri", variant.sourceSavedUri());
        return values;
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

    private static String requireValue(String value, String label) {
        String cleaned = clean(value);
        if (cleaned == null) throw new IllegalArgumentException(label + " is required");
        return cleaned;
    }
}
