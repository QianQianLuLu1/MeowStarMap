package app.nikkisync.mobile.ui.chrome;

/** PhotoLayout UI_REPLICATION_TOKENS, dp; exported-image rendering is separate. */
public final class ChromeTokens {
    private ChromeTokens() {}
    public static final float DOCK_HEIGHT_DP = 68, DOCK_MARGIN_DP = 18;
    public static final float TOP_HEIGHT_DP = 210, TOP_IDLE_BLUR_DP = 31.2f, TOP_SCROLL_BLUR_DP = 21.8f;
    public static float topMaskAlpha(float yDp) {
        float[] positions = {0,78.4f,124.6f,170.8f,200.2f,210};
        float[] alpha = {1,1,.58f,.14f,0,0};
        if (yDp <= 0) return 1;
        for (int i=1;i<positions.length;i++) if(yDp<=positions[i]) {
            float p=(yDp-positions[i-1])/(positions[i]-positions[i-1]);
            return alpha[i-1]+p*(alpha[i]-alpha[i-1]);
        }
        return 0;
    }
}
