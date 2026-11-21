package app.nikkisync.mobile.ui.chrome;
import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.*;
import android.view.View;

/** Double-buffered tiles. Displayed tiles are never eagerly recycled (RenderThread may retain them). */
public final class MonetBackgroundView extends View {
    private boolean photoMode;
    public void setPhotoMode(boolean photo){photoMode=photo;if(current!=null)currentShader=shader(current);if(next!=null)nextShader=shader(next);invalidate();}
    private Bitmap current,next;private float blend,flow;private ValueAnimator animation;
    private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG|Paint.FILTER_BITMAP_FLAG|Paint.DITHER_FLAG);
    private final Matrix matrix=new Matrix();private BitmapShader currentShader,nextShader;
    public MonetBackgroundView(Context context){super(context);setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);}
    public void transitionTo(Bitmap tile){
        if(tile==null || tile==current || tile.isRecycled())return;
        if(animation!=null){animation.removeAllListeners();animation.cancel();}
        if(next!=null){current=next;currentShader=nextShader;}
        if(current==null){current=tile;currentShader=shader(tile);next=null;nextShader=null;blend=0;invalidate();return;}
        next=tile;nextShader=shader(tile);blend=0;
        animation=ValueAnimator.ofFloat(0,1);animation.setDuration(280);
        animation.setInterpolator(new android.view.animation.PathInterpolator(.4f,0,.2f,1));
        animation.addUpdateListener(a->{blend=(float)a.getAnimatedValue();invalidate();});
        animation.addListener(new android.animation.AnimatorListenerAdapter(){@Override public void onAnimationEnd(android.animation.Animator a){current=next;currentShader=nextShader;next=null;nextShader=null;blend=0;invalidate();}});
        animation.start();
    }
    public void moveBy(int dy){flow=(flow+dy*.00020f)%1f;invalidate();}
    private BitmapShader shader(Bitmap b){Shader.TileMode mode=photoMode?Shader.TileMode.CLAMP:Shader.TileMode.REPEAT;return new BitmapShader(b,mode,mode);}
    @Override protected void onDraw(Canvas canvas){
        canvas.drawColor(0xffdedbd6);
        drawTile(canvas,current,currentShader,255);drawTile(canvas,next,nextShader,(int)(blend*255));
    }
    private void drawTile(Canvas canvas,Bitmap tile,BitmapShader shader,int alpha){
        if(tile==null || shader==null)return;
        matrix.setScale((photoMode?getWidth():1024f)/tile.getWidth(),(photoMode?getHeight():1024f)/tile.getHeight());if(!photoMode)matrix.postTranslate(0,flow*1024);
        shader.setLocalMatrix(matrix);paint.setShader(shader);paint.setAlpha(alpha);canvas.drawRect(0,0,getWidth(),getHeight(),paint);
    }
    @Override protected void onDetachedFromWindow(){
        if(animation!=null){animation.removeAllListeners();animation.cancel();}
        if(next!=null){current=next;currentShader=nextShader;next=null;nextShader=null;blend=0;}
        super.onDetachedFromWindow();
    }
}
