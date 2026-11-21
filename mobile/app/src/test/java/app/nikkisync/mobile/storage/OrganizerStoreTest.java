package app.nikkisync.mobile.storage;

import android.content.Context;
import app.nikkisync.mobile.model.Models.AssetSummary;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import java.util.List;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
public class OrganizerStoreTest {
    @Test public void reconciliationReadsIdsAndOnlyRequestedSavedSummaries()throws Exception{
        java.util.List<AssetSummary> items=new java.util.ArrayList<>();for(int i=0;i<601;i++)items.add(FavoritePhotoStore.decode(FavoritePhotoStore.encode(photo).put("assetId","scope_"+i)));
        store.remember("many",items,22);assertEquals(601,store.libraryIds("many").size());
        assertEquals(java.util.Set.of("scope_0","scope_600"),store.libraryForIds("many",java.util.Set.of("scope_0","scope_600")).stream().map(AssetSummary::assetId).collect(java.util.stream.Collectors.toSet()));
    }
    @Test public void upgradeKeepsOfflineRowsButDoesNotTrustPreDescriptorSnapshot()throws Exception{
        store.remember("old-format",List.of(photo),21);store.getWritableDatabase().execSQL("UPDATE library_snapshots SET snapshot_format=0 WHERE scope='old-format'");
        assertNull(store.snapshot("old-format"));assertEquals(1,store.library("old-format").size());
    }
    @Test public void failedSnapshotReplacementRollsBackItsRevisionAlongsideTheSummaries()throws Exception{
        store.remember("atomic",List.of(photo),21);assertThrows(android.database.sqlite.SQLiteConstraintException.class,()->store.remember("atomic",List.of(photo,photo),22));
        assertEquals(21,store.snapshot("atomic").revision());assertEquals(1,store.snapshot("atomic").items().size());
    }
    @Test public void snapshotRevisionIsAtomicScopedAndNeverTrustedAfterAnIncompleteOrLegacyWrite()throws Exception{
        store.remember("snapshot",List.of(photo),12);store.close();store=new OrganizerStore(context);
        assertEquals(12,store.snapshot("snapshot").revision());assertEquals(List.of(photo.assetId()),store.snapshot("snapshot").items().stream().map(AssetSummary::assetId).toList());assertNull(store.snapshot("other"));
        store.getWritableDatabase().execSQL("DELETE FROM library WHERE scope='snapshot'");assertNull(store.snapshot("snapshot"));
        store.remember("snapshot",List.of(photo),13);store.remember("snapshot",List.of(photo));assertNull(store.snapshot("snapshot"));
        store.remember("empty",List.of(),14);assertEquals(0,store.snapshot("empty").items().size());assertEquals(14,store.snapshot("empty").revision());
    }
    @Test public void modernIntentCarriesMediaProofAndFailureReceiptIsSentOnlyUntilAcknowledged()throws Exception{
        var summary=FavoritePhotoStore.encode(photo).put("mediaFingerprint","a".repeat(64));
        var modern=FavoritePhotoStore.decode(summary);store.enqueue("proof",List.of(modern));
        var request=store.outgoing("proof").getJSONObject(0);assertEquals("a".repeat(64),request.getString("mediaFingerprint"));assertTrue(request.getBoolean("batchVerification"));
        String id=request.getString("id");store.acknowledge("proof",new JSONArray().put(new JSONObject().put("id",id).put("state","changed").put("message","未删除").put("resultAcknowledged",false)));
        assertTrue(store.outgoing("proof").getJSONObject(0).getBoolean("resultAck"));
        store.acknowledge("proof",new JSONArray().put(new JSONObject().put("id",id).put("state","changed").put("message","未删除").put("resultAcknowledged",true)));
        assertEquals(0,store.outgoing("proof").length());assertEquals("changed",store.entries("proof").get(0).state());
    }
    @Test public void twentyFiveThousandOfflineSummariesPersistInOrderWithoutTouchingDeletionIntentions()throws Exception{
        List<AssetSummary> photos=new java.util.ArrayList<>();for(int i=0;i<25050;i++)photos.add(new AssetSummary("large_"+i,"photo","ready",null,null,i,null,null,false,false,null,"preview",null,null));
        store.enqueue("large",List.of(photos.get(24000)));store.remember("large",photos);store.close();store=new OrganizerStore(context);
        var restored=store.library("large");assertEquals(25050,restored.size());assertEquals("large_0",restored.get(0).assetId());assertEquals("large_25049",restored.get(25049).assetId());
        assertEquals(1,store.outgoing("large").length());store.cancel("large",List.of(store.entries("large").get(0).id()));assertTrue(store.outgoing("large").getJSONObject(0).getBoolean("cancel"));
    }
    @Test public void oldResultsDoNotReloadThousandsOfSummariesButUnsentReceiptsAndIntentionsRemain()throws Exception{
        var db=store.getWritableDatabase();String summary=FavoritePhotoStore.encode(photo).toString();
        db.beginTransaction();try{
            for(int i=0;i<3000;i++)db.execSQL("INSERT INTO deletions VALUES(?,?,?,?,?,?,?,?)",new Object[]{"old-"+i,"history",photo.assetId(),summary,"recycled","已回收",i,""});
            db.execSQL("UPDATE deletions SET approval='result:pending' WHERE id='old-0'");db.setTransactionSuccessful();
        }finally{db.endTransaction();}
        store.enqueue("history",List.of(photo));
        assertEquals(52,store.entries("history").size());assertEquals(2,store.outgoing("history").length());
        assertEquals(3001,android.database.DatabaseUtils.longForQuery(db,"SELECT COUNT(*) FROM deletions",null));
        store.acknowledge("history",new JSONArray().put(new JSONObject().put("id","old-0").put("state","recycled").put("resultAcknowledged",true)));
        assertEquals(51,store.entries("history").size());assertEquals(1,store.outgoing("history").length());
    }
    Context context;OrganizerStore store;
    final AssetSummary photo=new AssetSummary("asset_example","photo","ready",null,null,3,100,100,false,true,"thumb","original","2.9","inferred");
    @Before public void setup(){context=RuntimeEnvironment.getApplication();context.deleteDatabase("nikkisync-organizer.db");store=new OrganizerStore(context);}
    @After public void close(){store.close();}
    @Test public void libraryAndIntentSurviveRestartAndStayBoundToComputerIdentity()throws Exception{
        store.remember("pc:certificate",List.of(photo));store.enqueue("pc:certificate",List.of(photo));store.close();store=new OrganizerStore(context);
        assertEquals(1,store.library("pc:certificate").size());assertTrue(store.library("other:certificate").isEmpty());assertEquals(1,store.outgoing("pc:certificate").length());assertEquals(0,store.outgoing("other:certificate").length());assertEquals(3,store.entries("pc:certificate").get(0).asset().revision());
    }
    @Test public void cancellationSurvivesStaleResponseAndIsSentInsteadOfApproval()throws Exception{
        store.enqueue("pc",List.of(photo));String id=store.entries("pc").get(0).id();
        store.acknowledge("pc",new JSONArray().put(new JSONObject().put("id",id).put("state","confirming").put("approval","challenge")));
        assertEquals("challenge",store.outgoing("pc").getJSONObject(0).getString("approval"));
        store.cancel("pc",List.of(id));store.acknowledge("pc",new JSONArray().put(new JSONObject().put("id",id).put("state","confirming").put("approval","stale")));
        assertTrue(store.outgoing("pc").getJSONObject(0).getBoolean("cancel"));assertFalse(store.outgoing("pc").getJSONObject(0).has("approval"));
        store.acknowledge("pc",new JSONArray().put(new JSONObject().put("id",id).put("state","cancelled")));assertEquals(0,store.outgoing("pc").length());
    }
    @Test public void offlineLibraryPreservesOnlineSequenceAcrossRestartAndSnapshotReplacement()throws Exception{
        // IDs deliberately sort in reverse; null dates cannot reconstruct the PC order.
        AssetSummary newest=versionPhoto("z-newest","2.9");
        AssetSummary previous=versionPhoto("m-previous","2.8");
        AssetSummary older=versionPhoto("b-older","1.11");
        AssetSummary oldest=versionPhoto("a-oldest","1.8");
        List<AssetSummary> online=List.of(newest,previous,older,oldest);
        store.remember("pc",online);store.remember("other-pc",List.of(oldest,newest));
        store.close();store=new OrganizerStore(context);
        assertEquals(online.stream().map(AssetSummary::assetId).toList(),store.library("pc").stream().map(AssetSummary::assetId).toList());
        assertEquals(List.of("2.9","2.8","1.11","1.8"),
            app.nikkisync.mobile.ui.GalleryVersionGroups.group(store.library("pc")).stream()
                .map(app.nikkisync.mobile.ui.GalleryVersionGroups.Group::version).toList());
        List<AssetSummary> refreshed=List.of(previous,newest,oldest);
        store.remember("pc",refreshed);store.close();store=new OrganizerStore(context);
        assertEquals(refreshed.stream().map(AssetSummary::assetId).toList(),store.library("pc").stream().map(AssetSummary::assetId).toList());
        assertEquals(List.of("a-oldest","z-newest"),store.library("other-pc").stream().map(AssetSummary::assetId).toList());
    }
    private static AssetSummary versionPhoto(String id,String version){
        return new AssetSummary(id,"photo","ready",null,null,1,100,100,false,true,"thumb","original",version,"inferred");
    }
    @Test public void existingV1CacheRepairsOrderWithoutReconnectAndKeepsDeletionIntents()throws Exception{
        store.close();context.deleteDatabase("nikkisync-organizer.db");
        try(var legacy=android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath("nikkisync-organizer.db"),null)){
            legacy.execSQL("CREATE TABLE library(scope TEXT NOT NULL,asset_id TEXT NOT NULL,summary TEXT NOT NULL,PRIMARY KEY(scope,asset_id))");
            legacy.execSQL("CREATE TABLE deletions(id TEXT PRIMARY KEY,scope TEXT NOT NULL,asset_id TEXT NOT NULL,summary TEXT NOT NULL,state TEXT NOT NULL,message TEXT NOT NULL,created INTEGER NOT NULL,approval TEXT NOT NULL DEFAULT '')");
            for(var asset:List.of(versionPhoto("z-newest","2.9"),versionPhoto("a-oldest","1.8")))legacy.execSQL("INSERT INTO library VALUES(?,?,?)",new Object[]{"pc",asset.assetId(),FavoritePhotoStore.encode(asset).toString()});
            legacy.execSQL("INSERT INTO deletions VALUES(?,?,?,?,?,?,?,?)",new Object[]{"intent","pc",photo.assetId(),FavoritePhotoStore.encode(photo).toString(),"local","keep",1,""});legacy.setVersion(1);
        }
        store=new OrganizerStore(context);
        assertEquals(List.of("z-newest","a-oldest"),store.library("pc").stream().map(AssetSummary::assetId).toList());
        assertEquals(1,store.outgoing("pc").length());assertTrue(store.entries("pc").get(0).pending());
        assertEquals(2,store.getReadableDatabase().getVersion());
    }
    @Test public void completedRecyclingIsNotResentAndLocalFilesAreNotNeeded()throws Exception{
        store.enqueue("pc",List.of(photo));store.enqueue("pc",List.of(photo));assertEquals(1,store.entries("pc").size());String id=store.entries("pc").get(0).id();
        store.acknowledge("different",new JSONArray().put(new JSONObject().put("id",id).put("state","recycled")));assertEquals(1,store.outgoing("pc").length());
        store.acknowledge("pc",new JSONArray().put(new JSONObject().put("id",id).put("state","recycled").put("message","从回收站恢复")));assertEquals(0,store.outgoing("pc").length());assertEquals("recycled",store.entries("pc").get(0).state());
    }
    @Test public void processingIsPolledUntilATerminalResultAndCancellationSurvivesLateQueuedReplies()throws Exception{
        store.enqueue("pc",List.of(photo));String id=store.entries("pc").get(0).id();
        for(String state:List.of("preparing","pending","confirming","queued","checking","executing")){
            store.acknowledge("pc",new JSONArray().put(new JSONObject().put("id",id).put("state",state).put("approval","challenge")));
            assertEquals(1,store.outgoing("pc").length());
        }
        assertFalse(store.entries("pc").get(0).pending());
        store.acknowledge("pc",new JSONArray().put(new JSONObject().put("id",id).put("state","recycled")));assertEquals(0,store.outgoing("pc").length());
        store.enqueue("pc",List.of(photo));id=store.entries("pc").stream().filter(OrganizerStore.Entry::pending).findFirst().get().id();
        store.cancel("pc",List.of(id));
        for(String state:List.of("preparing","queued","checking"))store.acknowledge("pc",new JSONArray().put(new JSONObject().put("id",id).put("state",state)));
        assertTrue(store.outgoing("pc").getJSONObject(0).getBoolean("cancel"));
    }
    @Test public void aNewChallengeHasOneImmediateFollowUpAndRepeatedOrCancelledChallengesDoNotLoop()throws Exception{
        JSONArray sent=new JSONArray().put(new JSONObject().put("id","a").put("cancel",false));
        JSONArray challenge=new JSONArray().put(new JSONObject().put("id","a").put("state","confirming").put("approval","fresh"));
        assertTrue(OrganizerStore.needsFollowUp(sent,challenge));sent.getJSONObject(0).put("approval","fresh");assertFalse(OrganizerStore.needsFollowUp(sent,challenge));
        sent.getJSONObject(0).put("cancel",true).remove("approval");assertFalse(OrganizerStore.needsFollowUp(sent,challenge));
        for(String state:List.of("queued","checking","executing","recycled")){challenge.getJSONObject(0).put("state",state);assertFalse(OrganizerStore.needsFollowUp(new JSONArray(),challenge));}
    }
}
