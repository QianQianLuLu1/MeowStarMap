package app.nikkisync.mobile.inspiration;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.json.*;

/** Offline edits use a per-computer base revision; simultaneous edits retain both copies. */
public final class InspirationSyncEngine {
    public record Base(long revision,String hash) {}
    public record Versioned(long revision,JSONObject entry) {}
    public record Result(int synced,int conflicts,int failed) {}
    public interface Local {
        List<JSONObject> entries() throws Exception;
        default Set<String> unavailable(){return Set.of();}
        default boolean active(){return true;}
        Base base(String id) throws Exception;
        void mark(String id,long revision,String hash) throws Exception;
        boolean apply(JSONObject entry,String expectedLocalHash,Remote remote) throws Exception;
    }
    public interface Remote {
        List<Versioned> list() throws Exception;
        void ensureImages(JSONObject local,JSONObject target) throws Exception;
        Versioned save(JSONObject entry,long baseRevision) throws Exception;
        default byte[] image(String sha256) throws Exception {throw new UnsupportedOperationException();}
    }
    private final String server;private final Local local;private final Remote remote;
    public InspirationSyncEngine(String server,Local local,Remote remote){this.server=server;this.local=local;this.remote=remote;}
    public Result sync() throws Exception {
        Map<String,JSONObject> locals=new LinkedHashMap<>();for(JSONObject item:local.entries())locals.put(item.getString("id"),item);
        Map<String,Versioned> remotes=new LinkedHashMap<>();for(Versioned item:remote.list())remotes.put(item.entry().getString("id"),item);
        Set<String> ids=new LinkedHashSet<>(locals.keySet());ids.addAll(remotes.keySet());Set<String> unavailable=local.unavailable();ids.removeAll(unavailable);
        int synced=0,conflicts=0,failed=unavailable.size();
        for(String id:ids){if(!local.active()||Thread.currentThread().isInterrupted())throw new java.io.IOException("同步已中断");try{
            JSONObject a=locals.get(id);Versioned b=remotes.get(id);Base base=local.base(id);
            String localHash=a==null?null:digest(a),remoteHash=b==null?null:digest(b.entry());
            if(a==null&&b!=null){if(local.apply(b.entry(),null,remote)){local.mark(id,b.revision(),remoteHash);synced++;}else failed++;continue;}
            if(a!=null&&b==null){remote.ensureImages(a,a);Versioned pushed=remote.save(a,0);local.mark(id,pushed.revision(),localHash);synced++;continue;}
            if(a==null)continue;
            if(localHash.equals(remoteHash)){local.mark(id,b.revision(),localHash);continue;}
            boolean localChanged=base==null||!localHash.equals(base.hash());
            boolean remoteChanged=base==null||b.revision()!=base.revision();
            if(localChanged&&!remoteChanged){remote.ensureImages(a,a);Versioned pushed=remote.save(a,b.revision());local.mark(id,pushed.revision(),localHash);synced++;continue;}
            if(!localChanged&&remoteChanged){if(local.apply(b.entry(),localHash,remote)){local.mark(id,b.revision(),remoteHash);synced++;}else failed++;continue;}
            if(!localChanged){continue;}
            boolean localDeleted=a.optLong("deletedAt",0)>0,remoteDeleted=b.entry().optLong("deletedAt",0)>0;
            if(localDeleted&&remoteDeleted){if(local.apply(b.entry(),localHash,remote)){local.mark(id,b.revision(),remoteHash);synced++;}else failed++;continue;}
            JSONObject source=remoteDeleted?a:b.entry();
            String suffix=remoteDeleted?" · 手机冲突副本":" · 电脑冲突副本";
            String key=server+"\n"+id+"\n"+b.revision()+"\n"+localHash;
            String copyId=UUID.nameUUIDFromBytes(key.getBytes(StandardCharsets.UTF_8)).toString();
            JSONObject copy=new JSONObject(source.toString());copy.put("id",copyId);
            JSONObject code=copy.getJSONObject("code");code.put("id",UUID.nameUUIDFromBytes((copyId+"/code").getBytes(StandardCharsets.UTF_8)).toString());
            JSONArray copyImages=copy.getJSONArray("images");for(int i=0;i<copyImages.length();i++){
                JSONObject image=copyImages.getJSONObject(i);String originalId=image.getString("id");
                image.put("id",UUID.nameUUIDFromBytes((copyId+"/image/"+originalId).getBytes(StandardCharsets.UTF_8)).toString());
            }
            String title=copy.optString("title","");copy.put("title",title.substring(0,Math.min(title.length(),200-suffix.length()))+suffix);
            if(remoteDeleted)remote.ensureImages(a,copy);
            Versioned kept=remote.save(copy,0);
            JSONObject existing=locals.get(copyId);String expected=existing==null?null:digest(existing);
            if(existing!=null&&!expected.equals(digest(kept.entry())))throw new IllegalStateException("copy_changed");
            if(existing==null&&!local.apply(kept.entry(),null,remote))throw new IllegalStateException("copy_changed");
            local.mark(copyId,kept.revision(),digest(kept.entry()));
            if(remoteDeleted){if(!local.apply(b.entry(),localHash,remote))throw new IllegalStateException("local_changed");local.mark(id,b.revision(),remoteHash);}
            else{remote.ensureImages(a,a);Versioned pushed=remote.save(a,b.revision());local.mark(id,pushed.revision(),localHash);}
            conflicts++;synced++;
        }catch(Exception failure){if(!local.active()||Thread.currentThread().isInterrupted())throw failure;failed++;}}
        return new Result(synced,conflicts,failed);
    }
    public static String digest(JSONObject value)throws Exception{
        byte[] bytes=MessageDigest.getInstance("SHA-256").digest(canonical(value).getBytes(StandardCharsets.UTF_8));
        StringBuilder out=new StringBuilder();for(byte b:bytes)out.append(String.format(Locale.ROOT,"%02x",b&255));return out.toString();
    }
    private static String canonical(Object value)throws Exception{
        if(value==null||value==JSONObject.NULL)return "null";
        if(value instanceof JSONObject object){List<String> keys=new ArrayList<>();object.keys().forEachRemaining(keys::add);Collections.sort(keys);StringBuilder out=new StringBuilder("{");
            for(String key:keys){if(out.length()>1)out.append(',');out.append(JSONObject.quote(key)).append(':').append(canonical(object.get(key)));}return out.append('}').toString();}
        if(value instanceof JSONArray array){StringBuilder out=new StringBuilder("[");for(int i=0;i<array.length();i++){if(i>0)out.append(',');out.append(canonical(array.get(i)));}return out.append(']').toString();}
        if(value instanceof Number number)return JSONObject.numberToString(number);
        if(value instanceof Boolean)return value.toString();return JSONObject.quote(String.valueOf(value));
    }
}
