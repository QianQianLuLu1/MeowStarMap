package app.nikkisync.mobile.media.live;

import java.io.*;
import java.nio.file.Files;
import java.util.*;

/** Run in a separate 32 MiB JVM: a large motion file must never become a JPEG-sized heap buffer. */
public final class LargeMotionContainerChecks {
    public static void main(String[] args) throws Exception {
        File dir=Files.createTempDirectory("live-large-heap-").toFile();
        int checks=0;
        try {
            File jpeg=new File(dir,"source.jpg"),video=new File(dir,"source.mp4");
            // EXIF contains a false EOI; entropy contains stuffing/restart and a second scan.
            Files.write(jpeg.toPath(),new byte[]{-1,-40,-1,-31,0,10,'E','x','i','f',0,0,-1,-39,
                -1,-38,0,8,1,1,0,0,63,0,1,-1,0,2,-1,-48,3,
                -1,-38,0,8,1,1,0,0,63,0,4,-1,-39});
            int payload=80*1024*1024;
            try(var out=new DataOutputStream(new BufferedOutputStream(new FileOutputStream(video)))) {
                out.writeInt(20);out.writeBytes("ftypisom");out.writeInt(0);out.writeBytes("isom");
                out.writeInt(8);out.writeBytes("moov");out.writeInt(payload+8);out.writeBytes("mdat");
                byte[] buffer=new byte[128*1024];new Random(83).nextBytes(buffer);
                for(int left=payload;left>0;left-=buffer.length)out.write(buffer,0,Math.min(left,buffer.length));
            }
            if(args.length==2) {
                // Optional local real-media audit: copy inputs, never mutate originals in the corruption check.
                File sourceImage=new File(args[0]),sourceVideo=new File(args[1]);
                long jpegLength=JpegSegments.inspect(sourceImage).endOffset();
                try(var in=new FileInputStream(sourceImage);var out=new FileOutputStream(jpeg)) {
                    byte[] buffer=new byte[8192];
                    while(jpegLength>0){int n=in.read(buffer,0,(int)Math.min(buffer.length,jpegLength));if(n<0)throw new EOFException();out.write(buffer,0,n);jpegLength-=n;}
                }
                Files.copy(sourceVideo.toPath(),video.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
            var options=new MotionContainer.Options(500000,10,30,1000000,
                "1760000000000abcdef000000000","synthetic");
            for(var profile:LivePhotoProfile.values()) {
                File output=new File(dir,profile.id);if(!output.mkdir())throw new IOException("test directory");
                var product=MotionContainer.write(profile,jpeg,video,output,options);
                MotionContainerVerifier.verify(profile,product,video,options);checks++;
                try(var data=new RandomAccessFile(video,"rw")) {
                    long last=data.length()-1;data.seek(last);int original=data.read();
                    data.seek(last);data.write(original^1);
                    try {
                        MotionContainerVerifier.verify(profile,product,video,options);
                        throw new AssertionError("Tail corruption accepted: "+profile);
                    } catch(IOException expected) {checks++;}
                    finally {data.seek(last);data.write(original);}
                }
                for(File file:Objects.requireNonNull(output.listFiles()))Files.delete(file.toPath());
                Files.delete(output.toPath());
            }
            System.out.println("Large LIVE: "+checks+" checks PASS, "+video.length()+" MP4 bytes, max heap "+Runtime.getRuntime().maxMemory()+" bytes (container checks only)");
        } finally {
            try(var paths=Files.walk(dir.toPath())) {
                for(var path:paths.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(path);
            }
        }
    }
}
