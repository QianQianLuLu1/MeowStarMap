package app.nikkisync.mobile.storage;

import android.content.Context;
import app.nikkisync.mobile.net.CachedAssetDetails;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
public class AssetDetailCacheTest {
    Context context; AssetDetailCache store;
    @Before public void setup() {
        context=RuntimeEnvironment.getApplication(); context.deleteDatabase("nikkisync-detail-cache.db");
        store=new AssetDetailCache(context);
    }
    @After public void close() { store.close(); }
    static String response(String id,long revision,int focal) {
        return "{\"asset\":{\"assetId\":\""+id+"\",\"revision\":"+revision+
                ",\"type\":\"photo\",\"state\":\"ready\",\"resources\":[],\"metadata\":{\"camera\":{\"focalLength\":"+focal+"}}}}";
    }
    @Test public void restartUsesPrivatePersistentCacheWithoutNetwork() throws Exception {
        AtomicInteger requests=new AtomicInteger();
        var first=new CachedAssetDetails(store,"pc:tls",id->{requests.incrementAndGet();return response(id,7,50);});
        assertTrue(first.get("a").metadataJson().contains("50"));
        store.close();store=new AssetDetailCache(context);
        var restarted=new CachedAssetDetails(store,"pc:tls",id->{throw new AssertionError("Unexpected detail request after restart");});
        restarted.observe("a",7);
        assertTrue(restarted.get("a").metadataJson().contains("50"));assertEquals(1,requests.get());
    }
    @Test public void onlyChangedPhotoIsRefetchedAndParametersStayIndividual() throws Exception {
        AtomicInteger requests=new AtomicInteger();
        var loader=new CachedAssetDetails(store,"pc:tls",id->response(id,requests.incrementAndGet(),id.equals("a")?35:85));
        loader.get("a");loader.get("b");loader.observe("a",3);
        loader.get("a");assertTrue(loader.get("b").metadataJson().contains("85"));assertEquals(3,requests.get());
    }
    @Test public void otherPcOrChangedTlsCannotReadOldDetails() throws Exception {
        store.put("pc:tls","a",7,response("a",7,50));
        assertNull(store.get("other:tls","a"));assertNull(store.get("pc:new-tls","a"));
    }
    @Test public void simultaneousConsumersShareOneFetch() throws Exception {
        AtomicInteger requests=new AtomicInteger();var gate=new CountDownLatch(1);
        var loader=new CachedAssetDetails(store,"pc",id->{requests.incrementAndGet();gate.await(2,TimeUnit.SECONDS);return response(id,1,35);});
        var executor=Executors.newFixedThreadPool(3);
        try {
            var a=executor.submit(()->loader.get("a"));var b=executor.submit(()->loader.get("a"));
            gate.countDown();a.get();b.get();assertEquals(1,requests.get());
        } finally {executor.shutdownNow();}
    }
    @Test public void failedRefreshNeverPublishesStaleOrBrokenResponse() throws Exception {
        store.put("pc","a",1,response("a",1,35));
        var loader=new CachedAssetDetails(store,"pc",id->{throw new java.io.IOException("offline");});
        loader.observe("a",2);
        try {loader.get("a");fail();}catch(java.io.IOException expected){}
        assertNull(store.get("pc","a"));
    }
    @Test public void patchReplacesCacheAndOldInFlightResponseCannotUndoIt() throws Exception {
        store.put("pc","a",9,response("a",9,85));
        store.put("pc","a",8,response("a",8,35));
        assertTrue(store.get("pc","a").contains("85"));
    }
    @Test public void changedRevisionDuringFetchDoesNotCacheOlderResponse() throws Exception {
        var loader=new CachedAssetDetails(store,"pc",id->{store.observe("pc",id,10);return response(id,9,35);});
        loader.get("a");assertNull(store.get("pc","a"));
    }
    @Test public void corruptResponseIsRemovedAndDownloadedAgain() throws Exception {
        store.put("pc","a",1,"broken");
        var loader=new CachedAssetDetails(store,"pc",id->response(id,2,50));
        assertTrue(loader.get("a").metadataJson().contains("50"));
    }
    @Test public void wrongAssetFromServerIsNeverCached() throws Exception {
        var loader=new CachedAssetDetails(store,"pc",id->response("wrong",2,35));
        try {loader.get("a");fail();}catch(SecurityException expected){}
        assertNull(store.get("pc","a"));
    }
    @Test public void clearIsScopedAndBoundedCacheEvictsOldEntries() {
        store.close();store=new AssetDetailCache(context,1024,2);
        store.put("pc","a",1,response("a",1,35));store.put("pc","b",2,response("b",2,50));
        store.put("pc","c",3,response("c",3,85));
        assertNull(store.get("pc","a"));assertTrue(store.sizeBytes()<=1024);
        store.clear("other");assertNotNull(store.get("pc","c"));
        store.clear("pc");assertNull(store.get("pc","c"));
    }
    @Test public void oversizedEntryDoesNotConsumeCache() {
        store.close();store=new AssetDetailCache(context,100,5);
        store.put("pc","a",1,"x".repeat(101));assertEquals(0,store.sizeBytes());
    }
    @Test public void cachedDisplayDataDoesNotPersistNativeResolverTokenOrPayload() throws Exception {
        String json=response("a",1,35).replace("\"camera\":", "\"raw\":{\"nativeParamToken\":\"secret\",\"nativeParamPayload\":\"payload\",\"dictionary\":{\"providerVersion\":\"v1\"}},\"camera\":");
        var loader=new CachedAssetDetails(store,"pc",id->json);loader.get("a");
        String cached=store.get("pc","a");assertFalse(cached.contains("secret"));assertFalse(cached.contains("nativeParamPayload"));
        assertTrue(cached.contains("providerVersion"));assertTrue(cached.contains("focalLength"));
        assertTrue(new org.json.JSONObject(cached).getJSONObject("asset").getJSONObject("metadata").getJSONObject("raw").getBoolean("sourceParametersPresent"));
        var restarted=new CachedAssetDetails(store,"pc",id->{throw new AssertionError("must use the cached availability marker");});
        assertTrue(app.nikkisync.mobile.ui.PlayerFacingDetails.metadataNotice(restarted.get("a").metadataJson()).contains("尚未解码成功"));
    }
    @Test public void resyncOrUserClearCannotBeUndoneByLateFetch() throws Exception {
        final CachedAssetDetails[] loader=new CachedAssetDetails[1];
        loader[0]=new CachedAssetDetails(store,"pc",id->{loader[0].clear();return response(id,1,35);});
        loader[0].get("a");assertNull(store.get("pc","a"));
    }
    @Test public void listingUnopenedPhotosDoesNotPopulateCache() {
        for(int i=0;i<1000;i++)store.observe("pc","unopened-"+i,10);
        try(var rows=store.getReadableDatabase().rawQuery("SELECT COUNT(*) FROM details",null)) {
            rows.moveToFirst();assertEquals(0,rows.getInt(0));
        }
    }
    @Test public void applicationClientAlsoUsesCacheAfterReconnection() throws Exception {
        String tls="0".repeat(64);
        store.put("pc\n"+tls,"a",5,response("a",5,85));
        var server=new app.nikkisync.mobile.model.Models.PairedServer("pc","PC","invalid.local",1,tls,"","",0);
        // No signing identity: a network request would fail. This goes through the actual app client.
        var client=new app.nikkisync.mobile.net.NikkiSyncClient(server,null,store);
        assertTrue(client.asset("a").metadataJson().contains("85"));
        var moved=new app.nikkisync.mobile.net.NikkiSyncClient(server.withEndpoint("another.invalid",2),null,store);
        assertTrue(moved.asset("a").metadataJson().contains("85"));
    }
    @Test public void oldConnectionCannotUndoClearFromNewConnection() throws Exception {
        var reconnected=new CachedAssetDetails(store,"pc",id->response(id,2,85));
        var old=new CachedAssetDetails(store,"pc",id->{reconnected.clear();return response(id,1,35);});
        old.get("a");assertNull(store.get("pc","a"));
    }
}
