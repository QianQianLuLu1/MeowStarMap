package app.nikkisync.mobile.ui.chrome;

import android.view.MotionEvent;
import android.view.View;
import android.widget.ScrollView;
import java.time.Duration;
import java.util.ArrayList;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
public class HomeTabPagerTest {
    @Test public void gallerySelectionOwnsHorizontalSwipeUntilSelectionEnds() {
        var f=fixture();f.pager.setSelectionActive(true);
        event(f.pager,0,800,800,0);event(f.pager,2,300,800,100);event(f.pager,1,300,800,200);idle();
        assertTrue(f.selected.isEmpty());
        f.pager.setSelectionActive(false);
        event(f.pager,0,800,800,300);event(f.pager,2,300,800,400);event(f.pager,1,300,800,500);idle();
        assertEquals(java.util.List.of(1),f.selected);
    }
    private record Fixture(HomeTabPager pager,ArrayList<Integer> selected,View[] pages){}
    private Fixture fixture(){
        var c=RuntimeEnvironment.getApplication();var selected=new ArrayList<Integer>();
        var pager=new HomeTabPager(c,selected::add,i->{});View[] pages={new ScrollView(c),new ScrollView(c),new ScrollView(c)};
        for(View page:pages){View body=new View(c);body.setMinimumHeight(4000);((ScrollView)page).addView(body,new ScrollView.LayoutParams(-1,4000));pager.addPage(page);}
        pager.measure(View.MeasureSpec.makeMeasureSpec(1000,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(1600,View.MeasureSpec.EXACTLY));pager.layout(0,0,1000,1600);
        return new Fixture(pager,selected,pages);
    }
    private static void event(View view,int action,float x,float y,long time){var e=MotionEvent.obtain(0,time,action,x,y,0);view.dispatchTouchEvent(e);e.recycle();}
    private static void idle(){Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(Duration.ofSeconds(1));}
    @Test public void dragCancelPreservesPageStateAndTapSwitchSlidesWithoutAlpha(){
        var f=fixture();f.pages[0].scrollTo(0,123);
        assertEquals("fixture has scrollable content",123,f.pages[0].getScrollY());
        event(f.pager,0,800,800,0);event(f.pager,2,400,800,100);
        assertEquals(-400,f.pages[0].getTranslationX(),.01f);assertEquals(600,f.pages[1].getTranslationX(),.01f);
        event(f.pager,MotionEvent.ACTION_CANCEL,400,800,150);idle();
        assertTrue(f.selected.isEmpty());assertEquals(0,f.pages[0].getTranslationX(),0);assertEquals(123,f.pages[0].getScrollY());
        f.pager.select(2);
        assertEquals(1,f.pages[0].getAlpha(),0);assertEquals(1,f.pages[2].getAlpha(),0);
        assertEquals(View.VISIBLE,f.pages[0].getVisibility());assertEquals(1000,f.pages[2].getTranslationX(),.01f);
        idle();assertEquals(View.GONE,f.pages[0].getVisibility());assertEquals(View.VISIBLE,f.pages[2].getVisibility());
        f.pager.select(0);idle();assertEquals(123,f.pages[0].getScrollY());
    }
    @Test public void verticalSystemEdgeAndSecondFingerCannotCommitATab(){
        var f=fixture();
        event(f.pager,0,500,500,0);event(f.pager,2,530,1000,100);event(f.pager,1,530,1000,200);assertTrue(f.selected.isEmpty());
        event(f.pager,0,5,800,300);event(f.pager,2,650,800,400);event(f.pager,1,650,800,500);assertTrue(f.selected.isEmpty());
        event(f.pager,0,800,800,600);event(f.pager,2,350,800,700);
        event(f.pager,MotionEvent.ACTION_POINTER_DOWN,350,800,720);event(f.pager,1,350,800,800);idle();
        assertTrue(f.selected.isEmpty());assertEquals(0,f.pages[0].getTranslationX(),0);
        assertEquals(View.GONE,f.pages[1].getVisibility());
    }
    @Test public void resizeAndRapidTabChangesSettleWithoutGhostPages(){
        var f=fixture();f.pager.select(1);f.pager.select(2);f.pager.interrupt();idle();
        assertEquals(View.VISIBLE,f.pages[2].getVisibility());assertEquals(View.GONE,f.pages[0].getVisibility());assertEquals(View.GONE,f.pages[1].getVisibility());
        for(View page:f.pages){assertEquals(0,page.getTranslationX(),0);assertEquals(1,page.getAlpha(),0);}
        event(f.pager,0,500,800,0);event(f.pager,2,850,800,100);
        f.pager.layout(0,0,1100,1600);idle();assertTrue(f.selected.isEmpty());assertEquals(0,f.pages[2].getTranslationX(),0);
    }
    @Test public void childStoppingAFlingCannotSwallowTheNextHorizontalSwipe(){
        var f=fixture();
        f.pages[0].setOnTouchListener((v,e)->{v.getParent().requestDisallowInterceptTouchEvent(true);return true;});
        event(f.pager,0,800,800,0);event(f.pager,2,400,800,100);event(f.pager,1,400,800,200);idle();
        assertEquals(java.util.List.of(1),f.selected);
        f.pager.select(0);idle();
        event(f.pager,0,500,500,300);event(f.pager,2,520,1000,400);event(f.pager,1,520,1000,500);
        assertEquals("the same child still owns vertical gestures",java.util.List.of(1),f.selected);
    }
}
