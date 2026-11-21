package app.nikkisync.mobile.share;
import android.net.Uri;
import android.view.*;
import android.widget.*;
import app.nikkisync.mobile.R;
import app.nikkisync.mobile.ui.chrome.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import java.nio.file.Files;
import java.util.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
public class ShareCardPreviewNavigationTest {
    public static class HostActivity extends androidx.activity.ComponentActivity implements ChromePage.Owner {
        ChromeNavigationHost nav;public ChromeNavigationHost navigationHost(){return nav;}
    }
    @Test public void previewHasThreeActionsAndPredictiveCancelRetainsPagesUntilRealRemoval()throws Exception{
        HostActivity activity=Robolectric.buildActivity(HostActivity.class).setup().get();activity.setTheme(R.style.AppTheme);
        activity.nav=new ChromeNavigationHost(activity);activity.nav.setRoot(new View(activity));activity.setContentView(activity.nav);
        var dir=Files.createTempDirectory(activity.getCacheDir().toPath(),"preview-test-");var file=dir.resolve("page.png");Files.write(file,new byte[]{1});
        var prepared=new ShareCardPreparation.Prepared(dir.toFile(),List.of(file.toFile()),"a",0);
        Queue<Runnable> work=new ArrayDeque<>();var coordinator=new ShareCardExportCoordinator(activity,work::add,Runnable::run);
        var preview=new ShareCardPreviewDialog(activity,prepared,coordinator,work::add,false,p->Uri.EMPTY);preview.show();
        activity.nav.measure(View.MeasureSpec.makeMeasureSpec(800,1073741824),View.MeasureSpec.makeMeasureSpec(1600,1073741824));activity.nav.layout(0,0,800,1600);activity.nav.interrupt();
        for(String label:List.of("保存分享图","保存原图+分享图","关闭"))assertNotNull(find(activity.nav,label));
        View page=activity.nav.getChildAt(1);activity.nav.progress(.5f);assertTrue(page.getTranslationX()>0);
        activity.nav.cancel();activity.nav.interrupt();assertTrue(preview.isShowing());assertTrue(Files.exists(file));
        activity.nav.commit();activity.nav.interrupt();assertFalse(preview.isShowing());assertFalse(Files.exists(dir));
        while(!work.isEmpty())work.remove().run();Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();assertEquals(0,activity.nav.overlayCount());activity.finish();
    }
    @Test public void partialCombinedSaveKeepsShareUriAndRetryDoesNotDuplicateIt(){
        var context=RuntimeEnvironment.getApplication();var coordinator=new ShareCardExportCoordinator(context,Runnable::run,Runnable::run);Uri uri=Uri.parse("content://media/share/1");int[] original={0},success={0};
        coordinator.saveBoth(null,0,uri,p->{original[0]++;throw new java.io.IOException("offline");},new ShareCardExportCoordinator.SaveListener(){
            public void onSuccess(Uri result){fail();}public void onFailure(Exception error){assertTrue(error instanceof ShareCardExportCoordinator.PartialSaveException);assertEquals(uri,((ShareCardExportCoordinator.PartialSaveException)error).shareUri);}
        });
        coordinator.saveBoth(null,0,uri,p->{original[0]++;return Uri.EMPTY;},new ShareCardExportCoordinator.SaveListener(){
            public void onSuccess(Uri result){assertEquals(uri,result);success[0]++;}public void onFailure(Exception error){fail(error.toString());}
        });assertEquals(2,original[0]);assertEquals(1,success[0]);
    }
    private View find(View view,String label){if(view instanceof TextView text&&label.contentEquals(text.getText()))return view;if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++){View found=find(group.getChildAt(i),label);if(found!=null)return found;}return null;}
}
