package app.nikkisync.mobile.media;

import static org.junit.Assert.*;
import android.net.Uri;
import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSpec;
import app.nikkisync.mobile.model.Models.MediaResource;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.URL;
import java.security.cert.Certificate;
import javax.net.ssl.HttpsURLConnection;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class) @Config(sdk=35) @UnstableApi
public final class SignedVideoDataSourceTest {
    private static final long SIZE=200L*1024*1024;
    private static final String HASH="ab".repeat(32);
    private static final class Connection extends HttpsURLConnection {
        int status=206;String hash=HASH,range;byte[] body={1,2,3,4};boolean disconnected;
        Connection() throws Exception {super(new URL("https://example.invalid/video"));}
        @Override public int getResponseCode(){return status;}
        @Override public String getHeaderField(String key){return "X-NikkiSync-SHA256".equals(key)?hash:"Content-Range".equals(key)?range:null;}
        @Override public long getContentLengthLong(){return 4;}
        @Override public InputStream getInputStream(){return new ByteArrayInputStream(body);}
        @Override public void disconnect(){disconnected=true;}
        @Override public boolean usingProxy(){return false;}
        @Override public void connect(){}
        @Override public String getCipherSuite(){return "test";}
        @Override public Certificate[] getLocalCertificates(){return null;}
        @Override public Certificate[] getServerCertificates(){return new Certificate[0];}
    }
    @Test public void largeVideoSeeksByVerifiedSignedRangesWithoutDownloadingTheFile() throws Exception {
        long position=150L*1024*1024;Connection connection=new Connection();connection.range="bytes "+position+"-"+(position+3)+"/"+SIZE;
        var resource=new MediaResource("r","source_motion","recording.mp4","video/mp4",".mp4",SIZE,HASH,null,null,null);
        var source=new SignedVideoDataSource(new SignedVideoDataSource.Remote(){public MediaResource resource(){return resource;}public HttpsURLConnection open(MediaResource r){return connection;}});
        var spec=new DataSpec.Builder().setUri(Uri.parse("https://example.invalid/video.mp4")).setPosition(position).setLength(4).build();
        assertEquals(4,source.open(spec));assertEquals("bytes="+position+"-"+(position+3),connection.getRequestProperty("Range"));
        byte[] actual=new byte[4];assertEquals(4,source.read(actual,0,4));assertArrayEquals(connection.body,actual);assertEquals(C.RESULT_END_OF_INPUT,source.read(actual,0,4));
        source.close();assertTrue(connection.disconnected);
    }
    @Test public void changedHashIncorrectRangeAndShortResponseFailClosed() throws Exception {
        for(int fault=0;fault<3;fault++){
            Connection connection=new Connection();connection.range="bytes 0-3/"+SIZE;
            if(fault==0)connection.hash="cd".repeat(32);if(fault==1)connection.range="bytes 1-4/"+SIZE;if(fault==2)connection.body=new byte[]{1};
            var resource=new MediaResource("r","source_motion","recording.mp4","video/mp4",".mp4",SIZE,HASH,null,null,null);
            var source=new SignedVideoDataSource(new SignedVideoDataSource.Remote(){public MediaResource resource(){return resource;}public HttpsURLConnection open(MediaResource r){return connection;}});
            var spec=new DataSpec.Builder().setUri(Uri.parse("https://example.invalid/video.mp4")).setLength(4).build();
            if(fault<2)assertThrows(java.io.IOException.class,()->source.open(spec));
            else {source.open(spec);byte[] data=new byte[4];assertEquals(1,source.read(data,0,4));assertThrows(java.io.EOFException.class,()->source.read(data,0,4));source.close();}
            assertTrue(connection.disconnected);
        }
    }
}
