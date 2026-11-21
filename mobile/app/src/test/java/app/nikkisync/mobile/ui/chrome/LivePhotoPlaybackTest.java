package app.nikkisync.mobile.ui.chrome;

import android.app.Activity;
import android.view.View;
import android.widget.Button;
import app.nikkisync.mobile.media.live.MotionPreviewLoader;
import java.io.File;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
public class LivePhotoPlaybackTest {
    private Activity activity;private FakeSource source;private FakeEngine engine;private LivePhotoPlayback playback;
    @Before public void setup(){activity=Robolectric.buildActivity(Activity.class).setup().get();source=new FakeSource();playback=new LivePhotoPlayback(activity,source,(context,file,events)->engine=new FakeEngine(new View(context),events));}
    @After public void cleanup(){playback.close();activity.finish();}
    @Test public void opensMutedAndAutoplaysOnlyAfterEntryAndFirstFrame(){
        assertNull(source.callback);playback.setEligible(true);Video video=new Video();source.callback.ready(video);
        assertTrue(engine.playing);assertTrue(engine.muted);assertEquals(0,playback.surface().getAlpha(),0);
        engine.events.firstFrame();assertEquals(1,playback.surface().getAlpha(),0);
        button(0).performClick();assertFalse(engine.playing);assertEquals(1,playback.surface().getAlpha(),0);
        button(1).performClick();assertFalse(engine.muted);
    }
    @Test public void swipeAndBackHideMovieRetainCoverAndRespectManualPause(){
        playback.setEligible(true);source.callback.ready(new Video());engine.events.firstFrame();
        playback.setEligible(false);assertFalse(engine.playing);assertEquals(0,playback.surface().getAlpha(),0);
        playback.setEligible(true);assertTrue(engine.playing);button(0).performClick();
        playback.setEligible(false);playback.setEligible(true);assertFalse("Cancel back must not override a manual pause",engine.playing);
    }
    @Test public void closingCancelsAndReleasesPlayerAndIgnoresLateResults(){
        playback.setEligible(true);Video first=new Video();source.callback.ready(first);playback.close();
        assertTrue(source.cancelled);assertTrue(engine.released);assertTrue(first.closed);
        Video late=new Video();source.callback.ready(late);assertTrue("Late downloads must return their cache lease",late.closed);
        engine.events.firstFrame();assertEquals(0,playback.surface().getAlpha(),0);
    }
    @Test public void failedVideoKeepsPosterAndRetryStartsAFreshRequest(){
        playback.setEligible(true);source.callback.failed();assertEquals(0,playback.surface().getAlpha(),0);
        assertTrue(button(0).getText().toString().contains("重试"));button(0).performClick();assertEquals(2,source.loads);
        source.callback.ready(new Video());engine.events.failed();assertTrue(engine.released);assertEquals(0,playback.surface().getAlpha(),0);
    }
    @Test public void backgroundReleasesDecoderAndForegroundRestartsMutedWithoutLeaking(){
        playback.setEligible(true);Video first=new Video();source.callback.ready(first);engine.events.firstFrame();
        playback.setForeground(false);assertTrue(engine.released);assertTrue(first.closed);assertTrue(source.cancelled);
        playback.setForeground(true);assertEquals(2,source.loads);source.callback.ready(new Video());assertTrue(engine.muted);assertTrue(engine.playing);
    }
    @Test public void componentActivityLifecycleActuallySuspendsAndReleases(){
        var owner=Robolectric.buildActivity(androidx.activity.ComponentActivity.class).setup().visible();FakeSource another=new FakeSource();FakeEngine[] player={null};
        LivePhotoPlayback live=new LivePhotoPlayback(owner.get(),another,(c,f,e)->player[0]=new FakeEngine(new View(c),e));
        try{
            live.setEligible(true);Video v=new Video();another.callback.ready(v);assertTrue(player[0].playing);
            owner.pause().stop();assertTrue(player[0].released);assertTrue(v.closed);
            owner.start().resume();assertEquals(2,another.loads);another.callback.ready(new Video());assertTrue(player[0].playing);assertTrue(player[0].muted);
        }finally{live.close();owner.pause().stop().destroy();}
    }
    private Button button(int i){return (Button)playback.controls().getChildAt(i);}
    private static final class Video implements MotionPreviewLoader.Video {boolean closed;public File file(){return new File("synthetic.mp4");}public void close(){closed=true;}}
    private static final class FakeSource implements MotionPreviewLoader.Source {
        MotionPreviewLoader.Callback callback;boolean cancelled;int loads;
        public MotionPreviewLoader.Request load(MotionPreviewLoader.Callback callback){this.callback=callback;loads++;cancelled=false;return ()->cancelled=true;}
    }
    private static final class FakeEngine implements LivePhotoPlayback.Engine {
        final View view;final LivePhotoPlayback.Events events;boolean muted,playing,released;
        FakeEngine(View view,LivePhotoPlayback.Events events){this.view=view;this.events=events;}
        public View view(){return view;}public void playing(boolean value){playing=value;}public void muted(boolean value){muted=value;}public void close(){released=true;}
    }
}
