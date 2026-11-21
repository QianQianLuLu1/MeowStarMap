package app.nikkisync.mobile.media.live;

import app.nikkisync.mobile.model.Models.MediaResource;
import java.io.*;
import java.net.URL;
import java.nio.file.*;
import java.security.*;
import java.security.cert.Certificate;
import java.util.*;
import javax.net.ssl.HttpsURLConnection;
import org.junit.*;
import static org.junit.Assert.*;

public class MotionPreviewCacheTest {
    private File root;private MotionPreviewCache cache;private byte[] bytes;
    @Before public void setup()throws Exception{root=Files.createTempDirectory("preview-cache-").toFile();cache=new MotionPreviewCache(root,100000);bytes=MotionPreviewFileTest.MP4.clone();}
    @After public void cleanup()throws Exception{Thread.interrupted();try(var paths=Files.walk(root.toPath())){for(var p:paths.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(p);}}
    private MediaResource resource()throws Exception{return new MediaResource("movie","source_motion","movie.mp4","video/mp4","mp4",bytes.length,hash(bytes),320,180,1000L);}
    private static String hash(byte[] value)throws Exception{return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));}
    @Test public void verifiedCacheAvoidsNetworkButIsIsolatedByPcIdentity()throws Exception{
        Connection first=new Connection(bytes);File file;
        try(var lease=cache.remote("pc-one",resource(),()->first)){file=lease.file();assertArrayEquals(bytes,Files.readAllBytes(file.toPath()));}
        assertTrue(first.disconnected);
        try(var lease=cache.remote("pc-one",resource(),()->{throw new AssertionError("cache hit must not download");})){assertEquals(file,lease.file());}
        int[] calls={0};try(var lease=cache.remote("pc-two",resource(),()->{calls[0]++;return new Connection(bytes);})){assertNotEquals(file,lease.file());}assertEquals(1,calls[0]);
    }
    @Test public void corruptedCacheIsReplacedAndUnknownHashOrShortDownloadIsRejected()throws Exception{
        File cached;try(var lease=cache.remote("pc",resource(),()->new Connection(bytes))){cached=lease.file();}
        Files.write(cached.toPath(),new byte[]{1,2,3});
        try(var lease=cache.remote("pc",resource(),()->new Connection(bytes))){assertArrayEquals(bytes,Files.readAllBytes(lease.file().toPath()));}
        cache.clear();
        assertThrows(IOException.class,()->cache.remote("pc",resource(),()->new Connection(Arrays.copyOf(bytes,bytes.length-1))));
        byte[] corrupt=bytes.clone();corrupt[corrupt.length-1]^=1;
        assertThrows(IOException.class,()->cache.remote("pc",resource(),()->new Connection(corrupt)));
        assertEquals(0,root.listFiles().length);
    }
    @Test public void cancelledBeforeStartDoesNotOpenOrLeaveAPartialFile()throws Exception{
        Connection connection=new Connection(bytes);Thread.currentThread().interrupt();
        try{assertThrows(InterruptedIOException.class,()->cache.remote("pc",resource(),()->connection));}finally{Thread.interrupted();}
        assertEquals(0,root.listFiles().length);
    }
    @Test public void cancellationDuringReadClosesConnectionAndRemovesThePartialFile()throws Exception{
        Connection connection=new Connection(bytes){@Override public InputStream getInputStream(){return new ByteArrayInputStream(bytes){@Override public synchronized int read(byte[] b,int off,int len){int n=super.read(b,off,len);Thread.currentThread().interrupt();return n;}};}};
        try{assertThrows(InterruptedIOException.class,()->cache.remote("pc",resource(),()->connection));}finally{Thread.interrupted();}
        assertTrue(connection.disconnected);assertEquals(0,root.listFiles().length);
    }
    @Test public void rawGameVideoIsHashedBeforeOnlyThePlaybackCopyLosesItsTrailer()throws Exception{
        bytes=VivoGameTrailerTest.concat(bytes,VivoGameTrailerTest.trailer());byte[] original=bytes.clone();
        try(var lease=cache.remote("pc",resource(),()->new Connection(bytes))){assertArrayEquals(MotionPreviewFileTest.MP4,Files.readAllBytes(lease.file().toPath()));}
        assertArrayEquals(original,bytes);
    }
    @Test public void damagedFileAlreadyLeasedCannotBeRepublishedAsVerified()throws Exception{
        try(var active=cache.remote("pc",resource(),()->new Connection(bytes))){
            Files.write(active.file().toPath(),new byte[]{42});
            assertThrows(IOException.class,()->cache.remote("pc",resource(),()->new Connection(bytes)));
        }
    }
    @Test public void localUriContentChangesCannotReuseStaleMovie()throws Exception{
        File old;try(var lease=cache.local("same-uri",()->new ByteArrayInputStream(bytes),false)){old=lease.file();}
        bytes[bytes.length-1]^=1;
        try(var lease=cache.local("same-uri",()->new ByteArrayInputStream(bytes),false)){assertNotEquals(old,lease.file());assertArrayEquals(bytes,Files.readAllBytes(lease.file().toPath()));}
    }
    @Test public void pruningAndClearNeverRemoveTheMovieBeingPlayed()throws Exception{
        cache=new MotionPreviewCache(root,bytes.length+1);
        try(var active=cache.local("one",()->new ByteArrayInputStream(bytes),false)){
            try(var other=cache.local("two",()->new ByteArrayInputStream(bytes),false)){cache.clear();assertTrue(active.file().isFile());assertTrue(other.file().isFile());}
            assertTrue(active.file().isFile());
        }
        cache.clear();assertEquals(0,root.listFiles().length);
    }
    private static class Connection extends HttpsURLConnection {
        final byte[] bytes;boolean disconnected;
        Connection(byte[] bytes)throws Exception{super(new URL("https://127.0.0.1/v1/resource"));this.bytes=bytes;}
        @Override public int getResponseCode(){return 200;}
        @Override public InputStream getInputStream(){return new ByteArrayInputStream(bytes);}
        @Override public long getContentLengthLong(){return bytes.length;}
        @Override public void disconnect(){disconnected=true;}
        @Override public boolean usingProxy(){return false;}@Override public void connect(){}
        @Override public String getCipherSuite(){return "test";}@Override public Certificate[] getLocalCertificates(){return new Certificate[0];}
        @Override public Certificate[] getServerCertificates(){return new Certificate[0];}
    }
}
