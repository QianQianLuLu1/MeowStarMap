package app.nikkisync.mobile.ui.chrome;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.FrameLayout;
import android.widget.TextView;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class)
public class PhotoLayoutDockTest {
    @Test public void tabSelectionUsesGlassWithoutTheThemedPinkRipple() {
        var dock=new PhotoLayoutDock(RuntimeEnvironment.getApplication(),i->{});
        LinearLayout row=(LinearLayout)dock.getChildAt(1);
        for(int i=0;i<row.getChildCount();i++)assertNull("no colored overlay on tab press",row.getChildAt(i).getForeground());
        var color=((android.graphics.drawable.GradientDrawable)dock.getChildAt(0).getBackground()).getColor();
        assertNotNull(color);
        assertEquals("glass highlight has neutral channels",android.graphics.Color.red(color.getDefaultColor()),android.graphics.Color.green(color.getDefaultColor()));
        assertTrue("glass highlight remains light",android.graphics.Color.red(color.getDefaultColor())>200);
    }
    @Test public void oneIndicatorMovesBehindTransparentClickableItems() {
        int[] selected={-1};
        var dock=new PhotoLayoutDock(RuntimeEnvironment.getApplication(),i->selected[0]=i);
        dock.measure(View.MeasureSpec.makeMeasureSpec(360,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(68,View.MeasureSpec.EXACTLY));
        dock.layout(0,0,360,68);
        View indicator=dock.getChildAt(0);
        LinearLayout row=(LinearLayout)dock.getChildAt(1);
        assertEquals(3,row.getChildCount());
        for(int i=0;i<3;i++){
            var item=(FrameLayout)row.getChildAt(i);
            var content=(LinearLayout)item.getChildAt(0);
            var label=(TextView)content.getChildAt(1);
            assertEquals(1,label.getMaxLines());
            assertEquals(1,label.getLineCount());
        }
        row.getChildAt(2).performClick();
        assertEquals(2,selected[0]);
        dock.select(2);
        assertEquals(0,indicator.getTranslationX(),.01);
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(400));
        assertEquals(row.getChildAt(2).getLeft(),indicator.getTranslationX(),1);
        assertNull(row.getChildAt(2).getBackground());
        assertTrue(row.getChildAt(2).isSelected());
    }
}
