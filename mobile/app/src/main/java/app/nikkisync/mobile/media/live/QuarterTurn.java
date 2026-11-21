package app.nikkisync.mobile.media.live;

/** User rotation is clockwise and relative to the media's already displayed orientation. */
public final class QuarterTurn {
    private QuarterTurn() {}
    public static int normalize(int degrees) {
        if (degrees % 90 != 0) throw new IllegalArgumentException("Live 旋转仅支持 90° 的整数倍");
        return Math.floorMod(degrees, 360);
    }
    public static int counterClockwise(int degrees) { return Math.floorMod(-normalize(degrees),360); }
    public static int outputWidth(int width,int height,int degrees) {
        if (width <= 0 || height <= 0) throw new IllegalArgumentException("无效视频尺寸");
        return normalize(degrees) % 180 == 0 ? width : height;
    }
    public static int outputHeight(int width,int height,int degrees) { return outputWidth(height,width,degrees); }
}