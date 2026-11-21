package app.nikkisync.mobile.media.live;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Locale;
import org.junit.Test;
import static org.junit.Assert.*;

public class HuaweiFamilyContainerTest {
    private static final MotionContainer.Options OPTIONS=new MotionContainer.Options(
            500000,15,30,1000000,"1760000000000abcdef000000000","synthetic");
    private static final byte[] JPEG={(byte)255,(byte)216,(byte)255,(byte)218,0,8,1,1,0,0,63,0,1,2,(byte)255,(byte)217};

    @Test public void bothAutomaticRoutesWriteTheLegacyTailAndPreserveAllVideoBytes()throws Exception {
        File root=Files.createTempDirectory("huawei-family-").toFile();
        try {
            File image=new File(root,"source.jpg"),video=new File(root,"source.mp4");
            Files.write(image.toPath(),JPEG);Files.write(video.toPath(),MotionPreviewFileTest.MP4);
            byte[] expectedTail=String.format(Locale.ROOT,"%-20s%-20s%-20s","v6_f15","15:30",
                    "LIVE_"+(MotionPreviewFileTest.MP4.length+20)).getBytes(StandardCharsets.US_ASCII);
            for(String brand:new String[]{"HUAWEI","HONOR"}) {
                var profile=LivePhotoProfile.defaultFor(brand,brand);
                File out=new File(root,brand);assertTrue(out.mkdir());
                var product=MotionContainer.write(profile,image,video,out,OPTIONS);
                byte[] bytes=Files.readAllBytes(product.primary().toPath());
                assertTrue(product.companions().isEmpty());
                assertArrayEquals(brand,expectedTail,Arrays.copyOfRange(bytes,bytes.length-60,bytes.length));
                assertArrayEquals(MotionPreviewFileTest.MP4,Arrays.copyOfRange(bytes,
                        bytes.length-60-MotionPreviewFileTest.MP4.length,bytes.length-60));
                MotionContainerVerifier.verify(profile,product,video,OPTIONS);
                File preview=new File(out,"preview.tmp");Files.copy(product.primary().toPath(),preview.toPath());
                MotionPreviewFile.prepare(preview,true);assertArrayEquals(MotionPreviewFileTest.MP4,Files.readAllBytes(preview.toPath()));
                assertArrayEquals("Preview must preserve the saved export",bytes,Files.readAllBytes(product.primary().toPath()));
                bytes[bytes.length-40]='9'; // Historical cover/frame-count field, not video bytes.
                Files.write(product.primary().toPath(),bytes);
                assertThrows("Invalid tail must fail before publication",IOException.class,
                        ()->MotionContainerVerifier.verify(profile,product,video,OPTIONS));
            }
            assertArrayEquals(JPEG,Files.readAllBytes(image.toPath()));
            assertArrayEquals(MotionPreviewFileTest.MP4,Files.readAllBytes(video.toPath()));
        } finally {try(var paths=Files.walk(root.toPath())){for(var path:paths.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(path);}}
    }
    @Test public void unsupportedCoverFrameIsRejectedRatherThanTruncated() {
        assertThrows(IOException.class,()->MotionContainer.huaweiTail(
                new MotionContainer.Options(900000,120,150,1000000,"id","synthetic"),40));
    }
}
