package app.nikkisync.mobile.ui.chrome;
import org.junit.Test;
import static org.junit.Assert.*;
public class MonetBackgroundControllerTest {
    @Test public void staleAndClosedWorkCannotPublishOverCurrentBackground(){
        MonetBackgroundController c=new MonetBackgroundController();
        long a=c.beginRequest(),b=c.beginRequest();
        assertFalse(c.isCurrent(a));assertTrue(c.isCurrent(b));
        c.close();assertFalse(c.isCurrent(b));assertFalse(c.isCurrent(c.beginRequest()));
    }
}
