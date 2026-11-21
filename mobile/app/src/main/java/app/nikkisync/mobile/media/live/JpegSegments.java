package app.nikkisync.mobile.media.live;

import java.io.ByteArrayOutputStream;
import java.io.BufferedInputStream;
import java.io.DataInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Validates segments before writing any marker; single-image JPEG only, no unsafe MPF offset reuse. */
public final class JpegSegments {
    public static final int MAX_IMAGE_BYTES=64*1024*1024;
    private static final byte[] XMP="http://ns.adobe.com/xap/1.0/\0".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] EXT="http://ns.adobe.com/xmp/extension/\0".getBytes(StandardCharsets.US_ASCII);
    private record Segment(int marker,int start,int end,int payload){}
    private JpegSegments(){}
    public static byte[] read(File file)throws IOException{
        if(file.length()>MAX_IMAGE_BYTES)throw new IOException("静态资源过大，拒绝静默降分辨率");
        return Files.readAllBytes(file.toPath());
    }
    public record Inspection(long endOffset,byte[] xmp,long mpfPrimarySize) {}
    /** Reads JPEG markers/entropy to EOI without buffering image pixels or the embedded video. */
    public static Inspection inspect(File file)throws IOException{
        try(var input=new DataInputStream(new BufferedInputStream(new FileInputStream(file),64*1024))){
            require(input.readUnsignedShort()==0xffd8,"不是 JPEG");
            long position=2;boolean entropy=false,sawScan=false;byte[] xmp=null;long mpf=-1;
            while(position<MAX_IMAGE_BYTES){
                if(Thread.currentThread().isInterrupted())throw new java.io.InterruptedIOException("Live 校验已取消");
                int marker=input.readUnsignedByte();position++;
                if(entropy){
                    while(marker!=255){
                        require(position<MAX_IMAGE_BYTES,"JPEG 静态资源超出安全范围");
                        if((position&65535)==0&&Thread.currentThread().isInterrupted())throw new java.io.InterruptedIOException("Live 校验已取消");
                        marker=input.readUnsignedByte();position++;
                    }
                }
                require(marker==255,"JPEG marker 损坏");
                do{marker=input.readUnsignedByte();position++;}while(marker==255&&position<MAX_IMAGE_BYTES);
                if(entropy&&(marker==0||marker>=208&&marker<=215))continue;
                if(marker==217){require(sawScan&&position<=MAX_IMAGE_BYTES,"JPEG 缺少 SOS / 静态资源过大");return new Inspection(position,xmp,mpf);}
                require(marker!=0&&marker!=216,"JPEG marker 顺序无效");
                if(marker==1||marker>=208&&marker<=215)continue;
                int length=input.readUnsignedShort();position+=2;
                require(length>=2&&position+length-2<=MAX_IMAGE_BYTES,"JPEG 段长度无效");
                if(marker==225||marker==226){
                    byte[] segment=new byte[length+2];segment[0]=(byte)255;segment[1]=(byte)marker;
                    segment[2]=(byte)(length>>>8);segment[3]=(byte)length;input.readFully(segment,4,length-2);
                    var s=new Segment(marker,0,segment.length,4);
                    if(marker==225&&starts(segment,4,segment.length,XMP)){
                        require(xmp==null,"重复的主 XMP，需先修复输入");xmp=Arrays.copyOfRange(segment,4+XMP.length,segment.length);
                    }
                    if(isMpf(segment,s)){require(mpf<0,"重复的 MPF");mpf=mpfPrimarySize(segment,s);}
                }else app.nikkisync.mobile.util.ByteStreams.skipNBytes(input,length-2);
                position+=length-2;entropy=marker==218;if(entropy)sawScan=true;
            }
            throw new IOException("JPEG 缺少 EOI / 静态资源过大");
        }
    }
    private static List<Segment> header(byte[] b)throws IOException{
        require(b.length>=4 && u(b[0])==255&&u(b[1])==216,"不是 JPEG");
        List<Segment> out=new ArrayList<>();int p=2;
        while(p<b.length){int start=p;require(u(b[p++])==255,"JPEG marker 损坏");while(p<b.length&&u(b[p])==255)p++;
            require(p<b.length,"JPEG marker 截断");int m=u(b[p++]);
            require(m!=0 && m!=216 && m!=217,"JPEG 扫描结构无效");
            if(m==1 || m>=208&&m<=215){out.add(new Segment(m,start,p,p));continue;}
            require(p+2<=b.length,"JPEG 段长度截断");int n=(u(b[p])<<8)|u(b[p+1]);require(n>=2&&n<=b.length-p,"JPEG 段截断");
            out.add(new Segment(m,start,p+n,p+2));p+=n;if(m==218)return out;
        }throw new IOException("JPEG 缺少扫描数据");
    }
    public static int endOffset(byte[] b)throws IOException{
        require(b.length>=4&&u(b[0])==255&&u(b[1])==216,"不是 JPEG");int p=2;boolean entropy=false,sawScan=false;
        while(p<b.length){
            if(entropy){while(p<b.length&&u(b[p])!=255)p++;require(p<b.length,"JPEG 缺少 EOI");}
            require(u(b[p++])==255,"JPEG marker 损坏");while(p<b.length&&u(b[p])==255)p++;
            require(p<b.length,"JPEG marker 截断");int m=u(b[p++]);
            if(entropy&&(m==0 || m>=208&&m<=215))continue;
            if(m==217){require(sawScan,"JPEG 缺少 SOS");return p;}
            require(m!=0&&m!=216,"JPEG marker 顺序无效");
            if(m==1 || m>=208&&m<=215)continue;
            require(p+2<=b.length,"JPEG 段长度截断");int n=(u(b[p])<<8)|u(b[p+1]);require(n>=2&&n<=b.length-p,"JPEG 段截断");
            p+=n;entropy=m==218;if(entropy)sawScan=true;
        }throw new IOException("JPEG 缺少 EOI");
    }
    public static byte[] xmp(byte[] jpeg)throws IOException{
        byte[] result=null;
        for(Segment s:header(jpeg))if(s.marker==225&&starts(jpeg,s.payload,s.end,XMP)){
            require(result==null,"重复的主 XMP，需先修复输入");result=Arrays.copyOfRange(jpeg,s.payload+XMP.length,s.end);
        }return result;
    }
    public static byte[] rewrite(byte[] jpeg,byte[] xmp,byte[] mpf)throws IOException{
        endOffset(jpeg);List<Segment> segments=header(jpeg);
        for(Segment s:segments){
            require(!(s.marker==225&&starts(jpeg,s.payload,s.end,EXT)),"暂不支持 Extended XMP，原文件未修改");
            if(isMpf(jpeg,s))require(mpfInt(jpeg,s,0xb001)==1,"多图 MPF / HDR GainMap 暂不支持重排");
        }
        byte[] merged=xmp==null?xmp(jpeg):MotionXmp.merge(xmp(jpeg),xmp);
        ByteArrayOutputStream out=new ByteArrayOutputStream(jpeg.length+1024);out.write(255);out.write(216);
        if(merged!=null){require(merged.length+XMP.length+2<=65535,"Motion XMP 过大");out.write(255);out.write(225);int n=merged.length+XMP.length+2;out.write(n>>>8);out.write(n);out.write(XMP);out.write(merged);}
        if(mpf!=null)out.write(mpf);
        for(Segment s:segments){
            if(s.marker==218){out.write(jpeg,s.start,jpeg.length-s.start);break;}
            // Skip the whole old segment, never just its length/payload after emitting FF E1/E2.
            if(s.marker==225&&starts(jpeg,s.payload,s.end,XMP) || isMpf(jpeg,s))continue;
            out.write(jpeg,s.start,s.end-s.start);
        }
        return out.toByteArray();
    }
    public static long mpfPrimarySize(byte[] jpeg)throws IOException{
        for(Segment s:header(jpeg))if(isMpf(jpeg,s))return mpfPrimarySize(jpeg,s);
        throw new IOException("MPF primary entry 缺失");
    }
    private static long mpfPrimarySize(byte[] jpeg,Segment s)throws IOException{
            int base=s.payload+4;ByteBuffer b=tiff(jpeg,s);long ifd=uint(b,base+4);require(ifd<=s.end-base-2,"MPF IFD 越界");int count=ushort(b,base+(int)ifd);
            for(int i=0;i<count;i++){long at=base+ifd+2+12L*i;require(at+12<=s.end,"MPF IFD 截断");int p=(int)at;if(ushort(b,p)==0xb002){long offset=uint(b,p+8);require(offset<=s.end-base-16,"MPF entry 越界");return uint(b,base+(int)offset+4);}}
        throw new IOException("MPF primary entry 缺失");
    }
    private static long mpfInt(byte[] jpeg,Segment s,int tag)throws IOException{
        int base=s.payload+4;ByteBuffer b=tiff(jpeg,s);long offset=uint(b,base+4);require(offset<=s.end-base-2,"MPF IFD 越界");int count=ushort(b,base+(int)offset);
        for(int i=0;i<count;i++){long at=base+offset+2+12L*i;require(at+12<=s.end,"MPF IFD 截断");int p=(int)at;if(ushort(b,p)==tag)return uint(b,p+8);}throw new IOException("MPF image count 缺失");
    }
    private static ByteBuffer tiff(byte[] jpeg,Segment s)throws IOException{
        int base=s.payload+4;require(base+8<=s.end,"MPF TIFF 截断");boolean le=jpeg[base]=='I'&&jpeg[base+1]=='I',be=jpeg[base]=='M'&&jpeg[base+1]=='M';require(le||be,"MPF endian 无效");
        ByteBuffer b=ByteBuffer.wrap(jpeg).order(le?ByteOrder.LITTLE_ENDIAN:ByteOrder.BIG_ENDIAN);require(ushort(b,base+2)==42,"MPF TIFF 标记无效");return b;
    }
    private static boolean isMpf(byte[] b,Segment s){return s.marker==226&&starts(b,s.payload,s.end,new byte[]{'M','P','F',0});}
    private static boolean starts(byte[] b,int at,int end,byte[] prefix){if(end-at<prefix.length)return false;for(int i=0;i<prefix.length;i++)if(b[at+i]!=prefix[i])return false;return true;}
    private static int u(byte b){return b&255;}
    private static int ushort(ByteBuffer b,int at){return Short.toUnsignedInt(b.getShort(at));}
    private static long uint(ByteBuffer b,int at){return Integer.toUnsignedLong(b.getInt(at));}
    static void require(boolean valid,String message)throws IOException{if(!valid)throw new IOException(message);}
}
