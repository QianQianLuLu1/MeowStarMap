package app.nikkisync.mobile.media.live;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Isolated legacy candidate derived from the repository's prior vivo pair format. */
public final class VivoLegacyMetadata {
    static final byte[] USER_TYPE="vivoMediaExtInfo".getBytes(StandardCharsets.US_ASCII);
    static final byte[] MAGIC=new byte[]{0x1b,0x2a,0x39,0x48,0x57,0x66,0x75,(byte)0x84,(byte)0x93,(byte)0xa2,(byte)0xb3};
    private VivoLegacyMetadata(){}
    static byte[] payload(String id,String model,Integer frame)throws IOException{
        JpegSegments.require(id!=null&&id.matches("[0-9a-f]{28}"),"vivo 关联 ID 必须为 28 位");
        String json="{\"com.android.camera.takenmodel\":\""+escape(model)+"\",\"com.android.camera.camerafacing\":\"0\",\"com.android.camera.moduleid\":\"live_photo\",\"com.android.camera.livephoto\":\""+id+"\",\"version\":2014"
            +(frame==null?",\"com.android.camera.joint.fullview.orientation\":0,\"com.android.camera.joint.fullview\":false,\"com.android.camera.fisheye\":-1,\"com.android.camera.watermarkVersion\":null":",\"com.android.camera.imageTime\":"+frame+",\"com.android.camera.faceInfo\":{}")+"}";
        byte[] j=json.getBytes(StandardCharsets.UTF_8),key=id.getBytes(StandardCharsets.US_ASCII),marker="cameralbum!".getBytes(StandardCharsets.US_ASCII);
        int footer=4+key.length+4+MAGIC.length;
        return ByteBuffer.allocate(4+j.length+4+marker.length+footer).order(ByteOrder.BIG_ENDIAN)
            .put("vivo".getBytes(StandardCharsets.US_ASCII)).put(j).putInt(j.length).put(marker).putInt(footer).put(key).putInt(-1).put(MAGIC).array();
    }
    static byte[] uuid(byte[] payload){return ByteBuffer.allocate(8+16+payload.length).order(ByteOrder.BIG_ENDIAN).putInt(8+16+payload.length)
        .put("uuid".getBytes(StandardCharsets.US_ASCII)).put(USER_TYPE).put(payload).array();}
    public static String readId(File file)throws IOException{
        int n=4+28+4+MAGIC.length;byte[] tail=new byte[n];
        try(RandomAccessFile r=new RandomAccessFile(file,"r")){JpegSegments.require(r.length()>=n,"vivo 尾标截断");r.seek(r.length()-n);r.readFully(tail);}
        ByteBuffer b=ByteBuffer.wrap(tail).order(ByteOrder.BIG_ENDIAN);JpegSegments.require(b.getInt()==n,"vivo footer 长度无效");byte[] id=new byte[28];b.get(id);
        JpegSegments.require(b.getInt()==-1,"vivo footer 标记无效");byte[] magic=new byte[MAGIC.length];b.get(magic);JpegSegments.require(Arrays.equals(magic,MAGIC),"vivo footer magic 无效");
        return new String(id,StandardCharsets.US_ASCII);
    }
    private static String escape(String s){if(s==null)return "";StringBuilder b=new StringBuilder();for(char c:s.toCharArray()){if(c=='"'||c=='\\')b.append('\\').append(c);else if(c<32)b.append(String.format(java.util.Locale.ROOT,"\\u%04x",(int)c));else b.append(c);}return b.toString();}
}