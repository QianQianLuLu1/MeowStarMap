package app.nikkisync.mobile.ui.chrome;

import android.graphics.Bitmap;
import android.graphics.RectF;
import android.view.View;
import android.widget.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
public class PhotoDetailsViewportTest {
    @Test public void openingAnimationMovesThePhotoBeforeTheSheetHasSettled() throws Exception {
        Fixture f=new Fixture();
        try {
            var durationScale=android.animation.ValueAnimator.class.getDeclaredMethod("setDurationScale",float.class);
            durationScale.setAccessible(true);durationScale.invoke(null,1f);
            float start=pixels(f).centerY();f.page.openDetails();f.layout();
            var animation=ChromeNavigationHost.class.getDeclaredField("animation");animation.setAccessible(true);
            var animator=(android.animation.ValueAnimator)animation.get(f.activity.nav);assertNotNull(animator);
            animator.setCurrentPlayTime(0);assertEquals(start,pixels(f).centerY(),.01f);
            animator.setCurrentPlayTime(100);
            assertUncovered(f,f.sheet());float moving=pixels(f).centerY();
            assertTrue("photo moves during entry, not only after animation",moving<start);
            animator.setCurrentPlayTime(200);assertUncovered(f,f.sheet());assertTrue(pixels(f).centerY()<moving);
            idle();assertUncovered(f,f.sheet());
            // A late, differently shaped preview must refit without another open/close.
            f.image.setImageBitmap(Bitmap.createBitmap(1600,1000,Bitmap.Config.ARGB_8888));
            f.layout();assertUncovered(f,f.sheet());
        } finally {f.close();}
    }
    @Test public void ordinaryAndRotatedPhotosFollowEverySheetPositionAndRestoreOnClose() throws Exception {
        for(int rotation:new int[]{0,90,180,270}) {
            Fixture f=new Fixture();
            try {
                f.image.setRotation(rotation);f.page.refreshImageTransform();
                float originalScale=f.image.getScaleX();
                f.page.openDetails();idle();f.layout();
                ChromeSheetLayout sheet=f.sheet();
                assertUncovered(f,sheet);
                float openCenter=pixels(f).centerY();
                f.activity.nav.progress(.5f);
                assertUncovered(f,sheet);
                assertTrue("photo follows moving sheet on the same frame",pixels(f).centerY()>openCenter);
                f.activity.nav.cancel();idle();assertUncovered(f,sheet);
                f.activity.nav.commit();idle();f.layout();
                assertEquals(originalScale,f.image.getScaleX(),.001f);
                assertEquals(0,f.image.getTranslationY(),.001f);
                f.page.openDetails();idle();f.layout();assertUncovered(f,f.sheet());
            } finally {f.close();}
        }
    }
    @Test public void expandingDetailsRetainsPhotoSpaceAndCancelTracksDraggedSheet() throws Exception {
        Fixture f=new Fixture();
        try {
            f.page.openDetails();idle();f.layout();ChromeSheetLayout sheet=f.sheet();
            sheet.getDragHandle().performAccessibilityAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_SCROLL_FORWARD,null);
            f.layout();
            assertTrue("expanded details reserve a visible preview",sheet.getTop()>=f.page.getHeight()/3-2);
            assertUncovered(f,sheet);
            sheet.getDragHandle().performAccessibilityAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD,null);f.layout();
            RectF before=pixels(f);
            sheet.setTranslationY(120);assertUncovered(f,sheet);
            assertTrue(pixels(f).centerY()>before.centerY());
            sheet.setTranslationY(0);assertEquals(before.centerY(),pixels(f).centerY(),.01f);
        } finally {f.close();}
    }
    @Test public void closingDetailsRestoresExistingZoomAndPanRatherThanResettingUserPreview() throws Exception {
        Fixture f=new Fixture();
        try {
            var zoom=PhotoViewerPage.class.getDeclaredMethod("zoomAt",float.class,float.class,float.class);zoom.setAccessible(true);
            zoom.invoke(f.page,2.5f,f.page.getWidth()*.65f,f.page.getHeight()*.55f);
            float scale=f.image.getScaleX(),x=f.image.getTranslationX(),y=f.image.getTranslationY();
            f.page.openDetails();idle();f.layout();assertUncovered(f,f.sheet());
            f.activity.nav.commit();idle();f.layout();
            assertEquals(scale,f.image.getScaleX(),.001f);assertEquals(x,f.image.getTranslationX(),.001f);assertEquals(y,f.image.getTranslationY(),.001f);
        } finally {f.close();}
    }
    private static RectF pixels(Fixture f) {
        float iw=f.image.getDrawable().getIntrinsicWidth(),ih=f.image.getDrawable().getIntrinsicHeight();
        float base=PhotoViewerPage.fitScale(f.image.getWidth(),f.image.getHeight(),iw,ih,0);
        boolean sideways=Math.round(f.image.getRotation()/90)%2!=0;
        float w=(sideways?ih:iw)*base*f.image.getScaleX(),h=(sideways?iw:ih)*base*f.image.getScaleY();
        float cx=f.image.getWidth()/2f+f.image.getTranslationX(),cy=f.image.getHeight()/2f+f.image.getTranslationY();
        return new RectF(cx-w/2,cy-h/2,cx+w/2,cy+h/2);
    }
    private static void assertUncovered(Fixture f,ChromeSheetLayout sheet) {
        RectF r=pixels(f);float top=sheet.getTop()+sheet.getTranslationY();
        assertTrue("entire photo must stay above details: "+r+" / "+top,r.bottom<=top+1);
        assertTrue("photo stays within upper screen",r.top>=-1);
        assertTrue(r.left>=-1);assertTrue(r.right<=f.page.getWidth()+1);assertTrue(r.height()>1);
    }
    private static void idle(){org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(1));}
    private static final class Fixture {
        final PhotoViewerPageTest.HostActivity activity=Robolectric.buildActivity(PhotoViewerPageTest.HostActivity.class).setup().visible().get();
        final PhotoViewerPage page;final ImageView image;
        Fixture(){
            activity.nav=new ChromeNavigationHost(activity);activity.nav.setRoot(new View(activity));activity.setContentView(activity.nav);
            page=new PhotoViewerPage(activity,null);ScrollView scroll=new ScrollView(activity);LinearLayout body=new LinearLayout(activity);scroll.addView(body);
            body.addView(new LinearLayout(activity));image=new ImageView(activity);body.addView(image);
            image.setImageBitmap(Bitmap.createBitmap(1000,1600,Bitmap.Config.ARGB_8888));
            page.setContentView(scroll);page.show();idle();layout();page.setReveal(1);page.settle();
        }
        void layout(){int w=activity.nav.getWidth(),h=activity.nav.getHeight();assertTrue(w>0&&h>0);activity.nav.measure(View.MeasureSpec.makeMeasureSpec(w,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(h,View.MeasureSpec.EXACTLY));activity.nav.layout(0,0,w,h);}
        ChromeSheetLayout sheet() throws Exception {var field=PhotoViewerPage.class.getDeclaredField("sheet");field.setAccessible(true);return (ChromeSheetLayout)field.get(page);}
        void close(){activity.nav.close();activity.finish();}
    }
}
