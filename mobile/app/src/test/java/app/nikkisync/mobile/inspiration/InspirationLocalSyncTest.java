package app.nikkisync.mobile.inspiration;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.util.*;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

@RunWith(RobolectricTestRunner.class)
public class InspirationLocalSyncTest {
    private android.content.Context context;private InspirationStore store;private InspirationImageStore images;
    private static final byte[] PNG=java.util.Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAABQAAAAeCAIAAACjcKk8AAAAHklEQVR4nGMockohGzGMah7VPKp5VPOo5lHNw1kzAEYskF8kUse2AAAAAElFTkSuQmCC");
    @Before public void setup(){context=RuntimeEnvironment.getApplication();context.deleteDatabase("nikkisync-inspiration.db");store=new InspirationStore(context);images=new InspirationImageStore(context);}
    @After public void close(){store.close();}
    @Test public void oldDatabaseMigratesWithoutLosingEntries(){
        var entry=store.create(new InspirationStore.Draft("","old","dye","原文",null,"",List.of(),List.of("日常"),"self"),1);store.close();
        var db=context.openOrCreateDatabase("nikkisync-inspiration.db",0,null);db.execSQL("DROP TABLE inspiration_sync_state");db.setVersion(1);db.close();
        store=new InspirationStore(context);assertEquals("old",store.get(entry.id()).code().rawCode());assertNull(store.syncBase("pc",entry.id()));
    }
    @Test public void remoteApplyPreservesUserDataAndRejectsStaleLocalReplacement()throws Exception {
        var entry=store.create(new InspirationStore.Draft("旧","code","dye","原始分享",null,"备注",List.of("标签"),List.of("日常"),"self"),1);
        var copied=images.copy(new ByteArrayInputStream(PNG),"image/png");store.attachImage(entry.id(),copied.localName(),copied.mimeType(),copied.bytes(),2);
        JSONObject local=store.syncEntry(store.get(entry.id()),images),remote=new JSONObject(local.toString());remote.getJSONObject("code").put("rawCode","remote");
        String expected=InspirationSyncEngine.digest(local);var fake=new InspirationSyncEngine.Remote(){
            public List<InspirationSyncEngine.Versioned> list(){return List.of();}
            public void ensureImages(JSONObject a,JSONObject b){}
            public InspirationSyncEngine.Versioned save(JSONObject a,long b){return null;}
            public byte[] image(String hash){return PNG;}
        };
        assertFalse(store.applySyncEntry(remote,"not-current",images,fake));assertEquals("code",store.get(entry.id()).code().rawCode());
        assertTrue(store.applySyncEntry(remote,expected,images,fake));var result=store.get(entry.id());
        assertEquals("remote",result.code().rawCode());assertEquals("原始分享",result.code().sourceText());assertEquals("备注",result.notes());assertEquals(List.of("标签"),result.tags());assertEquals(1,result.images().size());
        assertArrayEquals(PNG,java.nio.file.Files.readAllBytes(images.resolve(result.images().get(0).localName()).toPath()));
        store.markSyncBase("pc",entry.id(),9,InspirationSyncEngine.digest(store.syncEntry(result,images)));
        assertEquals(9,store.syncBase("pc",entry.id()).revision());assertNull(store.syncBase("different-pc",entry.id()));
    }
    @Test public void editorCannotOverwriteAConcurrentRemoteUpdate()throws Exception{
        var entry=store.create(new InspirationStore.Draft("","old","dye","",null,"",List.of(),List.of(),"want"),1);
        store.updateUserFields(entry.id(),"","changed elsewhere",List.of(),List.of(),"self",2);
        var draft=new InspirationStore.Draft("","edited","dye","",null,"",List.of(),List.of(),"want");
        assertThrows(IllegalStateException.class,()->store.saveWithImages(entry,draft,List.of(),List.of(),3));
        assertEquals("changed elsewhere",store.get(entry.id()).notes());
    }
    @Test public void remoteSnapshotSurvivesAnImportAndLaterMetadataEdit()throws Exception{
        var source=store.create(new InspirationStore.Draft("","shared","dye","",null,"",List.of(),List.of(),"want"),1);
        store.recordParseResult(source.code().id(),"success","{\"pieces\":[1,2]}","resolver-1","dictionary-1",2);
        JSONObject remote=store.syncEntry(store.get(source.id()),images);
        String importedId=UUID.randomUUID().toString();remote.put("id",importedId);remote.getJSONObject("code").put("id",UUID.randomUUID().toString());
        var fake=new InspirationSyncEngine.Remote(){
            public List<InspirationSyncEngine.Versioned> list(){return List.of();}
            public void ensureImages(JSONObject a,JSONObject b){}
            public InspirationSyncEngine.Versioned save(JSONObject a,long b){return null;}
            public byte[] image(String hash){throw new AssertionError("no reference images");}
        };
        assertTrue(store.applySyncEntry(remote,null,images,fake));
        var imported=store.get(importedId);assertEquals("{\"pieces\":[1,2]}",imported.code().snapshotJson());
        assertEquals("resolver-1",imported.code().resolverVersion());assertEquals("dictionary-1",imported.code().dictionaryVersion());
        String base=InspirationSyncEngine.digest(store.syncEntry(imported,images));remote.put("notes","edited remotely");
        assertTrue(store.applySyncEntry(remote,base,images,fake));
        assertEquals("{\"pieces\":[1,2]}",store.get(importedId).code().snapshotJson());assertEquals("edited remotely",store.get(importedId).notes());
    }
    @Test public void corruptRemoteImageCannotReplaceAnExistingRecord()throws Exception{
        var entry=store.create(new InspirationStore.Draft("","safe","dye","",null,"original",List.of(),List.of(),"want"),1);
        var copied=images.copy(new ByteArrayInputStream(PNG),"image/png");store.attachImage(entry.id(),copied.localName(),copied.mimeType(),copied.bytes(),2);
        JSONObject current=store.syncEntry(store.get(entry.id()),images),remote=new JSONObject(current.toString());remote.put("notes","must not be committed");
        var fake=new InspirationSyncEngine.Remote(){
            public List<InspirationSyncEngine.Versioned> list(){return List.of();}
            public void ensureImages(JSONObject a,JSONObject b){}
            public InspirationSyncEngine.Versioned save(JSONObject a,long b){return null;}
            public byte[] image(String hash){return new byte[PNG.length];}
        };
        assertThrows(java.io.IOException.class,()->store.applySyncEntry(remote,InspirationSyncEngine.digest(current),images,fake));
        var result=store.get(entry.id());assertEquals("original",result.notes());assertEquals(1,result.images().size());
        assertArrayEquals(PNG,java.nio.file.Files.readAllBytes(images.resolve(result.images().get(0).localName()).toPath()));
    }
    @Test public void realLocalDatabaseKeepsBothPicturesWhenPhoneAndComputerEditOffline()throws Exception{
        var entry=store.create(new InspirationStore.Draft("","first","dye","原文",null,"备注",List.of("标签"),List.of("日常"),"self"),1);
        var copy=images.copy(new ByteArrayInputStream(PNG),"image/png");store.attachImage(entry.id(),copy.localName(),copy.mimeType(),copy.bytes(),2);
        class FakeRemote implements InspirationSyncEngine.Remote {
            final Map<String,InspirationSyncEngine.Versioned> rows=new LinkedHashMap<>();final Map<String,byte[]> media=new HashMap<>();long clock;
            public List<InspirationSyncEngine.Versioned> list(){return new ArrayList<>(rows.values());}
            public void ensureImages(JSONObject local,JSONObject target)throws Exception{var a=target.getJSONArray("images");for(int i=0;i<a.length();i++)media.put(a.getJSONObject(i).getString("sha256"),PNG);}
            public InspirationSyncEngine.Versioned save(JSONObject value,long base)throws Exception{String id=value.getString("id");var before=rows.get(id);
                if(before!=null&&InspirationSyncEngine.digest(before.entry()).equals(InspirationSyncEngine.digest(value)))return before;
                if((before==null?0:before.revision())!=base)throw new IllegalStateException("conflict");var result=new InspirationSyncEngine.Versioned(++clock,new JSONObject(value.toString()));rows.put(id,result);return result;}
            public byte[] image(String hash){return media.get(hash);}
        }
        var remote=new FakeRemote();var local=new InspirationSyncEngine.Local(){
            public List<JSONObject> entries()throws Exception{List<JSONObject> result=new ArrayList<>();for(var row:store.changesAfter(0))result.add(store.syncEntry(row,images));return result;}
            public InspirationSyncEngine.Base base(String id){return store.syncBase("pc",id);}
            public void mark(String id,long revision,String hash){store.markSyncBase("pc",id,revision,hash);}
            public boolean apply(JSONObject row,String expected,InspirationSyncEngine.Remote source)throws Exception{return store.applySyncEntry(row,expected,images,source);}
        };
        var engine=new InspirationSyncEngine("pc",local,remote);assertEquals(0,engine.sync().failed());
        JSONObject desktop=new JSONObject(remote.rows.get(entry.id()).entry().toString());desktop.getJSONObject("code").put("rawCode","desktop edit");remote.save(desktop,1);
        var current=store.get(entry.id());store.updateUserFields(entry.id(),current.title(),current.notes(),current.tags(),List.of("手机编辑"),current.status(),4);
        var result=engine.sync();assertEquals(1,result.conflicts());assertEquals(0,result.failed());
        var all=store.search("",null,null);assertEquals(2,all.size());assertTrue(all.stream().anyMatch(e->e.code().rawCode().equals("desktop edit")));
        for(var item:all){assertEquals(1,item.images().size());assertArrayEquals(PNG,java.nio.file.Files.readAllBytes(images.resolve(item.images().get(0).localName()).toPath()));}
        assertEquals(0,engine.sync().failed());assertEquals(2,remote.rows.size());
    }
}
