package app.nikkisync.mobile.media;

import static org.junit.Assert.*;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import app.nikkisync.mobile.model.Models.MediaResource;
import app.nikkisync.mobile.util.Hex;
import app.nikkisync.mobile.util.TaskProgress;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.net.URL;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.security.cert.Certificate;
import java.util.ArrayList;
import java.util.List;
import javax.net.ssl.HttpsURLConnection;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.shadows.ShadowContentResolver;

@RunWith(RobolectricTestRunner.class)
public final class OriginalVideoSaverTest {
    private final byte[] bytes=new byte[300_007];
    private Context context;private Provider provider;private Connection connection;private MediaResource resource;
    @Before public void setup() throws Exception {
        new java.util.Random(73).nextBytes(bytes);context=RuntimeEnvironment.getApplication();
        String hash=Hex.lower(MessageDigest.getInstance("SHA-256").digest(bytes));
        resource=new MediaResource("motion","source_motion","original.Mp4","video/mp4","mp4",bytes.length,hash,3840,2160,7000L);
        connection=new Connection(bytes,hash);provider=new Provider();
        provider.file=File.createTempFile("original-video-",".mp4",context.getCacheDir());
        ProviderInfo info=new ProviderInfo();info.authority="media";provider.attachInfo(context,info);
        ShadowContentResolver.registerProviderInternal("media",provider);
    }
    @After public void cleanup() throws Exception {Thread.interrupted();Files.deleteIfExists(provider.file.toPath());}
    @Test public void copiesExactBytesAndPublishesOnlyAfterReadbackWithProgress() throws Exception {
        List<String> stages=new ArrayList<>();List<Long> completed=new ArrayList<>();
        Uri result=OriginalVideoSaver.saveDownload(context.getContentResolver(),resource,connection,(stage,done,total)->{
            stages.add(stage);if(stage.equals("下载并保存原视频")){assertEquals(bytes.length,total);completed.add(done);}
            if(stage.equals("保存完成"))assertEquals(1,provider.updates);
        });
        assertEquals(provider.uri,result);assertArrayEquals(bytes,Files.readAllBytes(provider.file.toPath()));
        assertEquals(1,provider.inserts);assertEquals(1,provider.reads);assertEquals(1,provider.updates);assertEquals(0,provider.deletes);
        assertEquals("Movies/NikkiSync",provider.pending.getAsString("relative_path"));
        assertEquals("original.Mp4",provider.pending.getAsString("_display_name"));
        assertEquals("video/mp4",provider.pending.getAsString("mime_type"));assertEquals(Integer.valueOf(1),provider.pending.getAsInteger("is_pending"));
        assertTrue(completed.size()>2);assertEquals(Long.valueOf(bytes.length),completed.get(completed.size()-1));
        assertEquals("保存完成",stages.get(stages.size()-1));assertTrue(connection.disconnected);
    }
    @Test public void zeroDegreeVideoSaveNeverInvokesTheEncoder() throws Exception {
        MotionVideoSaver.saveDownload(context,resource,connection,0,TaskProgress.NONE,
            (input,degrees,job,safe,progress)->{throw new AssertionError("Zero degrees must copy original bytes");});
        assertArrayEquals(bytes,Files.readAllBytes(provider.file.toPath()));
        assertEquals(1,provider.reads);assertEquals(1,provider.updates);
    }
    @Test public void clockwise90PublishesTheRotatedVideoInsteadOfTheDownloadedSource() throws Exception {assertRotated(90);}
    @Test public void clockwise180PublishesTheRotatedVideoInsteadOfTheDownloadedSource() throws Exception {assertRotated(180);}
    @Test public void clockwise270PublishesTheRotatedVideoInsteadOfTheDownloadedSource() throws Exception {assertRotated(270);}
    private void assertRotated(int degrees) throws Exception {
        byte[] exported=("synthetic rotated MP4 "+degrees).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        List<String> stages=new ArrayList<>();File[] temporary={null};
        MotionVideoSaver.saveDownload(context,resource,connection,degrees,(stage,done,total)->stages.add(stage),
            (input,angle,job,safe,progress)->{
                assertArrayEquals(bytes,Files.readAllBytes(input.toPath()));assertEquals(degrees,angle);
                temporary[0]=job;progress.accept(50);File output=new File(job,"rotated.mp4");
                Files.write(output.toPath(),exported);return output;
            });
        assertArrayEquals(exported,Files.readAllBytes(provider.file.toPath()));
        assertEquals(1,provider.inserts);assertEquals(1,provider.reads);assertEquals(1,provider.updates);assertEquals(0,provider.deletes);
        assertEquals("Movies/NikkiSync",provider.pending.getAsString("relative_path"));
        assertTrue(provider.pending.getAsString("_display_name").contains("rotated_"+degrees));
        assertTrue(stages.contains("旋转视频"));assertEquals("保存完成",stages.get(stages.size()-1));
        assertFalse(temporary[0].exists());assertTrue(connection.disconnected);
    }
    @Test public void corruptSourceNeverReachesRotationOrPublication() throws Exception {
        connection.body=bytes.clone();connection.body[200]^=1;
        assertThrows(java.io.IOException.class,()->MotionVideoSaver.saveDownload(context,resource,connection,90,TaskProgress.NONE,
            (input,degrees,job,safe,progress)->{throw new AssertionError("Corrupt source must not be encoded");}));
        assertEquals(0,provider.inserts);assertTrue(connection.disconnected);
    }
    @Test public void rotationFailureDoesNotPublishAndCleansItsPrivateDirectory() throws Exception {
        File[] temporary={null};
        assertThrows(java.io.IOException.class,()->MotionVideoSaver.saveDownload(context,resource,connection,90,TaskProgress.NONE,
            (input,degrees,job,safe,progress)->{temporary[0]=job;throw new java.io.IOException("synthetic codec failure");}));
        assertFalse(temporary[0].exists());assertEquals(0,provider.inserts);assertTrue(connection.disconnected);
    }
    @Test public void corruptedRotatedGalleryFileIsRemovedWithoutPublication() throws Exception {
        provider.corruptRead=true;
        assertThrows(java.io.IOException.class,()->MotionVideoSaver.saveDownload(context,resource,connection,270,TaskProgress.NONE,
            (input,degrees,job,safe,progress)->{File output=new File(job,"rotated.mp4");Files.write(output.toPath(),bytes);return output;}));
        assertEquals(1,provider.deletes);assertEquals(0,provider.updates);
    }
    @Test public void corruptDownloadDeletesPendingVideoWithoutPublishing() throws Exception {
        connection.body=bytes.clone();connection.body[200]^=1;reject();assertEquals(1,provider.deletes);
    }
    @Test public void truncatedDownloadDeletesPendingVideoWithoutPublishing() throws Exception {
        connection.body=java.util.Arrays.copyOf(bytes,bytes.length-1);reject();assertEquals(1,provider.deletes);
    }
    @Test public void changedGalleryBytesAreDetectedEvenWhenSizeMatches() throws Exception {
        provider.corruptRead=true;reject();assertEquals(1,provider.reads);assertEquals(1,provider.deletes);
    }
    @Test public void missingAndChangedHashesNeverCreateGalleryEntries() throws Exception {
        connection.hash=null;reject();assertEquals(0,provider.inserts);
        connection.hash="0".repeat(64);reject();assertEquals(0,provider.inserts);
    }
    @Test public void publishFailureCompensatesWithoutReportingCompletion() throws Exception {
        provider.failUpdate=true;List<String> stages=new ArrayList<>();
        assertThrows(java.io.IOException.class,()->OriginalVideoSaver.saveDownload(context.getContentResolver(),resource,connection,
                (stage,done,total)->stages.add(stage)));
        assertEquals(1,provider.deletes);assertFalse(stages.contains("保存完成"));assertTrue(connection.disconnected);
    }
    @Test public void cancellationDoesNotPublishAnIncompleteVideo() throws Exception {
        Thread.currentThread().interrupt();
        try{assertThrows(java.io.InterruptedIOException.class,()->OriginalVideoSaver.saveDownload(context.getContentResolver(),resource,connection,TaskProgress.NONE));}
        finally{Thread.interrupted();}
        assertEquals(0,provider.updates);assertEquals(1,provider.deletes);assertTrue(connection.disconnected);
    }
    private void reject() {
        assertThrows(java.io.IOException.class,()->OriginalVideoSaver.saveDownload(context.getContentResolver(),resource,connection,TaskProgress.NONE));
        assertEquals(0,provider.updates);assertTrue(connection.disconnected);
    }
    private static final class Connection extends HttpsURLConnection {
        byte[] body;String hash;boolean disconnected;
        Connection(byte[] body,String hash) throws Exception {super(new URL("https://example.invalid/video"));this.body=body;this.hash=hash;}
        @Override public int getResponseCode(){return 200;}
        @Override public String getHeaderField(String key){return "X-NikkiSync-SHA256".equals(key)?hash:null;}
        @Override public InputStream getInputStream(){return new ByteArrayInputStream(body);}
        @Override public void disconnect(){disconnected=true;}
        @Override public boolean usingProxy(){return false;}
        @Override public void connect(){}
        @Override public String getCipherSuite(){return "test-only";}
        @Override public Certificate[] getLocalCertificates(){return null;}
        @Override public Certificate[] getServerCertificates(){return new Certificate[0];}
    }
    private static final class Provider extends ContentProvider {
        final Uri uri=Uri.parse("content://media/external/video/media/731");
        File file;ContentValues pending;int inserts,reads,updates,deletes;boolean corruptRead,failUpdate;
        @Override public boolean onCreate(){return true;}
        @Override public Uri insert(Uri target,ContentValues values){assertTrue(target.toString().contains("/video/"));pending=new ContentValues(values);inserts++;return uri;}
        @Override public ParcelFileDescriptor openFile(Uri target,String mode) throws FileNotFoundException {
            if(mode.equals("r")) {
                reads++;
                if(corruptRead)try{byte[] b=Files.readAllBytes(file.toPath());b[200]^=1;Files.write(file.toPath(),b);}catch(Exception e){throw new FileNotFoundException(e.toString());}
                return ParcelFileDescriptor.open(file,ParcelFileDescriptor.MODE_READ_ONLY);
            }
            return ParcelFileDescriptor.open(file,ParcelFileDescriptor.MODE_READ_WRITE|ParcelFileDescriptor.MODE_TRUNCATE);
        }
        @Override public int update(Uri target,ContentValues values,String selection,String[] args){updates++;assertEquals(Integer.valueOf(0),values.getAsInteger("is_pending"));return failUpdate?0:1;}
        @Override public int delete(Uri target,String selection,String[] args){deletes++;return 1;}
        @Override public String getType(Uri target){return "video/mp4";}
        @Override public Cursor query(Uri target,String[] projection,String selection,String[] args,String order){return null;}
    }
}
