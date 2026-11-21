package app.nikkisync.mobile.media.live;

import static org.junit.Assert.*;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.media.ExifInterface;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaMetadataRetriever;
import android.media.MediaMuxer;
import androidx.media3.common.util.UnstableApi;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.util.Comparator;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Requires a real Android codec/GPU. A JVM pass never substitutes for these pixel/audio checks. */
@UnstableApi
@RunWith(AndroidJUnit4.class)
public final class LivePhotoRotationInstrumentedTest {
    private static final int[][] EXPECTED = {{0,1,2,3},{2,0,3,1},{3,2,1,0},{1,3,0,2}};
    private static final int[][] RGB = {{240,30,30},{30,240,30},{30,30,240},{240,240,30}};

    @Test public void rotatePhysicalPixelsAtAllQuarterTurns() throws Exception { exercise(0); }
    @Test public void existingExifAndVideoOrientationAreAppliedExactlyOnce() throws Exception { exercise(90); }

    @Test public void standaloneVideoUsesPreviewDirectionAtAllQuarterTurns() throws Exception { exerciseVideoOnly(0); }
    @Test public void standaloneVideoDoesNotDoubleApplyExistingRotation() throws Exception { exerciseVideoOnly(90); }

    private void exerciseVideoOnly(int originalRotation) throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        File root=Files.createTempDirectory(context.getCacheDir().toPath(),"standalone-rotation-test-").toFile();
        AtomicBoolean cleanupSafe=new AtomicBoolean(true);
        try {
            File video=asset(root,"corners-audio.mp4");
            if(originalRotation!=0){File tagged=new File(root,"orientation.mp4");remuxWithRotation(video,tagged,originalRotation);video=tagged;}
            byte[] original=Files.readAllBytes(video.toPath());VideoFacts before=VideoFacts.read(video);
            for(int angle:new int[]{0,90,180,270}) {
                File target=new File(root,"r"+angle);assertTrue(target.mkdir());
                File output=LivePhotoRotation.rotateVideoOnly(context,video,angle,target,cleanupSafe,p->{});
                assertTrue(cleanupSafe.get());
                if(angle==0){assertEquals(video,output);assertArrayEquals(original,Files.readAllBytes(output.toPath()));}
                else before.verifyRotated(VideoFacts.read(output),angle);
                assertArrayEquals(original,Files.readAllBytes(video.toPath()));
                MediaMetadataRetriever reader=new MediaMetadataRetriever();Bitmap frame=null;
                try {
                    reader.setDataSource(output.getAbsolutePath());frame=reader.getFrameAtTime(500_000,MediaMetadataRetriever.OPTION_CLOSEST);
                    assertNotNull(frame);int total=(originalRotation+angle)%360;
                    assertEquals(total%180==0?320:180,frame.getWidth());assertEquals(total%180==0?180:320,frame.getHeight());
                    corners(frame,EXPECTED[total/90]);
                } finally {if(frame!=null)frame.recycle();reader.release();}
            }
        } finally {
            if(cleanupSafe.get())try(var paths=Files.walk(root.toPath())) {
                for(var p:paths.sorted(Comparator.reverseOrder()).collect(java.util.stream.Collectors.toList()))Files.deleteIfExists(p);
            }
        }
    }

    private void exercise(int originalRotation) throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        File root=Files.createTempDirectory(context.getCacheDir().toPath(),"live-rotation-test-").toFile();
        AtomicBoolean cleanupSafe=new AtomicBoolean(true);
        try {
            File image=asset(root,"corners.jpg"), video=asset(root,"corners-audio.mp4");
            if(originalRotation!=0){
                ExifInterface exif=new ExifInterface(image);exif.setAttribute(ExifInterface.TAG_ORIENTATION,"6");exif.saveAttributes();
                File metadataVideo=new File(root,"orientation.mp4");remuxWithRotation(video,metadataVideo,originalRotation);video=metadataVideo;
            }
            byte[] originalImage=Files.readAllBytes(image.toPath()),originalVideo=Files.readAllBytes(video.toPath());
            VideoFacts before=VideoFacts.read(video);assertTrue("fixture has audio",before.hasAudio());
            for(int angle:new int[]{0,90,180,270}){
                File target=new File(root,"r"+angle);assertTrue(target.mkdir());
                LivePhotoRotation.Output output=LivePhotoRotation.rotate(context,image,video,angle,target,cleanupSafe,p->{});
                assertTrue("codec acknowledged shutdown",cleanupSafe.get());
                if(angle==0){assertEquals(image,output.image());assertEquals(video,output.video());}
                else {before.verifyRotated(output.videoFacts(),angle);assertEquals(0,output.videoFacts().rotation());}
                assertArrayEquals("source JPEG remains unchanged",originalImage,Files.readAllBytes(image.toPath()));
                assertArrayEquals("source MP4 remains unchanged",originalVideo,Files.readAllBytes(video.toPath()));
                int total=(originalRotation+angle)%360;
                Bitmap still=ImageDecoder.decodeBitmap(ImageDecoder.createSource(output.image()),(d,i,s)->d.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE));
                MediaMetadataRetriever reader=new MediaMetadataRetriever();Bitmap frame=null;
                try {
                    reader.setDataSource(output.video().getAbsolutePath());frame=reader.getFrameAtTime(500_000,MediaMetadataRetriever.OPTION_CLOSEST);
                    assertNotNull("video frame remains decodable",frame);
                    int width=total%180==0?320:180,height=total%180==0?180:320;
                    assertEquals(width,still.getWidth());assertEquals(height,still.getHeight());
                    assertEquals(width,frame.getWidth());assertEquals(height,frame.getHeight());
                    corners(still,EXPECTED[total/90]);corners(frame,EXPECTED[total/90]);
                    assertTrue(output.videoFacts().hasAudio());assertEquals(24,output.videoFacts().sampleTimesUs().size());
                } finally {still.recycle();if(frame!=null)frame.recycle();reader.release();}
            }
        } finally {
            if(cleanupSafe.get())try(var paths=Files.walk(root.toPath())){
                for(var p:paths.sorted(Comparator.reverseOrder()).collect(java.util.stream.Collectors.toList()))Files.deleteIfExists(p);
            }
        }
    }
    private static void corners(Bitmap image,int[] expected){
        int index=0;for(int y:new int[]{1,3})for(int x:new int[]{1,3}){
            int p=image.getPixel(image.getWidth()*x/4,image.getHeight()*y/4);int best=-1;long error=Long.MAX_VALUE;
            for(int c=0;c<RGB.length;c++){long dr=(p>>16&255)-RGB[c][0],dg=(p>>8&255)-RGB[c][1],db=(p&255)-RGB[c][2];long e=dr*dr+dg*dg+db*db;if(e<error){error=e;best=c;}}
            assertTrue("corner has not turned into letterboxing",error<10000);assertEquals("clockwise corner "+index,expected[index++],best);
        }
    }
    private static File asset(File directory,String name)throws Exception{
        File file=new File(directory,name);try(InputStream in=InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("livephoto/"+name)){Files.copy(in,file.toPath());}return file;
    }
    private static void remuxWithRotation(File source,File target,int rotation)throws Exception{
        MediaExtractor input=new MediaExtractor();MediaMuxer muxer=null;boolean started=false;
        try {
            input.setDataSource(source.getAbsolutePath());muxer=new MediaMuxer(target.getAbsolutePath(),MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            int[] mapping=new int[input.getTrackCount()];for(int i=0;i<mapping.length;i++){mapping[i]=muxer.addTrack(input.getTrackFormat(i));input.selectTrack(i);}
            muxer.setOrientationHint(rotation);muxer.start();started=true;
            ByteBuffer buffer=ByteBuffer.allocate(1024*1024);MediaCodec.BufferInfo info=new MediaCodec.BufferInfo();
            while(input.getSampleTrackIndex()>=0){buffer.clear();int size=input.readSampleData(buffer,0);if(size<0)break;
                info.set(0,size,input.getSampleTime(),input.getSampleFlags());muxer.writeSampleData(mapping[input.getSampleTrackIndex()],buffer,info);input.advance();}
        }finally{input.release();if(muxer!=null){try{if(started)muxer.stop();}finally{muxer.release();}}}
    }
}
