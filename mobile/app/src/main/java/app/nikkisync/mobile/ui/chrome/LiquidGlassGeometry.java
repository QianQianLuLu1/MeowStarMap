package app.nikkisync.mobile.ui.chrome;

public final class LiquidGlassGeometry {
    private LiquidGlassGeometry(){}
    public static float edgeWeight(float x,float y,float width,float height,float radius,float band){
        float qx=Math.abs(x-width/2)-(width/2-radius), qy=Math.abs(y-height/2)-(height/2-radius);
        float sd=(float)Math.hypot(Math.max(qx,0),Math.max(qy,0))+Math.min(Math.max(qx,qy),0)-radius;
        return sd>0 || band<=0 ? 0 : Math.max(0,1+sd/band);
    }
}
