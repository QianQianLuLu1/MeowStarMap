package app.nikkisync.mobile.ui.chrome;

import android.app.Activity;
import android.graphics.*;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.view.*;
import android.widget.*;
import app.nikkisync.mobile.R;

/** Photo-first surface. Existing detail/action views live in a separate, on-demand sheet. */
@androidx.annotation.OptIn(markerClass=androidx.media3.common.util.UnstableApi.class)
public final class PhotoViewerPage extends FrameLayout implements ChromeNavigationHost.PhotoTransition {
    private final ChromeNavigationHost navigation;
    private final Activity activity;
    private int previousBarAppearance;
    private ImageView source;
    private Object sourceTag;
    private final View backdrop;
    private final LinearLayout toolbar;
    private final SharedImage transition;
    private ImageView image;
    private View header;
    private LinearLayout details;
    private View sheet;
    private float detailsBottom=Float.NaN;
    private float reveal;
    private boolean chromeVisible=true;
    private float zoom=1,dragX,dragY;
    private boolean previousAvailable,nextAvailable;
    private java.util.function.IntConsumer changePhoto;
    private float downX,downY,lastX,lastY;
    private int gesture;
    private boolean multiplePointers;
    private android.animation.ValueAnimator zoomAnimation;
    private android.animation.ValueAnimator pagingAnimation;
    private float pagingOffset;
    private boolean pagingHandoff;
    private Drawable handoffPixels;
    private ImageView pagingOutgoing;
    private int pagingDirection;
    private ImageView previousPhoto,nextPhoto;
    private LivePhotoPlayback live;
    private ContentBackdrop liveBackdrop;
    private LiquidGlassDockView liveGlass;
    private boolean covered;
    private Runnable dismissed=()->{};
    public void setOnDismissListener(Runnable listener){dismissed=listener==null?()->{}:listener;}

    public void setAdjacentPhotos(ImageView previous,ImageView next){
        if(previousPhoto!=null)removeView(previousPhoto);if(nextPhoto!=null)removeView(nextPhoto);
        previousPhoto=previous;nextPhoto=next;
        for(ImageView photo:new ImageView[]{previous,next})if(photo!=null){photo.setScaleType(ImageView.ScaleType.FIT_CENTER);photo.setVisibility(INVISIBLE);addView(photo,indexOfChild(image),new LayoutParams(-1,-1));}
    }
    private void resetAdjacent(){for(ImageView photo:new ImageView[]{previousPhoto,nextPhoto})if(photo!=null){photo.animate().cancel();photo.setVisibility(INVISIBLE);}}

    public void setPaging(boolean previous,boolean next,java.util.function.IntConsumer change){previousAvailable=previous;nextAvailable=next;changePhoto=change;}
    /** Rebind within the same navigation entry, never stack a page per swipe. */
    public void preparePhoto(ImageView thumbnail){
        clearLivePhoto();
        if(pagingAnimation!=null)pagingAnimation.cancel();
        if(!pagingHandoff){pagingOffset=0;clearPagingOutgoing();}
        else pagingOutgoing=image;
        if(zoomAnimation!=null)zoomAnimation.cancel();
        if(image!=null)image.animate().cancel();resetAdjacent();
        source=thumbnail;sourceTag=sourceIdentity(thumbnail);transition.seed=thumbnail==null?null:copy(thumbnail.getDrawable());
        removeAllViews();addView(backdrop,new LayoutParams(-1,-1));toolbar.removeAllViews();
        if(pagingOutgoing!=null)addView(pagingOutgoing,new LayoutParams(-1,-1));
        image=null;previousPhoto=nextPhoto=null;header=null;details=null;sheet=null;detailsBottom=Float.NaN;zoom=1;dragX=dragY=0;chromeVisible=true;
    }

