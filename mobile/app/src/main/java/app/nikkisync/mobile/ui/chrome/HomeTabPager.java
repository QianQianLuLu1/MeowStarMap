package app.nikkisync.mobile.ui.chrome;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.ValueAnimator;
import android.content.Context;
import android.view.MotionEvent;
import android.view.VelocityTracker;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.animation.PathInterpolator;
import android.widget.FrameLayout;
import java.util.ArrayList;
import java.util.function.IntConsumer;

/** Moves existing tab views, preserving scroll/selection; never snapshots or fades photo pages. */
public final class HomeTabPager extends FrameLayout {
    private final ArrayList<View> pages=new ArrayList<>();
    private final IntConsumer selectedTab,prepareTab;
    private final int slop;
    private final float edge;
    private int selected,neighbor=-1;
    private float downX,downY,delta;
    private boolean dragging,blocked;
    private boolean selectionActive;
    public void setSelectionActive(boolean active) { selectionActive = active; }
    private VelocityTracker velocity;
    private ValueAnimator animation;
    public HomeTabPager(Context context,IntConsumer selectedTab,IntConsumer prepareTab){
        super(context);this.selectedTab=selectedTab;this.prepareTab=prepareTab;
        slop=ViewConfiguration.get(context).getScaledTouchSlop();edge=24*getResources().getDisplayMetrics().density;
        setClipChildren(true);
    }
    public void addPage(View view){pages.add(view);addView(view,new LayoutParams(-1,-1));settle();}
    public void select(int tab){
        if(tab<0||tab>=pages.size())return;
        if(tab==selected){if(!dragging)interrupt();return;}
        boolean fromDrag=dragging&&neighbor==tab;
        if(!fromDrag)interrupt();else stopAnimation();
        int from=selected;View outgoing=pages.get(from),incoming=pages.get(tab);
        float startOut=fromDrag?outgoing.getTranslationX():0;
        float startIn=fromDrag?incoming.getTranslationX():(tab>from?getWidth():-getWidth());
        float endOut=tab>from?-getWidth():getWidth();
        selected=tab;dragging=false;neighbor=-1;recycleVelocity();
        outgoing.setVisibility(VISIBLE);incoming.setVisibility(VISIBLE);incoming.setTranslationX(startIn);
        outgoing.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        incoming.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_AUTO);
        if(getWidth()==0){settle();return;}
        animate(t->{outgoing.setTranslationX(startOut+(endOut-startOut)*t);incoming.setTranslationX(startIn*(1-t));});
    }
    /** Stop/background/resize completes a selected tab but cancels any uncommitted drag. */
    public void interrupt(){stopAnimation();dragging=false;neighbor=-1;blocked=true;recycleVelocity();settle();}
    private void settle(){
        for(int i=0;i<pages.size();i++){
            View page=pages.get(i);page.setTranslationX(0);page.setAlpha(1);page.setVisibility(i==selected?VISIBLE:GONE);
            page.setImportantForAccessibility(i==selected?IMPORTANT_FOR_ACCESSIBILITY_AUTO:IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        }
    }
    private void begin(MotionEvent event){
        interrupt();downX=event.getX();downY=event.getY();delta=0;
        blocked=selectionActive||downX<edge||downX>getWidth()-edge||event.getPointerCount()!=1;
        if(!blocked){velocity=VelocityTracker.obtain();velocity.addMovement(event);}
    }
    private boolean detect(MotionEvent event){
        if(blocked||event.getPointerCount()!=1)return false;
        float dx=event.getX()-downX,dy=event.getY()-downY;
        if(Math.max(Math.abs(dx),Math.abs(dy))<=slop)return false;
        if(Math.abs(dy)>=Math.abs(dx)/1.3f){blocked=true;recycleVelocity();return false;}
        int target=selected+(dx<0?1:-1);
        if(target<0||target>=pages.size()){blocked=true;recycleVelocity();return false;}
        dragging=true;neighbor=target;prepareTab.accept(target);
        pages.get(target).setVisibility(VISIBLE);
        pages.get(target).setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        move(event.getX()-downX);
        if(getParent()!=null)getParent().requestDisallowInterceptTouchEvent(true);
        return true;
    }
    private void move(float distance){
        delta=neighbor>selected?Math.max(-getWidth(),Math.min(0,distance)):Math.min(getWidth(),Math.max(0,distance));
        pages.get(selected).setTranslationX(delta);
        pages.get(neighbor).setTranslationX((neighbor>selected?getWidth():-getWidth())+delta);
    }
    @Override public void requestDisallowInterceptTouchEvent(boolean disallow){
        // RecyclerView may request this on DOWN while stopping a fling. Resolve direction first;
        // vertical, multiple-pointer and system-edge gestures then remain entirely with the child.
        super.requestDisallowInterceptTouchEvent(disallow&&(blocked||dragging));
    }
    @Override public boolean onInterceptTouchEvent(MotionEvent event){
        if(event.getActionMasked()==MotionEvent.ACTION_DOWN){begin(event);return false;}
        if(event.getActionMasked()==MotionEvent.ACTION_POINTER_DOWN){if(!dragging){blocked=true;recycleVelocity();}return dragging;}
        if(event.getActionMasked()==MotionEvent.ACTION_MOVE)return dragging||detect(event);
        if(!dragging&&(event.getActionMasked()==MotionEvent.ACTION_UP||event.getActionMasked()==MotionEvent.ACTION_CANCEL))recycleVelocity();
        return dragging;
    }
    @Override public boolean onTouchEvent(MotionEvent event){
        int action=event.getActionMasked();
        if(action==MotionEvent.ACTION_DOWN){begin(event);return true;}
        if(velocity!=null)velocity.addMovement(event);
        if(action==MotionEvent.ACTION_POINTER_DOWN){if(dragging)restore();blocked=true;return true;}
        if(action==MotionEvent.ACTION_MOVE){
            if(!dragging)detect(event);
            if(dragging)move(event.getX()-downX);
            return true;
        }
        if(action==MotionEvent.ACTION_UP||action==MotionEvent.ACTION_CANCEL){
            if(dragging){
                float speed=0;if(velocity!=null){velocity.computeCurrentVelocity(1000);speed=velocity.getXVelocity();}
                boolean commit=action==MotionEvent.ACTION_UP&&(Math.abs(delta)>getWidth()*.22f||Math.abs(delta)>slop*2&&Math.abs(speed)>600*getResources().getDisplayMetrics().density&&Math.signum(speed)==Math.signum(delta));
                if(commit){int target=neighbor;selectedTab.accept(target);if(dragging)select(target);}
                else restore();
            }
            recycleVelocity();return true;
        }
        return true;
    }
    private void restore(){
        if(!dragging)return;
        View current=pages.get(selected),other=pages.get(neighbor);float start=current.getTranslationX(),otherStart=other.getTranslationX();
        float otherEnd=neighbor>selected?getWidth():-getWidth();dragging=false;neighbor=-1;
        animate(t->{current.setTranslationX(start*(1-t));other.setTranslationX(otherStart+(otherEnd-otherStart)*t);});
    }
    private interface Tick{void apply(float value);}
    private void animate(Tick tick){
        stopAnimation();animation=ValueAnimator.ofFloat(0,1);animation.setDuration(240);animation.setInterpolator(new PathInterpolator(.2f,0,0,1));
        animation.addUpdateListener(a->tick.apply((Float)a.getAnimatedValue()));
        animation.addListener(new AnimatorListenerAdapter(){@Override public void onAnimationEnd(Animator a){animation=null;settle();}});animation.start();
    }
    private void stopAnimation(){if(animation!=null){animation.removeAllListeners();animation.cancel();animation=null;}}
    private void recycleVelocity(){if(velocity!=null){velocity.recycle();velocity=null;}}
    @Override protected void onSizeChanged(int w,int h,int oldW,int oldH){super.onSizeChanged(w,h,oldW,oldH);if(oldW>0&&(w!=oldW||h!=oldH))interrupt();}
    @Override protected void onDetachedFromWindow(){interrupt();super.onDetachedFromWindow();}
}
