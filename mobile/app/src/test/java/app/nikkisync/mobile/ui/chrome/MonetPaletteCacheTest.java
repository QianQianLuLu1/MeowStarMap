package app.nikkisync.mobile.ui.chrome;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import java.util.List;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class)
public class MonetPaletteCacheTest {
    @Test public void revisionAndAlgorithmKeysNeverReturnAnOlderPalette(){
        var cache=new MonetPaletteCache(RuntimeEnvironment.getApplication());
        var palette=new MonetPalette(List.of(0xff223344),List.of(0xff667788),123,.2f,.8f);
        cache.put("asset:thumb:1:v1",palette);
        assertEquals(palette,cache.get("asset:thumb:1:v1"));
        assertNull(cache.get("asset:thumb:2:v1"));assertNull(cache.get("asset:thumb:1:v2"));
    }
}
