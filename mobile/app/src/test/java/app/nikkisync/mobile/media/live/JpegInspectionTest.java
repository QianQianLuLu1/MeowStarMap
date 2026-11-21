package app.nikkisync.mobile.media.live;

import java.io.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class JpegInspectionTest {
    private static final byte[] SCAN={-1,-38,0,8,1,1,0,0,63,0,1,-1,0,2,-1,-48,3,-1,-39};
    @Test public void headerParsingMatchesExistingParserAndStopsAtRealEoi()throws Exception {
        byte[] xmp=MotionXmp.create(LivePhotoProfile.OPLUS,80_000_000,500000,0);
        var bytes=new ByteArrayOutputStream();bytes.write(new byte[]{-1,-40});
        segment(bytes,225,new byte[]{'E','x','i','f',0,0,-1,-39});
        segment(bytes,225,concat("http://ns.adobe.com/xap/1.0/\0".getBytes(StandardCharsets.US_ASCII),xmp));
        bytes.write(MotionContainer.mpfSegment(12345));bytes.write(SCAN);
        byte[] jpeg=bytes.toByteArray();bytes.write(new byte[]{-1,-39,-1,-31,0,0});
        File file=File.createTempFile("inspect-",".jpg");
        try {
            Files.write(file.toPath(),bytes.toByteArray());var actual=JpegSegments.inspect(file);
            assertEquals(JpegSegments.endOffset(jpeg),actual.endOffset());
            assertArrayEquals(JpegSegments.xmp(jpeg),actual.xmp());assertEquals(JpegSegments.mpfPrimarySize(jpeg),actual.mpfPrimarySize());
        }finally{Files.delete(file.toPath());}
    }
    @Test public void invalidSegmentsDuplicateXmpAndOutOfBoundsMpfRemainRejected()throws Exception {
        var duplicate=new ByteArrayOutputStream();duplicate.write(new byte[]{-1,-40});
        byte[] xmp=concat("http://ns.adobe.com/xap/1.0/\0".getBytes(StandardCharsets.US_ASCII),new byte[]{1});
        segment(duplicate,225,xmp);segment(duplicate,225,xmp);duplicate.write(SCAN);
        byte[] mpf=MotionContainer.mpfSegment(3);ByteBuffer.wrap(mpf).order(ByteOrder.LITTLE_ENDIAN).putInt(12,0x7fffffff);
        for(byte[] broken:new byte[][]{new byte[]{-1,-40,-1,-39},new byte[]{-1,-40,-1,-31,0,30,1},
            new byte[]{-1,-40,-1,-31,0,1},duplicate.toByteArray(),concat(concat(new byte[]{-1,-40},mpf),SCAN),
            concat(new byte[]{-1,-40},Arrays.copyOf(SCAN,SCAN.length-1))}) {
            File file=File.createTempFile("inspect-bad-",".jpg");
            try{Files.write(file.toPath(),broken);assertThrows(IOException.class,()->JpegSegments.inspect(file));}
            finally{Files.delete(file.toPath());}
        }
    }
    @Test public void cancellationIsObservedBeforeScanning()throws Exception {
        File file=File.createTempFile("inspect-cancel-",".jpg");
        try {
            Files.write(file.toPath(),concat(new byte[]{-1,-40},SCAN));Thread.currentThread().interrupt();
            assertThrows(InterruptedIOException.class,()->JpegSegments.inspect(file));
        }finally{Thread.interrupted();Files.delete(file.toPath());}
    }
    private static void segment(OutputStream out,int marker,byte[] data)throws IOException {
        int size=data.length+2;out.write(255);out.write(marker);out.write(size>>>8);out.write(size);out.write(data);
    }
    private static byte[] concat(byte[] a,byte[] b){byte[] c=Arrays.copyOf(a,a.length+b.length);System.arraycopy(b,0,c,a.length,b.length);return c;}
}
