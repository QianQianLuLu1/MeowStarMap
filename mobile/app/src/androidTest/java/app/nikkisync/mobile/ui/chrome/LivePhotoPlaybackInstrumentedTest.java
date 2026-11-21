package app.nikkisync.mobile.ui.chrome;

import android.content.Context;
import android.net.Uri;
import android.os.SystemClock;
import android.view.*;
import android.widget.*;
import androidx.lifecycle.Lifecycle;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.ui.PlayerView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import app.nikkisync.mobile.MainActivity;
import app.nikkisync.mobile.media.live.*;
import app.nikkisync.mobile.storage.SavedPhotoStore;
import java.io.*;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.BooleanSupplier;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Real TextureView/codec test. Synthetic files only; never inserts media or changes saved history. */
@UnstableApi
@RunWith(AndroidJUnit4.class)
public class LivePhotoPlaybackInstrumentedTest {
    @Test public void savedLiveRendersLoopsMutedPausesAndReleasesOnBackground()throws Exception{
        var instrumentation=InstrumentationRegistry.getInstrumentation();Context context=instrumentation.getTargetContext();
        assertTrue("Accept the application's initial consent manually before this hardware test",new app.nikkisync.mobile.privacy.PrivacyConsentStore(context).accepted());
        File root=Files.createTempDirectory(context.getCacheDir().toPath(),"live-preview-hardware-").toFile();
        LivePhotoPlayback[] live={null};FrameLayout[] overlay={null};
        try{
            File image=asset(root,"corners.jpg"),video=asset(root,"corners-audio.mp4"),out=new File(root,"export");assertTrue(out.mkdir());
            var product=MotionContainer.write(LivePhotoProfile.STANDARD,image,video,out,new MotionContainer.Options(500000,12,24,1000000,"1760000000000abcdef000000000","synthetic"));
            var record=new SavedPhotoStore.Record("synthetic-live-preview",Uri.fromFile(product.primary()).toString(),0,true,0,null,null,"jpg",List.of(),LivePhotoProfile.STANDARD.id,true,500000,"synthetic");
            try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
                scenario.onActivity(activity->{
                    overlay[0]=new FrameLayout(activity);overlay[0].setBackgroundColor(0xff101012);activity.addContentView(overlay[0],new android.view.ViewGroup.LayoutParams(-1,-1));
                    live[0]=new LivePhotoPlayback(activity,MotionPreviewLoader.saved(activity,record));
                    overlay[0].addView(live[0].surface(),new FrameLayout.LayoutParams(-1,-1));
                    overlay[0].addView(live[0].controls(),new FrameLayout.LayoutParams(-2,144,Gravity.BOTTOM|Gravity.CENTER_HORIZONTAL));live[0].setEligible(true);
                });
                await(()->live[0].surface().getAlpha()==1f&&player(live[0]).isPlaying());
                CountDownLatch loop=new CountDownLatch(1);
                instrumentation.runOnMainSync(()->{
                    PlayerView view=(PlayerView)live[0].surface().getChildAt(0);assertTrue("TextureView must participate in photo transforms",view.getVideoSurfaceView() instanceof TextureView);
                    assertEquals(0,player(live[0]).getVolume(),0);assertEquals(Player.REPEAT_MODE_ONE,player(live[0]).getRepeatMode());
                    player(live[0]).addListener(new Player.Listener(){@Override public void onPositionDiscontinuity(Player.PositionInfo oldPosition,Player.PositionInfo newPosition,int reason){if(reason==Player.DISCONTINUITY_REASON_AUTO_TRANSITION)loop.countDown();}});
                });
                assertTrue("The actual video must loop, not just display a still",loop.await(5,TimeUnit.SECONDS));
                instrumentation.runOnMainSync(()->((Button)live[0].controls().getChildAt(0)).performClick());
                await(()->!player(live[0]).getPlayWhenReady());
                instrumentation.runOnMainSync(()->{assertEquals(1,live[0].surface().getAlpha(),0);((Button)live[0].controls().getChildAt(0)).performClick();});
                scenario.moveToState(Lifecycle.State.CREATED);
                instrumentation.runOnMainSync(()->{assertEquals(0,live[0].surface().getAlpha(),0);assertEquals(0,live[0].surface().getChildCount());});
                scenario.moveToState(Lifecycle.State.RESUMED);await(()->live[0].surface().getAlpha()==1f&&player(live[0]).isPlaying());
                instrumentation.runOnMainSync(()->{assertEquals(0,player(live[0]).getVolume(),0);live[0].close();((android.view.ViewGroup)overlay[0].getParent()).removeView(overlay[0]);});
            }
        }finally{
            instrumentation.runOnMainSync(()->{if(live[0]!=null)live[0].close();});
            try(var paths=Files.walk(root.toPath())){for(var p:paths.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(p);}
        }
    }
    private static Player player(LivePhotoPlayback live){return ((PlayerView)live.surface().getChildAt(0)).getPlayer();}
    private static void await(BooleanSupplier condition)throws Exception{
        long until=SystemClock.uptimeMillis()+10000;boolean[] ready={false};
        do{InstrumentationRegistry.getInstrumentation().runOnMainSync(()->ready[0]=condition.getAsBoolean());if(ready[0])return;SystemClock.sleep(50);}while(SystemClock.uptimeMillis()<until);
        fail("LIVE did not reach the expected rendered/playback state within 10 seconds");
    }
    private static File asset(File root,String name)throws Exception{
        File file=new File(root,name);try(InputStream in=InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("livephoto/"+name)){Files.copy(in,file.toPath());}return file;
    }
}
