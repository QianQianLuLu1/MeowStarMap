package app.nikkisync.mobile.ui.chrome;
import android.view.*;
import android.widget.ScrollView;
import android.widget.FrameLayout;
import android.widget.TextView;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class)
public class ChromeSheetLayoutTest {
    @Test public void photoHandleDragExpandsThenCollapsesWithoutTakingFormScroll(){
        var c=RuntimeEnvironment.getApplication();
        ScrollView form=new ScrollView(c);form.addView(new View(c),new ScrollView.LayoutParams(-1,4000));
        TextView title=new TextView(c);title.setText("照片详情");
        var panel=new ChromeSheetLayout(c,title,form,new FrameLayout(c));
        panel.enablePhotoDetailDragging(()->{});
        int width=View.MeasureSpec.makeMeasureSpec(800,View.MeasureSpec.EXACTLY);
        int height=View.MeasureSpec.makeMeasureSpec(2600,View.MeasureSpec.AT_MOST);
        panel.measure(width,height);panel.layout(0,0,800,panel.getMeasuredHeight());
        int collapsed=panel.getMeasuredHeight();
        View handle=panel.getDragHandle();
        assertNotNull(handle);
        assertTrue(handle.getHeight()>0);
        drag(handle,400,180);
        panel.measure(width,height);panel.layout(0,0,800,panel.getMeasuredHeight());
        assertTrue("expanded="+panel.getMeasuredHeight()+" collapsed="+collapsed,panel.getMeasuredHeight()>collapsed);
        int expanded=panel.getMeasuredHeight();
        drag(form,300,100);
        panel.measure(width,height);panel.layout(0,0,800,panel.getMeasuredHeight());
        assertEquals("form scroll does not resize sheet",expanded,panel.getMeasuredHeight());
        drag(handle,180,400);
        panel.measure(width,height);panel.layout(0,0,800,panel.getMeasuredHeight());
        assertEquals(collapsed,panel.getMeasuredHeight());
    }
    @Test public void draggingDownFromCollapsedPhotoHandleRequestsDismiss(){
        var c=RuntimeEnvironment.getApplication();final int[] closes={0};
        var panel=new ChromeSheetLayout(c,new View(c),new View(c),new View(c));
        panel.enablePhotoDetailDragging(()->closes[0]++);
        panel.measure(View.MeasureSpec.makeMeasureSpec(800,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(1600,View.MeasureSpec.AT_MOST));
        panel.layout(0,0,800,panel.getMeasuredHeight());
        drag(panel.getDragHandle(),180,400);
        assertEquals(1,closes[0]);
    }
    private static void drag(View handle,float from,float to){
        long now=android.os.SystemClock.uptimeMillis();
        assertTrue(handle.dispatchTouchEvent(MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,30,from,0)));
        assertTrue(handle.dispatchTouchEvent(MotionEvent.obtain(now,now+16,MotionEvent.ACTION_MOVE,30,(from+to)/2,0)));
        assertTrue(handle.dispatchTouchEvent(MotionEvent.obtain(now,now+32,MotionEvent.ACTION_MOVE,30,to,0)));
        assertTrue(handle.dispatchTouchEvent(MotionEvent.obtain(now,now+48,MotionEvent.ACTION_UP,30,to,0)));
    }
    @Test public void keyboardHeightAlwaysReservesFooterBeforeScrollableForm(){
        var c=RuntimeEnvironment.getApplication();View title=new View(c),form=new View(c),footer=new View(c);
        title.setMinimumHeight(90);form.setMinimumHeight(1300);footer.setMinimumHeight(150);
        var panel=new ChromeSheetLayout(c,title,form,footer);
        for(int height:new int[]{900,420,240}){
            panel.measure(View.MeasureSpec.makeMeasureSpec(800,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(height,View.MeasureSpec.AT_MOST));panel.layout(0,0,800,panel.getMeasuredHeight());
            assertTrue(footer.getBottom()<=height);assertTrue(footer.getHeight()>0);assertTrue(form.getBottom()<=footer.getTop());
        }
    }
}
