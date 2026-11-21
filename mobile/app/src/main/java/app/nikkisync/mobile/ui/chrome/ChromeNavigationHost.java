package app.nikkisync.mobile.ui.chrome;

import android.animation.*;
import android.content.Context;
import android.graphics.RenderEffect;
import android.graphics.Shader;
import android.view.*;
import android.view.animation.LinearInterpolator;
import android.view.animation.PathInterpolator;
import android.widget.FrameLayout;
import androidx.activity.BackEventCompat;
import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import java.util.ArrayList;

/** Owns app pages, never external pickers or the system share sheet. All mutations are on main. */
public final class ChromeNavigationHost extends FrameLayout {
    public interface PhotoTransition {
        void setReveal(float value);
        float getReveal();
        void settle();
        default void setCovered(boolean covered){}
    }
    private record Entry(View layer,View moving,View effect,BackPreviewState.Kind kind,Runnable closed) {}
    private final ArrayList<Entry> stack=new ArrayList<>();
    private View root;
    private ValueAnimator animation;
    private boolean committing;
    private float previewBlurDp;
    private long navigationGeneration;
    private record Covered(int accessibility,int focusability,View focused) {}
    private final java.util.IdentityHashMap<View,Covered> covered=new java.util.IdentityHashMap<>();
    private OnBackPressedCallback callback;
    private WindowInsets lastInsets;
    @Override public WindowInsets dispatchApplyWindowInsets(WindowInsets insets){lastInsets=insets;return super.dispatchApplyWindowInsets(insets);}
    public ChromeNavigationHost(Context context){super(context);setClipChildren(false);}
    public void bind(ComponentActivity activity){
        callback=new OnBackPressedCallback(false){
            @Override public void handleOnBackStarted(BackEventCompat event){progress(0);}
            @Override public void handleOnBackProgressed(BackEventCompat event){progress(event.getProgress());}
            @Override public void handleOnBackCancelled(){cancel();}
            @Override public void handleOnBackPressed(){commit();}
        };
        activity.getOnBackPressedDispatcher().addCallback(activity,callback);
    }
    public void setRoot(View view){if(root!=null)removeView(root);root=view;addView(view,0,new LayoutParams(-1,-1));}
    public int overlayCount(){return stack.size();}
    public boolean hasOverlay(){return !stack.isEmpty();}
    public void push(View page){push(page,()->{});}
    public void push(View page,Runnable closed){
        interrupt();page.setClickable(true);page.setAlpha(0);addView(page,new LayoutParams(-1,-1));
        Entry e=new Entry(page,page,null,BackPreviewState.Kind.PAGE,closed);stack.add(e);sync();
        if(lastInsets!=null)page.dispatchApplyWindowInsets(lastInsets);page.requestApplyInsets();
        long ticket=navigationGeneration;
        page.post(()->{if(top()!=e||committing||ticket!=navigationGeneration)return;animate(210,t->{page.setTranslationX(getWidth()/8f*(1-t));page.setAlpha(Math.min(1,t*210/150));},()->reset(e));});
    }
    public void pushPhoto(View page,Runnable closed){
        interrupt();PhotoTransition photo=(PhotoTransition)page;photo.setReveal(0);
        page.setClickable(true);addView(page,new LayoutParams(-1,-1));
        Entry e=new Entry(page,page,null,BackPreviewState.Kind.PAGE,closed);stack.add(e);sync();
        if(lastInsets!=null)page.dispatchApplyWindowInsets(lastInsets);page.requestApplyInsets();
        long ticket=navigationGeneration;
        page.post(()->{if(top()!=e||committing||ticket!=navigationGeneration)return;
            animate(300,t->photo.setReveal(ease(t)),()->reset(e));});
    }
    public void showSheet(View sheet){showSheet(sheet,()->{});}
    public void showSheet(View sheet,Runnable closed){showSheet(sheet,closed,false,top->{},true);}
    public void showSheetWithOwnControls(View sheet){showSheet(sheet,()->{},false,top->{},false);}
    public void showPhotoDetails(ChromeSheetLayout sheet){showPhotoDetails(sheet,()->{});}
    public void showPhotoDetails(ChromeSheetLayout sheet,Runnable closed){
        showPhotoDetails(sheet,closed,top->{});
    }
    public void showPhotoDetails(ChromeSheetLayout sheet,Runnable closed,java.util.function.DoubleConsumer visibleTop){
        sheet.enablePhotoDetailDragging(()->dismiss(sheet));
        showSheet(sheet,closed,true,visibleTop,true);
    }
    private void showSheet(View sheet,Runnable closed,boolean dismissOutside,java.util.function.DoubleConsumer visibleTop,boolean glassControls){
        interrupt();FrameLayout layer=new FrameLayout(getContext()){
            private boolean outside;
            @Override public boolean onInterceptTouchEvent(MotionEvent event){
                if(!dismissOutside)return super.onInterceptTouchEvent(event);
                if(event.getActionMasked()==MotionEvent.ACTION_DOWN)
                    outside=event.getX()<sheet.getLeft()||event.getX()>=sheet.getRight()||event.getY()<sheet.getTop()||event.getY()>=sheet.getBottom();
                return outside;
            }
            @Override public boolean onTouchEvent(MotionEvent event){
                if(!dismissOutside||!outside)return super.onTouchEvent(event);
                if(event.getActionMasked()==MotionEvent.ACTION_UP){outside=false;dismiss(sheet);performClick();}
                else if(event.getActionMasked()==MotionEvent.ACTION_CANCEL)outside=false;
                return true;
            }
            @Override public boolean performClick(){super.performClick();return true;}
        };layer.setClickable(true);
        // Backdrop contains only the previous page; sheet controls are never sampled.
        View previous=hasOverlay()?top().layer():root;
        ContentBackdrop source=new ContentBackdrop(previous);
        FrameLayout recording=new FrameLayout(getContext()){
            @Override protected void dispatchDraw(android.graphics.Canvas c){if(c.isHardwareAccelerated())source.record(getWidth(),getHeight());super.dispatchDraw(c);}
        };
        layer.addView(recording,new LayoutParams(-1,-1));
        LiquidGlassDockView glass=new LiquidGlassDockView(getContext(),source,sheet,true,dismissOutside);
        recording.addView(glass,new LayoutParams(-1,-1));
        ArrayList<LiquidGlassDockView> controlGlass=new ArrayList<>();
        if(glassControls&&sheet.getBackground()==null)addSheetControlGlass(sheet,source,recording,controlGlass,dismissOutside);
        Runnable updateGeometry=()->{
            glass.invalidate();
            for(View control:controlGlass)control.invalidate();
            if(dismissOutside&&sheet.getHeight()>0)visibleTop.accept(layer.getTop()+sheet.getY());
        };
        if(sheet instanceof ChromeSheetLayout chromeSheet)chromeSheet.setPhotoDetailGeometryListener(updateGeometry);
        View.OnLayoutChangeListener geometry=(v,l,t,r,b,ol,ot,or,ob)->updateGeometry.run();
        sheet.addOnLayoutChangeListener(geometry);
        sheet.setTranslationY(Math.max(getHeight(),getResources().getDisplayMetrics().heightPixels));
        layer.addView(sheet,new LayoutParams(-1,-2,Gravity.BOTTOM));sheet.setClickable(true);
        layer.setOnApplyWindowInsetsListener((v,insets)->{
            var safe=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout()|WindowInsets.Type.ime());
            layer.setPadding(safe.left,safe.top, safe.right,safe.bottom);return insets;
        });
        addView(layer,new LayoutParams(-1,-1));
        View.OnLayoutChangeListener[] pendingEntry={null};
        Entry e=new Entry(layer,sheet,recording,BackPreviewState.Kind.SHEET,()->{sheet.removeOnLayoutChangeListener(geometry);if(pendingEntry[0]!=null)sheet.removeOnLayoutChangeListener(pendingEntry[0]);if(sheet instanceof ChromeSheetLayout chromeSheet)chromeSheet.setPhotoDetailGeometryListener(()->{});source.close();closed.run();});stack.add(e);sync();
        if(lastInsets!=null)layer.dispatchApplyWindowInsets(lastInsets);
        long ticket=navigationGeneration;
        Runnable enter=()->{if(top()!=e||committing||ticket!=navigationGeneration)return;animate(300,t->sheet.setTranslationY(sheet.getHeight()*(1-t)),()->reset(e));};
        {
            // Start only after the first measured layout, never with a zero-height sheet.
            pendingEntry[0]=new View.OnLayoutChangeListener(){
                @Override public void onLayoutChange(View v,int l,int t,int r,int b,int ol,int ot,int or,int ob){
                    if(b<=t)return;sheet.removeOnLayoutChangeListener(this);pendingEntry[0]=null;enter.run();
                }
            };
            sheet.addOnLayoutChangeListener(pendingEntry[0]);
        }
        layer.requestApplyInsets();
    }
    public void dismiss(View page){
        Entry found=null;for(Entry e:stack)if(e.moving()==page||e.layer()==page){found=e;break;}
        if(found==null)return;
        while(top()!=found)remove(top());
        commit(true);
    }
    private void addSheetControlGlass(View view,ContentBackdrop source,FrameLayout recording,ArrayList<LiquidGlassDockView> controls,boolean photoDetails){
        if(view instanceof android.widget.Button || view instanceof android.widget.EditText){
            ((android.widget.TextView)view).setTextColor(getContext().getColor(photoDetails
                ? app.nikkisync.mobile.R.color.photo_detail_glass_ink : app.nikkisync.mobile.R.color.text_primary));
            // Scrolling controls must own their material: an independently rendered
            // overlay can lag or remain visible during overscroll on real devices.
            boolean scrolling=false;
            for(android.view.ViewParent p=view.getParent();p instanceof View;p=p.getParent())
                if(p instanceof android.widget.ScrollView){scrolling=true;break;}
            if(scrolling)view.setBackgroundResource(photoDetails
                ? app.nikkisync.mobile.R.drawable.bg_photo_detail_glass_chip : app.nikkisync.mobile.R.drawable.bg_glass_chip);
            else {
                view.setBackgroundColor(android.graphics.Color.TRANSPARENT);
                LiquidGlassDockView effect=new LiquidGlassDockView(getContext(),source,view);
                recording.addView(effect,new LayoutParams(-1,-1));controls.add(effect);
            }
        }
        if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++)addSheetControlGlass(group.getChildAt(i),source,recording,controls,photoDetails);
    }
    private boolean userCanDismiss(){return !(top().moving() instanceof ChromeSheetLayout sheet)||sheet.isUserDismissible();}
    public void progress(float p){
        if(!hasOverlay()||committing||!userCanDismiss())return;navigationGeneration++;stopAnimation();Entry e=top();e.moving().setAlpha(1);
        if(e.layer() instanceof PhotoTransition photo){photo.setReveal(1-Math.max(0,Math.min(1,p)));clearBlur();return;}
        var frame=BackPreviewState.frame(e.kind(),p,getWidth(),e.moving().getHeight());
        e.moving().setTranslationX(frame.x());e.moving().setTranslationY(frame.y());
        if(e.effect()!=null)e.effect().invalidate();
        setPreviousBlur(frame.previousBlurDp());
    }
    public void cancel(){
        if(!hasOverlay()||committing)return;navigationGeneration++;Entry e=top();float x=e.moving().getTranslationX(),y=e.moving().getTranslationY(),startBlur=previewBlurDp;
        if(e.layer() instanceof PhotoTransition photo){float start=photo.getReveal();animate(200,t->photo.setReveal(start+(1-start)*ease(t)),()->reset(e));return;}
        animate(e.kind()==BackPreviewState.Kind.SHEET?450:170,t->{float v=e.kind()==BackPreviewState.Kind.SHEET?spring(t,.72f,620):t;e.moving().setTranslationX(x*(1-v));e.moving().setTranslationY(y*(1-v));if(e.kind()==BackPreviewState.Kind.PAGE)setPreviousBlur(startBlur*(1-v));},()->reset(e));
    }
    public void commit(){
        commit(false);
    }
    private void commit(boolean programmatic){
        if(!hasOverlay()||committing||(!programmatic&&!userCanDismiss()))return;navigationGeneration++;Entry e=top();committing=true;
        if(!programmatic&&e.moving() instanceof ChromeSheetLayout sheet){sheet.notifyUserDismiss();if(top()!=e){committing=false;return;}}
        if(e.layer() instanceof PhotoTransition photo){float start=photo.getReveal();animate(260,t->photo.setReveal(start*(1-ease(t))),()->{remove(e);committing=false;});return;}
        float x=e.moving().getTranslationX(),y=e.moving().getTranslationY(),startBlur=previewBlurDp;e.moving().setAlpha(1);
        animate(e.kind()==BackPreviewState.Kind.SHEET?480:170,t->{
            float v=e.kind()==BackPreviewState.Kind.SHEET?spring(t,.78f,520):t;
            if(e.kind()==BackPreviewState.Kind.PAGE){e.moving().setTranslationX(x+(getWidth()-x)*v);setPreviousBlur(startBlur*(1-v));}
            else e.moving().setTranslationY(y+(e.moving().getHeight()-y)*v);
        },()->{remove(e);committing=false;});
    }
    /** Background/resize interrupts preview; an already committed pop still consumes exactly one. */
    public void interrupt(){
        navigationGeneration++;stopAnimation();if(committing&&hasOverlay()){Entry e=top();committing=false;remove(e);}else if(hasOverlay())reset(top());
    }
    public void close(){interrupt();while(hasOverlay())remove(top());}
    @Override protected void onSizeChanged(int w,int h,int ow,int oh){super.onSizeChanged(w,h,ow,oh);if(ow>0&&(w!=ow||h!=oh))interrupt();}
    private Entry top(){return stack.isEmpty()?null:stack.get(stack.size()-1);}
    private View previous(){return stack.size()>1?stack.get(stack.size()-2).layer():root;}
    private void reset(Entry e){e.moving().setTranslationX(0);e.moving().setTranslationY(0);e.moving().setAlpha(1);if(e.layer() instanceof PhotoTransition photo){photo.setReveal(1);photo.settle();}clearBlur();}
    private void setPreviousBlur(float radiusDp){
        previewBlurDp=Math.max(0,radiusDp);
        View prior=previous();if(prior==null)return;
        if(android.os.Build.VERSION.SDK_INT<31)return;
        float radius=previewBlurDp*getResources().getDisplayMetrics().density;
        prior.setRenderEffect(radius>.01f?RenderEffect.createBlurEffect(radius,radius,Shader.TileMode.CLAMP):null);
    }
    private void clearBlur(){previewBlurDp=0;if(android.os.Build.VERSION.SDK_INT<31)return;if(root!=null)root.setRenderEffect(null);for(Entry e:stack)e.layer().setRenderEffect(null);}
    private void remove(Entry e){stack.remove(e);covered.remove(e.layer());removeView(e.layer());e.closed().run();clearBlur();sync();}
    private void sync(){if(callback!=null)callback.setEnabled(hasOverlay());cover(root,hasOverlay());for(Entry e:stack){cover(e.layer(),e!=top());if(e.layer() instanceof PhotoTransition photo)photo.setCovered(e!=top());}}
    private void cover(View view,boolean hide){
        if(view==null)return;
        if(hide){
            if(covered.containsKey(view))return;
            int focus=view instanceof ViewGroup group?group.getDescendantFocusability():0;
            covered.put(view,new Covered(view.getImportantForAccessibility(),focus,view.findFocus()));
            view.clearFocus();view.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            if(view instanceof ViewGroup group)group.setDescendantFocusability(FOCUS_BLOCK_DESCENDANTS);
        }else{
            Covered state=covered.remove(view);if(state==null)return;
            view.setImportantForAccessibility(state.accessibility());
            if(view instanceof ViewGroup group)group.setDescendantFocusability(state.focusability());
            if(state.focused()!=null)state.focused().requestFocus();
        }
    }
    @Override public void addFocusables(ArrayList<View> views,int direction,int mode){View active=hasOverlay()?top().layer():root;if(active!=null)active.addFocusables(views,direction,mode);}
    private void stopAnimation(){if(animation!=null){animation.removeAllListeners();animation.cancel();animation=null;}}
    private interface Tick {void apply(float t);}
    private void animate(long duration,Tick tick,Runnable done){
        stopAnimation();animation=ValueAnimator.ofFloat(0,1);animation.setDuration(duration);animation.setInterpolator(new LinearInterpolator());
        animation.addUpdateListener(a->{tick.apply((Float)a.getAnimatedValue());if(top()!=null&&top().effect()!=null)top().effect().invalidate();});
        animation.addListener(new AnimatorListenerAdapter(){@Override public void onAnimationEnd(Animator a){animation=null;done.run();}});animation.start();
    }
    private static float spring(float fraction,float damping,float stiffness){double time=fraction*.48,omega=Math.sqrt(stiffness),wd=omega*Math.sqrt(1-damping*damping);return (float)(1-Math.exp(-damping*omega*time)*(Math.cos(wd*time)+damping/Math.sqrt(1-damping*damping)*Math.sin(wd*time)));}
    private static float ease(float t){return new PathInterpolator(.2f,0,0,1).getInterpolation(t);}
}
