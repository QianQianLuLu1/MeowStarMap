package app.nikkisync.mobile.media.live;
import static org.junit.Assert.*;
import java.io.IOException;
import java.util.List;
import org.junit.Test;
public class RotationVideoSupportTest {
 @Test public void checksDisplayedSizeAndRotationRatherThanRawTrackSize()throws Exception{
  VideoFacts before=new VideoFacts(3840,2160,90,100000,false,false,List.of(0L));
  RotationVideoSupport.requireSupported(before,90,List.of((w,h)->w==3840&&h==2160));
  IOException error=assertThrows(IOException.class,()->RotationVideoSupport.requireSupported(before,180,List.of((w,h)->w<=1920&&h<=1920)));
  assertTrue(error.getMessage().contains("2160×3840"));
 }
 @Test public void checksAllEncodersAndDoesNotTreatBrokenCapabilityReportsAsKnownUnsupported()throws Exception{
  VideoFacts before=new VideoFacts(7680,4320,0,100000,false,false,List.of(0L));
  RotationVideoSupport.requireSupported(before,90,List.of((w,h)->false,(w,h)->true));
  RotationVideoSupport.requireSupported(before,90,List.of((w,h)->{throw new IllegalArgumentException("OEM report unavailable");}));
  assertThrows(IOException.class,()->RotationVideoSupport.requireSupported(before,90,List.of()));
 }
}
