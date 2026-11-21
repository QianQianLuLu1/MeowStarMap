package app.nikkisync.mobile.update;

import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import javax.net.ssl.HttpsURLConnection;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;

/** Trust the bundled update key first, then the signed size, digest and Android package identity. */
public final class AndroidUpdateClient {
    private static final long MAX_APK_BYTES=200L*1024*1024;
    private static final int MAX_FEED_BYTES=32*1024;
    private final PublicKey key;
    private final Transport transport;

    public record Release(String version,int versionCode,URI apk,long size,String sha256,String notes){}
    public static final class VerificationException extends IOException {
        public VerificationException(){super("Update verification failed");}
    }
    public static final class FeedUnavailableException extends IOException {}
    interface Transport {Response open(URI uri,long offset)throws IOException;}
    interface Response extends AutoCloseable {
        int status();
        String header(String name);
        InputStream body()throws IOException;
        @Override void close()throws IOException;
    }
    public interface ArchiveVerifier {void verify(File apk,Release release)throws IOException;}
    public interface Progress {void received(long bytes,long total);}

    AndroidUpdateClient(PublicKey key,Transport transport){this.key=key;this.transport=transport;}
    public static AndroidUpdateClient fromPem(InputStream pem)throws IOException {
        String text=new String(readBounded(pem,4096),StandardCharsets.US_ASCII)
                .replace("-----BEGIN PUBLIC KEY-----","").replace("-----END PUBLIC KEY-----","").replaceAll("\\s","");
        try {
            byte[] bytes=Base64.getDecoder().decode(text);
            PublicKey key=KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(bytes));
            return new AndroidUpdateClient(key,AndroidUpdateClient::openHttps);
        }catch(GeneralSecurityException|IllegalArgumentException error){throw new VerificationException();}
    }

    public Release check(URI feed,String appId,long installedCode)throws IOException {
        requireHttps(feed);
        if(feed.getRawQuery()!=null)throw new VerificationException();
        byte[] json=fetch(feed,MAX_FEED_BYTES);
        byte[] signed=fetch(URI.create(feed+".sig"),1024);
        try {
            Signature verifier=Signature.getInstance("SHA256withRSA");
            verifier.initVerify(key);
            verifier.update(json);
            if(!verifier.verify(signed))throw new VerificationException();
            JSONTokener tokens=new JSONTokener(new String(json,StandardCharsets.UTF_8));
            if(!(tokens.nextValue() instanceof JSONObject manifest)||tokens.nextClean()!=0
                    ||integer(manifest,"Schema")!=1||!appId.equals(manifest.get("AppId")))throw new VerificationException();
            long code=integer(manifest,"VersionCode"),size=integer(manifest,"Size");
            String version=manifest.getString("Version"),sha=manifest.getString("Sha256");
            String notes=manifest.optString("Notes","");
            URI apk=URI.create(manifest.getString("DownloadUrl"));
            requireHttps(apk);
            if(code<1||code>Integer.MAX_VALUE||size<1||size>MAX_APK_BYTES||!sha.matches("[a-f0-9]{64}")
                    ||!version.matches("[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,4}")||notes.length()>2000)throw new VerificationException();
            return code<=installedCode?null:new Release(version,(int)code,apk,size,sha,notes);
        }catch(GeneralSecurityException|JSONException|IllegalArgumentException error){throw new VerificationException();}
    }

    public File download(Release release,File directory,ArchiveVerifier verifier,Progress progress)throws IOException {
        synchronized(AndroidUpdateClient.class){
            Files.createDirectories(directory.toPath());
            File apk=new File(new File(directory,"verified"),release.sha256()+".apk");
            if(apk.isFile()){
                try{verify(apk,release,verifier);return apk;}
                catch(VerificationException invalid){Files.deleteIfExists(apk.toPath());}
            }
            File part=new File(directory,release.sha256()+".part.apk");
            try {
                long offset=part.length();
                if(offset>release.size()){Files.delete(part.toPath());offset=0;}
                if(offset<release.size())fetchApk(release,part,offset,progress);
                verify(part,release,verifier);
                Files.createDirectories(apk.getParentFile().toPath());
                Files.move(part.toPath(),apk.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
                return apk;
            }catch(VerificationException invalid){
                Files.deleteIfExists(part.toPath());
                throw invalid;
            }
        }
    }

    private void fetchApk(Release release,File part,long offset,Progress progress)throws IOException {
        try(Response response=transport.open(release.apk(),offset)){
            if(response.status()==200)offset=0;
            else if(response.status()==206){
                String expected="bytes "+offset+"-"+(release.size()-1)+"/"+release.size();
                if(!expected.equals(response.header("Content-Range")))throw new VerificationException();
            }else throw new IOException("APK download unavailable");
            long received=offset;
            try(InputStream input=response.body();FileOutputStream output=new FileOutputStream(part,offset>0)){
                byte[] buffer=new byte[64*1024];
                for(int count;(count=input.read(buffer))!=-1;){
                    if(Thread.currentThread().isInterrupted())throw new java.io.InterruptedIOException();
                    received+=count;
                    if(received>release.size())throw new VerificationException();
                    output.write(buffer,0,count);
                    progress.received(received,release.size());
                }
            }
            if(received!=release.size())throw new IOException("APK download interrupted");
        }
    }

    private static void verify(File apk,Release release,ArchiveVerifier verifier)throws IOException {
        if(apk.length()!=release.size())throw new VerificationException();
        try(InputStream input=Files.newInputStream(apk.toPath())){
            var hash=MessageDigest.getInstance("SHA-256");
            byte[] buffer=new byte[64*1024];
            for(int count;(count=input.read(buffer))!=-1;)hash.update(buffer,0,count);
            StringBuilder hex=new StringBuilder(64);
            for(byte value:hash.digest()){
                hex.append(Character.forDigit((value>>>4)&15,16)).append(Character.forDigit(value&15,16));
            }
            if(!release.sha256().contentEquals(hex))throw new VerificationException();
        }catch(GeneralSecurityException error){throw new VerificationException();}
        verifier.verify(apk,release);
    }

    private static long integer(JSONObject json,String field)throws JSONException,VerificationException {
        Object value=json.get(field);
        if(!(value instanceof Integer)&&!(value instanceof Long))throw new VerificationException();
        return ((Number)value).longValue();
    }

    private byte[] fetch(URI uri,int limit)throws IOException {
        try(Response response=transport.open(uri,0)){
            if(response.status()==404)throw new FeedUnavailableException();
            if(response.status()!=200)throw new IOException("Update check unavailable");
            try(InputStream body=response.body()){return readBounded(body,limit);}
        }
    }

    private static byte[] readBounded(InputStream body,int limit)throws IOException {
        var output=new ByteArrayOutputStream();
        byte[] buffer=new byte[4096];
        for(int count;(count=body.read(buffer))!=-1;){
            if(output.size()+count>limit)throw new VerificationException();
            output.write(buffer,0,count);
        }
        return output.toByteArray();
    }

    private static void requireHttps(URI uri)throws VerificationException {
        if(!"https".equalsIgnoreCase(uri.getScheme())||uri.getHost()==null||uri.getRawUserInfo()!=null
                ||uri.getRawFragment()!=null||(uri.getPort()!=-1&&uri.getPort()!=443))throw new VerificationException();
    }

    private static Response openHttps(URI uri,long offset)throws IOException {
        for(int hops=0;hops<=5;hops++){
            requireHttps(uri);
            HttpsURLConnection connection=(HttpsURLConnection)uri.toURL().openConnection();
            connection.setConnectTimeout(12000);connection.setReadTimeout(20000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept-Encoding","identity");
            if(offset>0)connection.setRequestProperty("Range","bytes="+offset+"-");
            boolean retained=false;
            try {
                int status=connection.getResponseCode();
                if(status==301||status==302||status==303||status==307||status==308){
                    String location=connection.getHeaderField("Location");
                    if(location==null)throw new IOException("Update redirect missing location");
                    try{uri=uri.resolve(location);}catch(IllegalArgumentException invalid){throw new VerificationException();}
                    continue;
                }
                retained=true;
                return new Response(){
                    public int status(){return status;}
                    public String header(String name){return connection.getHeaderField(name);}
                    public InputStream body()throws IOException{return connection.getInputStream();}
                    public void close(){connection.disconnect();}
                };
            }finally{if(!retained)connection.disconnect();}
        }
        throw new IOException("Too many update redirects");
    }
}
