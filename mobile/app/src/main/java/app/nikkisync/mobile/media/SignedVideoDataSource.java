package app.nikkisync.mobile.media;

import android.net.Uri;
import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.BaseDataSource;
import androidx.media3.datasource.DataSpec;
import app.nikkisync.mobile.model.Models.MediaResource;
import app.nikkisync.mobile.net.NikkiSyncClient;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import javax.net.ssl.HttpsURLConnection;

/** Range playback uses the same per-request signature and pinned TLS as media downloads. */
@UnstableApi
public final class SignedVideoDataSource extends BaseDataSource {
    interface Remote {
        MediaResource resource() throws Exception;
        HttpsURLConnection open(MediaResource resource) throws Exception;
    }
    private final Remote remote;
    private MediaResource resource;
    private HttpsURLConnection connection;
    private InputStream input;
    private Uri uri;
    private long remaining;
    private boolean started;

    public SignedVideoDataSource(NikkiSyncClient client,String assetId) {
        this(new Remote(){
            public MediaResource resource() throws Exception {
                var detail=client.asset(assetId);
                if(!"video".equals(detail.type()))throw new IOException("这不是独立视频");
                return detail.motionResource();
            }
            public HttpsURLConnection open(MediaResource value) throws Exception {return client.resource(assetId,value.resourceId());}
        });
    }
    SignedVideoDataSource(Remote remote){super(true);this.remote=remote;}

    @Override public long open(DataSpec spec) throws IOException {
        transferInitializing(spec);
        try {
            if(resource==null)resource=remote.resource();
            if(resource==null||!"video/mp4".equals(resource.mimeType())||resource.sizeBytes()<=0
                ||resource.sha256()==null||!resource.sha256().matches("(?i)[a-f0-9]{64}"))throw new IOException("视频信息不可用");
            long size=resource.sizeBytes(),start=spec.position;
            if(start<0||start>=size)throw new EOFException("视频位置超出范围");
            long available=size-start;
            remaining=spec.length==C.LENGTH_UNSET?available:Math.min(available,spec.length);
            if(remaining<=0)throw new EOFException("视频片段为空");
            long end=start+remaining-1;
            connection=remote.open(resource);connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Range","bytes="+start+"-"+end);
            if(connection.getResponseCode()!=206)throw new IOException("电脑未返回视频片段");
            String range=connection.getHeaderField("Content-Range"),hash=connection.getHeaderField("X-NikkiSync-SHA256");
            if(!("bytes "+start+"-"+end+"/"+size).equals(range)||hash==null||!hash.equalsIgnoreCase(resource.sha256()))
                throw new IOException("视频已变化，请刷新后重试");
            long length=connection.getContentLengthLong();
            if(length>=0&&length!=remaining)throw new IOException("视频片段长度不一致");
            input=connection.getInputStream();uri=spec.uri;started=true;transferStarted(spec);
            return remaining;
        } catch(Exception error) {
            close();
            if(error instanceof IOException io)throw io;
            throw new IOException("无法连接电脑播放视频",error);
        }
    }
    @Override public int read(byte[] buffer,int offset,int length) throws IOException {
        if(length==0)return 0;
        if(remaining==0)return C.RESULT_END_OF_INPUT;
        int count=input.read(buffer,offset,(int)Math.min(length,remaining));
        if(count<0)throw new EOFException("视频片段读取不完整");
        remaining-=count;bytesTransferred(count);return count;
    }
    @Override public Uri getUri(){return uri;}
    @Override public void close() throws IOException {
        try{if(input!=null)input.close();}finally{
            input=null;if(connection!=null)connection.disconnect();connection=null;uri=null;
            if(started){started=false;transferEnded();}
        }
    }
}
