package app.nikkisync.mobile.ui.chrome;
import org.junit.Test;
import static org.junit.Assert.*;
public class BackPreviewStateTest {
    @Test public void pageDoesNotShrinkAndPreviousBlurFollowsProgress() {
        var frame=BackPreviewState.frame(BackPreviewState.Kind.PAGE,.5f,1000,2000);
        assertEquals(500,frame.x(),0);assertEquals(1,frame.scale(),0);assertEquals(9,frame.previousBlurDp(),0);
        assertEquals(0,BackPreviewState.frame(BackPreviewState.Kind.PAGE,-1,1000,2000).x(),0);
        assertEquals(1000,BackPreviewState.frame(BackPreviewState.Kind.PAGE,2,1000,2000).x(),0);
    }
    @Test public void sheetMovesHalfItsHeightAtFullProgress() {
        assertEquals(250,BackPreviewState.frame(BackPreviewState.Kind.SHEET,.5f,1000,1000).y(),0);
    }
}
