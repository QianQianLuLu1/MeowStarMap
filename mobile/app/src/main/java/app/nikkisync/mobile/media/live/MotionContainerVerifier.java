package app.nikkisync.mobile.media.live;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Independently reads declared offsets/trailers and compares the embedded motion bytes before publication. */
public final class MotionContainerVerifier {
    private MotionContainerVerifier(){}
    public static void verify(LivePhotoProfile profile,MotionContainer.Product product,File motion,MotionContainer.Options o)throws IOException{
        File primary=product.primary();var jpeg=JpegSegments.inspect(primary);
        long jpegEnd=jpeg.endOffset();
        if(profile==LivePhotoProfile.VIVO_LEGACY_PAIR){
            JpegSegments.require(product.companions().size()==1,"vivo 动态组件缺失");File video=product.companions().get(0);
            JpegSegments.require(o.pairId().equals(VivoLegacyMetadata.readId(primary))&&o.pairId().equals(VivoLegacyMetadata.readId(video)),"vivo 关联 ID 不一致");
            var source=MotionContainer.vivoSource(motion);long uuidOffset=source.packagedBytes();
            compareRange(video,0,motion,0,source.mediaBytes());
            try(RandomAccessFile r=new RandomAccessFile(video,"r")){
                JpegSegments.require(r.length()>=uuidOffset+24,"vivo uuid box 截断");
                if(source.trailerBytes()>0){
                    r.seek(source.mediaBytes());long size=Integer.toUnsignedLong(r.readInt());byte[] type=new byte[4];r.readFully(type);
                    JpegSegments.require(size==source.trailerBytes()+8L&&ascii(type).equals("free"),"vivo 游戏尾部 free box 无效");
                    compareRange(video,source.mediaBytes()+8,motion,source.mediaBytes(),source.trailerBytes());
                }
                r.seek(uuidOffset);long box=Integer.toUnsignedLong(r.readInt());byte[] kind=new byte[4],uuid=new byte[16];r.readFully(kind);r.readFully(uuid);
                JpegSegments.require(box==r.length()-uuidOffset&&ascii(kind).equals("uuid")&&Arrays.equals(uuid,VivoLegacyMetadata.USER_TYPE),"vivo uuid box 无效");
            }
            return;
        }
        JpegSegments.require(product.companions().isEmpty(),"单文件配置出现额外媒体");long offset,length;
        try(RandomAccessFile r=new RandomAccessFile(primary,"r")){
            if(profile==LivePhotoProfile.SAMSUNG_SEF){
                JpegSegments.require(r.length()>=32,"SEF 尾索引缺失");r.seek(r.length()-32);byte[] bytes=new byte[32];r.readFully(bytes);ByteBuffer b=ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
                JpegSegments.require(ascii(Arrays.copyOfRange(bytes,0,4)).equals("SEFH")&&ascii(Arrays.copyOfRange(bytes,28,32)).equals("SEFT"),"SEF magic 无效");
                JpegSegments.require(b.getInt(4)==106&&b.getInt(8)==1&&b.getInt(12)==0x0a300000&&b.getInt(24)==24,"SEF 索引格式无效");
                long back=Integer.toUnsignedLong(b.getInt(16)),size=Integer.toUnsignedLong(b.getInt(20));JpegSegments.require(back==size&&size>=8+MotionContainer.SEF_NAME.length,"SEF offset/length 无效");
                long field=r.length()-32-back;JpegSegments.require(field>=jpegEnd,"SEF 指向 JPEG 内部");r.seek(field);byte[] h=new byte[8+MotionContainer.SEF_NAME.length];r.readFully(h);
                ByteBuffer hb=ByteBuffer.wrap(h).order(ByteOrder.LITTLE_ENDIAN);JpegSegments.require(hb.getInt()==0x0a300000&&hb.getInt()==MotionContainer.SEF_NAME.length&&ascii(Arrays.copyOfRange(h,8,h.length)).equals("MotionPhoto_Data"),"SEF motion field 无效");
                offset=field+h.length;length=size-h.length;JpegSegments.require(MotionXmp.timestamp(jpeg.xmp())==o.presentationUs(),"SEF 封面时间不一致");
            }else if(profile.usesHuaweiTail()){
                JpegSegments.require(r.length()>=60,"Huawei 尾标缺失");r.seek(r.length()-60);byte[] tail=new byte[60];r.readFully(tail);
                JpegSegments.require(ascii(Arrays.copyOfRange(tail,0,6)).trim().equals("v6_f"+o.coverFrame()),"Huawei 封面帧不一致");
                JpegSegments.require(ascii(Arrays.copyOfRange(tail,20,28)).trim().equals(o.coverFrame()+":"+o.frameCount()),"华为/荣耀尾标帧信息不一致");
                String live=ascii(Arrays.copyOfRange(tail,40,60)).trim();JpegSegments.require(live.startsWith("LIVE_"),"Huawei LIVE_ 缺失");
                try{length=Long.parseLong(live.substring(5))-20;}catch(NumberFormatException e){throw new IOException("Huawei 视频长度无效",e);}offset=r.length()-60-length;
            }else{
                byte[] xmp=jpeg.xmp();length=MotionXmp.videoLength(xmp);offset=r.length()-length;
                JpegSegments.require(MotionXmp.timestamp(xmp)==o.presentationUs(),"Motion 封面时间不一致");
                JpegSegments.require(MotionXmp.primaryPadding(xmp)==offset-jpegEnd,"Primary padding/视频起点不一致");
                if(profile==LivePhotoProfile.OPLUS){
                    MotionXmp.verifyOplus(xmp,length,o.presentationUs());
                    JpegSegments.require(offset==jpegEnd,"Oplus 视频没有紧接 JPEG EOI");
                    JpegSegments.require(jpeg.mpfPrimarySize()==jpegEnd,"MPF 不是最终 JPEG 长度");
                }
            }
        }
        JpegSegments.require(offset>=jpegEnd&&length==motion.length(),"视频边界与原动态资源不一致");compare(primary,offset,length,motion);
    }
    private static void compare(File container,long offset,long length,File source)throws IOException{
        JpegSegments.require(length==source.length(),"动态资源长度不一致");
        try(RandomAccessFile a=new RandomAccessFile(container,"r")){
            JpegSegments.require(offset>=0&&length>=12&&offset<=a.length()-length,"动态数据范围越界");
            a.seek(offset+4);byte[] ftyp=new byte[4];a.readFully(ftyp);JpegSegments.require(ascii(ftyp).equals("ftyp"),"视频起点不是 MP4 ftyp");
        }
        compareRange(container,offset,source,0,length);
    }
    private static void compareRange(File container,long offset,File source,long sourceOffset,long length)throws IOException{
        try(RandomAccessFile a=new RandomAccessFile(container,"r");FileInputStream b=new FileInputStream(source)){
            JpegSegments.require(offset>=0&&sourceOffset>=0&&length>=0&&offset<=a.length()-length&&sourceOffset<=source.length()-length,"动态数据范围越界");
            a.seek(offset);app.nikkisync.mobile.util.ByteStreams.skipNBytes(b,sourceOffset);
            byte[] left=new byte[128*1024],right=new byte[128*1024];long remaining=length;
            while(remaining>0){if(Thread.currentThread().isInterrupted())throw new java.io.InterruptedIOException("Live 校验已取消");int n=(int)Math.min(left.length,remaining);a.readFully(left,0,n);int read=app.nikkisync.mobile.util.ByteStreams.readNBytes(b,right,0,n);JpegSegments.require(read==n,"源视频截断");
                for(int i=0;i<n;i++)if(left[i]!=right[i])throw new IOException("封装后动态资源不完整/被改写");remaining-=n;}
        }
    }
    private static String ascii(byte[] b){return new String(b,StandardCharsets.US_ASCII);}
}
