package app.nikkisync.mobile.ui;
import app.nikkisync.mobile.model.Models.*;
import app.nikkisync.mobile.storage.*;
import app.nikkisync.mobile.media.PhotoCachePreferences;
import java.util.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class PhotoScopeFilterTest {
    @Test public void defaultsUseTwoGiBAndExplicitChoicesSurvive(){
        var context=RuntimeEnvironment.getApplication();context.getSharedPreferences("nikkisync.photo-cache-v2",0).edit().clear().commit();
        var choices=new PhotoCachePreferences(context);assertEquals(2048,choices.thumbnailMiB());choices.setThumbnailMiB(512);
        assertEquals(512,new PhotoCachePreferences(context).thumbnailMiB());
    }
    @Test public void sourceFieldsSurviveJsonAndSavedRetentionAndFilterByExactUidAndFolder()throws Exception{
        var a=asset("a","1001").withSource("D:\\Old\\a.jpeg","D:\\Old",1234567L);
        var b=asset("b","2002").withSource("D:\\Other\\b.jpeg","D:\\Other",567L);
        assertTrue(PhotoScopeFilter.matches(a,0,"1001","D:\\Old"));assertFalse(PhotoScopeFilter.matches(b,0,"1001",null));
        assertFalse(PhotoScopeFilter.matches(a,1,null,null));assertTrue(PhotoScopeFilter.matches(a,2,null,null));
        assertTrue(PhotoScopeFilter.matches(asset("c",null),0,"","") );
        try(var store=new SavedSourceStore(RuntimeEnvironment.getApplication())){store.put(a);assertEquals(a.sourcePath(),store.get("a").sourcePath());assertEquals(a.sizeBytes(),store.get("a").sizeBytes());}
        try(var store=new SavedSourceStore(RuntimeEnvironment.getApplication())){assertEquals("1001",store.get("a").uid());}
    }
    @Test public void independentVideosHaveTheirOwnFilterRatherThanBeingOrdinaryPhotosOrLive(){
        var video=new AssetSummary("v","video","ready",null,null,1,null,null,false,false,null,null,null,null);
        assertTrue(PhotoScopeFilter.matches(video,0,null,null));assertTrue(PhotoScopeFilter.matches(video,3,null,null));
        assertFalse(PhotoScopeFilter.matches(video,1,null,null));assertFalse(PhotoScopeFilter.matches(video,2,null,null));
        assertFalse(PhotoScopeFilter.matches(asset("p",null),3,null,null));
    }
    static AssetSummary asset(String id,String uid){return new AssetSummary(id,"photo","ready","2026-10-27T01:00:00Z",uid,1,100,200,false,false,null,"r",null,null);}
}
