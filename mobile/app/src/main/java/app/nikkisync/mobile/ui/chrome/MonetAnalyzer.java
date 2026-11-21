package app.nikkisync.mobile.ui.chrome;

import android.graphics.Bitmap;
import android.graphics.Color;
import java.util.*;

/** Area/tone histogram for atmosphere, separate weighted local contrast histogram for accents. */
public final class MonetAnalyzer {
    private MonetAnalyzer(){}
    private static final class Bucket {
        double weight,hx,hy,s,v;
        void add(float[] hsv,double w){weight+=w;hx+=Math.cos(Math.toRadians(hsv[0]))*w;hy+=Math.sin(Math.toRadians(hsv[0]))*w;s+=hsv[1]*w;v+=hsv[2]*w;}
        float[] hsv(){return new float[]{(float)((Math.toDegrees(Math.atan2(hy,hx))+360)%360),(float)(s/weight),(float)(v/weight)};}
    }
    public static MonetPalette analyze(Bitmap bitmap){
        if(bitmap==null || bitmap.isRecycled()) return new MonetPalette(List.of(0xff777777,0xff888888),List.of(),0);
        Bucket[] bg=new Bucket[23],accent=new Bucket[23];for(int i=0;i<23;i++){bg[i]=new Bucket();accent[i]=new Bucket();}
        long hash=0xcbf29ce484222325L;int count=0,dark=0,bright=0;double luminance=0;
        int sx=Math.max(1,(int)Math.ceil(bitmap.getWidth()/96.0)),sy=Math.max(1,(int)Math.ceil(bitmap.getHeight()/96.0));
        float[] hsv=new float[3];
        for(int y=0;y<bitmap.getHeight();y+=sy)for(int x=0;x<bitmap.getWidth();x+=sx){
            int c=bitmap.getPixel(x,y);if(Color.alpha(c)<180)continue;
            hash=(hash^Color.red(c))*0x100000001b3L;hash=(hash^Color.green(c))*0x100000001b3L;hash=(hash^Color.blue(c))*0x100000001b3L;
            Color.colorToHSV(c,hsv);float l=luma(c);luminance+=l;count++;if(l<.34)dark++;if(l>.78)bright++;
            float right=luma(bitmap.getPixel(Math.min(bitmap.getWidth()-1,x+sx),y));
            float down=luma(bitmap.getPixel(x,Math.min(bitmap.getHeight()-1,y+sy)));
            float contrast=(Math.abs(l-right)+Math.abs(l-down))*.5f;
            int slot=hsv[1]<.11?18+Math.min(4,(int)(hsv[2]*5)):Math.min(17,(int)(hsv[0]/20));
            float tone=l<.05?.58f:l<.18?.90f:l<.58?1.18f:l<.78?1.02f:l<.90?.62f:.30f;
            bg[slot].add(hsv,tone*(.92+hsv[1]*.18)*(1-Math.min(.55,contrast)*.38));
            float highlight=l>.93 && hsv[1]<.08?.58f:l>.62?1.28f:l>.42?1.10f:.88f;
            accent[slot].add(hsv,highlight*(.58+hsv[1]*1.28)*(.82+Math.min(.55,contrast)*1.35));
        }
        if(count==0)return new MonetPalette(List.of(0xff777777,0xff888888),List.of(),hash);
        float darkRatio=dark/(float)count,mood=clamp((float)(luminance/count)-darkRatio*.10f+bright/(float)count*.04f,.08f,.92f);
        return new MonetPalette(select(bg,mood,false),select(accent,mood,true),hash,mood,darkRatio);
    }
    private static List<Integer> select(Bucket[] buckets,float mood,boolean accent){
        List<Bucket> ranked=new ArrayList<>(Arrays.asList(buckets));ranked.removeIf(b->b.weight<=0);
        ranked.sort(Comparator.comparingDouble((Bucket b)->b.weight).reversed());
        List<Integer> result=new ArrayList<>();List<Float> hues=new ArrayList<>();
        for(Bucket bucket:ranked){
            float[] h=bucket.hsv();if(accent && h[1]<.13)continue;
            boolean duplicate=false;for(float hue:hues){float diff=Math.abs(hue-h[0]);if(Math.min(diff,360-diff)<18 && h[1]>=.11)duplicate=true;}
            if(duplicate)continue;if(h[1]>=.11)hues.add(h[0]);
            float floor=mood<.28?.16f:mood<.40?.20f:mood<.58?.28f:mood<.72?.38f:.48f;
            float ceiling=mood<.28?.48f:mood<.40?.58f:mood<.58?.72f:mood<.72?.82f:.90f;
            h[2]=accent?Math.min(.92f,Math.max(h[2]*.72f+mood*.28f,mood<.28?.56f:mood<.4?.60f:mood<.58?.64f:mood<.72?.68f:.72f)):
                    clamp(h[2]*.46f+mood*.54f,floor,ceiling);
            h[1]=h[1]<.11?Math.min(.07f,h[1]*.55f):accent?clamp(h[1]*.96f,.16f,.62f):clamp(h[1]*.82f,.08f,.46f);
            result.add(Color.HSVToColor(h));if(result.size()==6)break;
        }
        if(!accent && result.size()==1)result.add(result.get(0));
        return result;
    }
    private static float luma(int c){return (Color.red(c)*.2126f+Color.green(c)*.7152f+Color.blue(c)*.0722f)/255;}
    static float clamp(float x,float lo,float hi){return Math.max(lo,Math.min(hi,x));}
}
