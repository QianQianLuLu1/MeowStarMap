package app.nikkisync.mobile;

import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import app.nikkisync.mobile.ui.chrome.ChromeNavigationHost;
import app.nikkisync.mobile.ui.SavedFilterSheet;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import android.os.Looper;
import java.time.Duration;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
public class SavedFilterSheetIntegrationTest {
    @Test public void savedToolbarOpensCompactFilterSheet() throws Exception {
        MainActivity activity=activity();
        LinearLayout controls=controls(activity);
        controls.setVisibility(View.VISIBLE);
        for(int width:new int[]{320,360}) {
            int densityWidth=Math.round(width*activity.getResources().getDisplayMetrics().density);
            controls.measure(View.MeasureSpec.makeMeasureSpec(densityWidth,View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(1000,View.MeasureSpec.AT_MOST));
            assertTrue("saved controls should occupy one compact row at "+width+"dp",controls.getMeasuredHeight()<=dp(activity,60));
        }

        Button trigger=findButton(controls,"筛选");
        assertNotNull("saved controls need a filter sheet entry",trigger);
        trigger.performClick();
        assertEquals(1,navigation(activity).overlayCount());
    }

    @Test public void filterAndSortChangeOnlyAfterApply() throws Exception {
        MainActivity activity=activity();
        findButton(controls(activity),"筛选").performClick();
        ChromeNavigationHost navigation=navigation(activity);
        View sheet=navigation.getChildAt(navigation.getChildCount()-1);
        findButton(sheet,"LIVE").performClick();
        findButton(sheet,"拍摄时间").performClick();
        assertEquals(0,intField(activity,"savedFilter"));
        assertEquals(0,intField(activity,"savedSort"));
        findButton(sheet,"应用").performClick();
        assertEquals(1,intField(activity,"savedFilter"));
        assertEquals(1,intField(activity,"savedSort"));
        assertTrue(findButton(controls(activity),"LIVE · 拍摄时间")!=null);
    }

    @Test public void predictiveBackDiscardsUnappliedSelection() throws Exception {
        MainActivity activity=activity();
        findButton(controls(activity),"筛选").performClick();
        ChromeNavigationHost navigation=navigation(activity);
        View sheet=navigation.getChildAt(navigation.getChildCount()-1);
        findButton(sheet,"LIVE").performClick();
        navigation.progress(.5f);
        navigation.commit();
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2));
        assertEquals(0,navigation.overlayCount());
        assertEquals(0,intField(activity,"savedFilter"));
    }

    @Test public void recoveryActionCannotStartTwiceWhileSheetDismisses() {
        MainActivity activity=Robolectric.buildActivity(MainActivity.class).get();
        SavedFilterSheet sheet=new SavedFilterSheet(activity,0,0);
        int[] recoveries={0};
        sheet.setListener(new SavedFilterSheet.Listener() {
            @Override public void onApply(int filter,int sort) {}
            @Override public void onRecoverHistoricalSavedPhotos() {recoveries[0]++;}
            @Override public void onCancel() {}
        });
        Button recover=findButton(sheet,"找回历史保存");
        assertNotNull(recover);
        recover.performClick();
        recover.performClick();
        assertEquals(1,recoveries[0]);
    }

    @Test public void applyCannotSubmitTwiceWhileSheetDismisses() {
        MainActivity activity=Robolectric.buildActivity(MainActivity.class).get();
        SavedFilterSheet sheet=new SavedFilterSheet(activity,0,0);
        int[] applications={0};
        sheet.setListener(new SavedFilterSheet.Listener() {
            @Override public void onApply(int filter,int sort) {applications[0]++;}
            @Override public void onRecoverHistoricalSavedPhotos() {}
            @Override public void onCancel() {}
        });
        Button apply=findButton(sheet,"应用");
        assertNotNull(apply);
        apply.performClick();
        apply.performClick();
        assertEquals(1,applications[0]);
    }

    private static MainActivity activity() throws Exception {
        MainActivity activity=Robolectric.buildActivity(MainActivity.class).get();
        Method buildUi=MainActivity.class.getDeclaredMethod("buildUi");
        buildUi.setAccessible(true);
        buildUi.invoke(activity);
        return activity;
    }
    private static LinearLayout controls(MainActivity activity) throws Exception {
        Field field=MainActivity.class.getDeclaredField("savedControls");
        field.setAccessible(true);
        LinearLayout controls=(LinearLayout)field.get(activity);
        controls.setVisibility(View.VISIBLE);
        return controls;
    }
    private static ChromeNavigationHost navigation(MainActivity activity) throws Exception {
        Field field=MainActivity.class.getDeclaredField("navigation");
        field.setAccessible(true);
        return (ChromeNavigationHost)field.get(activity);
    }
    private static int intField(MainActivity activity,String name) throws Exception {
        Field field=MainActivity.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.getInt(activity);
    }

    private static int dp(MainActivity activity,int value) {
        return Math.round(value*activity.getResources().getDisplayMetrics().density);
    }
    private static Button findButton(View view,String text) {
        if(view instanceof Button button && button.getText().toString().contains(text))return button;
        if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++){
            Button found=findButton(group.getChildAt(i),text);if(found!=null)return found;
        }
        return null;
    }
}
