package app.nikkisync.mobile.update;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.Rule;
import org.junit.rules.TemporaryFolder;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.Signature;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.*;

public class AndroidUpdateClientTest {
    @Rule public TemporaryFolder directory=new TemporaryFolder();
    private static final URI FEED=URI.create("https://example.test/update.json");
    private static final String APP="app.nikkisync.mobile";
    private static final byte[] APK="synthetic APK bytes for transport testing".getBytes(StandardCharsets.UTF_8);

    @Test public void verifiesExactFeedAndIgnoresOldOrEqualBuilds() throws Exception {
        var key=KeyPairGenerator.getInstance("RSA").generateKeyPair();
        byte[] manifest=manifest(61,"https://example.test/app.apk");
        var signature=Signature.getInstance("SHA256withRSA");
        signature.initSign(key.getPrivate());signature.update(manifest);
        byte[] signed=signature.sign();
        var client=new AndroidUpdateClient(key.getPublic(),(url,offset)->response(200,null,
                new ByteArrayInputStream(url.equals(FEED)?manifest:signed)));
        assertEquals(61,client.check(FEED,APP,60).versionCode());
        assertNull(client.check(FEED,APP,61));
        assertThrows(AndroidUpdateClient.VerificationException.class,()->client.check(FEED,"other.app",60));
        manifest[manifest.length-1]=' ';
        assertThrows(AndroidUpdateClient.VerificationException.class,()->client.check(FEED,APP,60));
    }

    @Test public void interruptedDownloadResumesAndVerifiesBeforePublication() throws Exception {
        var requests=new AtomicInteger();
        var client=client((url,offset)->{
            if(requests.getAndIncrement()==0){
                assertEquals(0,offset);
                return response(200,null,new InputStream(){
                    boolean started;
                    @Override public int read()throws IOException{throw new IOException("test interruption");}
                    @Override public int read(byte[] buffer,int start,int length)throws IOException{
                        if(started)throw new IOException("test interruption");
                        started=true;System.arraycopy(APK,0,buffer,start,9);return 9;
                    }
                });
            }
            assertEquals(9,offset);
            return response(206,"bytes 9-"+(APK.length-1)+"/"+APK.length,
                    new ByteArrayInputStream(Arrays.copyOfRange(APK,9,APK.length)));
        });
        File cache=directory.getRoot();
        assertThrows(IOException.class,()->client.download(update(),cache,(file,release)->{},(size,total)->{}));
        assertEquals(9,new File(cache,update().sha256()+".part.apk").length());
        var verified=new AtomicInteger();
        File apk=client.download(update(),cache,(file,release)->{
            assertArrayEquals(APK,Files.readAllBytes(file.toPath()));verified.incrementAndGet();
        },(size,total)->{});
        assertEquals(1,verified.get());
        assertArrayEquals(APK,Files.readAllBytes(apk.toPath()));
        assertFalse(new File(cache,update().sha256()+".part.apk").exists());
    }

    @Test public void rejectsCorruptPayloadAndWrongArchiveIdentity() throws Exception {
        byte[] bad=APK.clone();bad[1]^=1;
        var client=client((url,offset)->response(200,null,new ByteArrayInputStream(bad)));
        var cache=directory.getRoot();
        assertThrows(AndroidUpdateClient.VerificationException.class,
                ()->client.download(update(),cache,(file,release)->fail("must verify bytes first"),(size,total)->{}));
        assertEquals(0,cache.list().length);
        var validBytes=client((url,offset)->response(200,null,new ByteArrayInputStream(APK)));
        assertThrows(AndroidUpdateClient.VerificationException.class,
                ()->validBytes.download(update(),cache,(file,release)->{throw new AndroidUpdateClient.VerificationException();},(size,total)->{}));
        assertEquals(0,cache.list().length);
    }

    private static AndroidUpdateClient client(AndroidUpdateClient.Transport transport){
        return new AndroidUpdateClient(null,transport);
    }
    private static AndroidUpdateClient.Release update() throws Exception {
        return new AndroidUpdateClient.Release("1.0.33",61,URI.create("https://example.test/app.apk"),APK.length,sha(),"");
    }
    private static byte[] manifest(int code,String url)throws Exception{
        return new JSONObject().put("Schema",1).put("AppId",APP).put("Version","1.0.33").put("VersionCode",code)
                .put("Size",APK.length).put("DownloadUrl",url).put("Sha256",sha()).put("Notes","test")
                .toString().getBytes(StandardCharsets.UTF_8);
    }
    private static String sha()throws Exception{
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(APK));
    }
    private static AndroidUpdateClient.Response response(int status,String range,InputStream body){
        return new AndroidUpdateClient.Response(){
            public int status(){return status;}
            public String header(String name){return "Content-Range".equals(name)?range:null;}
            public InputStream body(){return body;}
            public void close()throws IOException{body.close();}
        };
    }
}
