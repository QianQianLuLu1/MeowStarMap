package app.nikkisync.mobile.inspiration;

import static org.junit.Assert.*;
import java.io.*;
import java.net.URL;
import java.security.cert.Certificate;
import java.util.*;
import javax.net.ssl.HttpsURLConnection;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

@RunWith(RobolectricTestRunner.class)
public class InspirationSyncClientTest {
    private static final byte[] PNG=Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAABQAAAAeCAIAAACjcKk8AAAAHklEQVR4nGMockohGzGMah7VPKp5VPOo5lHNw1kzAEYskF8kUse2AAAAAElFTkSuQmCC");
    private android.content.Context context;private InspirationStore store;private InspirationImageStore images;
    @Before public void setup(){context=RuntimeEnvironment.getApplication();context.deleteDatabase("nikkisync-inspiration.db");store=new InspirationStore(context);images=new InspirationImageStore(context);}
    @After public void close(){store.close();}
    @Test public void imageAndMetadataTravelBothWaysAndUnchangedBytesAreNotReuploaded()throws Exception {
        var entry=store.create(new InspirationStore.Draft("","code","dye","原文",null,"备注",List.of("标签"),List.of("日常"),"self"),1);
        var image=images.copy(new ByteArrayInputStream(PNG),"image/png");store.attachImage(entry.id(),image.localName(),image.mimeType(),image.bytes(),2);
        Wire wire=new Wire();
        try(var client=new InspirationSyncClient(context,"computer",()->true,wire::open)){
            var first=client.sync();assertEquals(0,first.failed());assertEquals(1,wire.uploads);assertEquals(1,wire.rows.size());
            var current=store.get(entry.id());store.updateUserFields(current.id(),current.title(),current.notes(),current.tags(),List.of("新分类"),current.status(),3);
            assertEquals(0,client.sync().failed());assertEquals("unchanged reference must use HEAD instead of uploading again",1,wire.uploads);
            JSONObject desktop=new JSONObject(wire.rows.get(entry.id()).toString());desktop.getJSONObject("entry").put("status","reproduced");wire.putRow(desktop.getJSONObject("entry"),desktop.getLong("revision"));
            assertEquals(0,client.sync().failed());assertEquals("reproduced",store.get(entry.id()).status());assertEquals(1,store.get(entry.id()).images().size());
            assertArrayEquals(PNG,java.nio.file.Files.readAllBytes(images.resolve(store.get(entry.id()).images().get(0).localName()).toPath()));
        }
    }
    @Test public void olderComputerIsReportedWithoutDeletingPhoneData()throws Exception{
        var entry=store.create(new InspirationStore.Draft("","keep","dye","",null,"",List.of(),List.of(),"want"),1);
        try(var client=new InspirationSyncClient(context,"old",()->true,(a,b,c,d)->new FakeConnection(404,new byte[0],null,0))){
            assertThrows(InspirationSyncClient.UnsupportedServer.class,client::sync);assertEquals("keep",store.get(entry.id()).code().rawCode());
        }
    }
    static final class Wire {
        final Map<String,JSONObject> rows=new TreeMap<>();final Map<String,byte[]> media=new HashMap<>();long clock;int uploads;
        HttpsURLConnection open(String method,String path,byte[] body,String mime)throws Exception{
            if(method.equals("GET")&&path.startsWith("/v1/inspiration?"))return json(200,new JSONObject().put("items",new JSONArray(rows.values())).put("nextCursor",JSONObject.NULL));
            if(path.startsWith("/v1/inspiration/images/")){String hash=path.substring(path.lastIndexOf('/')+1);byte[] data=media.get(hash);
                if(method.equals("HEAD"))return new FakeConnection(data==null?404:200,new byte[0],"image/png",data==null?0:data.length);
                if(method.equals("PUT")){assertEquals("image/png",mime);assertEquals(hash,app.nikkisync.mobile.util.Hex.lower(java.security.MessageDigest.getInstance("SHA-256").digest(body)));media.put(hash,body.clone());uploads++;return json(200,new JSONObject().put("ok",true));}
                return new FakeConnection(data==null?404:200,data==null?new byte[0]:data,"image/png",data==null?0:data.length);
            }
            if(method.equals("POST")){JSONObject input=new JSONObject(new String(body,java.nio.charset.StandardCharsets.UTF_8));JSONObject row=putRow(input.getJSONObject("entry"),input.getLong("baseRevision"));return json(200,row);}
            return new FakeConnection(404,new byte[0],null,0);
        }
        JSONObject putRow(JSONObject entry,long base)throws Exception{String id=entry.getString("id");JSONObject before=rows.get(id);if((before==null?0:before.getLong("revision"))!=base)throw new IOException("conflict");JSONObject next=new JSONObject().put("revision",++clock).put("entry",new JSONObject(entry.toString()));rows.put(id,next);return next;}
        HttpsURLConnection json(int status,JSONObject value)throws Exception{return new FakeConnection(status,value.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8),"application/json",0);}
    }
    static final class FakeConnection extends HttpsURLConnection {
        final int status;final byte[] data;final String mime;final long length;
        FakeConnection(int status,byte[] data,String mime,long length)throws Exception{super(new URL("https://127.0.0.1/"));this.status=status;this.data=data;this.mime=mime;this.length=length;}
        @Override public int getResponseCode(){return status;}
        @Override public InputStream getInputStream(){return new ByteArrayInputStream(data);}
        @Override public String getContentType(){return mime;}
        @Override public long getContentLengthLong(){return length;}
        @Override public void connect(){}
        @Override public void disconnect(){}
        @Override public boolean usingProxy(){return false;}
        @Override public String getCipherSuite(){return "";}
        @Override public Certificate[] getLocalCertificates(){return null;}
        @Override public Certificate[] getServerCertificates(){return null;}
    }
}
