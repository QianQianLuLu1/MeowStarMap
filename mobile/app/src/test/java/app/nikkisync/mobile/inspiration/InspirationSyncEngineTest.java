package app.nikkisync.mobile.inspiration;

import static org.junit.Assert.*;
import java.util.*;
import org.json.*;
import org.junit.Test;

public class InspirationSyncEngineTest {
    private static JSONObject item(String id,String code,long deleted)throws Exception {
        return new JSONObject().put("id",id).put("title","").put("deletedAt",deleted)
                .put("code",new JSONObject().put("id","33333333-3333-4333-8333-333333333333").put("rawCode",code)).put("images",new JSONArray());
    }
    private static final String ID="11111111-1111-4111-8111-111111111111";
    static class Local implements InspirationSyncEngine.Local {
        final Map<String,JSONObject> entries=new LinkedHashMap<>();final Map<String,InspirationSyncEngine.Base> bases=new HashMap<>();
        public List<JSONObject> entries(){return new ArrayList<>(entries.values());}
        public InspirationSyncEngine.Base base(String id){return bases.get(id);}
        public void mark(String id,long revision,String hash){bases.put(id,new InspirationSyncEngine.Base(revision,hash));}
        public boolean apply(JSONObject entry,String expected,InspirationSyncEngine.Remote remote)throws Exception {
            String id=entry.getString("id");JSONObject previous=entries.get(id);
            if(!Objects.equals(expected,previous==null?null:InspirationSyncEngine.digest(previous)))return false;
            entries.put(id,new JSONObject(entry.toString()));return true;
        }
    }
    static class Remote implements InspirationSyncEngine.Remote {
        final Map<String,InspirationSyncEngine.Versioned> entries=new LinkedHashMap<>();long clock;
        public List<InspirationSyncEngine.Versioned> list(){return new ArrayList<>(entries.values());}
        public void ensureImages(JSONObject local,JSONObject target){}
        public InspirationSyncEngine.Versioned save(JSONObject entry,long base)throws Exception {
            String id=entry.getString("id");var current=entries.get(id);
            if(current!=null&&InspirationSyncEngine.digest(current.entry()).equals(InspirationSyncEngine.digest(entry)))return current;
            if((current==null?0:current.revision())!=base)throw new IllegalStateException("conflict");
            var result=new InspirationSyncEngine.Versioned(++clock,new JSONObject(entry.toString()));entries.put(id,result);return result;
        }
    }
    @Test public void initialOfflineUploadAndRemoteUpdateWorkWithoutDependingOnClock()throws Exception {
        var local=new Local();var remote=new Remote();local.entries.put(ID,item(ID,"original",0));
        new InspirationSyncEngine("pc",local,remote).sync();assertEquals(1,remote.entries.size());
        remote.save(item(ID,"computer edit",0),1);new InspirationSyncEngine("pc",local,remote).sync();
        assertEquals("computer edit",local.entries.get(ID).getJSONObject("code").getString("rawCode"));
    }
    @Test public void concurrentEditsPreserveBothAndRepeatIsIdempotent()throws Exception {
        var local=new Local();var remote=new Remote();local.entries.put(ID,item(ID,"first",0));var engine=new InspirationSyncEngine("pc",local,remote);engine.sync();
        local.entries.put(ID,item(ID,"phone",0));remote.save(item(ID,"desktop",0),1);engine.sync();
        assertEquals(2,local.entries.size());assertEquals(2,remote.entries.size());
        assertTrue(local.entries.values().stream().anyMatch(e->e.optJSONObject("code").optString("rawCode").equals("phone")));
        assertTrue(local.entries.values().stream().anyMatch(e->e.optJSONObject("code").optString("rawCode").equals("desktop")));
        engine.sync();assertEquals(2,remote.entries.size());
    }
    @Test public void deleteAndConcurrentEditRetainTheEditedCopy()throws Exception {
        var local=new Local();var remote=new Remote();local.entries.put(ID,item(ID,"first",0));var engine=new InspirationSyncEngine("pc",local,remote);engine.sync();
        local.entries.put(ID,item(ID,"first",10));remote.save(item(ID,"desktop change",0),1);engine.sync();
        assertTrue(remote.entries.get(ID).entry().getLong("deletedAt")>0);
        assertTrue(local.entries.values().stream().anyMatch(e->e.optLong("deletedAt")==0&&e.optJSONObject("code").optString("rawCode").equals("desktop change")));
    }
    @Test public void remoteDeleteAndOfflineEditKeepAPhoneCopy()throws Exception {
        var local=new Local();var remote=new Remote();local.entries.put(ID,item(ID,"first",0));var engine=new InspirationSyncEngine("pc",local,remote);engine.sync();
        local.entries.put(ID,item(ID,"phone change",0));remote.save(item(ID,"first",10),1);engine.sync();
        assertTrue(local.entries.get(ID).getLong("deletedAt")>0);
        assertTrue(local.entries.values().stream().anyMatch(e->e.optLong("deletedAt")==0&&e.optJSONObject("code").optString("rawCode").equals("phone change")));
    }
    @Test public void unreadableLocalImageDoesNotCauseRemoteToOverwriteThatRecord()throws Exception {
        var local=new Local(){@Override public Set<String> unavailable(){return Set.of(ID);}};
        var remote=new Remote();remote.save(item(ID,"desktop",0),0);
        var result=new InspirationSyncEngine("pc",local,remote).sync();
        assertFalse(local.entries.containsKey(ID));assertEquals(1,result.failed());
    }
    @Test public void editingWhileUploadingIsDetectedOnTheNextSync()throws Exception {
        var local=new Local();local.entries.put(ID,item(ID,"first",0));
        var remote=new Remote(){boolean changed;
            @Override public void ensureImages(JSONObject a,JSONObject b){if(!changed){changed=true;try{local.entries.put(ID,item(ID,"changed while uploading",0));}catch(Exception e){throw new RuntimeException(e);}}}
        };
        var engine=new InspirationSyncEngine("pc",local,remote);engine.sync();engine.sync();
        assertEquals("changed while uploading",remote.entries.get(ID).entry().getJSONObject("code").getString("rawCode"));
    }
    @Test public void unsupportedComputerDoesNotChangeLocalRecords()throws Exception {
        var local=new Local();local.entries.put(ID,item(ID,"keep",0));
        var remote=new Remote(){@Override public List<InspirationSyncEngine.Versioned> list(){throw new IllegalStateException("unsupported");}};
        assertThrows(IllegalStateException.class,()->new InspirationSyncEngine("old-computer",local,remote).sync());
        assertEquals("keep",local.entries.get(ID).getJSONObject("code").getString("rawCode"));
    }
}
