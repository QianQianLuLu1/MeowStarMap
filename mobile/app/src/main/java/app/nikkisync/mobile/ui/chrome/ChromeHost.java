package app.nikkisync.mobile.ui.chrome;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.FrameLayout;

/** Content is the only backdrop source. Neither effects nor controls can capture themselves. */
public final class ChromeHost extends FrameLayout {
    private final FrameLayout content, effects, controls;
    private ContentBackdrop backdrop;
    private ProgressiveTopBlurView topBlur;
    private int insetTop, insetBottom, insetLeft, insetRight;
    private View top, bottom;
    private boolean headerOnlyBlur;
    private View[] scrolling = new View[0];
    public ChromeHost(Context context) {
        super(context);
        content = new FrameLayout(context); effects = new FrameLayout(context); controls = new FrameLayout(context);
        content.setBackground(new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                new int[]{0xffdcd7d1,0xffeeeae5,0xffc4c5c4}));
        addView(content,new LayoutParams(-1,-1));
        addView(effects,new LayoutParams(-1,-1));
        addView(controls,new LayoutParams(-1,-1));
        backdrop=new ContentBackdrop(content);
        topBlur=new ProgressiveTopBlurView(context,backdrop);
        effects.addView(topBlur,new LayoutParams(-1,dp(ChromeTokens.TOP_HEIGHT_DP),Gravity.TOP));
        setOnApplyWindowInsetsListener((view,insets)-> {
            Insets safe=insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            insetTop=safe.top; insetBottom=safe.bottom; insetLeft=safe.left; insetRight=safe.right;
            updateSpacing(); return insets;
        });
    }
    public FrameLayout contentLayer(){return content;}
    public FrameLayout effectsLayer(){return effects;}
    public FrameLayout controlsLayer(){return controls;}
    public ContentBackdrop backdrop(){return backdrop;}
    public void setScrolling(boolean value){topBlur.setScrolling(value);}
    /** Ambient form pages keep body text sharp; photo pages retain the full progressive blur. */
    public void limitTopBlurToHeader(){headerOnlyBlur=true;updateSpacing();}
    public void addDockEffect(View anchor){
        LiquidGlassDockView dock=new LiquidGlassDockView(getContext(),backdrop,anchor);
        effects.addView(dock,new LayoutParams(-1,-1));
        anchor.addOnLayoutChangeListener((v,l,t,r,b,ol,ot,or,ob)->dock.invalidate());
    }
    @Override protected void dispatchDraw(android.graphics.Canvas canvas){
        if(canvas.isHardwareAccelerated()) backdrop.record(getWidth(),getHeight());
        super.dispatchDraw(canvas);
    }
    public void installChrome(View header, View dock, View... scrollables) {
        top=header; bottom=dock; scrolling=scrollables.clone();
        controls.addView(header,new LayoutParams(-1,-2, Gravity.TOP));
        controls.addView(dock,new LayoutParams(-1,-2, Gravity.BOTTOM));
        header.addOnLayoutChangeListener((v,l,t,r,b,ol,ot,or,ob)->updateSpacing());
        dock.addOnLayoutChangeListener((v,l,t,r,b,ol,ot,or,ob)->updateSpacing());
        updateSpacing(); requestApplyInsets();
    }
    private void updateSpacing() {
        if(top==null) return;
        if(headerOnlyBlur){LayoutParams blur=(LayoutParams)topBlur.getLayoutParams();int height=insetTop+top.getHeight()+dp(8);if(blur.height!=height){blur.height=height;topBlur.setLayoutParams(blur);}}
        int side=dp(18);
        LayoutParams a=(LayoutParams)top.getLayoutParams(), b=(LayoutParams)bottom.getLayoutParams();
        if(a.topMargin!=insetTop || a.leftMargin!=side+insetLeft || a.rightMargin!=side+insetRight) {
            a.topMargin=insetTop; a.leftMargin=side+insetLeft; a.rightMargin=side+insetRight; top.setLayoutParams(a);
        }
        int bottomMargin=insetBottom+dp(12);
        if(b.bottomMargin!=bottomMargin || b.leftMargin!=side+insetLeft || b.rightMargin!=side+insetRight) {
            b.bottomMargin=bottomMargin; b.leftMargin=side+insetLeft; b.rightMargin=side+insetRight; bottom.setLayoutParams(b);
        }
        for(View view:scrolling) {
            int t=insetTop+top.getHeight()+dp(8), end=bottomMargin+bottom.getHeight()+dp(12);
            if(view.getPaddingTop()!=t || view.getPaddingBottom()!=end || view.getPaddingLeft()!=insetLeft+dp(14)
                    || view.getPaddingRight()!=insetRight+dp(14))
                view.setPadding(insetLeft+dp(14),t,insetRight+dp(14),end);
        }
    }
    private int dp(float value){return Math.round(value*getResources().getDisplayMetrics().density);}
}
