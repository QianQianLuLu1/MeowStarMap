package app.nikkisync.mobile.media.live;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardOpenOption;
import java.util.Arrays;
import java.util.List;

/** File packaging only. No Android UI, downloading, metadata SDK calls or gallery-certification claims. */
public final class MotionContainer {
    static final byte[] SEF_NAME="MotionPhoto_Data".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] GAME_MARKER="%PAPERGAMES%".getBytes(StandardCharsets.US_ASCII);
    record VivoSource(long mediaBytes,int trailerBytes) {
        long packagedBytes(){return mediaBytes+(trailerBytes==0?0:8L+trailerBytes);}
    }
    public record Options(long presentationUs,int coverFrame,int frameCount,long durationUs,String pairId,String model){
        public Options{if(presentationUs<0||durationUs<=presentationUs||coverFrame<0||frameCount<=coverFrame)throw new IllegalArgumentException("封面必须位于真实视频范围内");}
    }
    public record Product(File primary,List<File> companions){public Product{companions=List.copyOf(companions);}}
    private MotionContainer(){}
    public static Product write(LivePhotoProfile profile,File jpeg,File video,File outDir,Options options)throws IOException{
        byte[] original=JpegSegments.read(jpeg);int oldEnd=JpegSegments.endOffset(original);
        // Match the public Oplus reference layout: MP4 immediately after EOI. Drop only the exported copy's
        // opaque trailer, never image scan data or the source file/parameter snapshot.
        if(profile==LivePhotoProfile.OPLUS&&oldEnd!=original.length)original=Arrays.copyOf(original,oldEnd);
        long padding=original.length-oldEnd;
        JpegSegments.require(video.length()>0,"视频为空");
        byte[] xmp=MotionXmp.create(profile,video.length(),options.presentationUs,padding);
        byte[] primary=JpegSegments.rewrite(original,xmp,profile==LivePhotoProfile.OPLUS?mpfSegment(0):null);
        if(profile==LivePhotoProfile.OPLUS)primary=JpegSegments.rewrite(original,xmp,mpfSegment(JpegSegments.endOffset(primary)));
        File image=new File(outDir,profile.paired?"IMG_live.jpg":"live_MP.jpg");
        if(profile==LivePhotoProfile.VIVO_LEGACY_PAIR){
            VivoSource layout=vivoSource(video);
            File movie=new File(outDir,"IMG_live.mp4");
            try(OutputStream out=create(image)){out.write(primary);out.write(VivoLegacyMetadata.payload(options.pairId,options.model,null));}
            try(OutputStream out=create(movie)){
                // A recognized game envelope is not a top-level MP4 box. Keep every byte in a
                // finite free box so the following vivo uuid can be reached by normal parsers.
                copyRange(video,out,0,layout.mediaBytes());
                if(layout.trailerBytes()>0){
                    out.write(ByteBuffer.allocate(8).order(ByteOrder.BIG_ENDIAN).putInt(layout.trailerBytes()+8)
                        .put("free".getBytes(StandardCharsets.US_ASCII)).array());
                    copyRange(video,out,layout.mediaBytes(),layout.trailerBytes());
                }
                out.write(VivoLegacyMetadata.uuid(VivoLegacyMetadata.payload(options.pairId,options.model,options.coverFrame)));
            }
            return new Product(image,List.of(movie));
        }
        try(OutputStream out=create(image)){
            out.write(primary);
            if(profile==LivePhotoProfile.SAMSUNG_SEF){
                long size=8L+SEF_NAME.length+video.length();JpegSegments.require(size<=0xffffffffL,"SEF 视频超出 32 位范围");
                out.write(new byte[]{0,0,0x30,0x0a});out.write(le32(SEF_NAME.length));out.write(SEF_NAME);copy(video,out);out.write(sefIndex(size));
            }else{copy(video,out);if(profile.usesHuaweiTail())out.write(huaweiTail(options,video.length()));}
        }
        return new Product(image,List.of());
    }
    public static byte[] mpfSegment(long primaryLength)throws IOException{
        JpegSegments.require(primaryLength>=0&&primaryLength<=0xffffffffL,"MPF 图像超出 32 位范围");
        ByteBuffer b=ByteBuffer.allocate(74).order(ByteOrder.BIG_ENDIAN);b.put((byte)255).put((byte)226).putShort((short)72).put(new byte[]{'M','P','F',0});
        b.order(ByteOrder.LITTLE_ENDIAN).put((byte)'I').put((byte)'I').putShort((short)42).putInt(8).putShort((short)3);
        ifd(b,0xb000,7,4,0x30303130); // ASCII 0100 (not the old byte-reversed version literal).
        ifd(b,0xb001,4,1,1);ifd(b,0xb002,7,16,50);b.putInt(0);
        b.putInt(0x00030000).putInt((int)primaryLength).putInt(0).putShort((short)0).putShort((short)0);return b.array();
    }
    private static void ifd(ByteBuffer b,int tag,int type,int count,int value){b.putShort((short)tag).putShort((short)type).putInt(count).putInt(value);}
    private static byte[] sefIndex(long size){return ByteBuffer.allocate(32).order(ByteOrder.LITTLE_ENDIAN)
        .put("SEFH".getBytes(StandardCharsets.US_ASCII)).putInt(106).putInt(1).putInt(0x0a300000).putInt((int)size).putInt((int)size).putInt(24).put("SEFT".getBytes(StandardCharsets.US_ASCII)).array();}
    static byte[] huaweiTail(Options o,long videoLength)throws IOException{
        // A narrowly scoped legacy candidate; fields are NOT a universal Huawei/Honor specification.
        JpegSegments.require(o.coverFrame<100,"当前华为尾标候选仅支持两位封面帧号，请选标准格式");
        byte[] tail=new byte[60];Arrays.fill(tail,(byte)' ');
        ascii(tail,0,6,"v6_f"+o.coverFrame);ascii(tail,20,8,o.coverFrame+":"+o.frameCount);ascii(tail,40,20,"LIVE_"+(videoLength+20));return tail;
    }
    private static void ascii(byte[] b,int offset,int max,String value)throws IOException{byte[] a=value.getBytes(StandardCharsets.US_ASCII);JpegSegments.require(a.length<=max,"厂商尾标字段超长，拒绝截断");System.arraycopy(a,0,b,offset,a.length);}
    private static byte[] le32(int n){return ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(n).array();}
    private static OutputStream create(File file)throws IOException{return new BufferedOutputStream(Files.newOutputStream(file.toPath(),StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE));}
    static void copy(File file,OutputStream out)throws IOException{try(InputStream in=new BufferedInputStream(new FileInputStream(file))){byte[] b=new byte[128*1024];int n;while((n=in.read(b))!=-1){if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Live 导出已取消");out.write(b,0,n);}}}
    static VivoSource vivoSource(File mp4)throws IOException{
        try(var r=new java.io.RandomAccessFile(mp4,"r")){
            long at=0;int count=0;boolean movie=false,media=false;
            while(at<r.length()){
            JpegSegments.require(++count<=65536,"MP4 box 数量过多");
            long remaining=r.length()-at;
            if(movie&&media&&remaining>=GAME_MARKER.length){
                r.seek(at);byte[] marker=new byte[GAME_MARKER.length];r.readFully(marker);
                if(Arrays.equals(marker,GAME_MARKER)){
                    JpegSegments.require(remaining<=1024*1024,"游戏视频参数尾部过大");
                    byte[] tail=new byte[(int)remaining];r.seek(at);r.readFully(tail);
                    validateGameTrailer(tail);
                    return new VivoSource(at,tail.length);
                }
            }
            JpegSegments.require(remaining>=8,"MP4 box 截断");r.seek(at);long n=Integer.toUnsignedLong(r.readInt());int type=r.readInt();int header=8;
            JpegSegments.require(n!=0,"vivo 双文件追加 uuid 前不接受 size=0 的末尾 box");if(n==1){JpegSegments.require(r.length()-at>=16,"MP4 largesize 截断");n=r.readLong();header=16;}
            JpegSegments.require(n>=header&&n<=remaining,"MP4 box 长度无效");
            if(at==0)JpegSegments.require(type==0x66747970&&n>=header+8,"视频起点不是有效 MP4 ftyp");
            movie|=type==0x6d6f6f76;media|=type==0x6d646174;at+=n;
            }
            JpegSegments.require(movie&&media,"MP4 缺少 moov/mdat");
            return new VivoSource(at,0);
        }
    }
    private static void validateGameTrailer(byte[] tail)throws IOException{
        int end=tail.length-44-GAME_MARKER.length,start=GAME_MARKER.length;
        JpegSegments.require(end>start&&(end-start)%4==0,"游戏视频参数尾部不完整");
        for(int i=0;i<GAME_MARKER.length;i++)JpegSegments.require(tail[end+i]==GAME_MARKER[i],"游戏视频参数结束标记无效");
        try{
            java.util.Base64.getDecoder().decode(Arrays.copyOfRange(tail,start,end));
            JpegSegments.require(java.util.Base64.getDecoder().decode(Arrays.copyOfRange(tail,end+GAME_MARKER.length,tail.length)).length==32,"游戏视频参数校验尾部无效");
        }catch(IllegalArgumentException error){throw new IOException("游戏视频参数尾部编码无效",error);}
    }
    private static void copyRange(File file,OutputStream out,long offset,long length)throws IOException{
        try(var input=new java.io.RandomAccessFile(file,"r")){
            JpegSegments.require(offset>=0&&length>=0&&offset<=input.length()-length,"视频复制范围越界");
            input.seek(offset);byte[] bytes=new byte[128*1024];
            while(length>0){
                if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Live 导出已取消");
                int n=(int)Math.min(bytes.length,length);input.readFully(bytes,0,n);out.write(bytes,0,n);length-=n;
            }
        }
    }
}
