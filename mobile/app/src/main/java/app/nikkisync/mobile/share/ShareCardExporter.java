package app.nikkisync.mobile.share;
import static app.nikkisync.mobile.share.ShareCardLayout.EFFECT_ICON_SIZE;
import static app.nikkisync.mobile.share.ShareCardLayout.EFFECT_LINE_HEIGHT;
import static app.nikkisync.mobile.share.ShareCardLayout.EFFECT_ROW_GAP;
import static app.nikkisync.mobile.share.ShareCardLayout.EFFECT_TEXT_SIZE;

import android.graphics.*;
import java.util.Map;

/** Same geometry and colors as the mini-program; each page is rendered independently. */
public final class ShareCardExporter {
    public static final int WIDTH=1440;
    private static final int INK=0xFFFFF8F0, PINK=0xFFF6BCC0;
    private static final int EFFECT_ICON_X=708, EFFECT_ICON_INSET=2;
    private static final int EFFECT_TEXT_X=EFFECT_ICON_X+EFFECT_ICON_SIZE+20;
    private ShareCardExporter() {}
    static Bitmap render(Bitmap background,ShareCardPayload payload) {
        return renderPage(background,payload,ShareCardLayout.pages(payload).get(0),0,1,Map.of());
    }
    static Bitmap renderPage(Bitmap background,ShareCardPayload payload,ShareCardLayout.Page page,int index,int total,Map<String,Bitmap> icons) {
        int height=page.height(); Bitmap output=Bitmap.createBitmap(WIDTH,height,Bitmap.Config.ARGB_8888);
        Canvas canvas=new Canvas(output);
        try {
            if(background==null) {
                Paint fill=new Paint();fill.setShader(new LinearGradient(0,0,WIDTH,height,0xFFC985AA,0xFFFFEAC3,Shader.TileMode.CLAMP));
                canvas.drawRect(0,0,WIDTH,height,fill);
            } else {
                float scale=Math.max(WIDTH/(float)background.getWidth(),height/(float)background.getHeight());
                float w=background.getWidth()*scale,h=background.getHeight()*scale;
                canvas.drawBitmap(background,null,new RectF((WIDTH-w)/2,(height-h)/2,(WIDTH+w)/2,(height+h)/2),paint(0,0xFFFFFFFF));
            }
            canvas.drawColor(0x7A221C26);
            fitted(canvas,payload.branding().title(),60,98,48,INK,1320);
            String date=payload.capturedAt()==null||payload.capturedAt().isBlank()?"无限暖暖摄影":payload.capturedAt().split("T")[0];
            text(canvas,date+(payload.gameVersion()==null||payload.gameVersion().isBlank()?"":" · "+payload.gameVersion()),60,146,25,0xCCFFF8F0);
            rounded(canvas,60,170,96,4,2,PINK);
            panel(canvas,60,440,height);panel(canvas,536,844,height);
            text(canvas,"穿搭",90,272,30,INK);text(canvas,"拍摄参数",570,272,30,INK);
            for(var part:page.outfit()) {
                float x=86+part.column()*200,y=310+part.y();
                rounded(canvas,x,y,178,178,18,0x1FFFF8F0);
                Bitmap icon=icons.get(part.item().clothingId());
                if(icon!=null) {
                    float scale=Math.min(162f/icon.getWidth(),162f/icon.getHeight()),w=icon.getWidth()*scale,h=icon.getHeight()*scale;
                    canvas.drawBitmap(icon,null,new RectF(x+(178-w)/2,y+(178-h)/2,x+(178+w)/2,y+(178+h)/2),paint(0,0xFFFFFFFF));
                } else centered(canvas,"图标暂缺",x+89,y+96,20,0x99FFF8F0);
                for(int n=0;n<part.lines().size();n++) centered(canvas,part.lines().get(n),x+89,y+208+n*29,23,INK);
            }
            if(page.outfit().isEmpty()) text(canvas,"暂无穿搭数据",90,360,24,0xA6FFF8F0);
            float y=348;boolean firstEffect=true;
            for(var row:page.parameters()) {
                if(row.effect()) {
                    if(firstEffect) {line(canvas,570,y-22,1346,y-22,0x80FFF8F0);y+=16;firstEffect=false;}
                    float centerX=EFFECT_ICON_X+EFFECT_ICON_SIZE/2f;
                    float centerY=y+(row.height()-EFFECT_ROW_GAP)/2f;
                    float top=centerY-EFFECT_ICON_SIZE/2f;
                    text(canvas,row.label(),574,centerY+10,28,0xDBFFF8F0);
                    RectF badge=new RectF(EFFECT_ICON_X,top,EFFECT_ICON_X+EFFECT_ICON_SIZE,top+EFFECT_ICON_SIZE);
                    canvas.drawRoundRect(badge,16,16,paint(0,0x26F6BCC0));
                    Paint border=paint(0,0x8CF6BCC0);border.setStyle(Paint.Style.STROKE);border.setStrokeWidth(1);
                    canvas.drawRoundRect(badge,16,16,border);
                    Bitmap icon=icons.get("effect:"+ShareCardPayload.effectKind(row.label()));
                    if(icon!=null) {
                        float size=EFFECT_ICON_SIZE-2*EFFECT_ICON_INSET;
                        float scale=Math.min(size/icon.getWidth(),size/icon.getHeight());
                        float w=icon.getWidth()*scale,h=icon.getHeight()*scale;
                        canvas.drawBitmap(icon,null,new RectF(centerX-w/2,centerY-h/2,centerX+w/2,centerY+h/2),paint(0,0xFFFFFFFF));
                    } else centered(canvas,row.label().substring(0,1),centerX,centerY+11,EFFECT_TEXT_SIZE,PINK);
                    float baseline=centerY+11-(row.lines().size()-1)*EFFECT_LINE_HEIGHT/2f;
                    for(int n=0;n<row.lines().size();n++)
                        text(canvas,row.lines().get(n),EFFECT_TEXT_X,baseline+n*EFFECT_LINE_HEIGHT,EFFECT_TEXT_SIZE,INK);
                    y+=row.height();continue;
                }
                String label=switch(row.label()) {case "焦距","光圈","晕影" -> row.label()+"调节";case "柔光" -> "柔光强度";default -> row.label();};
                int color=row.missing()?0x6BFFF8F0:INK;
                text(canvas,label,570,y,29,color);
                rounded(canvas,748,y-18,374,10,5,row.missing()?0x29FFF8F0:0x80FFF8F0);
                if(row.ratio()!=null) {
                    float x=748+(float)(374*row.ratio());
                    canvas.drawCircle(x,y-13,25,paint(0,0x33F6BCC0));canvas.drawCircle(x,y-13,18,paint(0,INK));
                }
                Paint value=paint(29,color);float measured=value.measureText(row.displayValue());
                if(measured>196) value.setTextSize(29*196/measured);
                canvas.drawText(row.displayValue(),1150,y,value);
                y+=row.height();if(row.label().equals("光圈")) line(canvas,570,y-40,1346,y-40,0x5CFFF8F0);
            }
            fitted(canvas,payload.branding().footer()+(total>1?" · "+(index+1)+" / "+total:""),60,height-26,20,0xB3FFF8F0,1320);
            return output;
        } catch(RuntimeException|Error error) {output.recycle();throw error;}
    }
    private static void fitted(Canvas canvas,String value,float x,float y,float size,int color,float width){
        Paint p=paint(size,color);String display=android.text.TextUtils.ellipsize(value,new android.text.TextPaint(p),width,android.text.TextUtils.TruncateAt.END).toString();canvas.drawText(display,x,y,p);
    }
    private static void panel(Canvas canvas,float x,float width,int height) {
        RectF rect=new RectF(x,218,x+width,height-66);canvas.drawRoundRect(rect,22,22,paint(0,0x29F4E0E8));
        Paint stroke=paint(0,0x85FFF8F0);stroke.setStyle(Paint.Style.STROKE);stroke.setStrokeWidth(2);
        canvas.drawRoundRect(rect,22,22,stroke);
    }
    private static Paint paint(float size,int color) {
        Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG|Paint.FILTER_BITMAP_FLAG);
        paint.setColor(color);paint.setTextSize(size);return paint;
    }
    private static void text(Canvas c,String s,float x,float y,float size,int color) {c.drawText(s,x,y,paint(size,color));}
    private static void centered(Canvas c,String s,float x,float y,float size,int color) {Paint p=paint(size,color);p.setTextAlign(Paint.Align.CENTER);c.drawText(s,x,y,p);}
    private static void rounded(Canvas c,float x,float y,float w,float h,float r,int color) {c.drawRoundRect(new RectF(x,y,x+w,y+h),r,r,paint(0,color));}
    private static void line(Canvas c,float x,float y,float x2,float y2,int color) {c.drawLine(x,y,x2,y2,paint(0,color));}
}
