package app.nikkisync.mobile.ui.chrome;
import android.view.View;
import android.view.MotionEvent;
import android.widget.EditText;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import android.os.Looper;
import java.time.Duration;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class)
public class ChromeNavigationHostTest {
    @Test public void scrollableDetailButtonsOwnTheirBackground(){
        var c=RuntimeEnvironment.getApplication();var host=new ChromeNavigationHost(c);host.setRoot(new View(c));
        var title=new android.widget.TextView(c);var form=new android.widget.LinearLayout(c);
        var button=new android.widget.Button(c);form.addView(button);
        var scroll=new android.widget.ScrollView(c);scroll.addView(form);
        var sheet=new ChromeSheetLayout(c,title,scroll,new View(c));host.showPhotoDetails(sheet);
        assertNotNull("button background must scroll and clip together with text",button.getBackground());
        assertEquals("scroll controls use their own glass drawable",c.getDrawable(app.nikkisync.mobile.R.drawable.bg_glass_chip).getClass(),button.getBackground().getClass());
    }
    @Test public void ordinarySheetIsOffscreenBeforeItsFirstMeasuredEntryFrame(){
        var context=RuntimeEnvironment.getApplication();var host=new ChromeNavigationHost(context);
        host.setRoot(new View(context));
        var title=new android.widget.TextView(context);title.setText("保存为");
        var body=new android.widget.LinearLayout(context);body.addView(new android.widget.Button(context));
        var sheet=new ChromeSheetLayout(context,title,body,new View(context)).wrapContentForm();
        host.showSheet(sheet);
        assertTrue("ordinary LIVE/save/input sheets must not paint at their final position first",sheet.getTranslationY()>0);
    }
    @Test public void photoDetailOutsideTapDismissesOnlySheetWithoutBlurringViewer(){
        var c=RuntimeEnvironment.getApplication();var host=new ChromeNavigationHost(c);
        View root=new View(c);host.setRoot(root);
        class RecordingView extends View {
            android.graphics.RenderEffect effect;
            RecordingView(){super(c);}
            @Override public void setRenderEffect(android.graphics.RenderEffect next){super.setRenderEffect(next);effect=next;}
        }
        RecordingView viewer=new RecordingView();host.push(viewer);
        var title=new android.widget.TextView(c);title.setText("照片详情");
        var sheet=new ChromeSheetLayout(c,title,new android.widget.ScrollView(c),new android.widget.FrameLayout(c));
        host.showPhotoDetails(sheet);
        assertEquals(2,host.overlayCount());
        host.measure(View.MeasureSpec.makeMeasureSpec(800,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(1600,View.MeasureSpec.EXACTLY));
        host.layout(0,0,800,1600);
        tap(host,30,30);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2));
        assertEquals("sheet top="+sheet.getTop()+" height="+sheet.getHeight()+" host="+host.getHeight(),1,host.overlayCount());
        assertSame(host,viewer.getParent());
        assertNull(viewer.effect);
    }
    @Test public void ordinarySheetsIgnoreOutsideTap(){
        var c=RuntimeEnvironment.getApplication();var host=new ChromeNavigationHost(c);
        host.setRoot(new View(c));View sheet=new View(c);host.showSheet(sheet);
        host.measure(View.MeasureSpec.makeMeasureSpec(800,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(1600,View.MeasureSpec.EXACTLY));
        host.layout(0,0,800,1600);
        tap(host,30,30);
        assertEquals(1,host.overlayCount());
    }
    private static void tap(View view,float x,float y){
        long now=android.os.SystemClock.uptimeMillis();
        view.dispatchTouchEvent(MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,x,y,0));
        view.dispatchTouchEvent(MotionEvent.obtain(now,now+20,MotionEvent.ACTION_UP,x,y,0));
    }
    @Test public void pageIsHiddenBeforeItsPostedEntryAnimation() {
        var context=RuntimeEnvironment.getApplication();
        var host=new ChromeNavigationHost(context);host.setRoot(new View(context));
        View page=new View(context);host.push(page);
        assertEquals("no opaque first frame before animation starts",0f,page.getAlpha(),0f);
    }
    @Test public void buttonBackDoesNotBlurGalleryDuringExit() throws Exception {
        var activity=org.robolectric.Robolectric.buildActivity(android.app.Activity.class).setup().visible().get();
        var host=new ChromeNavigationHost(activity);activity.setContentView(host);
        class RecordingView extends View {
            android.graphics.RenderEffect effect;
            RecordingView(android.content.Context context){super(context);}
            @Override public void setRenderEffect(android.graphics.RenderEffect next){super.setRenderEffect(next);effect=next;}
        }
        var gallery=new RecordingView(activity);host.setRoot(gallery);
        host.measure(View.MeasureSpec.makeMeasureSpec(1000,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(2000,View.MeasureSpec.EXACTLY));
        host.layout(0,0,1000,2000);
        host.push(new View(activity));
        host.commit();
        java.lang.reflect.Field current=ChromeNavigationHost.class.getDeclaredField("animation");
        current.setAccessible(true);
        android.animation.ValueAnimator animator=(android.animation.ValueAnimator)current.get(host);
        assertNotNull(animator);
        animator.setCurrentPlayTime(0);
        assertNull("a direct return must leave the exposed gallery sharp",gallery.effect);
        animator.setCurrentPlayTime(85);
        assertNull("the gallery must stay sharp through the exit",gallery.effect);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(400));
        assertNull(gallery.effect);
        activity.finish();
    }
    @Test public void immediateBackCannotBeOverwrittenByPostedEntryAnimation(){
        var activity=org.robolectric.Robolectric.buildActivity(android.app.Activity.class).setup().visible().get();
        var host=new ChromeNavigationHost(activity);activity.setContentView(host);host.setRoot(new View(activity));
        host.push(new View(activity));host.commit();
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2));
        assertFalse(host.hasOverlay());activity.finish();
    }
    @Test public void overlaysHideUnderlyingAccessibilityAndKeyboardFocus(){
        var c=RuntimeEnvironment.getApplication();var host=new ChromeNavigationHost(c);
        var root=new android.widget.FrameLayout(c);host.setRoot(root);var page=new android.widget.FrameLayout(c);host.push(page);
        assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS,root.getImportantForAccessibility());
        assertEquals(android.view.ViewGroup.FOCUS_BLOCK_DESCENDANTS,root.getDescendantFocusability());
        var sheet=new EditText(c);host.showSheet(sheet);
        assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS,page.getImportantForAccessibility());
        host.commit();Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2));
        assertNotEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS,page.getImportantForAccessibility());
    }
    @Test public void latePushedPageInheritsWindowInsets() {
        var c=RuntimeEnvironment.getApplication();var host=new ChromeNavigationHost(c);host.setRoot(new View(c));
        host.dispatchApplyWindowInsets(new android.view.WindowInsets.Builder().setInsets(android.view.WindowInsets.Type.statusBars(),android.graphics.Insets.of(0,80,0,0)).build());
        ChromeHost page=new ChromeHost(c);View header=new View(c);page.installChrome(header,new View(c));host.push(page);
        assertEquals(80,((android.widget.FrameLayout.LayoutParams)header.getLayoutParams()).topMargin);
    }
    @Test public void cancelKeepsInputAndDuplicateCommitConsumesOnlyOneLayer() {
        var context=RuntimeEnvironment.getApplication();
        ChromeNavigationHost host=new ChromeNavigationHost(context);
        host.setRoot(new View(context));
        View page=new View(context);host.push(page);
        EditText input=new EditText(context);input.setText("未保存输入");host.showSheet(input);
        host.measure(View.MeasureSpec.makeMeasureSpec(1000,1073741824),View.MeasureSpec.makeMeasureSpec(2000,1073741824));host.layout(0,0,1000,2000);
        host.progress(.5f);host.cancel();
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2));
        assertEquals("未保存输入",input.getText().toString());assertEquals(2,host.overlayCount());
        host.progress(.5f);host.commit();host.commit();
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2));
        assertEquals(1,host.overlayCount());assertEquals(host,page.getParent());
        host.commit();Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2));
        assertFalse(host.hasOverlay());
    }
}
