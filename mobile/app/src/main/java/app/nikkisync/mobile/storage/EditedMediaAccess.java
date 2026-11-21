package app.nikkisync.mobile.storage;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

/** Reads user-selected edited media metadata without broad gallery permission or file mutation. */
public final class EditedMediaAccess {
    public record Info(String uri, String displayName, String mimeType, boolean persistGranted) {}

    interface ResolverOps {
        void persist(Uri uri);
        String displayName(Uri uri);
        String mimeType(Uri uri);
    }

    private EditedMediaAccess() {}

    public static Info describeAndPersist(Context context, Uri uri) {
        if (context == null) throw new IllegalArgumentException("context is required");
        ContentResolver resolver = context.getContentResolver();
        return describeAndPersist(new ResolverOps() {
            @Override public void persist(Uri value) {
                resolver.takePersistableUriPermission(value, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            }

            @Override public String displayName(Uri value) {
                try (Cursor cursor = resolver.query(
                        value,
                        new String[]{OpenableColumns.DISPLAY_NAME},
                        null,
                        null,
                        null
                )) {
                    if (cursor == null || !cursor.moveToFirst()) return null;
                    int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    return index < 0 || cursor.isNull(index) ? null : clean(cursor.getString(index));
                } catch (Exception ignored) {
                    return null;
                }
            }

            @Override public String mimeType(Uri value) {
                try {
                    return clean(resolver.getType(value));
                } catch (Exception ignored) {
                    return null;
                }
            }
        }, uri);
    }

    static Info describeAndPersist(ResolverOps ops, Uri uri) {
        if (ops == null) throw new IllegalArgumentException("resolver ops are required");
        if (uri == null) throw new IllegalArgumentException("uri is required");
        boolean persisted = true;
        try {
            ops.persist(uri);
        } catch (SecurityException | UnsupportedOperationException ignored) {
            persisted = false;
        }
        return new Info(
                uri.toString(),
                clean(ops.displayName(uri)),
                clean(ops.mimeType(uri)),
                persisted
        );
    }

    private static String clean(String value) {
        if (value == null) return null;
        String cleaned = value.trim();
        return cleaned.isEmpty() ? null : cleaned;
    }
}
