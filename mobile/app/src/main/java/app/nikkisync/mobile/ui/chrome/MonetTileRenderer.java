package app.nikkisync.mobile.ui.chrome;
import android.graphics.*;
import java.util.*;

public final class MonetTileRenderer {
    static int polishRootAmbient(int color){
        float[] hsv=new float[3];Color.colorToHSV(color,hsv);
        hsv[1]=hsv[1]<.08f?Math.min(.055f,hsv[1]*.45f):Math.max(.20f,Math.min(.54f,hsv[1]*1.28f+.055f));
        hsv[2]=Math.max(.64f,Math.min(.90f,hsv[2]*.46f+.48f));return Color.HSVToColor(hsv);
    }
    private MonetTileRenderer(){}
    public static Bitmap renderRoot(List<MonetPalette> palettes){
        List<Integer> colors=new ArrayList<>();for(MonetPalette p:palettes)for(int i=0;i<Math.min(2,p.atmosphere().size()) && colors.size()<6;i++)colors.add(p.atmosphere().get(i));
        if(colors.isEmpty())colors.addAll(List.of(0xffaaaaaa,0xff888888));
        // Avoid order-dependent 8-bit rounding where wrapped copies overlap at tile borders.
        Bitmap out=Bitmap.createBitmap(1024,1024,Bitmap.Config.RGBA_F16);Canvas canvas=new Canvas(out);
        // Root UI uses a light neutral substrate as PhotoLayout does; photo mood remains in the fields.
        canvas.drawColor(0xffeeeae5);Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG|Paint.DITHER_FLAG);
        float[][] anchors={{.10f,.84f},{.84f,.14f},{.73f,.76f},{.18f,.26f},{.48f,.50f},{.93f,.50f}};
        float[] radii={.72f,.81f,.90f};
        for(int i=0;i<colors.size();i++)for(int dy=-1;dy<=1;dy++)for(int dx=-1;dx<=1;dx++){
            int c=polishRootAmbient(colors.get(i));paint.setShader(new RadialGradient((anchors[i][0]+dx)*1024,(anchors[i][1]+dy)*1024,radii[i%3]*1024,
                    new int[]{alpha(c,.62f),alpha(c,.34f),alpha(c,.11f),alpha(c,0)},new float[]{0,.46f,.76f,1},Shader.TileMode.CLAMP));
            canvas.drawRect(0,0,1024,1024,paint);
        }
        Bitmap tile=out.copy(Bitmap.Config.ARGB_8888,false);out.recycle();return tile;
    }
    public static Bitmap renderPhoto(MonetPalette palette){
        List<Integer> colors=new ArrayList<>(palette.atmosphere().subList(0,Math.min(3,palette.atmosphere().size())));
        if(colors.isEmpty())colors.add(0xff777777);while(colors.size()<3)colors.add(colors.get(0));
        for(int c:palette.accents())if(colors.size()<5)colors.add(c);while(colors.size()<5)colors.add(colors.get(0));
        colors.add(0xff11131d);
        Bitmap out=Bitmap.createBitmap(1024,1024,Bitmap.Config.ARGB_8888);Canvas canvas=new Canvas(out);
        canvas.drawColor(mix(mix(colors.get(2),colors.get(0),.34f),0xff11131d,palette.mood()<.28?.16f:palette.mood()<.42?.11f:palette.mood()<.62?.07f:.03f));
        float[][] anchors={{.16f,.8f},{.76f,.82f},{.1f,.34f},{.56f,.48f},{.86f,.34f},{.94f,.08f}};
        float[] radius={.76f,.63f,.68f,.58f,.44f,.92f};
        float accent=palette.darkRatio()>.7?.52f:palette.darkRatio()>.52?.46f:.38f;
        float[] opacity={.50f,.42f,.32f,accent,accent*.72f,.30f};
        int[][] salts={{11,17},{23,29},{31,37},{41,47},{53,59},{0,0}};
        Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG|Paint.DITHER_FLAG);
        for(int i=0;i<6;i++){
            float x=anchors[i][0]+(i==5?0:jitter(palette.sourceHash(),salts[i][0])*.045f);
            float y=anchors[i][1]+(i==5?0:jitter(palette.sourceHash(),salts[i][1])*.045f);
            paint.setShader(new RadialGradient(x*1024,y*1024,radius[i]*1024,new int[]{alpha(colors.get(i),opacity[i]),alpha(colors.get(i),0)},null,Shader.TileMode.CLAMP));
            canvas.drawRect(0,0,1024,1024,paint);
        }
        return out;
    }
    private static float jitter(long hash,int salt){long v=hash^(salt*-7046029254386353131L);v^=v>>>33;v*=-49064778989728563L;v^=v>>>33;return ((v>>>1)%10001)/10000f*2-1;}
    private static int alpha(int c,float a){return ((int)(a*255)<<24)|(c&0xffffff);}
    private static int mix(int a,int b,float t){return Color.rgb((int)(Color.red(a)+(Color.red(b)-Color.red(a))*t),(int)(Color.green(a)+(Color.green(b)-Color.green(a))*t),(int)(Color.blue(a)+(Color.blue(b)-Color.blue(a))*t));}
}
