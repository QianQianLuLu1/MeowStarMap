package app.nikkisync.mobile;

import android.widget.Button;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.media.ImageLoader;
import app.nikkisync.mobile.share.ShareCardExportCoordinator;
import app.nikkisync.mobile.storage.SavedPhotoStore;
import app.nikkisync.mobile.storage.EditedVariantStore;
import java.lang.reflect.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@org.robolectric.annotation.Config(sdk={30,31,32,35})
public class MainViewerEntryTest {
    @Test public void viewerFindsPhotoThumbnailWithComputerScopedCacheKey() throws Exception {
        var activity=fixture();
        try {
            var asset=new AssetSummary("synthetic","photo","ready","2026-09-25T10:20:00Z",null,
                    1,1000,1200,false,false,null,null,"2.9","inferred");
            var scope=new android.widget.FrameLayout(activity);
            var thumbnail=new android.widget.ImageView(activity);scope.addView(thumbnail);
            Field loader=MainActivity.class.getDeclaredField("imageLoader");loader.setAccessible(true);
            ((ImageLoader)loader.get(activity)).load(null,asset,thumbnail);
            Method find=MainActivity.class.getDeclaredMethod("findThumbnail",android.view.View.class,String.class);find.setAccessible(true);
            assertSame("The viewer must locate its original tile independently of the disk cache key",thumbnail,find.invoke(activity,scope,"synthetic:"));
            assertNull(find.invoke(activity,scope,"another-photo:"));
            // Recycled holders must not be mistaken for the previously opened photo.
            var other=new AssetSummary("another-photo","photo","ready",null,null,2,1000,1200,false,false,null,null,null,null);
            ((ImageLoader)loader.get(activity)).load(null,other,thumbnail);
            assertNull(find.invoke(activity,scope,"synthetic:"));
        } finally {cleanup(activity);}
    }
    private MainActivity fixture() throws Exception {
        var activity=Robolectric.buildActivity(MainActivity.class).get();
        set(activity,"shareCardExportCoordinator",new ShareCardExportCoordinator(activity,Runnable::run,Runnable::run));
        set(activity,"imageLoader",new ImageLoader(activity));
        set(activity,"savedPhotoStore",new SavedPhotoStore(activity));
        set(activity,"savedPhotoHealthStore",new app.nikkisync.mobile.storage.SavedPhotoHealthStore(activity));
        invoke(activity,"buildUi",new Class<?>[0]);
        Field connectionField=MainActivity.class.getDeclaredField("connectionState");connectionField.setAccessible(true);
        var connection=(app.nikkisync.mobile.net.ConnectionState)connectionField.get(activity);connection.httpResult(connection.session(),true);
        return activity;
    }
    private static void awaitSavedHealth(MainActivity activity)throws Exception{
        Field field=MainActivity.class.getDeclaredField("savedHealthIo");field.setAccessible(true);
        ((java.util.concurrent.ExecutorService)field.get(activity)).submit(()->{}).get(10,java.util.concurrent.TimeUnit.SECONDS);
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
    }
    @Test public void offlinePhotoUsesSameViewerWithDisabledNetworkActions()throws Exception{
        var activity=fixture();try{
            Field field=MainActivity.class.getDeclaredField("connectionState");field.setAccessible(true);var state=(app.nikkisync.mobile.net.ConnectionState)field.get(activity);state.beginSession();
            set(activity,"pairedServer",new app.nikkisync.mobile.model.Models.PairedServer("pc","PC","127.0.0.1",1,"00","","",0));
            var asset=new AssetSummary("synthetic","photo","ready",null,null,1,100,100,false,false,"thumb","original",null,null);
            invoke(activity,"showViewer",new Class<?>[]{AssetSummary.class},asset);
            assertEquals(1,activity.navigationHost().overlayCount());
            assertNotNull(activity.navigationHost().findViewWithTag("photo-gestures"));
            assertFalse(findButton(activity.navigationHost(),"保存").isEnabled());assertFalse(findButton(activity.navigationHost(),"分享").isEnabled());
            assertTrue(findButton(activity.navigationHost(),"旋转").isEnabled());
            findButton(activity.navigationHost(),"详情").performClick();assertNotNull(findButton(activity.navigationHost(),"加入待删除"));
        }finally{cleanup(activity);}
    }
    @Test @org.robolectric.annotation.Config(sdk={30,35})
    public void openOfflineViewerRestoresSaveAndShareWhenHttpRecovers()throws Exception{
        for(String type:java.util.List.of("photo","motion_photo","video")){
            var activity=fixture();try{
                var state=connection(activity);state.beginSession();set(activity,"pairedServer",viewerServer());
                var asset=new AssetSummary("reconnect-"+type,type,"ready",null,null,1,100,100,
                        type.equals("motion_photo"),false,null,null,null,null);
                invoke(activity,"showViewer",new Class<?>[]{AssetSummary.class},asset);
                var save=findButton(activity.navigationHost(),"保存");assertFalse(save.isEnabled());
                var gestures=activity.navigationHost().findViewWithTag("photo-gestures");
                findButton(activity.navigationHost(),"旋转").performClick();
                state.httpResult(state.session(),true);
                invoke(activity,"renderConnectionStatus",new Class<?>[0]);
                assertTrue("Recovery must update the already open "+type+" viewer",save.isEnabled());
                assertEquals(1f,save.getAlpha(),.001f);
                assertSame("Recovery must not rebuild the photo or reset its gestures",gestures,activity.navigationHost().findViewWithTag("photo-gestures"));
                Field rotations=MainActivity.class.getDeclaredField("rotationByAssetId");rotations.setAccessible(true);
                assertEquals(90,((java.util.Map<?,?>)rotations.get(activity)).get(asset.assetId()));
                if(!asset.isVideo())assertTrue(findButton(activity.navigationHost(),"分享").isEnabled());
                save.performClick();
                if(asset.hasMotion())findButton(activity.navigationHost(),"视频").performClick();
                assertEquals("The restored action must reach the normal save flow","请先连接电脑",org.robolectric.shadows.ShadowToast.getTextOfLatestToast());
            }finally{cleanup(activity);}
        }
    }
    @Test @org.robolectric.annotation.Config(sdk={30,35})
    public void viewerActionsTrackDisconnectAndEitherAuthenticatedChannel()throws Exception{
        var activity=fixture();try{
            set(activity,"pairedServer",viewerServer());var state=connection(activity);
            invoke(activity,"showViewer",new Class<?>[]{AssetSummary.class},viewerAsset("channels"));
            var save=findButton(activity.navigationHost(),"保存");assertTrue(save.isEnabled());
            state.realtimeResult(state.session(),true);state.httpResult(state.session(),false);
            invoke(activity,"renderConnectionStatus",new Class<?>[0]);assertTrue(save.isEnabled());
            state.realtimeResult(state.session(),false);
            invoke(activity,"renderConnectionStatus",new Class<?>[0]);assertFalse(save.isEnabled());
            assertEquals(.35f,save.getAlpha(),.001f);assertFalse(findButton(activity.navigationHost(),"分享").isEnabled());
            state.httpResult(state.session(),true);
            invoke(activity,"renderConnectionStatus",new Class<?>[0]);assertTrue(save.isEnabled());
        }finally{cleanup(activity);}
    }
    @Test @org.robolectric.annotation.Config(sdk={30,35})
    public void viewerDoesNotSaveItsPhotoThroughADifferentComputerOrCertificate()throws Exception{
        var activity=fixture();try{
            var server=viewerServer();set(activity,"pairedServer",server);
            invoke(activity,"showViewer",new Class<?>[]{AssetSummary.class},viewerAsset("scoped"));
            var save=findButton(activity.navigationHost(),"保存");
            set(activity,"pairedServer",new app.nikkisync.mobile.model.Models.PairedServer("other","PC","127.0.0.1",1,"a".repeat(64),"","",0));
            invoke(activity,"renderConnectionStatus",new Class<?>[0]);assertFalse(save.isEnabled());
            set(activity,"pairedServer",new app.nikkisync.mobile.model.Models.PairedServer(server.serverId(),"PC","127.0.0.1",1,"b".repeat(64),"","",0));
            invoke(activity,"renderConnectionStatus",new Class<?>[0]);assertFalse(save.isEnabled());
            set(activity,"pairedServer",server.withEndpoint("127.0.0.2",2));
            invoke(activity,"renderConnectionStatus",new Class<?>[0]);assertTrue("The same paired PC may change its endpoint",save.isEnabled());
        }finally{cleanup(activity);}
    }
    @Test @org.robolectric.annotation.Config(sdk={30,35})
    public void pagingWhileOfflineRestoresOnlyTheCurrentPhotoActions()throws Exception{
        var activity=fixture();try{
            var state=connection(activity);state.beginSession();set(activity,"pairedServer",viewerServer());
            var first=viewerAsset("first");var second=viewerAsset("second");
            var context=java.util.List.of(first,second);
            invoke(activity,"showViewer",new Class<?>[]{AssetSummary.class,java.util.List.class},first,context);
            var oldSave=findButton(activity.navigationHost(),"保存");
            var page=(app.nikkisync.mobile.ui.chrome.PhotoViewerPage)oldSave.getParent().getParent();
            invoke(activity,"showViewer",new Class<?>[]{AssetSummary.class,app.nikkisync.mobile.ui.chrome.PhotoViewerPage.class,java.util.List.class,android.view.View.class},second,page,context,activity.navigationHost());
            var currentSave=findButton(activity.navigationHost(),"保存");assertNotSame(oldSave,currentSave);
            state.httpResult(state.session(),true);invoke(activity,"renderConnectionStatus",new Class<?>[0]);
            assertTrue(currentSave.isEnabled());assertFalse("Detached photo actions must not be revived",oldSave.isEnabled());
            assertEquals(1,activity.navigationHost().overlayCount());
        }finally{cleanup(activity);}
    }
    @Test @org.robolectric.annotation.Config(sdk={30,35})
    public void backgroundSessionInvalidatesOpenViewerUntilFreshConnection()throws Exception{
        var activity=fixture();try{
            set(activity,"pairedServer",viewerServer());var state=connection(activity);long previous=state.session();
            invoke(activity,"showViewer",new Class<?>[]{AssetSummary.class},viewerAsset("resume"));
            var save=findButton(activity.navigationHost(),"保存");
            invoke(activity,"onStop",new Class<?>[0]);assertFalse(save.isEnabled());
            state.httpResult(previous,true);invoke(activity,"renderConnectionStatus",new Class<?>[0]);assertFalse(save.isEnabled());
            state.httpResult(state.session(),true);invoke(activity,"renderConnectionStatus",new Class<?>[0]);assertTrue(save.isEnabled());
        }finally{cleanup(activity);}
    }
    @Test @org.robolectric.annotation.Config(sdk={30,35})
    public void closingOfflineViewerRemovesItsConnectionRefresh()throws Exception{
        var activity=fixture();try{
            var state=connection(activity);state.beginSession();set(activity,"pairedServer",viewerServer());
            invoke(activity,"showViewer",new Class<?>[]{AssetSummary.class},viewerAsset("closed"));
            var save=findButton(activity.navigationHost(),"保存");
            var page=(app.nikkisync.mobile.ui.chrome.PhotoViewerPage)save.getParent().getParent();
            page.dismiss();activity.navigationHost().interrupt();assertEquals(0,activity.navigationHost().overlayCount());
            state.httpResult(state.session(),true);invoke(activity,"renderConnectionStatus",new Class<?>[0]);
            assertFalse(save.isEnabled());assertEquals(0,activity.navigationHost().overlayCount());
        }finally{cleanup(activity);}
    }
    @Test @org.robolectric.annotation.Config(sdk=35,shadows=ShadowViewerClient.class)
    public void recoveredViewerLoadsShareDetailsAndIgnoresAnEarlierConnectionResponse()throws Exception{
        var activity=fixture();try{
            var queue=viewerQueue(activity);var server=viewerServer();set(activity,"pairedServer",server);
            set(activity,"client",new app.nikkisync.mobile.net.NikkiSyncClient(server,null));
            var state=connection(activity);state.beginSession();
            invoke(activity,"showViewer",new Class<?>[]{AssetSummary.class},viewerAsset("metadata"));
            findButton(activity.navigationHost(),"详情").performClick();
            var share=findButton(activity.navigationHost(),"生成分享图");assertFalse(share.isEnabled());
            state.httpResult(state.session(),true);invoke(activity,"renderConnectionStatus",new Class<?>[0]);
            invoke(activity,"renderConnectionStatus",new Class<?>[0]);
            assertEquals("Status renders must not duplicate the viewer metadata request",1,queue.queued.size());
            queue.queued.remove(0).run(); // Its completion is still queued on the main thread.
            state.httpResult(state.session(),false);invoke(activity,"renderConnectionStatus",new Class<?>[0]);
            state.httpResult(state.session(),true);invoke(activity,"renderConnectionStatus",new Class<?>[0]);
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertFalse("A response from before the disconnect cannot enable the new share action",share.isEnabled());
            assertEquals(1,queue.queued.size());queue.queued.remove(0).run();
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertTrue("The current session's details make sharing usable after recovery",share.isEnabled());
        }finally{cleanup(activity);}
    }
    @Test @org.robolectric.annotation.Config(sdk=35,shadows=ShadowViewerClient.class)
    public void dismissedViewerIgnoresPendingMetadataCompletion()throws Exception{
        var activity=fixture();try{
            var queue=viewerQueue(activity);var server=viewerServer();set(activity,"pairedServer",server);
            set(activity,"client",new app.nikkisync.mobile.net.NikkiSyncClient(server,null));
            invoke(activity,"showViewer",new Class<?>[]{AssetSummary.class},viewerAsset("late-details"));
            findButton(activity.navigationHost(),"详情").performClick();
            var share=findButton(activity.navigationHost(),"生成分享图");assertFalse(share.isEnabled());
            assertEquals(1,queue.queued.size());queue.queued.remove(0).run();
            activity.navigationHost().close();
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertFalse(share.isEnabled());assertEquals(0,activity.navigationHost().overlayCount());
        }finally{cleanup(activity);}
    }
    private static MainConnectionRecoveryTest.QueueExecutor viewerQueue(MainActivity activity)throws Exception{
        Field field=MainActivity.class.getDeclaredField("io");field.setAccessible(true);
        ((java.util.concurrent.ExecutorService)field.get(activity)).shutdownNow();
        var queue=new MainConnectionRecoveryTest.QueueExecutor();field.set(activity,queue);return queue;
    }
    @org.robolectric.annotation.Implements(value=app.nikkisync.mobile.net.NikkiSyncClient.class,isInAndroidSdk=false)
    public static class ShadowViewerClient {
        @org.robolectric.annotation.Implementation
        protected app.nikkisync.mobile.model.Models.AssetDetail asset(String id){
            return new app.nikkisync.mobile.model.Models.AssetDetail(id,"photo","ready",java.util.List.of(),false,null,null,null,"{}");
        }
    }
    private static app.nikkisync.mobile.net.ConnectionState connection(MainActivity activity)throws Exception{
        Field field=MainActivity.class.getDeclaredField("connectionState");field.setAccessible(true);
        return (app.nikkisync.mobile.net.ConnectionState)field.get(activity);
    }
    private static app.nikkisync.mobile.model.Models.PairedServer viewerServer(){
        return new app.nikkisync.mobile.model.Models.PairedServer("viewer-pc","PC","127.0.0.1",1,"a".repeat(64),"","",0);
    }
    private static AssetSummary viewerAsset(String id){
        return new AssetSummary(id,"photo","ready",null,null,1,100,100,false,false,null,null,null,null);
    }
    @Test public void openingFirstPhotoWithoutShareWorkShowsFullscreenViewer() throws Exception {
        var activity=fixture();
        try {
            var asset=new AssetSummary("synthetic","photo","ready","2026-09-25T10:20:00Z",null,
                    1,1000,1200,false,false,null,null,"2.9","inferred");
            invoke(activity,"showViewer",new Class<?>[]{AssetSummary.class},asset);
            assertEquals(1,activity.navigationHost().overlayCount());
            assertNull(activity.navigationHost().findViewWithTag("live-playback-controls"));
            findButton(activity.navigationHost(),"详情").performClick();
            assertNull(findButton(activity.navigationHost(),"保存原视频"));
        } finally {cleanup(activity);}
    }
    @Test public void liveSaveOffersLiveOrVideoAndCancellationKeepsTheViewer() throws Exception {
        var activity=fixture();
        try {
            var asset=new AssetSummary("synthetic-live","motion_photo","ready",null,null,
                    1,3840,2160,true,false,null,null,null,null);
            invoke(activity,"showViewer",new Class<?>[]{AssetSummary.class},asset);
            assertNotNull(activity.navigationHost().findViewWithTag("live-playback-controls"));
            findButton(activity.navigationHost(),"保存").performClick();
            assertEquals(2,activity.navigationHost().overlayCount());
            assertNotNull(findButton(activity.navigationHost(),"实况照片"));
            assertNotNull(findButton(activity.navigationHost(),"视频"));
            findButton(activity.navigationHost(),"取消").performClick();
            activity.navigationHost().interrupt();
            assertEquals(1,activity.navigationHost().overlayCount());
            findButton(activity.navigationHost(),"保存").performClick();
            findButton(activity.navigationHost(),"视频").performClick();
            assertEquals("请先连接电脑",org.robolectric.shadows.ShadowToast.getTextOfLatestToast());
            activity.navigationHost().interrupt();
            assertEquals(1,activity.navigationHost().overlayCount());
        } finally {cleanup(activity);}
    }
    @Test public void ordinaryPhotoSaveDoesNotOfferVideo() throws Exception {
        var activity=fixture();
        try {
            var asset=new AssetSummary("synthetic","photo","ready",null,null,1,1000,1200,false,false,null,null,null,null);
            invoke(activity,"showViewer",new Class<?>[]{AssetSummary.class},asset);
            findButton(activity.navigationHost(),"保存").performClick();
            assertEquals(1,activity.navigationHost().overlayCount());
            assertNull(findButton(activity.navigationHost(),"视频"));
            assertEquals("请先连接电脑",org.robolectric.shadows.ShadowToast.getTextOfLatestToast());
        } finally {cleanup(activity);}
    }
    @Test public void standaloneVideoShowsVideoControlsAndSavesWithoutLiveChoices() throws Exception {
        var activity=fixture();
        try {
            var asset=new AssetSummary("synthetic-video","video","ready",null,null,1,null,null,false,false,null,null,null,null);
            invoke(activity,"showViewer",new Class<?>[]{AssetSummary.class},asset);
            var controls=(android.widget.LinearLayout)activity.navigationHost().findViewWithTag("live-playback-controls");
            assertNotNull(controls);assertTrue(((Button)controls.getChildAt(0)).getText().toString().contains("视频"));
            assertTrue(controls.getChildAt(1) instanceof android.widget.SeekBar);
            assertNull(findButton(activity.navigationHost(),"分享"));
            findButton(activity.navigationHost(),"保存").performClick();
            assertEquals(1,activity.navigationHost().overlayCount());assertNull(findButton(activity.navigationHost(),"实况照片"));
            assertEquals("请先连接电脑",org.robolectric.shadows.ShadowToast.getTextOfLatestToast());
        } finally {cleanup(activity);}
    }
    @Test public void mixedBatchOffersTheSameMotionSaveChoices() throws Exception {
        var activity=fixture();
        try {
            var photo=new AssetSummary("synthetic","photo","ready",null,null,1,1000,1200,false,false,null,null,null,null);
            var live=new AssetSummary("synthetic-live","motion_photo","ready",null,null,1,3840,2160,true,false,null,null,null,null);
            invoke(activity,"requestPhotoSave",new Class<?>[]{java.util.List.class,boolean.class},java.util.List.of(photo,live),true);
            assertEquals(1,activity.navigationHost().overlayCount());
            assertNotNull(findButton(activity.navigationHost(),"实况照片"));
            assertNotNull(findButton(activity.navigationHost(),"视频"));
            findButton(activity.navigationHost(),"实况照片").performClick();
            assertEquals("请先连接电脑",org.robolectric.shadows.ShadowToast.getTextOfLatestToast());
            activity.navigationHost().interrupt();assertEquals(0,activity.navigationHost().overlayCount());
        } finally {cleanup(activity);}
    }
    private static Button findButton(android.view.View view,String text) {
        if(view instanceof Button button&&text.contentEquals(button.getText()))return button;
        if(view instanceof android.view.ViewGroup group)for(int i=0;i<group.getChildCount();i++){
            Button found=findButton(group.getChildAt(i),text);if(found!=null)return found;
        }
        return null;
    }
    @Test public void noPendingShareWorkCanBeCancelledWithoutTouchingButtons() throws Exception {
        var activity=fixture();
        try {invoke(activity,"cancelShareCardFrom",new Class<?>[]{Button.class},(Object)null);}
        finally {cleanup(activity);}
    }
    @Test public void openingSavedPhotoWithoutShareWorkShowsFullscreenViewer() throws Exception {
        var activity=fixture();
        try {
            var record=new SavedPhotoStore.Record("synthetic","content://media/external/images/media/100",0,false,0,
                    "2026-09-25T10:20:00Z","2.9","jpg");
            invoke(activity,"showSavedPhotoDetails",new Class<?>[]{SavedPhotoStore.Record.class},record);
            awaitSavedHealth(activity);
            assertEquals(1,activity.navigationHost().overlayCount());
        } finally {cleanup(activity);}
    }
    @Test public void missingSavedPhotoOffersResaveInsteadOfOpeningSystemGallery() throws Exception {
        var activity=fixture();
        try {
            var record=new SavedPhotoStore.Record("missing-source","content://missing.saved/photo",0,false,0,null,null,"jpg");
            invoke(activity,"showSavedPhotoDetails",new Class<?>[]{SavedPhotoStore.Record.class},record);
            awaitSavedHealth(activity);
            findButton(activity.navigationHost(),"详情").performClick();
            assertNotNull(findButton(activity.navigationHost(),"重新保存"));
            assertFalse(findButton(activity.navigationHost(),"重新保存").isEnabled());
            assertFalse(findButton(activity.navigationHost(),"系统相册文件不可访问").isEnabled());
        } finally {cleanup(activity);}
    }
    @Test public void widgetOpensOnlyAPhotoAlreadyInSavedHistory() throws Exception {
        var activity=fixture();
        try {
            String uri="content://media/external/images/media/100";
            activity.getSharedPreferences("nikkisync_saved_photos",0).edit().putString("records",
                    new org.json.JSONArray().put(new org.json.JSONObject().put("assetId","synthetic").put("uri",uri)).toString()).commit();
            var intent=new android.content.Intent(activity,MainActivity.class)
                    .setAction(app.nikkisync.mobile.widget.PhotoAlbumWidgetProvider.OPEN_PHOTO)
                    .putExtra(app.nikkisync.mobile.widget.PhotoAlbumWidgetProvider.PHOTO_URI,"content://untrusted/unknown");
            invoke(activity,"handleIntent",new Class<?>[]{android.content.Intent.class},intent);
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertEquals(0,activity.navigationHost().overlayCount());
            intent.putExtra(app.nikkisync.mobile.widget.PhotoAlbumWidgetProvider.PHOTO_URI,uri);
            invoke(activity,"handleIntent",new Class<?>[]{android.content.Intent.class},intent);
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            awaitSavedHealth(activity);
            assertEquals(1,activity.navigationHost().overlayCount());
        } finally {cleanup(activity);}
    }
    @Test public void openingEditedPhotoWithoutShareWorkShowsFullscreenViewer() throws Exception {
        var activity=fixture();
        try {
            var variant=new EditedVariantStore.Variant("variant","synthetic","content://media/external/images/media/101",
                    0,"synthetic.jpg","image/jpeg","content://media/external/images/media/100");
            invoke(activity,"showEditedPhotoDetails",new Class<?>[]{EditedVariantStore.Variant.class},variant);
            assertEquals(1,activity.navigationHost().overlayCount());
        } finally {cleanup(activity);}
    }
    // Robolectric's API 31/32 AlertDialog window shadow resolves a Bluetooth class absent from those SDK jars.
    @Test @org.robolectric.annotation.Config(sdk={30,35})
    public void missingSavedAndEditedItemsCanBeRemovedWithoutDeletingMedia() throws Exception {
        var activity=fixture();var edits=new EditedVariantStore(activity);
        try {
            set(activity,"editedVariantStore",edits);
            set(activity,"savedPhotoHealthStore",new app.nikkisync.mobile.storage.SavedPhotoHealthStore(activity));
            var saved=new SavedPhotoStore(activity);
            var asset=new AssetSummary("source-a","photo","ready",null,null,1,100,100,false,false,null,null,null,null);
            String uri="content://example.test/unavailable";saved.record(asset,android.net.Uri.parse(uri),0,"JPEG");
            var record=saved.load().get(0);
            invoke(activity,"confirmRemoveSavedRecord",new Class<?>[]{SavedPhotoStore.Record.class},record);
            var alert=org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog();
            assertTrue(org.robolectric.Shadows.shadowOf(alert).getMessage().toString().contains("不会删除"));
            alert.getButton(android.app.AlertDialog.BUTTON_NEGATIVE).performClick();assertEquals(1,saved.load().size());
            invoke(activity,"confirmRemoveSavedRecord",new Class<?>[]{SavedPhotoStore.Record.class},record);
            org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog().getButton(android.app.AlertDialog.BUTTON_POSITIVE).performClick();
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertTrue(saved.load().isEmpty());
            var variant=edits.link("source-a",null,"content://example.test/edit",1,"edit.jpg","image/jpeg").variant();
            invoke(activity,"confirmRemoveEditedRecord",new Class<?>[]{EditedVariantStore.Variant.class},variant);
            alert=org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog();
            assertTrue(org.robolectric.Shadows.shadowOf(alert).getMessage().toString().contains("不会删除"));
            alert.getButton(android.app.AlertDialog.BUTTON_POSITIVE).performClick();org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();assertTrue(edits.loadAll().isEmpty());
        }finally{edits.close();cleanup(activity);}
    }
    private static void invoke(MainActivity activity,String name,Class<?>[] types,Object... args) throws Exception {
        Method method=MainActivity.class.getDeclaredMethod(name,types);method.setAccessible(true);
        try {method.invoke(activity,args);}catch(InvocationTargetException error){
            if(error.getCause() instanceof Exception failure)throw failure;
            if(error.getCause() instanceof Error failure)throw failure;
            throw error;
        }
    }
    @Test public void savingRotatedPhotoKeepsViewerDirectionForFollowingShare() throws Exception {
        var activity=fixture();
        try {
            var asset=new AssetSummary("synthetic","photo","ready","2026-09-25T10:20:00Z",null,
                    1,1000,1200,false,false,null,null,"2.9","inferred");
            invoke(activity,"rememberRotation",new Class<?>[]{String.class,int.class},"synthetic",90);
            invoke(activity,"showViewer",new Class<?>[]{AssetSummary.class},asset);
            invoke(activity,"applyCompletedSaves",new Class<?>[]{java.util.List.class,java.util.Map.class,boolean.class},
                    java.util.List.of(asset),java.util.Map.of("synthetic",90),false);
            Field field=MainActivity.class.getDeclaredField("rotationByAssetId");field.setAccessible(true);
            assertEquals("Sharing must keep the direction still shown in the open viewer",90,((java.util.Map<?,?>)field.get(activity)).get("synthetic"));
        } finally {cleanup(activity);}
    }
    private static void set(MainActivity activity,String name,Object value) throws Exception {
        Field field=MainActivity.class.getDeclaredField(name);field.setAccessible(true);field.set(activity,value);
    }
    private static void cleanup(MainActivity activity) throws Exception {
        activity.navigationHost().close();
        for(String name:new String[]{"io","shareWorker","organizerIo"}) {
            Field field=MainActivity.class.getDeclaredField(name);field.setAccessible(true);
            ((java.util.concurrent.ExecutorService)field.get(activity)).shutdownNow();
        }
        Field field=MainActivity.class.getDeclaredField("imageLoader");field.setAccessible(true);
        ((ImageLoader)field.get(activity)).shutdown();
        field=MainActivity.class.getDeclaredField("savedAdapter");field.setAccessible(true);
        ((app.nikkisync.mobile.ui.SavedPhotoAdapter)field.get(activity)).shutdown();
    }
}
