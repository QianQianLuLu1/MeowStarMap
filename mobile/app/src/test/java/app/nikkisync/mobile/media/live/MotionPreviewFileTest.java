package app.nikkisync.mobile.media.live;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.junit.*;
import static org.junit.Assert.*;

public class MotionPreviewFileTest {
    private File root,jpeg,video;
    static final byte[] MP4={0,0,0,20,'f','t','y','p','i','s','o','m',0,0,0,0,'i','s','o','m',
        0,0,0,8,'m','o','o','v',0,0,0,12,'m','d','a','t',1,2,3,4};
    @Before public void setup()throws Exception{
        root=Files.createTempDirectory("motion-preview-").toFile();jpeg=new File(root,"source.jpg");video=new File(root,"source.mp4");
        Files.write(jpeg.toPath(),new byte[]{(byte)255,(byte)216,(byte)255,(byte)218,0,8,1,1,0,0,63,0,1,2,(byte)255,(byte)217});
        Files.write(video.toPath(),MP4);
    }
    @After public void cleanup()throws Exception{try(var paths=Files.walk(root.toPath())){for(var p:paths.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(p);}}
    @Test public void everyExportProfileCanBePreviewedWithoutAlteringSavedMedia()throws Exception{
        var options=new MotionContainer.Options(500000,15,30,1000000,"1760000000000abcdef000000000","synthetic");
        for(var profile:LivePhotoProfile.values()){
            File out=new File(root,profile.id);assertTrue(out.mkdir());
            var product=MotionContainer.write(profile,jpeg,video,out,options);
            File source=product.companions().isEmpty()?product.primary():product.companions().get(0);
            byte[] original=Files.readAllBytes(source.toPath());File copy=new File(out,"preview.tmp");Files.copy(source.toPath(),copy.toPath());
            MotionPreviewFile.prepare(copy,product.companions().isEmpty());
            assertArrayEquals(profile.id,MP4,Arrays.copyOf(Files.readAllBytes(copy.toPath()),MP4.length));
            assertArrayEquals("Saved export stays untouched",original,Files.readAllBytes(source.toPath()));
        }
    }
    @Test public void gameParametersAreRemovedOnlyFromPrivatePlaybackCopy()throws Exception{
        byte[] source=VivoGameTrailerTest.concat(MP4,VivoGameTrailerTest.trailer());Files.write(video.toPath(),source);
        File copy=new File(root,"preview.tmp");Files.copy(video.toPath(),copy.toPath());MotionPreviewFile.prepare(copy,false);
        assertArrayEquals(MP4,Files.readAllBytes(copy.toPath()));assertArrayEquals(source,Files.readAllBytes(video.toPath()));
    }
    @Test public void staticJpegAndUnknownOrTruncatedVideoNeverBecomeAFalseLive()throws Exception{
        assertThrows(IOException.class,()->MotionPreviewFile.prepare(jpeg,true));
        for(byte[] bad:new byte[][]{Arrays.copyOf(MP4,MP4.length-1),VivoGameTrailerTest.concat(MP4,new byte[]{1,2,3,4}),new byte[]{1,2,3,4}}){
            Files.write(video.toPath(),bad);assertThrows(IOException.class,()->MotionPreviewFile.prepare(video,false));
        }
    }
    @Test public void jpegXmpLengthCannotPointOutsideItsFile()throws Exception{
        byte[] xmp=MotionXmp.create(LivePhotoProfile.STANDARD,Long.MAX_VALUE,0,0);
        Files.write(jpeg.toPath(),JpegSegments.rewrite(Files.readAllBytes(jpeg.toPath()),xmp,null));
        assertThrows(IOException.class,()->MotionPreviewFile.prepare(jpeg,true));
    }
}
