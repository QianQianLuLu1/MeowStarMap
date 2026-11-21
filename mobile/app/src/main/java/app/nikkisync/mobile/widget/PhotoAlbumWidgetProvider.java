package app.nikkisync.mobile.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import android.widget.RemoteViews;
import app.nikkisync.mobile.MainActivity;
import app.nikkisync.mobile.R;
import app.nikkisync.mobile.privacy.PrivacyConsentStore;
import app.nikkisync.mobile.storage.SavedPhotoStore;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** Square frame. Wide frame shares the same local-only slideshow and renderer. */
public class PhotoAlbumWidgetProvider extends AppWidgetProvider {
    public static final String OPEN_PHOTO = "app.nikkisync.mobile.widget.OPEN_PHOTO";
    public static final String PHOTO_URI = "saved_photo_uri";
    private static final String NEXT = "app.nikkisync.mobile.widget.NEXT";
    private static final String REFRESH = "app.nikkisync.mobile.widget.REFRESH";
    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor();
    protected boolean wide() { return false; }

    @Override public void onReceive(Context context, Intent intent) {
        if (NEXT.equals(intent.getAction()) || REFRESH.equals(intent.getAction())) {
            int[] ids = NEXT.equals(intent.getAction())
                    ? new int[]{intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1)}
                    : AppWidgetManager.getInstance(context).getAppWidgetIds(new ComponentName(context, getClass()));
            submit(context, ids, NEXT.equals(intent.getAction()), false);
        } else super.onReceive(context, intent);
    }

    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        submit(context, ids, false, true);
    }
    @Override public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int id, Bundle options) {
        submit(context, new int[]{id}, false, false);
    }
    @Override public void onDeleted(Context context, int[] ids) {
        var state = new PhotoAlbumWidgetState(context);
        for (int id : ids) state.remove(id);
    }
    @Override public void onRestored(Context context, int[] oldIds, int[] newIds) {
        onDeleted(context, oldIds);
        // AppWidgetProvider dispatches onUpdate(newIds) immediately after this callback.
    }

    private void submit(Context context, int[] ids, boolean next, boolean timed) {
        Context app = context.getApplicationContext();
        PendingResult result = goAsync();
        AtomicBoolean finished = new AtomicBoolean();
        Handler handler = new Handler(Looper.getMainLooper());
        Runnable finish = () -> { if (finished.compareAndSet(false, true) && result != null) result.finish(); };
        long deadline = SystemClock.elapsedRealtime() + 8000;
        handler.postDelayed(finish, 9000);
        WORKER.execute(() -> {
            try {
                var manager = AppWidgetManager.getInstance(app);
                for (int id : ids) {
                    var info = manager.getAppWidgetInfo(id);
                    if (info == null || !info.provider.equals(new ComponentName(app, getClass()))) continue;
                    if (finished.get() || SystemClock.elapsedRealtime() >= deadline) break;
                    try { update(app, manager, id, next, timed, deadline); }
                    catch (RuntimeException ignored) { /* A removed/unavailable host must not crash the app. */ }
                }
            } finally { handler.removeCallbacks(finish); finish.run(); }
        });
    }

    /** Notify only existing widgets, so saving a photo adds no work for users without frames. */
    public static void refreshAll(Context context) {
        for (Class<?> provider : List.of(PhotoAlbumWidgetProvider.class, WidePhotoAlbumWidgetProvider.class)) {
            if (AppWidgetManager.getInstance(context).getAppWidgetIds(new ComponentName(context, provider)).length > 0)
                context.sendBroadcast(new Intent(context, provider).setAction(REFRESH));
        }
    }

    record Frame(Bitmap photo, String uri, int count, boolean consent) {}

    static Frame prepare(Context context, int id, boolean wide, long now, boolean next, boolean timed) {
        return prepare(context, id, wide, now, next, timed, SystemClock.elapsedRealtime() + 7000);
    }
    private static Frame prepare(Context context, int id, boolean wide, long now, boolean next, boolean timed, long deadline) {
        if (!new PrivacyConsentStore(context).accepted()) return new Frame(null, "", 0, false);
        var photos = new SavedPhotoStore(context).load();
        var uris = photos.stream().map(SavedPhotoStore.Record::uri).toList();
        var state = new PhotoAlbumWidgetState(context);
        int start = state.select(id, uris, now, next, timed);
        if (start >= 0) for (int offset = 0; offset < photos.size(); offset++) {
            if (SystemClock.elapsedRealtime() >= deadline) break;
            var record = photos.get((start + offset) % photos.size());
            try {
                Uri uri = record.mediaUri();
                if (!"content".equals(uri.getScheme()) && !"file".equals(uri.getScheme())) continue;
                Bitmap photo = WidgetPhotoDecoder.decode(context, uri);
                if (wide && photo.getHeight() > photo.getWidth()) { photo.recycle(); continue; }
                // Use the file's actual EXIF/pixels, not a second application of record.rotationDegrees().
                if (!new PrivacyConsentStore(context).accepted()) {
                    photo.recycle(); return new Frame(null, "", 0, false);
                }
                return new Frame(photo, record.uri(), photos.size(), true);
            } catch (Exception ignored) { /* Skip missing/revoked/corrupt media without changing history. */ }
        }
        return new Frame(null, "", 0, true);
    }

    private void update(Context context, AppWidgetManager manager, int id, boolean next, boolean timed, long deadline) {
        Frame frame = prepare(context, id, wide(), System.currentTimeMillis(), next, timed, deadline);
        Bundle options = manager.getAppWidgetOptions(id);
        float density = context.getResources().getDisplayMetrics().density;
        int width = Math.round(options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, wide() ? 280 : 140) * density);
        int height = Math.round(options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 140) * density);
        try {
            // Recheck consent immediately before publication, including withdrawal during decode.
            boolean consent = new PrivacyConsentStore(context).accepted();
            Bitmap rendered = PhotoAlbumWidgetRenderer.render(context, consent ? frame.photo() : null, wide(), width, height);
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.photo_album_widget);
            views.setImageViewBitmap(R.id.widget_photo, rendered);
            boolean hasPhoto = consent && frame.photo() != null;
            views.setViewVisibility(R.id.widget_empty, hasPhoto ? View.GONE : View.VISIBLE);
            views.setTextViewText(R.id.widget_empty, context.getString(consent ? (wide()?R.string.widget_no_landscape:R.string.widget_no_photos) : R.string.widget_needs_consent));
            Intent open = new Intent(context, MainActivity.class).setAction(OPEN_PHOTO)
                    .putExtra(PHOTO_URI, hasPhoto ? frame.uri() : "")
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent openIntent = PendingIntent.getActivity(context, id, open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            views.setOnClickPendingIntent(R.id.widget_photo, openIntent);
            views.setOnClickPendingIntent(R.id.widget_empty, openIntent);
            views.setContentDescription(R.id.widget_photo, context.getString(hasPhoto ? R.string.widget_open_photo : R.string.widget_open_saved));
            manager.updateAppWidget(id, views);
            if (hasPhoto) new PhotoAlbumWidgetState(context).displayed(id, frame.uri(), System.currentTimeMillis());
        } finally {
            if (frame.photo() != null) frame.photo().recycle();
            // RemoteViews retains its bitmap for serialization; do not recycle the published bitmap.
        }
    }

    static PendingIntent nextIntent(Context context, int id, Class<?> provider) {
        Intent intent = new Intent(context, provider).setAction(NEXT)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
        return PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
