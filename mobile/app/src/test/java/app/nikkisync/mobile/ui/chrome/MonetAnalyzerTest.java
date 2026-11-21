package app.nikkisync.mobile.ui.chrome;
import android.graphics.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.GraphicsMode;
import static org.junit.Assert.*;
import java.util.List;
@RunWith(RobolectricTestRunner.class) @GraphicsMode(GraphicsMode.Mode.NATIVE)
public class MonetAnalyzerTest {
    @Test public void rootAmbientIsLegibleWithoutChangingDarkPhotoPalette(){
        float[] hsv=new float[3];Color.colorToHSV(MonetTileRenderer.polishRootAmbient(0xff111111),hsv);
        assertEquals(.64f,hsv[2],1f/255);assertTrue(hsv[1]<.06f);
    }
    @Test public void grayStaysNeutralAndRepeatedAnalysisIsStable() {
        Bitmap b=Bitmap.createBitmap(96,96,Bitmap.Config.ARGB_8888);b.eraseColor(0xff777777);
        MonetPalette palette=MonetAnalyzer.analyze(b);
        assertEquals(palette,MonetAnalyzer.analyze(b));
        for(int c:palette.atmosphere()){float[] hsv=new float[3];Color.colorToHSV(c,hsv);assertTrue(hsv[1]<=.07);}
        b.recycle();
    }
    @Test public void smallMagentaAccentCannotReplaceYellowAtmosphereAndNightStaysDark() {
        Bitmap b=Bitmap.createBitmap(96,96,Bitmap.Config.ARGB_8888);b.eraseColor(0xffaa8811);
        for(int x=0;x<5;x++)for(int y=0;y<5;y++)b.setPixel(x,y,Color.MAGENTA);
        float[] hsv=new float[3];Color.colorToHSV(MonetAnalyzer.analyze(b).atmosphere().get(0),hsv);
        assertTrue(hsv[0]>35 && hsv[0]<65);
        b.eraseColor(0xff111111);Color.colorToHSV(MonetAnalyzer.analyze(b).atmosphere().get(0),hsv);
        assertTrue(hsv[2]<=.48);
        b.eraseColor(0);assertFalse(MonetAnalyzer.analyze(b).atmosphere().isEmpty());b.recycle();
    }
    @Test public void rootTileIsRepeatableAndHasNoOpaqueSeam() {
        MonetPalette p=new MonetPalette(List.of(0xffccaa77,0xff777788),List.of(),123L);
        Bitmap a=MonetTileRenderer.renderRoot(List.of(p)),b=MonetTileRenderer.renderRoot(List.of(p));
        assertEquals(1024,a.getWidth());assertTrue(a.sameAs(b));
        for(int y=0;y<1024;y+=31){
            int l=a.getPixel(0,y),r=a.getPixel(1023,y);
            assertTrue(Math.abs(Color.red(l)-Color.red(r))<4);
            assertTrue(Math.abs(Color.green(l)-Color.green(r))<4);
            assertEquals(255,Color.alpha(l));
        }
        a.recycle();b.recycle();
    }
}
