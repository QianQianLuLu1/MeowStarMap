package app.nikkisync.mobile.inspiration;

import android.content.Context;
import app.nikkisync.mobile.net.NikkiSyncClient;
import app.nikkisync.mobile.util.ByteStreams;
import java.io.IOException;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import java.util.function.BooleanSupplier;
import javax.net.ssl.HttpsURLConnection;
import org.json.*;

/** Syncs only with the explicitly paired PC, using the existing pinned TLS and signed requests. */
public final class InspirationSyncClient implements InspirationSyncEngine.Local,InspirationSyncEngine.Remote,AutoCloseable {
    public static final class UnsupportedServer extends IOException {public UnsupportedServer(){super("电脑端暂不支持灵感同步");}}
    @FunctionalInterface interface Opener {HttpsURLConnection open(String method,String path,byte[] body,String mime)throws Exception;}
    private final InspirationStore store;private final InspirationImageStore images;private final Opener open;
    private final String scope;private final BooleanSupplier active;private final Set<String> unavailable=new LinkedHashSet<>();
    public InspirationSyncClient(Context context,NikkiSyncClient client,BooleanSupplier active){
        this(context,client.server().serverId()+"\n"+client.server().tlsFingerprintSha256(),active,
                (method,path,body,mime)->client.signedHttp().open(method,path,body,true,mime));
    }
    InspirationSyncClient(Context context,String scope,BooleanSupplier active,Opener open){store=new InspirationStore(context);images=new InspirationImageStore(context);this.scope=scope;this.active=active;this.open=open;}
    private HttpsURLConnection request(String method,String path,byte[] body,String mime)throws Exception{return open.open(method,path,body,mime);}
    private void check()throws IOException{if(Thread.currentThread().isInterrupted()||!active.getAsBoolean())throw new IOException("同步已中断");}
    public InspirationSyncEngine.Result sync()throws Exception{return new InspirationSyncEngine(scope,this,this).sync();}
    @Override public void close(){store.close();}
    @Override public List<JSONObject> entries()throws Exception{
        check();unavailable.clear();List<JSONObject> out=new ArrayList<>();
        for(var entry:store.changesAfter(0)){check();try{out.add(store.syncEntry(entry,images));}catch(Exception failure){unavailable.add(entry.id());}}
        return out;
    }
    @Override public Set<String> unavailable(){return Set.copyOf(unavailable);}
    @Override public boolean active(){return active.getAsBoolean();}
    @Override public InspirationSyncEngine.Base base(String id){return store.syncBase(scope,id);}
    @Override public void mark(String id,long revision,String hash)throws Exception{check();store.markSyncBase(scope,id,revision,hash);}
    @Override public boolean apply(JSONObject entry,String expected,InspirationSyncEngine.Remote remote)throws Exception{
        check();return store.applySyncEntry(entry,expected,images,new InspirationSyncEngine.Remote(){
            public List<InspirationSyncEngine.Versioned> list()throws Exception{return remote.list();}
            public void ensureImages(JSONObject a,JSONObject b)throws Exception{remote.ensureImages(a,b);}
            public InspirationSyncEngine.Versioned save(JSONObject a,long b)throws Exception{return remote.save(a,b);}
            public byte[] image(String hash)throws Exception{check();return remote.image(hash);}
        },active);
    }
    @Override public List<InspirationSyncEngine.Versioned> list()throws Exception{
        List<InspirationSyncEngine.Versioned> result=new ArrayList<>();String cursor="";
        do{
            check();String path="/v1/inspiration?limit=20"+(cursor.isEmpty()?"":"&after="+cursor);
            HttpsURLConnection connection=request("GET",path,new byte[0],"application/json; charset=utf-8");
            try{
                int status=connection.getResponseCode();if(status==404)throw new UnsupportedServer();if(status!=200)throw new IOException("灵感读取失败");
                byte[] bytes=ByteStreams.readNBytes(connection.getInputStream(),11*1024*1024+1);if(bytes.length>11*1024*1024)throw new IOException("灵感数据过大");
                JSONObject data=new JSONObject(new String(bytes,java.nio.charset.StandardCharsets.UTF_8));JSONArray items=data.getJSONArray("items");if(items.length()>20)throw new IOException("灵感分页异常");
                for(int i=0;i<items.length();i++){JSONObject row=items.getJSONObject(i);result.add(new InspirationSyncEngine.Versioned(row.getLong("revision"),row.getJSONObject("entry")));}
                String next=data.isNull("nextCursor")?"":data.getString("nextCursor");if(!next.isEmpty()&&(!next.matches("(?i)[a-f0-9-]{36}")||next.compareTo(cursor)<=0))throw new IOException("灵感分页异常");cursor=next;
                if(result.size()>100000)throw new IOException("灵感记录过多");
            }finally{connection.disconnect();}
        }while(!cursor.isEmpty());return result;
    }
    @Override public void ensureImages(JSONObject local,JSONObject target)throws Exception{
        check();JSONArray required=target.getJSONArray("images");if(required.length()==0)return;
        InspirationStore.Entry entry=store.getIncludingDeleted(local.getString("id"));if(entry==null)throw new IOException("灵感已更改，请重试");
        Map<String,InspirationStore.Image> lookup=new HashMap<>();for(var image:entry.images())lookup.put(image.id(),image);
        Map<String,InspirationStore.Image> byHash=new HashMap<>();JSONArray localImages=local.getJSONArray("images");
        for(int i=0;i<localImages.length();i++){JSONObject info=localImages.getJSONObject(i);var image=lookup.get(info.getString("id"));if(image!=null)byHash.put(info.getString("sha256"),image);}
        for(int i=0;i<required.length();i++){
            check();JSONObject descriptor=required.getJSONObject(i);String hash=descriptor.getString("sha256"),path="/v1/inspiration/images/"+hash;
            if(!hash.matches("[a-f0-9]{64}"))throw new IOException("参考图校验失败");
            HttpsURLConnection head=request("HEAD",path,new byte[0],"application/json; charset=utf-8");int status;
            try{status=head.getResponseCode();if(status==200&&(head.getContentLengthLong()!=descriptor.getLong("bytes")||!descriptor.getString("mimeType").equals(head.getContentType())))throw new IOException("参考图格式不匹配");}finally{head.disconnect();}
            if(status==200)continue;if(status==404){
                var localImage=lookup.get(descriptor.getString("id"));if(localImage==null)localImage=byHash.get(hash);if(localImage==null)throw new IOException("参考图已变化，请重试");
                var file=images.resolve(localImage.localName());if(!file.isFile()||file.length()!=descriptor.getLong("bytes")||file.length()>InspirationImageStore.MAX_BYTES)throw new IOException("参考图不可访问");
                byte[] bytes=Files.readAllBytes(file.toPath());if(!app.nikkisync.mobile.util.Hex.lower(MessageDigest.getInstance("SHA-256").digest(bytes)).equals(hash))throw new IOException("参考图已变化，请重试");
                HttpsURLConnection put=request("PUT",path,bytes,descriptor.getString("mimeType"));try{if(put.getResponseCode()!=200)throw new IOException("参考图上传失败");}finally{put.disconnect();}
            }else throw new IOException("参考图检查失败");
        }
    }
    @Override public InspirationSyncEngine.Versioned save(JSONObject entry,long base)throws Exception{
        check();byte[] body=new JSONObject().put("baseRevision",base).put("entry",entry).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
        HttpsURLConnection connection=request("POST","/v1/inspiration",body,"application/json; charset=utf-8");
        try{int status=connection.getResponseCode();if(status==409)throw new IOException("灵感已在另一端更新，请重试");if(status==404)throw new UnsupportedServer();if(status!=200)throw new IOException("灵感保存失败");
            byte[] data=ByteStreams.readNBytes(connection.getInputStream(),600*1024+1);if(data.length>600*1024)throw new IOException("灵感数据过大");JSONObject row=new JSONObject(new String(data,java.nio.charset.StandardCharsets.UTF_8));return new InspirationSyncEngine.Versioned(row.getLong("revision"),row.getJSONObject("entry"));
        }finally{connection.disconnect();}
    }
    @Override public byte[] image(String sha)throws Exception{
        check();if(!sha.matches("[a-f0-9]{64}"))throw new IOException("参考图校验失败");
        HttpsURLConnection c=request("GET","/v1/inspiration/images/"+sha,new byte[0],"application/json; charset=utf-8");
        try{if(c.getResponseCode()!=200)throw new IOException("参考图下载失败");byte[] bytes=ByteStreams.readNBytes(c.getInputStream(),(int)InspirationImageStore.MAX_BYTES+1);if(bytes.length>InspirationImageStore.MAX_BYTES)throw new IOException("参考图过大");return bytes;}
        finally{c.disconnect();}
    }
}
