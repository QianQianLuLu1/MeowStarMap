package app.nikkisync.mobile.ui.chrome;

import android.content.Context;
import android.graphics.*;
import android.view.View;

/** Overscan → Gaussian blur → independent destination-in mask; never captures controls. */
public final class ProgressiveTopBlurView extends View {
    private final ContentBackdrop backdrop;
    private final RenderNode blurred=new RenderNode("NikkiSync progressive blur");
    private final Paint mask=new Paint(Paint.ANTI_ALIAS_FLAG);
    private boolean scrolling;
    private float radiusDp=ChromeTokens.TOP_IDLE_BLUR_DP;
    private android.animation.ValueAnimator radiusAnimator;
    public ProgressiveTopBlurView(Context context,ContentBackdrop backdrop){
        super(context); this.backdrop=backdrop;
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        mask.setBlendMode(BlendMode.DST_IN);
    }
    public void setScrolling(boolean value){
        if(scrolling==value) return;
        scrolling=value;
        if(radiusAnimator!=null) radiusAnimator.cancel();
        radiusAnimator=android.animation.ValueAnimator.ofFloat(radiusDp,
                value?ChromeTokens.TOP_SCROLL_BLUR_DP:ChromeTokens.TOP_IDLE_BLUR_DP);
        radiusAnimator.setDuration(260);
        radiusAnimator.setInterpolator(new android.view.animation.PathInterpolator(.4f,0, .2f,1));
        radiusAnimator.addUpdateListener(animation->{radiusDp=(float)animation.getAnimatedValue();invalidate();});
        radiusAnimator.start();
    }
    @Override protected void onDraw(Canvas canvas){
        if(getWidth()==0 || getHeight()==0) return;
        float density=getResources().getDisplayMetrics().density;
        if(android.os.Build.VERSION.SDK_INT<31||!canvas.isHardwareAccelerated()){drawContrastVeil(canvas);return;}
        float radius=radiusDp*density;
        int overscan=(int)Math.ceil(radius*3), h=getHeight()+overscan;
        blurred.setPosition(0,0,getWidth(),getHeight()+overscan);
        RecordingCanvas recording=blurred.beginRecording(getWidth(),h);
        try {backdrop.draw(recording);} finally {blurred.endRecording();}
        blurred.setRenderEffect(RenderEffect.createBlurEffect(radius,radius,Shader.TileMode.CLAMP));
        int layer=canvas.saveLayer(0,0,getWidth(),getHeight(),null);
        canvas.drawRenderNode(blurred);
        mask.setShader(new LinearGradient(0,0,0,getHeight(),
                new int[]{0xffffffff,0xffffffff,0x94ffffff,0x24ffffff,0,0},
                new float[]{0,112f/300,178f/300,244f/300,286f/300,1},Shader.TileMode.CLAMP));
        canvas.drawRect(0,0,getWidth(),getHeight(),mask);
        canvas.restoreToCount(layer);
        drawContrastVeil(canvas);
    }
    private void drawContrastVeil(Canvas canvas){
        // Text stays dark across night/bright photos; the veil fades, it is not the blur substitute.
        Paint veil=new Paint(Paint.ANTI_ALIAS_FLAG);
        veil.setShader(new LinearGradient(0,0,0,getHeight(),new int[]{0xc7ffffff,0xb8ffffff,0x40ffffff,0,0},new float[]{0,112f/300,178f/300,286f/300,1},Shader.TileMode.CLAMP));
        canvas.drawRect(0,0,getWidth(),getHeight(),veil);
    }
    @Override protected void onDetachedFromWindow(){
        if(radiusAnimator!=null) radiusAnimator.cancel();
        radiusDp=scrolling?ChromeTokens.TOP_SCROLL_BLUR_DP:ChromeTokens.TOP_IDLE_BLUR_DP;
        blurred.discardDisplayList();super.onDetachedFromWindow();
    }
}
