package app.nikkisync.mobile.media.live;
import static org.junit.Assert.*;
import org.junit.Test;
import java.io.IOException;
public class LosslessJpegRotationTest {
 @Test public void exifAndUserRotationComposeWithoutDroppingMirrors(){
  assertEquals(5,LosslessJpegRotation.operation(1,90));
  assertEquals(6,LosslessJpegRotation.operation(6,90));
  assertEquals(0,LosslessJpegRotation.operation(8,90));
  assertEquals(4,LosslessJpegRotation.operation(2,90));
  for(int exif=1;exif<=8;exif++)assertEquals(LosslessJpegRotation.operation(exif,0),LosslessJpegRotation.operation(exif,360));
 }
 @Test public void scratchBudgetSupports8KAnd16KAndRejectsUnboundedInputs()throws Exception{
  assertTrue(LosslessJpegRotation.requiredScratchBytes(7680,4320,20L*1024*1024)<400L*1024*1024);
  assertTrue(LosslessJpegRotation.requiredScratchBytes(16384,9216,32L*1024*1024)<1400L*1024*1024);
  assertThrows(IOException.class,()->LosslessJpegRotation.requiredScratchBytes(65535,65535,1));
  assertThrows(IOException.class,()->LosslessJpegRotation.requiredScratchBytes(3840,2160,65L*1024*1024));
 }
}
