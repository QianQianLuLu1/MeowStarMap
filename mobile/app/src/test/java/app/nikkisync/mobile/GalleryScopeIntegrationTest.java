package app.nikkisync.mobile;
import android.view.*;
import android.widget.*;
import app.nikkisync.mobile.media.ImageLoader;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.ui.*;
import java.lang.reflect.*;
import java.util.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class GalleryScopeIntegrationTest {
    @Test public void galleryFiltersAndLiveCacheProgressRemainVisibleWithoutChangingLibrary()throws Exception{
        MainActivity activity=Robolectric.buildActivity(MainActivity.class).get();call(activity,"buildUi");ImageLoader loader=new ImageLoader(activity);
        try{
            List<AssetSummary> assets=(List<AssetSummary>)get(activity,"assets");assets.add(photo("a","1001"));assets.add(photo("b","2002"));
            set(activity,"imageLoader",loader);set(loader,"offlineProgress",new ImageLoader.OfflineProgress(1,2,true,false,0));set(activity,"galleryUid","1001");call(activity,"renderGallery");call(activity,"updateGalleryCacheCount");
            assertEquals(1,((GalleryAdapter)get(activity,"adapter")).visiblePhotos().size());assertEquals(2,assets.size());
            String count=((TextView)get(activity,"countLabel")).getText().toString();assertTrue(count.contains("已同步 2 张"));assertTrue(count.contains("已缓存 1 张"));
            call(activity,"showGalleryFilterSheet");assertEquals(1,activity.navigationHost().overlayCount());
        }finally{activity.navigationHost().close();loader.shutdown();for(String name:new String[]{"io","organizerIo","organizerNetworkIo"})((java.util.concurrent.ExecutorService)get(activity,name)).shutdownNow();}
    }
    @Test public void sourcePathStartsCollapsedAndTapExpandsAndCopiesIt()throws Exception{
        MainActivity activity=Robolectric.buildActivity(MainActivity.class).get();LinearLayout box=new LinearLayout(activity);
        try{
            var source=photo("a","1001").withSource("D:\\Original\\Photos\\example.jpeg","D:\\Original\\Photos",2345678L);
            Method method=MainActivity.class.getDeclaredMethod("addSourceDetails",LinearLayout.class,AssetSummary.class);method.setAccessible(true);method.invoke(activity,box,source);
            TextView path=(TextView)box.getChildAt(1);assertTrue(path.getText().toString().contains("example.jpeg"));assertFalse(path.getText().toString().contains("Original"));path.performClick();assertTrue(path.getText().toString().contains(source.sourcePath()));
            var clipboard=(android.content.ClipboardManager)activity.getSystemService(android.content.Context.CLIPBOARD_SERVICE);assertEquals(source.sourcePath(),clipboard.getPrimaryClip().getItemAt(0).getText().toString());
            assertTrue(((TextView)box.getChildAt(0)).getText().toString().contains("1001"));assertTrue(((TextView)box.getChildAt(2)).getText().toString().contains("2.35 MB"));
        }finally{for(String name:new String[]{"io","organizerIo","organizerNetworkIo"})((java.util.concurrent.ExecutorService)get(activity,name)).shutdownNow();}
    }
    @Test public void videoFilterSelectsRecordingsAndCountsOnlyPhotosAsThumbnailCache()throws Exception{
        MainActivity activity=Robolectric.buildActivity(MainActivity.class).get();call(activity,"buildUi");ImageLoader loader=new ImageLoader(activity);
        try{
            List<AssetSummary> assets=(List<AssetSummary>)get(activity,"assets");assets.add(photo("p","1001"));
            assets.add(new AssetSummary("v","video","ready",null,null,1,null,null,false,false,null,null,null,null));
            set(activity,"imageLoader",loader);set(loader,"offlineProgress",new ImageLoader.OfflineProgress(1,1,false,false,0));set(activity,"galleryType",3);
            call(activity,"renderGallery");call(activity,"updateGalleryCacheCount");
            var visible=((GalleryAdapter)get(activity,"adapter")).visiblePhotos();assertEquals(1,visible.size());assertTrue(visible.get(0).isVideo());
            String count=((TextView)get(activity,"countLabel")).getText().toString();assertTrue(count.contains("已同步 2 项"));assertTrue(count.contains("已缓存 1 张照片"));
        }finally{activity.navigationHost().close();loader.shutdown();for(String name:new String[]{"io","organizerIo","organizerNetworkIo"})((java.util.concurrent.ExecutorService)get(activity,name)).shutdownNow();}
    }
    static AssetSummary photo(String id,String uid){return new AssetSummary(id,"photo","ready","2026-10-27T01:00:00Z",uid,1,100,200,false,false,null,"r",null,null);}
    static Object get(Object object,String name)throws Exception{Field f=object.getClass().getDeclaredField(name);f.setAccessible(true);return f.get(object);}
    static void set(Object object,String name,Object value)throws Exception{Field f=object.getClass().getDeclaredField(name);f.setAccessible(true);f.set(object,value);}
    static void call(Object object,String name)throws Exception{Method m=object.getClass().getDeclaredMethod(name);m.setAccessible(true);m.invoke(object);}
}
