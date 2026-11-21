package app.nikkisync.mobile.ui;

/** Shared fade stops. Mask is applied after blur; the final 5% is deliberately transparent. */
public final class GalleryGlassGeometry {
    private static final float[] POSITIONS = {0f, .36f, .59f, .81f, .95f, 1f};
    private static final float[] ALPHAS = {1f, 1f, .58f, .14f, 0f, 0f};
    private GalleryGlassGeometry() {}
    public static float[] positions() { return POSITIONS.clone(); }
    public static float alphaAt(float position) {
        if (position <= 0) return 1;
        if (position >= 1) return 0;
        for (int i = 1; i < POSITIONS.length; i++) {
            if (position <= POSITIONS[i]) {
                float fraction = (position - POSITIONS[i - 1]) / (POSITIONS[i] - POSITIONS[i - 1]);
                return ALPHAS[i - 1] + fraction * (ALPHAS[i] - ALPHAS[i - 1]);
            }
        }
        return 0;
    }
    public static float overscan(float radius) { return Math.max(0, radius) * 3f; }
}
