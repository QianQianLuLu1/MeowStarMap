package app.nikkisync.mobile.net;

import app.nikkisync.mobile.model.Models.PairedServer;
import app.nikkisync.mobile.security.DeviceIdentity;
import java.io.*;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.security.cert.Certificate;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

/** Real loopback TLS fixture with an ephemeral, test-only certificate and Ed25519 key. */
@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class SignedClockTlsTest {
    private static SSLServerSocket server;
    private static Thread serverThread;
    private static Path temp;
    private static String fingerprint;
    private static final AtomicBoolean wrongIdentity=new AtomicBoolean();
    private static long computerTime;
    @BeforeClass public static void start()throws Exception{
        temp=Files.createTempDirectory("momo-clock-tls-");Path store=temp.resolve("fixture.p12");
        String keytool=Path.of(System.getProperty("java.home"),"bin",System.getProperty("os.name").startsWith("Windows")?"keytool.exe":"keytool").toString();
        Process p=new ProcessBuilder(keytool,"-genkeypair","-alias","fixture","-keyalg","RSA","-keysize","2048","-validity","1",
                "-dname","CN=Ephemeral test fixture","-storetype","PKCS12","-keystore",store.toString(),"-storepass","testfixture","-keypass","testfixture","-noprompt")
                .redirectErrorStream(true).start();
        try(InputStream in=p.getInputStream()){while(in.read()!=-1){}}assertEquals(0,p.waitFor());
        KeyStore keys=KeyStore.getInstance("PKCS12");try(InputStream in=Files.newInputStream(store)){keys.load(in,"testfixture".toCharArray());}
        Certificate cert=keys.getCertificate("fixture");fingerprint=app.nikkisync.mobile.util.Hex.lower(MessageDigest.getInstance("SHA-256").digest(cert.getEncoded()));
        KeyManagerFactory kmf=KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());kmf.init(keys,"testfixture".toCharArray());
        SSLContext tls=SSLContext.getInstance("TLS");tls.init(kmf.getKeyManagers(),null,new SecureRandom());
        server=(SSLServerSocket)tls.getServerSocketFactory().createServerSocket(0,16,InetAddress.getByName("127.0.0.1"));
        serverThread=new Thread(()->{while(!server.isClosed()){
            try(SSLSocket socket=(SSLSocket)server.accept()){
                socket.setSoTimeout(5000);socket.startHandshake();InputStream in=socket.getInputStream();int state=0,limit=0;
                while(state<4&&limit++<16384){int b=in.read();if(b<0)break;state=state==0?(b=='\r'?1:0):state==1?(b=='\n'?2:0):state==2?(b=='\r'?3:0):(b=='\n'?4:0);}
                byte[] body=("{\"serverId\":\""+(wrongIdentity.get()?"other-pc":"trusted-pc")+"\",\"protocolVersion\":1}").getBytes(StandardCharsets.UTF_8);
                String date=DateTimeFormatter.RFC_1123_DATE_TIME.format(Instant.ofEpochMilli(computerTime).atZone(ZoneOffset.UTC));
                OutputStream out=socket.getOutputStream();out.write(("HTTP/1.1 200 OK\r\nDate: "+date+"\r\nContent-Length: "+body.length+"\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));out.write(body);out.flush();
            }catch(IOException ignored){/* closed fixture or expected rejected certificate */}
        }},"clock-test-server");serverThread.setDaemon(true);serverThread.start();
    }
    @AfterClass public static void stop()throws Exception{
        if(server!=null)server.close();if(serverThread!=null)serverThread.join(2000);
        if(temp!=null)try(var paths=Files.walk(temp)){for(Path p:paths.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(p);}
    }
    private DeviceIdentity identity()throws Exception{
        Class<?> type=Class.forName("app.nikkisync.mobile.security.Ed25519IdentityKey");var generate=type.getDeclaredMethod("generate");generate.setAccessible(true);Object key=generate.invoke(null);
        var getPublic=type.getDeclaredMethod("publicKeyDer");getPublic.setAccessible(true);byte[] publicKey=(byte[])getPublic.invoke(key);
        var constructor=DeviceIdentity.class.getDeclaredConstructor(String.class,byte[].class,type,boolean.class);constructor.setAccessible(true);
        return constructor.newInstance("clock-test",publicKey,key,false);
    }
    private PairedServer peer(String pin){return new PairedServer("trusted-pc","PC","127.0.0.1",server.getLocalPort(),pin,"","",0);}
    @Test public void signedRequestUsesThePinnedComputersClockAndRetainsAValidEd25519Signature()throws Exception{
        wrongIdentity.set(false);computerTime=System.currentTimeMillis()-3_600_000L;DeviceIdentity identity=identity();
        SignedHttpClient client=new SignedHttpClient(peer(fingerprint),identity);Map<String,String> headers=client.authHeaders("GET","/v1/assets",new byte[0]);
        long time=Long.parseLong(headers.get("X-NikkiSync-Timestamp"));assertTrue(Math.abs(time-computerTime)<2500);
        String hash=app.nikkisync.mobile.util.Hex.lower(MessageDigest.getInstance("SHA-256").digest(new byte[0]));
        String canonical="GET\n/v1/assets\n"+time+"\n"+headers.get("X-NikkiSync-Nonce")+"\n"+hash;
        var verifier=Signature.getInstance("Ed25519");verifier.initVerify(KeyFactory.getInstance("Ed25519").generatePublic(new java.security.spec.X509EncodedKeySpec(Base64.getUrlDecoder().decode(identity.publicKeyBase64Url()))));
        verifier.update(canonical.getBytes(StandardCharsets.UTF_8));assertTrue(verifier.verify(Base64.getUrlDecoder().decode(headers.get("X-NikkiSync-Signature"))));
    }
    @Test public void incorrectServerIdentityOrCertificateCannotChangeTheSigningClock()throws Exception{
        computerTime=System.currentTimeMillis()-3_600_000L;wrongIdentity.set(true);
        var wrongId=new SignedHttpClient(peer(fingerprint),identity());long idTime=Long.parseLong(wrongId.authHeaders("GET","/v1/assets",new byte[0]).get("X-NikkiSync-Timestamp"));
        assertTrue(Math.abs(idTime-System.currentTimeMillis())<2500);wrongIdentity.set(false);
        var wrongPin=new SignedHttpClient(peer("00".repeat(32)),identity());long pinTime=Long.parseLong(wrongPin.authHeaders("GET","/v1/assets",new byte[0]).get("X-NikkiSync-Timestamp"));
        assertTrue(Math.abs(pinTime-System.currentTimeMillis())<2500);
        var connection=wrongPin.open("GET","/v1/server",new byte[0],false);
        try{assertThrows(SSLHandshakeException.class,connection::getResponseCode);}finally{connection.disconnect();}
    }
}