    public PhotoViewerPage(Activity activity,ImageView source){
        super(activity);this.activity=activity;navigation=((ChromePage.Owner)activity).navigationHost();
        this.source=source;sourceTag=sourceIdentity(source);
        backdrop=new View(activity);backdrop.setBackgroundColor(0xff101012);addView(backdrop,new LayoutParams(-1,-1));
        toolbar=new LinearLayout(activity);toolbar.setGravity(Gravity.CENTER);toolbar.setPadding(dp(8),dp(4),dp(8),dp(4));
        GradientDrawable glass=new GradientDrawable();glass.setColor(0xc02d2d30);glass.setCornerRadius(dp(28));glass.setStroke(dp(1),0x35ffffff);toolbar.setBackground(glass);
        transition=new SharedImage(activity);
        setOnApplyWindowInsetsListener((v,insets)->{
            var safe=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout());
            if(header!=null){LayoutParams h=(LayoutParams)header.getLayoutParams();h.topMargin=safe.top+dp(6);h.leftMargin=safe.left+dp(16);h.rightMargin=safe.right+dp(16);header.setLayoutParams(h);}
            LayoutParams b=(LayoutParams)toolbar.getLayoutParams();b.bottomMargin=safe.bottom+dp(16);b.leftMargin=safe.left+dp(24);b.rightMargin=safe.right+dp(24);toolbar.setLayoutParams(b);
            positionLiveControls();
            return insets;
        });
    }

    public void setContentView(View content){
        LinearLayout body=(LinearLayout)((ScrollView)content).getChildAt(0);
        header=body.getChildAt(0);body.removeView(header);
        image=(ImageView)body.getChildAt(0);body.removeView(image);
        image.setScaleType(ImageView.ScaleType.FIT_CENTER);image.setBackground(null);image.setClipToOutline(false);
        if(image.getDrawable()==null&&handoffPixels!=null)image.setImageDrawable(handoffPixels);
        if(image.getDrawable()==null&&source!=null)image.setImageDrawable(copy(source.getDrawable()));
        addView(image,new LayoutParams(-1,-1));
        View touch=new View(getContext());touch.setTag("photo-gestures");touch.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        addView(touch,new LayoutParams(-1,-1));
        details=body;((ScrollView)content).removeView(body);details.setPadding(dp(8),dp(8),dp(8),dp(16));
        tintHeader(header);addView(header,new LayoutParams(-1,-2,Gravity.TOP));
        addAction("详情",this::openDetails);
        addView(toolbar,new LayoutParams(-1,dp(56),Gravity.BOTTOM));
        addView(transition,new LayoutParams(-1,-1));transition.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        image.setOnClickListener(v->toggleChrome());
        GestureDetector taps=new GestureDetector(getContext(),new GestureDetector.SimpleOnGestureListener(){
            @Override public boolean onDown(android.view.MotionEvent e){return true;}
            @Override public boolean onSingleTapConfirmed(android.view.MotionEvent e){image.performClick();return true;}
            @Override public boolean onDoubleTap(android.view.MotionEvent e){animateZoom(zoom>1?1:2.5f,e.getX(),e.getY());return true;}
        });
        ScaleGestureDetector pinch=new ScaleGestureDetector(getContext(),new ScaleGestureDetector.SimpleOnScaleGestureListener(){
            @Override public boolean onScale(ScaleGestureDetector detector){zoomAt(zoom*detector.getScaleFactor(),detector.getFocusX(),detector.getFocusY());return true;}
        });
        // Input must not share the image's transform: transformed local coordinates feed back
        // into pan deltas and cause oscillation. This surface remains screen-sized and stationary.
        touch.setOnTouchListener((v,event)->{
            int action=event.getActionMasked();float x=event.getX(),y=event.getY();
            if(action==MotionEvent.ACTION_DOWN){if(zoomAnimation!=null)zoomAnimation.cancel();if(pagingAnimation!=null)pagingAnimation.cancel();pagingOffset=0;image.animate().cancel();applyPan();resetAdjacent();downX=lastX=x;downY=lastY=y;gesture=0;multiplePointers=false;}
            if(action==MotionEvent.ACTION_POINTER_DOWN){
                if(gesture==2)navigation.interrupt();
                else if(gesture==1){image.animate().cancel();image.setTranslationX(0);resetAdjacent();}
                multiplePointers=true;gesture=0;
                MotionEvent cancel=MotionEvent.obtain(event);cancel.setAction(MotionEvent.ACTION_CANCEL);taps.onTouchEvent(cancel);cancel.recycle();}
            pinch.onTouchEvent(event);
            if(action==MotionEvent.ACTION_POINTER_UP){int remaining=event.getActionIndex()==0?1:0;lastX=downX=event.getX(remaining);lastY=downY=event.getY(remaining);}
            if(action==MotionEvent.ACTION_MOVE&&!pinch.isInProgress()&&event.getPointerCount()==1){
                float dx=x-downX,dy=y-downY;
                if(zoom>1.001f){dragX+=x-lastX;dragY+=y-lastY;applyPan();gesture=3;}
                else if(!multiplePointers){
                    if(gesture==0&&Math.max(Math.abs(dx),Math.abs(dy))>ViewConfiguration.get(getContext()).getScaledTouchSlop())
                        gesture=Math.abs(dx)>Math.abs(dy)?1:dy>0?2:3;
                    if(gesture==1){boolean available=dx>0?previousAvailable:nextAvailable;
                        ImageView neighbor=dx>0?previousPhoto:nextPhoto,other=dx>0?nextPhoto:previousPhoto;
                        boolean loaded=neighbor==null||neighbor.getDrawable()!=null;
                        pagingOffset=available&&loaded?dx:dx*.18f;applyPan();
                        if(other!=null)other.setVisibility(INVISIBLE);
                        if(neighbor!=null){neighbor.setVisibility(loaded?VISIBLE:INVISIBLE);neighbor.setTranslationX((dx>0?-getWidth():getWidth())+dx);
                            Drawable d=neighbor.getDrawable();if(d!=null){float iw=d.getIntrinsicWidth(),ih=d.getIntrinsicHeight();float fit=fitScale(getWidth(),getHeight(),iw,ih,neighbor.getRotation())/fitScale(getWidth(),getHeight(),iw,ih,0);neighbor.setScaleX(fit);neighbor.setScaleY(fit);}}
                    }
                    if(gesture==2)navigation.progress(Math.min(.85f,Math.max(0,dy)/(Math.max(1,getHeight())*.8f)));
                }
                lastX=x;lastY=y;
            }
            if(!multiplePointers&&gesture==0)taps.onTouchEvent(event);
            if(action==MotionEvent.ACTION_UP||action==MotionEvent.ACTION_CANCEL){
                boolean released=action==MotionEvent.ACTION_UP;
                if(gesture==2){if(released&&y-downY>dp(110))navigation.commit();else navigation.cancel();}
                else if(gesture==1){float dx=x-downX;int direction=dx<0?1:-1;
                    ImageView ready=direction>0?nextPhoto:previousPhoto;
                    if(released&&Math.abs(dx)>getWidth()*.2f&&(direction<0?previousAvailable:nextAvailable)&&changePhoto!=null
                        &&(ready==null||ready.getDrawable()!=null)){
                        float entryX=direction*getWidth()+dx;
                        Drawable readyPixels=ready==null?null:copy(ready.getDrawable());
                        pagingOffset=entryX;pagingHandoff=true;handoffPixels=readyPixels;
                        try{changePhoto.accept(direction);}finally{pagingHandoff=false;handoffPixels=null;}
                        pagingDirection=direction;
                        if(image.getDrawable()==null&&readyPixels!=null){image.setImageDrawable(readyPixels);refreshImageTransform();}
                        animatePaging(entryX);
                    }else {animatePaging(pagingOffset);
                        ImageView neighbor=dx>0?previousPhoto:nextPhoto;if(neighbor!=null)neighbor.animate().translationX(dx>0?-getWidth():getWidth()).setDuration(180).withEndAction(()->neighbor.setVisibility(INVISIBLE)).start();}
                }
                gesture=0;multiplePointers=false;updateLivePhoto();
            }
            return true;
        });
        if(getParent()==null)setReveal(0);else{reveal=1;backdrop.setAlpha(1f);transition.setVisibility(INVISIBLE);image.setImageAlpha(255);image.setAlpha(1f);refreshImageTransform();}
    }

    public void setLivePhoto(app.nikkisync.mobile.media.live.MotionPreviewLoader.Source source){setLivePhoto(new LivePhotoPlayback(activity,source));}
    public void setRemoteVideo(app.nikkisync.mobile.net.NikkiSyncClient client,String assetId){setLivePhoto(LivePhotoPlayback.remoteVideo(activity,client,assetId));}
    void setLivePhoto(LivePhotoPlayback playback){
        clearLivePhoto();live=playback;
        // Texture content shares the photo transform; the gesture surface and buttons stay fixed.
        addView(live.surface(),indexOfChild(image)+1,new LayoutParams(-1,-1));
        live.controls().setBackgroundColor(Color.TRANSPARENT);
        liveBackdrop=new ContentBackdrop(image);liveGlass=new LiquidGlassDockView(getContext(),liveBackdrop,live.controls());
        addView(liveGlass,indexOfChild(transition),new LayoutParams(-1,-1));
        addView(live.controls(),indexOfChild(transition),new LayoutParams(-2,dp(48),Gravity.BOTTOM|Gravity.CENTER_HORIZONTAL));
        positionLiveControls();updateLivePhoto();
    }
    private void positionLiveControls(){
        if(live==null)return;LayoutParams params=(LayoutParams)live.controls().getLayoutParams();
        params.bottomMargin=((LayoutParams)toolbar.getLayoutParams()).bottomMargin+dp(68);live.controls().setLayoutParams(params);
    }
    public void clearLivePhoto(){
        if(live!=null){live.close();removeView(live.surface());removeView(live.controls());live=null;}
        if(liveGlass!=null){removeView(liveGlass);liveGlass=null;}if(liveBackdrop!=null){liveBackdrop.close();liveBackdrop=null;}
    }
    private void updateLivePhoto(){
        if(live==null||image==null)return;
        View surface=live.surface();surface.setRotation(image.getRotation());surface.setScaleX(image.getScaleX());surface.setScaleY(image.getScaleY());
        surface.setTranslationX(image.getTranslationX());surface.setTranslationY(image.getTranslationY());
        live.controls().setVisibility(chromeVisible?VISIBLE:INVISIBLE);live.controls().setAlpha(reveal);if(liveGlass!=null)liveGlass.setAlpha(reveal);
        live.setEligible(isAttachedToWindow()&&image.getDrawable()!=null&&!covered&&reveal>=.999f&&transition.getVisibility()!=VISIBLE&&sheet==null
            &&gesture==0&&!multiplePointers&&zoom<=1.001f&&!pagingHandoff&&Math.abs(pagingOffset)<.5f&&(pagingAnimation==null||!pagingAnimation.isRunning()));
    }
    @Override public void setCovered(boolean value){covered=value;updateLivePhoto();}
    @Override protected void dispatchDraw(Canvas canvas){if(liveBackdrop!=null&&canvas.isHardwareAccelerated())liveBackdrop.record(getWidth(),getHeight());super.dispatchDraw(canvas);}

    public void addAction(String label,Runnable action){addAction(label,true,action);}
    public void addAction(String label,boolean enabled,Runnable action){
        Button b=new Button(getContext());b.setText(label);b.setTextSize(14);b.setTextColor(Color.WHITE);b.setAllCaps(false);b.setMinWidth(0);b.setMinimumWidth(0);b.setPadding(0,0,0,0);b.setBackgroundColor(Color.TRANSPARENT);
        b.setEnabled(enabled);b.setAlpha(enabled?1f:.35f);
        b.setOnClickListener(v->{action.run();if(image!=null)setZoom(zoom);});toolbar.addView(b,new LinearLayout.LayoutParams(0,-1,1));
    }
    /** Update an existing action without rebinding the photo, zoom or details sheet. */
    public void setActionEnabled(String label,boolean enabled){
        for(int i=0;i<toolbar.getChildCount();i++){
            if(toolbar.getChildAt(i) instanceof Button button&&label.contentEquals(button.getText())){
                button.setEnabled(enabled);button.setAlpha(enabled?1f:.35f);
            }
        }
    }
    public void show(){
        if(getParent()!=null){settle();requestApplyInsets();postDelayed(()->logViewport(),250);return;}
        var bars=activity.getWindow().getInsetsController();
        int mask=WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS|WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
        if(bars!=null){previousBarAppearance=bars.getSystemBarsAppearance();bars.setSystemBarsAppearance(0,mask);}
        navigation.pushPhoto(this,()->{
            if(bars!=null)bars.setSystemBarsAppearance(previousBarAppearance,mask);
            dismissed.run();
        });
        postDelayed(()->logViewport(),500);
    }
    private void logViewport(){
        if(!app.nikkisync.mobile.BuildConfig.DEBUG||image==null||getParent()==null)return;
        Drawable pixels=image.getDrawable();
        android.util.Log.i("NikkiSyncViewport","photo="+image.getWidth()+"x"+image.getHeight()+" pixels="+(pixels!=null)+" alpha="+image.getAlpha()+" drawableAlpha="+(pixels==null?-1:pixels.getAlpha())+" scale="+image.getScaleX()+","+image.getScaleY()+" offset="+image.getTranslationX()+","+image.getTranslationY()+" reveal="+reveal+" transition="+transition.getVisibility());
    }
    public void dismiss(){navigation.dismiss(this);}
    public void openDetails(){
        if(sheet!=null&&sheet.getParent()!=null)return;
        if(zoomAnimation!=null)zoomAnimation.cancel();
        if(pagingAnimation!=null)pagingAnimation.cancel();pagingOffset=0;
        image.animate().cancel();resetAdjacent();
        float savedZoom=zoom,savedX=dragX,savedY=dragY;
        if(details.getParent() instanceof android.view.ViewGroup parent)parent.removeView(details);
        ScrollView scroller=new ScrollView(getContext());scroller.addView(details);
        LinearLayout heading=new LinearLayout(getContext());heading.setGravity(Gravity.CENTER_VERTICAL);heading.setPadding(dp(8),0,0,dp(12));
        TextView title=new TextView(getContext());title.setText("照片详情");title.setTextSize(20);title.setTextColor(getContext().getColor(R.color.photo_detail_text));
        heading.addView(title,new LinearLayout.LayoutParams(0,-2,1));
        Button done=new Button(getContext());done.setText("完成");
        heading.addView(done,new LinearLayout.LayoutParams(dp(72),dp(48)));
        ChromeSheetLayout opened=new ChromeSheetLayout(getContext(),heading,scroller,new FrameLayout(getContext()));
        sheet=opened;updateLivePhoto();
        done.setOnClickListener(v->navigation.dismiss(opened));
        navigation.showPhotoDetails(opened,()->{
            if(sheet==opened){sheet=null;detailsBottom=Float.NaN;refreshImageTransform();}
        },top->{if(sheet==opened){detailsBottom=(float)top;applyDetailsViewport();}});
        setZoom(savedZoom);dragX=savedX;dragY=savedY;applyPan();
    }
    public boolean isChromeVisible(){return chromeVisible;}
    private void toggleChrome(){chromeVisible=!chromeVisible;header.setVisibility(chromeVisible?VISIBLE:INVISIBLE);toolbar.setVisibility(chromeVisible?VISIBLE:INVISIBLE);updateLivePhoto();}
    static float fitScale(float width,float height,float imageWidth,float imageHeight,float rotation){
        boolean sideways=Math.round(rotation/90)%2!=0;
        return Math.min(width/Math.max(1,sideways?imageHeight:imageWidth),height/Math.max(1,sideways?imageWidth:imageHeight));
    }
    private void setZoom(float value){
        zoom=Math.max(1,Math.min(4,value));float correction=1;
        Drawable d=image.getDrawable();if(d!=null&&getWidth()>0&&getHeight()>0){float iw=d.getIntrinsicWidth(),ih=d.getIntrinsicHeight();correction=fitScale(getWidth(),getHeight(),iw,ih,image.getRotation())/fitScale(getWidth(),getHeight(),iw,ih,0);}
        image.setScaleX(zoom*correction);image.setScaleY(zoom*correction);if(zoom==1){dragX=dragY=0;}applyPan();
    }
    private void zoomAt(float value,float focusX,float focusY){
        float next=Math.max(1,Math.min(4,value)),ratio=next/zoom;
        dragX=(focusX-getWidth()/2f)*(1-ratio)+dragX*ratio;
        dragY=(focusY-getHeight()/2f)*(1-ratio)+dragY*ratio;setZoom(next);
    }
    private void animateZoom(float target,float x,float y){
        if(zoomAnimation!=null)zoomAnimation.cancel();zoomAnimation=android.animation.ValueAnimator.ofFloat(zoom,target);
        zoomAnimation.setDuration(220);zoomAnimation.addUpdateListener(a->zoomAt((Float)a.getAnimatedValue(),x,y));zoomAnimation.start();
    }
    private void animatePaging(float start){
        if(pagingAnimation!=null)pagingAnimation.cancel();pagingOffset=start;applyPan();
        pagingAnimation=android.animation.ValueAnimator.ofFloat(start,0);pagingAnimation.setDuration(180);
        pagingAnimation.setInterpolator(new android.view.animation.PathInterpolator(.2f,0,0,1));
        pagingAnimation.addUpdateListener(a->{pagingOffset=(Float)a.getAnimatedValue();if(image!=null)applyPan();});
        pagingAnimation.addListener(new android.animation.AnimatorListenerAdapter(){
            @Override public void onAnimationEnd(android.animation.Animator animation){pagingAnimation=null;clearPagingOutgoing();updateLivePhoto();}
        });pagingAnimation.start();
    }
    private void clearPagingOutgoing(){if(pagingOutgoing!=null)removeView(pagingOutgoing);pagingOutgoing=null;pagingDirection=0;}
    @Override protected void onDetachedFromWindow(){clearLivePhoto();if(zoomAnimation!=null)zoomAnimation.cancel();if(pagingAnimation!=null)pagingAnimation.cancel();clearPagingOutgoing();super.onDetachedFromWindow();}
    public void refreshImageTransform(){if(image!=null)setZoom(zoom);}
    @Override protected void onLayout(boolean changed,int l,int t,int r,int b){super.onLayout(changed,l,t,r,b);refreshImageTransform();}
    private void applyPan(){
        float x=0,y=0;Drawable d=image.getDrawable();
        if(d!=null){boolean sideways=Math.round(image.getRotation()/90)%2!=0;float iw=d.getIntrinsicWidth(),ih=d.getIntrinsicHeight();
            float scale=fitScale(getWidth(),getHeight(),iw,ih,image.getRotation())*zoom;
            x=Math.max(0,((sideways?ih:iw)*scale-getWidth())/2);y=Math.max(0,((sideways?iw:ih)*scale-getHeight())/2);}
        dragX=Math.max(-x,Math.min(x,dragX));dragY=Math.max(-y,Math.min(y,dragY));image.setTranslationX(dragX+pagingOffset);image.setTranslationY(dragY);
        if(pagingOutgoing!=null)pagingOutgoing.setTranslationX(pagingOffset-pagingDirection*getWidth());
        applyDetailsViewport();
        updateLivePhoto();
    }
    /** Use the sheet's actual animated edge; no second animator or bitmap capture. */
    private void applyDetailsViewport(){
        if(image==null||sheet==null||Float.isNaN(detailsBottom)||getWidth()<=0||getHeight()<=0)return;
        Drawable d=image.getDrawable();if(d==null)return;
        float bottom=Math.max(0,Math.min(getHeight(),detailsBottom));
        float fraction=Math.max(0,Math.min(1,(getHeight()-bottom)/Math.max(1,sheet.getHeight())));
        float margin=dp(12)*fraction;
        float top=(header==null?dp(12):header.getBottom()+dp(12))*fraction;
        float height=Math.max(0,bottom-margin-top),width=Math.max(0,getWidth()-2*margin);
        float iw=d.getIntrinsicWidth(),ih=d.getIntrinsicHeight();
        float base=fitScale(getWidth(),getHeight(),iw,ih,0);
        float scale=fitScale(width,height,iw,ih,image.getRotation())/base*(zoom+(1-zoom)*fraction);
        image.setScaleX(scale);image.setScaleY(scale);
        image.setTranslationX(dragX*(1-fraction));
        image.setTranslationY(top+height/2-getHeight()/2f+dragY*(1-fraction));
    }
    @Override public float getReveal(){return reveal;}
    @Override public void setReveal(float value){
        reveal=Math.max(0,Math.min(1,value));backdrop.setAlpha(reveal);
        if(image==null)return;
        setZoom(1);header.setAlpha(reveal);toolbar.setAlpha(reveal);
        transition.setVisibility(VISIBLE);image.setAlpha(0f);
        updateLivePhoto();
        transition.invalidate();
    }
    @Override public void settle(){transition.setVisibility(INVISIBLE);image.setImageAlpha(255);image.setAlpha(1f);setZoom(1);updateLivePhoto();}
    private boolean sourceMatches(){return source!=null&&source.isAttachedToWindow()&&java.util.Objects.equals(sourceTag,sourceIdentity(source));}
    private static Object sourceIdentity(ImageView source){
        if(source==null)return null;
        Object identity=source.getTag(R.id.photo_source_identity);
        return identity!=null?identity:source.getTag();
    }
    private static Drawable copy(Drawable drawable){return drawable==null?null:drawable.getConstantState()==null?drawable:drawable.getConstantState().newDrawable().mutate();}
    private void tintHeader(View v){if(v instanceof TextView text){text.setTextColor(Color.WHITE);if(v instanceof Button){if("完成".contentEquals(text.getText()))text.setText("关闭");if(!"photo-selection".equals(v.getTag()))text.setBackgroundColor(Color.TRANSPARENT);}}if(v instanceof android.view.ViewGroup group)for(int i=0;i<group.getChildCount();i++)tintHeader(group.getChildAt(i));}
    private int dp(float value){return Math.round(value*getResources().getDisplayMetrics().density);}

    private final class SharedImage extends View {
        private Drawable seed;
        private final RectF origin=new RectF();
        SharedImage(android.content.Context c){super(c);seed=source==null?null:copy(source.getDrawable());}
        @Override protected void onDraw(Canvas canvas){
            Drawable drawable=seed!=null?seed:image.getDrawable();if(drawable==null)return;
            float iw=Math.max(1,drawable.getIntrinsicWidth()),ih=Math.max(1,drawable.getIntrinsicHeight());
            float rotation=image.getRotation();boolean sideways=Math.round(rotation/90)%2!=0;
            float fit=fitScale(getWidth(),getHeight(),iw,ih,rotation),ew=(sideways?ih:iw)*fit,eh=(sideways?iw:ih)*fit;
            RectF end=new RectF((getWidth()-ew)/2,(getHeight()-eh)/2,(getWidth()+ew)/2,(getHeight()+eh)/2);
            boolean anchored=sourceMatches()&&source.getWidth()>0&&source.getHeight()>0;
            if(anchored){int[] s=new int[2],p=new int[2];source.getLocationOnScreen(s);getLocationOnScreen(p);origin.set(s[0]-p[0],s[1]-p[1],s[0]-p[0]+source.getWidth(),s[1]-p[1]+source.getHeight());}
            else origin.set(end);
            float t=reveal;
            float scale=anchored?lerp(Math.max(origin.width()/iw,origin.height()/ih),fit,t):fit;
            if(scale<=0)return;
            float cx=anchored?lerp(origin.centerX(),end.centerX(),t):end.centerX();
            float cy=anchored?lerp(origin.centerY(),end.centerY(),t):end.centerY();
            // Interpolate the visible rectangle in the image's axes, then rotate it with the pixels.
            // A screen-aligned interpolated box cuts a rotating rectangle into a polygon.
            float cropWidth=anchored?lerp(origin.width(),iw*fit,t)/scale:iw;
            float cropHeight=anchored?lerp(origin.height(),ih*fit,t)/scale:ih;
            int save=canvas.save();
            canvas.translate(cx,cy);canvas.rotate(anchored?rotation*t:rotation);canvas.scale(scale,scale);canvas.translate(-iw/2,-ih/2);
            RectF crop=new RectF((iw-cropWidth)/2,(ih-cropHeight)/2,(iw+cropWidth)/2,(ih+cropHeight)/2);
            float radius=anchored?dp(18)*(1-t)/scale:0;
            Path clip=new Path();clip.addRoundRect(crop,radius,radius,Path.Direction.CW);canvas.clipPath(clip);
            drawable.setBounds(0,0,(int)iw,(int)ih);drawable.setAlpha(anchored?255:(int)(255*t));drawable.draw(canvas);canvas.restoreToCount(save);
        }
        private float lerp(float a,float b,float t){return a+(b-a)*t;}
    }
}
