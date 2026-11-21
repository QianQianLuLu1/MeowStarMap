package app.nikkisync.mobile.ui.chrome;
import org.junit.Test;
import static org.junit.Assert.*;
public class LiquidGlassGeometryTest {
    @Test public void refractionIsConfinedToInsideRimNotCenterOrOutside() {
        assertEquals(0,LiquidGlassGeometry.edgeWeight(100,34,200,68,28,20),.001);
        assertEquals(0,LiquidGlassGeometry.edgeWeight(-5,34,200,68,28,20),.001);
        assertEquals(0,LiquidGlassGeometry.edgeWeight(0,0,200,68,28,20),.001);
        assertTrue(LiquidGlassGeometry.edgeWeight(5,34,200,68,28,20)>.5);
    }
}
