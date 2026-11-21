package app.nikkisync.mobile.media.live;

import java.io.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Works only on a disposable private copy. Saved photos and PC originals are never edited. */
public final class MotionPreviewFile {
    private static final byte[] XMP="http://ns.adobe.com/xap/1.0/\0".getBytes(StandardCharsets.US_ASCII);
    private record Range(long offset,long length){}
    private MotionPreviewFile(){}

    public static void prepare(File copy,boolean embedded)throws IOException{
        if(embedded){
            try(var file=new RandomAccessFile(copy,"rw")){
                Range range=embeddedRange(file);byte[] buffer=new byte[128*1024];long done=0;
                while(done<range.length){
                    checkCancelled();int count=(int)Math.min(buffer.length,range.length-done);
                    file.seek(range.offset+done);file.readFully(buffer,0,count);file.seek(done);file.write(buffer,0,count);done+=count;
                }
                file.setLength(range.length);
            }
        }
        // The game's parameter envelope is not an MP4 atom. Drop it in this copy after validating it;
        // a normal saved vivo pair already has the envelope inside a finite free atom.
        var layout=MotionContainer.vivoSource(copy);
        if(layout.trailerBytes()>0)try(var file=new RandomAccessFile(copy,"rw")){file.setLength(layout.mediaBytes());}
    }
    private static Range embeddedRange(RandomAccessFile file)throws IOException{
        byte[] xmp=readXmp(file);Long length=null;
        if(xmp!=null)try{length=MotionXmp.videoLength(xmp);}catch(IOException absent){/* SEF and legacy Huawei have no length in XMP. */}
        if(length!=null)return checked(file,file.length()-length,length);
        if(file.length()>=32){
            byte[] tail=new byte[32];file.seek(file.length()-32);file.readFully(tail);ByteBuffer b=ByteBuffer.wrap(tail).order(ByteOrder.LITTLE_ENDIAN);
            if(ascii(tail,0,4).equals("SEFH")&&ascii(tail,28,4).equals("SEFT")){
                long size=Integer.toUnsignedLong(b.getInt(16)),back=Integer.toUnsignedLong(b.getInt(20));
                require(b.getInt(4)==106&&b.getInt(8)==1&&b.getInt(12)==0x0a300000&&b.getInt(24)==24&&size==back,"SEF 索引无效");
                long start=file.length()-32-size;int header=8+MotionContainer.SEF_NAME.length;
                require(start>=2&&size>header,"SEF 视频范围无效");file.seek(start);byte[] prefix=new byte[header];file.readFully(prefix);
                ByteBuffer p=ByteBuffer.wrap(prefix).order(ByteOrder.LITTLE_ENDIAN);
                require(p.getInt()==0x0a300000&&p.getInt()==MotionContainer.SEF_NAME.length&&Arrays.equals(Arrays.copyOfRange(prefix,8,header),MotionContainer.SEF_NAME),"SEF 视频标记无效");
                return checked(file,start+header,size-header);
            }
        }
        if(file.length()>=60){
            byte[] tail=new byte[60];file.seek(file.length()-60);file.readFully(tail);
            String value=ascii(tail,40,20).trim();
            if(ascii(tail,0,4).equals("v6_f")&&value.startsWith("LIVE_")){
                try{long size=Long.parseLong(value.substring(5))-20;return checked(file,file.length()-60-size,size);}
                catch(NumberFormatException invalid){throw new IOException("华为 LIVE 尾标无效",invalid);}
            }
        }
        throw new IOException("这张照片没有可读取的动态视频");
    }
    private static Range checked(RandomAccessFile file,long offset,long length)throws IOException{
        require(offset>=2&&length>=28&&offset<=file.length()-length,"动态视频范围越界");
        file.seek(offset+4);require(file.readInt()==0x66747970,"动态视频起点无效");return new Range(offset,length);
    }
    /** Read only JPEG header segments, never allocate the full image/video attachment. */
    private static byte[] readXmp(RandomAccessFile file)throws IOException{
        file.seek(0);require(file.length()>4&&file.readUnsignedShort()==0xffd8,"动态照片不是 JPEG");byte[] found=null;
        for(int count=0;count<1024&&file.getFilePointer()<4*1024*1024;count++){
            require(file.readUnsignedByte()==255,"JPEG 段标记无效");int marker;do{marker=file.readUnsignedByte();}while(marker==255);
            if(marker==0xda||marker==0xd9)return found;
            require(marker!=0&&marker!=0xd8,"JPEG 段无效");if(marker==1||marker>=0xd0&&marker<=0xd7)continue;
            int size=file.readUnsignedShort()-2;long next=file.getFilePointer()+size;
            require(size>=0&&next<=file.length(),"JPEG 段截断");
            if(marker==0xe1&&size>=XMP.length){
                byte[] header=new byte[XMP.length];file.readFully(header);
                if(Arrays.equals(header,XMP)){
                    require(found==null,"重复的动态照片 XMP");found=new byte[size-XMP.length];file.readFully(found);
                }
            }
            file.seek(next);
        }
        throw new IOException("JPEG 头部过长");
    }
    static void checkCancelled()throws InterruptedIOException{if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("动态预览已取消");}
    private static String ascii(byte[] bytes,int start,int size){return new String(bytes,start,size,StandardCharsets.US_ASCII);}
    private static void require(boolean condition,String message)throws IOException{if(!condition)throw new IOException(message);}
}
