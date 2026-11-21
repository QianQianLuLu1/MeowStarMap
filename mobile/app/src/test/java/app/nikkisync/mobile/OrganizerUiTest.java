package app.nikkisync.mobile;
import android.os.*;
import android.view.*;
import android.widget.*;
import app.nikkisync.mobile.media.ImageLoader;
import app.nikkisync.mobile.model.Models.*;
import app.nikkisync.mobile.storage.OrganizerStore;
import app.nikkisync.mobile.ui.*;
import java.util.*;
import java.lang.reflect.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class OrganizerUiTest {
    static AssetSummary photo(String id){return new AssetSummary(id,"photo","ready",null,null,1,100,100,false,false,null,null,null,null);}
    @Test public void organizerFailureStaysVisibleAcrossRefreshAndClearsOnlyAfterSuccess()throws Exception{
        var activity=Robolectric.buildActivity(MainActivity.class).get();ImageLoader images=new ImageLoader(activity);OrganizerStore store=new OrganizerStore(activity);
        try{
            var build=MainActivity.class.getDeclaredMethod("buildUi");build.setAccessible(true);build.invoke(activity);
            var server=new PairedServer("failure-pc","PC","127.0.0.1",1,"fingerprint","","",0);store.enqueue(OrganizerStore.scope(server),List.of(photo("failure")));
            var page=new OrganizerPage(activity,store,server,null,images,Runnable::run,new Handler(Looper.getMainLooper()),()->{});Shadows.shadowOf(Looper.getMainLooper()).idle();
            var failure=OrganizerPage.class.getMethod("setSyncFailure",String.class);
            String message="整理同步未完成，请更新电脑端后重试";failure.invoke(page,message);Shadows.shadowOf(Looper.getMainLooper()).idle();
            Field field=OrganizerPage.class.getDeclaredField("note");field.setAccessible(true);TextView note=(TextView)field.get(page);
            assertTrue(note.getText().toString().contains(message));page.refresh();Shadows.shadowOf(Looper.getMainLooper()).idle();assertTrue(note.getText().toString().contains(message));
            assertEquals(1,store.outgoing(OrganizerStore.scope(server)).length());
            failure.invoke(page,new Object[]{null});Shadows.shadowOf(Looper.getMainLooper()).idle();assertFalse(note.getText().toString().contains(message));assertTrue(note.getText().toString().contains("待处理 1 张"));
        }finally{activity.navigationHost().close();images.shutdown();store.close();}
    }
    @Test public void phoneCanLeaveOnlyAfterBatchVerificationAndNotDuringInitialPreparation()throws Exception{
        var activity=Robolectric.buildActivity(MainActivity.class).get();ImageLoader images=new ImageLoader(activity);OrganizerStore store=new OrganizerStore(activity);
        try{
            var build=MainActivity.class.getDeclaredMethod("buildUi");build.setAccessible(true);build.invoke(activity);
            var server=new PairedServer("batch-pc","PC","127.0.0.1",1,"fingerprint","","",0);String scope=OrganizerStore.scope(server);store.enqueue(scope,List.of(photo("asset_batch")));String id=store.entries(scope).get(0).id();
            store.acknowledge(scope,new org.json.JSONArray().put(new org.json.JSONObject().put("id",id).put("state","preparing").put("batchVerified",false)));
            var page=new OrganizerPage(activity,store,server,null,images,Runnable::run,new Handler(Looper.getMainLooper()),()->{});Shadows.shadowOf(Looper.getMainLooper()).idle();
            Field field=OrganizerPage.class.getDeclaredField("note");field.setAccessible(true);TextView note=(TextView)field.get(page);assertTrue(note.getText().toString().contains("请保持 App 打开"));
            store.acknowledge(scope,new org.json.JSONArray().put(new org.json.JSONObject().put("id",id).put("state","executing").put("batchVerified",true)));page.refresh();Shadows.shadowOf(Looper.getMainLooper()).idle();assertTrue(note.getText().toString().contains("可关闭 App"));
        }finally{activity.navigationHost().close();images.shutdown();store.close();}
    }
    @Test public void recentlyDeletedHasItsOwnCapsuleAndCancelsOnlySelectedPhotos()throws Exception{
        var activity=Robolectric.buildActivity(MainActivity.class).get();ImageLoader images=new ImageLoader(activity);
        var build=MainActivity.class.getDeclaredMethod("buildUi");build.setAccessible(true);build.invoke(activity);
        var field=MainActivity.class.getDeclaredField("savedControls");field.setAccessible(true);ViewGroup controls=(ViewGroup)field.get(activity);
        assertNotNull(button(controls,"最近删除"));assertFalse(button(controls,"最近删除").isEnabled());
        OrganizerStore store=new OrganizerStore(activity);var server=new PairedServer("pc","PC","127.0.0.1",1,"fingerprint","","",0);String scope=OrganizerStore.scope(server);
        try{
            store.enqueue(scope,List.of(photo("asset_first"),photo("asset_second")));
            var page=new OrganizerPage(activity,store,server,null,images,Runnable::run,new Handler(Looper.getMainLooper()),()->{});Shadows.shadowOf(Looper.getMainLooper()).idle();
            Field adapterField=OrganizerPage.class.getDeclaredField("adapter");adapterField.setAccessible(true);GalleryAdapter adapter=(GalleryAdapter)adapterField.get(page);
            java.lang.reflect.Method toggle=OrganizerPage.class.getDeclaredMethod("toggle",AssetSummary.class);toggle.setAccessible(true);toggle.invoke(page,photo("asset_first"));
            button(activity.navigationHost(),"取消所选删除").performClick();Shadows.shadowOf(Looper.getMainLooper()).idle();
            assertEquals("cancel_requested",store.entries(scope).stream().filter(e->e.asset().assetId().equals("asset_first")).findFirst().get().state());
            assertTrue(store.entries(scope).stream().filter(e->e.asset().assetId().equals("asset_second")).findFirst().get().pending());
        }finally{store.close();images.shutdown();Field io=MainActivity.class.getDeclaredField("io");io.setAccessible(true);((java.util.concurrent.ExecutorService)io.get(activity)).shutdownNow();}
    }
    @Test public void organizerHeaderRemainsSharpAndCenteredAtNarrowWidth()throws Exception{
        var activity=Robolectric.buildActivity(MainActivity.class).get();ImageLoader images=new ImageLoader(activity);OrganizerStore store=new OrganizerStore(activity);
        try{
            var build=MainActivity.class.getDeclaredMethod("buildUi");build.setAccessible(true);build.invoke(activity);
            var server=new PairedServer("header-pc","PC","127.0.0.1",1,"fingerprint","","",0);
            var page=new OrganizerPage(activity,store,server,null,images,Runnable::run,new Handler(Looper.getMainLooper()),()->{});Shadows.shadowOf(Looper.getMainLooper()).idle();
            Field field=OrganizerPage.class.getDeclaredField("page");field.setAccessible(true);var chromePage=field.get(page);
            field=chromePage.getClass().getDeclaredField("chrome");field.setAccessible(true);var chrome=(app.nikkisync.mobile.ui.chrome.ChromeHost)field.get(chromePage);
            field=OrganizerPage.class.getDeclaredField("note");field.setAccessible(true);TextView note=(TextView)field.get(page);
            Button close=button(activity.navigationHost(),"关闭"),cancel=button(activity.navigationHost(),"取消所选删除");
            assertSame("Instructions must sit above the blur, in the controls layer",chrome.controlsLayer(),((View)note.getParent()).getParent());
            for(int width:new int[]{320,360}){
                float density=activity.getResources().getDisplayMetrics().density;int w=Math.round(width*density),h=Math.round(700*density);
                for(int pass=0;pass<3;pass++){chrome.measure(View.MeasureSpec.makeMeasureSpec(w,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(h,View.MeasureSpec.EXACTLY));chrome.layout(0,0,w,h);}
                assertEquals(Gravity.CENTER,close.getGravity()&Gravity.RELATIVE_HORIZONTAL_GRAVITY_MASK|close.getGravity()&Gravity.VERTICAL_GRAVITY_MASK);
                assertEquals(Math.round(44*density),close.getHeight());assertEquals(Math.round(44*density),cancel.getHeight());
                assertTrue(note.getBottom()<=cancel.getTop());assertTrue(close.getTop()>=0);
            }
            assertFalse(cancel.isEnabled());
        }finally{activity.navigationHost().close();images.shutdown();store.close();}
    }
    @Test public void localQueueOpensOnceEvenWhileNetworkWorkerIsBlocked()throws Exception{
        var activity=Robolectric.buildActivity(MainActivity.class).get();ImageLoader images=new ImageLoader(activity);
        OrganizerStore store=new OrganizerStore(activity);java.util.concurrent.CountDownLatch gate=new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.ExecutorService network=null,local=null;
        try{
            var build=MainActivity.class.getDeclaredMethod("buildUi");build.setAccessible(true);build.invoke(activity);
            var server=new PairedServer("blocked-pc","PC","127.0.0.1",1,"fingerprint","","",0);store.enqueue(OrganizerStore.scope(server),List.of(photo("queued")));
            for(var entry:Map.of("organizer",store,"pairedServer",server,"imageLoader",images).entrySet()){Field field=MainActivity.class.getDeclaredField(entry.getKey());field.setAccessible(true);field.set(activity,entry.getValue());}
            Field field=MainActivity.class.getDeclaredField("io");field.setAccessible(true);network=(java.util.concurrent.ExecutorService)field.get(activity);
            field=MainActivity.class.getDeclaredField("organizerIo");field.setAccessible(true);local=(java.util.concurrent.ExecutorService)field.get(activity);
            network.execute(()->{try{gate.await();}catch(InterruptedException ignored){}});
            field=MainActivity.class.getDeclaredField("recentDeletedButton");field.setAccessible(true);Button open=(Button)field.get(activity);open.setEnabled(true);open.performClick();open.performClick();open.performClick();
            local.submit(()->{}).get(3,java.util.concurrent.TimeUnit.SECONDS);Shadows.shadowOf(Looper.getMainLooper()).idle();
            assertEquals(1,activity.navigationHost().overlayCount());
            field=MainActivity.class.getDeclaredField("organizerPage");field.setAccessible(true);OrganizerPage page=(OrganizerPage)field.get(activity);
            field=OrganizerPage.class.getDeclaredField("adapter");field.setAccessible(true);
            assertEquals(1,((GalleryAdapter)field.get(page)).visiblePhotos().size());
            assertNotNull(button(activity.navigationHost(),"关闭"));assertTrue(page.isOpen());
        }finally{gate.countDown();activity.navigationHost().close();if(network!=null)network.shutdownNow();if(local!=null)local.shutdownNow();images.shutdown();store.close();}
    }
    private static Button button(View view,String text){if(view instanceof Button b&&text.contentEquals(b.getText()))return b;if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++){Button b=button(group.getChildAt(i),text);if(b!=null)return b;}return null;}
}
