package app.nikkisync.mobile.ui;

import android.content.Context;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;

import app.nikkisync.mobile.R;

/**
 * Shared styling helpers for the M2.3.2 gallery liquid-glass refresh.
 * Keeps GalleryAdapter focused on binding data while visual constants stay centralized.
 */
public final class GalleryUxStyle {
    private GalleryUxStyle() {}

    public static Drawable glassCard(Context context) {
        return context.getDrawable(R.drawable.bg_glass_card);
    }

    public static Drawable glassChip(Context context) {
        return context.getDrawable(R.drawable.bg_glass_chip);
    }

    public static Drawable glassButton(Context context) {
        GradientDrawable drawable = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{0x80FFFFFF, 0x45FFFFFF});
        float density = context.getResources().getDisplayMetrics().density;
        drawable.setCornerRadius(16*density);
        drawable.setStroke(Math.max(1,Math.round(density)), 0x99FFFFFF);
        return drawable;
    }

    public static GradientDrawable fallbackRound(int color, float radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(radius);
        return drawable;
    }
}
