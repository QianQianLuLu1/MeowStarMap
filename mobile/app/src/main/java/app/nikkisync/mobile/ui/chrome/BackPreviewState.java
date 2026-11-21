package app.nikkisync.mobile.ui.chrome;

public final class BackPreviewState {
    public enum Kind { PAGE, SHEET }
    public record Frame(float x,float y,float scale,float previousBlurDp) {}
    private BackPreviewState() {}
    public static Frame frame(Kind kind,float progress,float width,float height) {
        float p=Float.isFinite(progress)?Math.max(0,Math.min(1,progress)):0;
        return kind==Kind.PAGE?new Frame(width*p,0,1,18*(1-p)):new Frame(0,height*.5f*p,1,0);
    }
}
