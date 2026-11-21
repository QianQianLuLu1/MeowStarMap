package app.nikkisync.mobile.ui;

import static org.junit.Assert.*;
import android.app.Activity;
import android.widget.ProgressBar;
import android.widget.TextView;
import app.nikkisync.mobile.R;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
public class OperationProgressDialogTest {
    public static class HostActivity extends androidx.activity.ComponentActivity implements app.nikkisync.mobile.ui.chrome.ChromePage.Owner {
        app.nikkisync.mobile.ui.chrome.ChromeNavigationHost nav;
        public app.nikkisync.mobile.ui.chrome.ChromeNavigationHost navigationHost(){return nav;}
    }
    @Test public void productProgressUsesGlassStackAndCannotBeDismissedDuringSaving(){
        HostActivity activity=Robolectric.buildActivity(HostActivity.class).setup().get();activity.setTheme(R.style.AppTheme);
        activity.nav=new app.nikkisync.mobile.ui.chrome.ChromeNavigationHost(activity);activity.nav.setRoot(new android.view.View(activity));activity.setContentView(activity.nav);
        var dialog=new OperationProgressDialog(activity,"保存原图",null);dialog.show();assertEquals(1,activity.nav.overlayCount());
        activity.nav.progress(.8f);activity.nav.commit();activity.nav.interrupt();assertEquals(1,activity.nav.overlayCount());
        dialog.update("下载原图",3,4);assertEquals(75,dialog.bar().getProgress());
        dialog.dismiss();activity.nav.interrupt();assertEquals(0,activity.nav.overlayCount());activity.finish();
    }
    @Test public void explicitGenerationCancelRunsOnceAndStopsLateUpdates(){
        HostActivity activity=Robolectric.buildActivity(HostActivity.class).setup().get();activity.setTheme(R.style.AppTheme);
        activity.nav=new app.nikkisync.mobile.ui.chrome.ChromeNavigationHost(activity);activity.nav.setRoot(new android.view.View(activity));activity.setContentView(activity.nav);
        int[] count={0};var dialog=new OperationProgressDialog(activity,"生成分享图",()->count[0]++);dialog.show();
        dialog.cancel();assertEquals(1,count[0]);activity.nav.interrupt();dialog.cancel();assertEquals(1,count[0]);assertFalse(dialog.isShowing());activity.finish();
    }
    @Test public void committedPredictiveBackCancelsGenerationBeforeExitAnimationCompletes(){
        HostActivity activity=Robolectric.buildActivity(HostActivity.class).setup().get();activity.setTheme(R.style.AppTheme);
        activity.nav=new app.nikkisync.mobile.ui.chrome.ChromeNavigationHost(activity);activity.nav.setRoot(new android.view.View(activity));activity.setContentView(activity.nav);
        int[] count={0};var dialog=new OperationProgressDialog(activity,"生成分享图",()->count[0]++);dialog.show();
        activity.nav.commit();assertEquals("a late success must not outrun user cancellation",1,count[0]);
        activity.nav.interrupt();assertEquals(1,count[0]);activity.finish();
    }
    @Test public void unknownStageThenMeasuredProgressAndCompletionAreVisible() {
        Activity activity=Robolectric.buildActivity(Activity.class).setup().get();activity.setTheme(R.style.AppTheme);
        var dialog=new OperationProgressDialog(activity,"生成分享图",null);dialog.show();
        dialog.update("读取原图",0,0);assertTrue(dialog.bar().isIndeterminate());
        dialog.update("部件图片",4,16);assertFalse(dialog.bar().isIndeterminate());assertEquals(25,dialog.bar().getProgress());
        assertTrue(dialog.label().getText().toString().contains("4 / 16"));
        dialog.update("写入相册",3,3);assertEquals(100,dialog.bar().getProgress());dialog.dismiss();
        dialog.update("迟到结果",0,0);assertFalse(dialog.isShowing());
    }
}
