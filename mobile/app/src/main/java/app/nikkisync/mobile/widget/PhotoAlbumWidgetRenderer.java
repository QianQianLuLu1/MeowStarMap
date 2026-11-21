package app.nikkisync.mobile.widget;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;
import app.nikkisync.mobile.R;

/** Fixed 1:1 / 2:1 frames. All photo pixels are fitted, never cropped or stretched. */
final class PhotoAlbumWidgetRenderer {
    private static final int MAX_PIXELS = 750_000;
    private PhotoAlbumWidgetRenderer() {}

    static Bitmap render(Context context, Bitmap photo, boolean wide, int availableWidth, int availableHeight) {
        float ratio = wide ? 2f : 1f;
        float width = Math.max(1, Math.min(Math.max(1, availableWidth), Math.max(1, availableHeight) * ratio));
        float height = width / ratio;
        float reduction = Math.min(1f, (float) Math.sqrt(MAX_PIXELS / (width * height)));
        int w = Math.max(1, (int) (width * reduction)), h = Math.max(1, (int) (height * reduction));
        Bitmap bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        float dp = context.getResources().getDisplayMetrics().density * reduction;
        float border = Math.max(1, Math.min(2 * dp, Math.min(w, h) / 8f));
        float radius = Math.min(18 * dp, Math.min(w, h) / 4f);
        paint.setShader(new LinearGradient(0, 0, w, h,
                new int[]{context.getColor(R.color.primary_action), context.getColor(R.color.brand),
                        context.getColor(R.color.background_top)}, null, Shader.TileMode.CLAMP));
        canvas.drawRoundRect(new RectF(0, 0, w, h), radius, radius, paint);
        RectF inside = new RectF(border, border, w - border, h - border);
        float innerRadius = Math.max(0, radius - border);
        Path clip = new Path(); clip.addRoundRect(inside, innerRadius, innerRadius, Path.Direction.CW);
        canvas.save(); canvas.clipPath(clip);
        // Reuse the application's pink/peach ambient gradient for any letterboxing.
        paint.setShader(new LinearGradient(0, 0, 0, h,
                new int[]{context.getColor(R.color.background_top), context.getColor(R.color.background_middle),
                        context.getColor(R.color.app_background)}, null, Shader.TileMode.CLAMP));
        canvas.drawRect(inside, paint);
        paint.setShader(null);
        if (photo != null && !photo.isRecycled()) {
            float scale = Math.min(inside.width() / photo.getWidth(), inside.height() / photo.getHeight());
            float photoWidth = photo.getWidth() * scale, photoHeight = photo.getHeight() * scale;
            RectF destination = new RectF(inside.centerX() - photoWidth / 2, inside.centerY() - photoHeight / 2,
                    inside.centerX() + photoWidth / 2, inside.centerY() + photoHeight / 2);
            canvas.drawBitmap(photo, null, destination, paint);
        }
        canvas.restore();
        return bitmap;
    }
}
