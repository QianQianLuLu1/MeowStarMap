package app.nikkisync.mobile.ui.chrome;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.os.Bundle;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.accessibility.AccessibilityNodeInfo;

/** Measures actions first so IME shrinks the form rather than hiding the buttons. */
public final class ChromeSheetLayout extends ViewGroup {
    private final View title,form,footer;
    private View dragHandle;
    private int dragHandleColor=0xffFFFFFF;
    private boolean expanded;
    private boolean wrapForm;
    private int maximumFormDp=400;
    private int draggedFormHeight=-1;
    private Runnable dismissPhotoDetails;
    private Runnable geometryChanged=()->{};
    private boolean userDismissible=true;
    private Runnable userDismissRequested=()->{};
    public ChromeSheetLayout setUserDismissible(boolean value){userDismissible=value;return this;}
    public boolean isUserDismissible(){return userDismissible;}
    public ChromeSheetLayout onUserDismiss(Runnable action){userDismissRequested=action;return this;}
    void notifyUserDismiss(){userDismissRequested.run();}
    private float gestureStartY;
    private int gestureStartFormHeight;
    private boolean gestureStartedExpanded;
    public ChromeSheetLayout(Context c,View title,View form,View footer){
        super(c);this.title=title;this.form=form;this.footer=footer;
        int padding=Math.round(18*getResources().getDisplayMetrics().density);setPadding(padding,padding,padding,padding);
        addView(title);addView(form);addView(footer);
    }
    /** Short forms size to their content; long photo/editor sheets keep their existing scroll geometry. */
    public ChromeSheetLayout wrapContentForm(){wrapForm=true;requestLayout();return this;}
    public ChromeSheetLayout wrapContentForm(int maximumDp){maximumFormDp=maximumDp;return wrapContentForm();}
    public ChromeSheetLayout setDragHandleColor(int color){dragHandleColor=color;if(dragHandle!=null)dragHandle.invalidate();return this;}
    /** Opts this sheet into photo-detail gestures; the form remains the owner of its scroll events. */
    public void enablePhotoDetailDragging(Runnable dismiss){
        dismissPhotoDetails=dismiss;
        if(dragHandle!=null)return;
        dragHandle=new View(getContext()){
            private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
            private final RectF pill=new RectF();
            @Override protected void onDraw(Canvas canvas){
                float w=dp(36),h=dp(4);
                pill.set((getWidth()-w)/2f,dp(8),(getWidth()+w)/2f,dp(8)+h);
                paint.setColor(dragHandleColor);canvas.drawRoundRect(pill,h/2,h/2,paint);
            }
            @Override public boolean onTouchEvent(MotionEvent event){return handleDrag(event);}
            @Override public boolean performAccessibilityAction(int action,Bundle args){
                if(action==AccessibilityNodeInfo.ACTION_SCROLL_FORWARD){settleExpanded(true);return true;}
                if(action==AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD){if(expanded)settleExpanded(false);else dismissPhotoDetails.run();return true;}
                if(action==AccessibilityNodeInfo.ACTION_DISMISS){dismissPhotoDetails.run();return true;}
                return super.performAccessibilityAction(action,args);
            }
            @Override public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info){
                super.onInitializeAccessibilityNodeInfo(info);
                info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD);
                info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_BACKWARD);
                info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_DISMISS);
            }
        };
        dragHandle.setContentDescription("拖动展开或关闭照片详情");
        dragHandle.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);
        dragHandle.setFocusable(true);
        addView(dragHandle,0);
        requestLayout();
    }
    public View getDragHandle(){return dragHandle;}
    void setPhotoDetailGeometryListener(Runnable listener){geometryChanged=listener;}
    @Override public void setTranslationY(float value){super.setTranslationY(value);if(geometryChanged!=null)geometryChanged.run();}
    private int dp(float value){return Math.round(value*getResources().getDisplayMetrics().density);}
    private boolean handleDrag(MotionEvent event){
        switch(event.getActionMasked()){
            case MotionEvent.ACTION_DOWN:
                gestureStartY=event.getRawY();gestureStartFormHeight=form.getMeasuredHeight();gestureStartedExpanded=expanded;
                if(getParent()!=null)getParent().requestDisallowInterceptTouchEvent(true);return true;
            case MotionEvent.ACTION_MOVE:
                float delta=event.getRawY()-gestureStartY;
                if(!gestureStartedExpanded&&delta>0){setTranslationY(Math.min(delta,getHeight()));geometryChanged.run();}
                else{setTranslationY(0);draggedFormHeight=Math.max(0,gestureStartFormHeight-Math.round(delta));requestLayout();geometryChanged.run();}
                return true;
            case MotionEvent.ACTION_UP:
                float distance=event.getRawY()-gestureStartY;
                if(distance>dp(48)&&!gestureStartedExpanded){dismissPhotoDetails.run();return true;}
                setTranslationY(0);geometryChanged.run();
                if(distance>dp(48))settleExpanded(false);
                else if(distance<-dp(48))settleExpanded(true);
                else settleExpanded(gestureStartedExpanded);
                return true;
            case MotionEvent.ACTION_CANCEL:
                setTranslationY(0);geometryChanged.run();settleExpanded(gestureStartedExpanded);return true;
            default:return false;
        }
    }
    private void settleExpanded(boolean value){expanded=value;draggedFormHeight=-1;requestLayout();geometryChanged.run();}
    @Override protected LayoutParams generateDefaultLayoutParams(){return new LayoutParams(-1,-2);}
    @Override protected void onMeasure(int widthSpec,int heightSpec){
        // Expanded photo details still leave the upper third for the actual photo.
        if(dragHandle!=null)heightSpec=MeasureSpec.makeMeasureSpec(MeasureSpec.getSize(heightSpec)*2/3,MeasureSpec.AT_MOST);
        int width=MeasureSpec.getSize(widthSpec),available=Math.max(0,MeasureSpec.getSize(heightSpec)-getPaddingTop()-getPaddingBottom());
        int childWidth=MeasureSpec.makeMeasureSpec(Math.max(0,width-getPaddingLeft()-getPaddingRight()),MeasureSpec.EXACTLY);
        if(dragHandle!=null){dragHandle.measure(childWidth,MeasureSpec.makeMeasureSpec(dp(24),MeasureSpec.EXACTLY));available=Math.max(0,available-dragHandle.getMeasuredHeight());}
        footer.measure(childWidth,MeasureSpec.makeMeasureSpec(available,MeasureSpec.AT_MOST));available-=footer.getMeasuredHeight();
        title.measure(childWidth,MeasureSpec.makeMeasureSpec(available,MeasureSpec.AT_MOST));available-=title.getMeasuredHeight();
        int formHeight=Math.min(Math.max(0,available),draggedFormHeight>=0?draggedFormHeight:expanded?available:dp(maximumFormDp));
        form.measure(childWidth,MeasureSpec.makeMeasureSpec(formHeight,wrapForm?MeasureSpec.AT_MOST:MeasureSpec.EXACTLY));
        if(wrapForm)formHeight=form.getMeasuredHeight();
        setMeasuredDimension(width,resolveSize(getPaddingTop()+(dragHandle==null?0:dragHandle.getMeasuredHeight())+title.getMeasuredHeight()+formHeight+footer.getMeasuredHeight()+getPaddingBottom(),heightSpec));
    }
    @Override protected void onLayout(boolean changed,int l,int t,int r,int b){
        int y=getPaddingTop();if(dragHandle!=null){dragHandle.layout(getPaddingLeft(),y,getWidth()-getPaddingRight(),y+dragHandle.getMeasuredHeight());y+=dragHandle.getMeasuredHeight();}
        for(View child:new View[]{title,form,footer}){child.layout(getPaddingLeft(),y,getWidth()-getPaddingRight(),y+child.getMeasuredHeight());y+=child.getMeasuredHeight();}
    }
}
