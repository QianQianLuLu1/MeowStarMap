package app.nikkisync.mobile.widget;

import static org.junit.Assert.*;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProviderInfo;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.widget.ImageView;
import android.widget.RemoteViews;
import app.nikkisync.mobile.R;
import app.nikkisync.mobile.privacy.PrivacyConsentStore;
import app.nikkisync.mobile.storage.SavedPhotoStore;
import java.io.File;
import java.io.FileOutputStream;
import java.util.List;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = {30,31,32,35})
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public final class PhotoAlbumWidgetTest {
    private Context context;
    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("momo.photo.widgets", 0).edit().clear().commit();
        context.getSharedPreferences("nikkisync_saved_photos", 0).edit().clear().commit();
        context.getSharedPreferences("momo.privacy", 0).edit().clear().commit();
    }

    @Test public void portraitPhotoIsCompleteAndUndistortedInWideFrame() {
        Bitmap photo = Bitmap.createBitmap(80, 160, Bitmap.Config.ARGB_8888);
        photo.eraseColor(Color.BLUE);
        Bitmap rendered = PhotoAlbumWidgetRenderer.render(context, photo, true, 400, 200);
        assertEquals(Color.BLUE, rendered.getPixel(200, 100));
        assertNotEquals(Color.BLUE, rendered.getPixel(80, 100));
        assertEquals(0, Color.alpha(rendered.getPixel(0, 0)));
        assertEquals(Color.BLUE, rendered.getPixel(160, 15));
        assertNotEquals(Color.BLUE, rendered.getPixel(150, 100));
        assertEquals(2f, (float) rendered.getWidth() / rendered.getHeight(), .01f);
    }

    @Test public void landscapePhotoHasLetterboxAndThemeBorderInSquare() {
        Bitmap photo = Bitmap.createBitmap(160, 80, Bitmap.Config.ARGB_8888);
        photo.eraseColor(Color.BLUE);
        Bitmap rendered = PhotoAlbumWidgetRenderer.render(context, photo, false, 200, 400);
        assertEquals(rendered.getWidth(), rendered.getHeight());
        assertEquals(Color.BLUE, rendered.getPixel(100, 100));
        assertNotEquals(Color.BLUE, rendered.getPixel(100, 20));
        assertNotEquals(Color.BLUE, rendered.getPixel(1, 100));
        assertEquals(0, Color.alpha(rendered.getPixel(0, 0)));
        // RemoteViews parcels must stay bounded even for an oversized launcher allocation.
        Bitmap large = PhotoAlbumWidgetRenderer.render(context, photo, false, 2000, 2000);
        assertTrue(large.getByteCount() <= 3_000_000);
    }

    @Test public void rotationIsTimeBasedAndDoesNotJumpOnResizeOrLibraryRefresh() {
        var store = new PhotoAlbumWidgetState(context);
        var photos = List.of("content://media/a", "content://media/b", "content://media/c");
        assertEquals(0, store.select(7, photos, 1000, false, true));
        store.displayed(7, photos.get(0), 1000);
        assertEquals(0, store.select(7, photos, 1001, false, true));
        assertEquals(0, store.select(7, photos, 1_801_000, false, false));
        assertEquals(1, store.select(7, photos, 1_801_000, false, true));
        assertEquals(1, store.select(7, photos, 1001, true, false));
        assertEquals(0, store.select(8, photos, 1_801_000, false, true));
        store.displayed(7, photos.get(2), 1000);
        assertEquals(0, store.select(7, photos, 1001, true, false));
        assertEquals(0, store.select(7, List.of("content://media/a"), 1001, true, false));
        assertEquals(-1, store.select(7, List.of(), 1001, true, true));
    }

    @Test public void newPhotosDoNotResetCurrentPhotoAndDeletedPhotosRecover() {
        var store = new PhotoAlbumWidgetState(context);
        store.displayed(2, "content://media/b", 1000);
        assertEquals(2, store.select(2, List.of("content://media/new", "content://media/a", "content://media/b"), 2000, false, false));
        assertEquals(0, store.select(2, List.of("content://media/a"), 2000, false, false));
        store.remove(2);
        assertEquals("", store.current(2));
    }

    @Test public void launcherListsOnlyTwoFixedTemplatesWithNoConfigurationActivity() throws Exception {
        var providers = context.getPackageManager().queryBroadcastReceivers(
                new android.content.Intent(AppWidgetManager.ACTION_APPWIDGET_UPDATE).setPackage(context.getPackageName()),
                android.content.pm.PackageManager.GET_META_DATA);
        assertEquals(2, providers.size());
        for (var info : providers) {
            try (var xml = context.getResources().getXml(info.activityInfo.metaData.getInt("android.appwidget.provider"))) {
                while (xml.next() != org.xmlpull.v1.XmlPullParser.START_TAG) {}
                String ns = "http://schemas.android.com/apk/res/android";
                assertNull(xml.getAttributeValue(ns, "configure"));
                assertEquals(1_800_000, xml.getAttributeIntValue(ns, "updatePeriodMillis", 0));
                assertEquals(AppWidgetProviderInfo.RESIZE_NONE, xml.getAttributeIntValue(ns, "resizeMode", -1));
            }
        }
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.photo_album_widget);
        var root = views.apply(context, null);
        assertEquals(ImageView.ScaleType.FIT_CENTER, ((ImageView) root.findViewById(R.id.widget_photo)).getScaleType());
    }

    @Test public void missingMediaIsSkippedWithoutDeletingSavedHistory() throws Exception {
        new PrivacyConsentStore(context).accept();
        Uri good = image("good.png", Color.BLUE);
        savedRows("content://media/missing", good.toString());
        var frame = PhotoAlbumWidgetProvider.prepare(context, 12, false, 2000, false, true);
        assertEquals(good.toString(), frame.uri());
        assertNotNull(frame.photo());
        assertEquals(2, new SavedPhotoStore(context).load().size());
    }

    @Test public void noConsentClearsPhotoAndDoesNotReadSavedMedia() throws Exception {
        Uri good = image("private.png", Color.RED);
        savedRows(good.toString());
        var frame = PhotoAlbumWidgetProvider.prepare(context, 12, false, 2000, false, true);
        assertNull(frame.photo());
        assertEquals("", frame.uri());
        new PrivacyConsentStore(context).accept();
        frame = PhotoAlbumWidgetProvider.prepare(context, 12, false, 2000, false, true);
        assertNotNull(frame.photo());
        new PrivacyConsentStore(context).withdraw();
        assertNull(PhotoAlbumWidgetProvider.prepare(context, 12, false, 2001, false, true).photo());
    }

    @Test public void nextTapChangesOnlyItsOwnWidgetAndUsesImmutableIntent() throws Exception {
        int squareId = 7, wideId = 8;
        var nextSquare = PhotoAlbumWidgetProvider.nextIntent(context, squareId, PhotoAlbumWidgetProvider.class);
        var nextWide = PhotoAlbumWidgetProvider.nextIntent(context, wideId, WidePhotoAlbumWidgetProvider.class);
        assertNotEquals(nextSquare, nextWide);
        assertTrue((Shadows.shadowOf(nextSquare).getFlags() & android.app.PendingIntent.FLAG_IMMUTABLE) != 0);
        assertEquals(squareId, Shadows.shadowOf(nextSquare).getSavedIntent().getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1));
        assertEquals(WidePhotoAlbumWidgetProvider.class.getName(), Shadows.shadowOf(nextWide).getSavedIntent().getComponent().getClassName());
    }

    @Test public void receiverNextAndResizePublishRealViewsWithoutChangingOtherFrame() throws Exception {
        new PrivacyConsentStore(context).accept();
        Uri blue = image("blue.png", Color.BLUE), red = image("red.png", Color.RED);
        savedRows(blue.toString(), red.toString());
        var manager = AppWidgetManager.getInstance(context);
        var shadow = Shadows.shadowOf(manager);
        int squareId = shadow.createWidget(PhotoAlbumWidgetProvider.class, R.layout.photo_album_widget);
        int wideId = shadow.createWidget(WidePhotoAlbumWidgetProvider.class, R.layout.photo_album_widget);
        var squareInfo = new AppWidgetProviderInfo();
        squareInfo.provider = new android.content.ComponentName(context, PhotoAlbumWidgetProvider.class);
        shadow.putWidgetInfo(squareId, squareInfo);
        var wideInfo = new AppWidgetProviderInfo();
        wideInfo.provider = new android.content.ComponentName(context, WidePhotoAlbumWidgetProvider.class);
        shadow.putWidgetInfo(wideId, wideInfo);
        new PhotoAlbumWidgetProvider().onUpdate(context, manager, new int[]{squareId});
        new WidePhotoAlbumWidgetProvider().onUpdate(context, manager, new int[]{wideId});
        awaitWorker();
        assertEquals(blue.toString(), new PhotoAlbumWidgetState(context).current(squareId));
        var next = PhotoAlbumWidgetProvider.nextIntent(context, squareId, PhotoAlbumWidgetProvider.class);
        new PhotoAlbumWidgetProvider().onReceive(context, Shadows.shadowOf(next).getSavedIntent());
        awaitWorker();
        assertEquals(red.toString(), new PhotoAlbumWidgetState(context).current(squareId));
        assertEquals(blue.toString(), new PhotoAlbumWidgetState(context).current(wideId));
        new PhotoAlbumWidgetProvider().onAppWidgetOptionsChanged(context, manager, squareId, new Bundle());
        awaitWorker();
        assertEquals(red.toString(), new PhotoAlbumWidgetState(context).current(squareId));
        assertEquals(android.view.View.GONE, shadow.getViewFor(squareId).findViewById(R.id.widget_empty).getVisibility());
        var view = (ImageView) shadow.getViewFor(squareId).findViewById(R.id.widget_photo);
        assertEquals(ImageView.ScaleType.FIT_CENTER, view.getScaleType());
        // The receiver must reject a NEXT intent for a widget owned by the other template.
        new PhotoAlbumWidgetProvider().onReceive(context, Shadows.shadowOf(PhotoAlbumWidgetProvider.nextIntent(context, wideId, PhotoAlbumWidgetProvider.class)).getSavedIntent());
        awaitWorker();
        assertEquals(blue.toString(), new PhotoAlbumWidgetState(context).current(wideId));
    }

    @Test public void exifQuarterTurnAndMirrorPreserveActualPixelDirection() {
        Bitmap source = Bitmap.createBitmap(4, 2, Bitmap.Config.ARGB_8888);
        source.eraseColor(Color.BLUE); source.setPixel(0, 0, Color.RED);
        Bitmap rotated = WidgetPhotoDecoder.orient(source, 6);
        assertEquals(2, rotated.getWidth()); assertEquals(4, rotated.getHeight());
        assertEquals(Color.RED, rotated.getPixel(1, 0));
        Bitmap mirrored = WidgetPhotoDecoder.orient(rotated, 2);
        assertEquals(Color.RED, mirrored.getPixel(0, 0));
    }

    @Test public void saveChangesAndConsentChangesNotifyBothExistingTemplates() {
        var manager = AppWidgetManager.getInstance(context);
        for (Class<?> provider : List.of(PhotoAlbumWidgetProvider.class, WidePhotoAlbumWidgetProvider.class)) {
            var info = new AppWidgetProviderInfo(); info.provider = new android.content.ComponentName(context, provider);
            Shadows.shadowOf(manager).addBoundWidget(provider == PhotoAlbumWidgetProvider.class ? 21 : 22, info);
        }
        int before = Shadows.shadowOf((android.app.Application) context).getBroadcastIntents().size();
        new SavedPhotoStore(context).removeUri("content://missing");
        new PrivacyConsentStore(context).accept();
        new PrivacyConsentStore(context).withdraw();
        assertEquals(before + 6, Shadows.shadowOf((android.app.Application) context).getBroadcastIntents().size());
    }

    @Test public void renderPreviewUsingTheActualWidgetRenderer() throws Exception {
        Bitmap sample = Bitmap.createBitmap(480, 300, Bitmap.Config.ARGB_8888);
        var canvas = new android.graphics.Canvas(sample);
        var paint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
        paint.setShader(new android.graphics.LinearGradient(0, 0, 0, 300,
                new int[]{0xffdddaf1, 0xfff3d9e2, 0xffffe7cd}, null, android.graphics.Shader.TileMode.CLAMP));
        canvas.drawRect(0, 0, 480, 300, paint); paint.setShader(null);
        paint.setColor(0xffffefd6); canvas.drawCircle(365, 72, 30, paint);
        paint.setColor(0xffa6a0bf); canvas.drawOval(-60, 160, 390, 400, paint);
        paint.setColor(0xffc9b1be); canvas.drawOval(160, 190, 580, 380, paint);
        Bitmap preview = Bitmap.createBitmap(680, 410, Bitmap.Config.ARGB_8888);
        preview.eraseColor(0xffeeedf1);
        canvas = new android.graphics.Canvas(preview);
        paint.setColor(0xff62425a); paint.setTextSize(19);
        canvas.drawText("Square / 1:1", 30, 40, paint);
        canvas.drawText("Wide / 2:1", 260, 40, paint);
        canvas.drawBitmap(PhotoAlbumWidgetRenderer.render(context, sample, false, 200, 200), 30, 60, null);
        canvas.drawBitmap(PhotoAlbumWidgetRenderer.render(context, sample, true, 400, 200), 260, 60, null);
        paint.setTextSize(15);
        canvas.drawText("Fixed pink gradient border + rounded corners", 30, 310, paint);
        canvas.drawText("Full photo, original aspect ratio, no crop or stretching", 30, 340, paint);
        canvas.drawText("Illustration fixture; rendered by production code", 30, 380, paint);
        File output = new File("build/reports/photo-widgets/preview.png");
        assertTrue(output.getParentFile().isDirectory() || output.getParentFile().mkdirs());
        try (var stream = new FileOutputStream(output)) { assertTrue(preview.compress(Bitmap.CompressFormat.PNG, 100, stream)); }
    }

    private void awaitWorker() throws Exception {
        var field = PhotoAlbumWidgetProvider.class.getDeclaredField("WORKER"); field.setAccessible(true);
        ((java.util.concurrent.ExecutorService) field.get(null)).submit(() -> {}).get(10, java.util.concurrent.TimeUnit.SECONDS);
    }

    private Uri image(String name, int color) throws Exception {
        File file = new File(context.getCacheDir(), name);
        Bitmap bitmap = Bitmap.createBitmap(80, 40, Bitmap.Config.ARGB_8888);
        bitmap.eraseColor(color);
        try (var out = new FileOutputStream(file)) { bitmap.compress(Bitmap.CompressFormat.PNG, 100, out); }
        bitmap.recycle();
        // Android's serialized file URIs cannot represent a Windows drive on API 30-32.
        // Real saved media is accessed through a content provider, with a fresh stream per read.
        Uri uri = Uri.parse("content://momo.widget.fixture/" + name);
        Shadows.shadowOf(context.getContentResolver()).registerInputStreamSupplier(uri, () -> {
            try { return new java.io.FileInputStream(file); }
            catch (java.io.IOException error) { throw new java.io.UncheckedIOException(error); }
        });
        return uri;
    }

    private void savedRows(String... uris) throws Exception {
        var rows = new org.json.JSONArray();
        int i = 0;
        for (String uri : uris) rows.put(new org.json.JSONObject().put("assetId", "a" + i).put("uri", uri).put("savedAt", 1000 - i++));
        context.getSharedPreferences("nikkisync_saved_photos", 0).edit().putString("records", rows.toString()).commit();
    }
}
