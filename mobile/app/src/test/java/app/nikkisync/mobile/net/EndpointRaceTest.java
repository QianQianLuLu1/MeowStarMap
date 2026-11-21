package app.nikkisync.mobile.net;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import static org.junit.Assert.*;

public final class EndpointRaceTest {
    @Test public void unreachableFirstAddressDoesNotBlockReachableAlternative() throws Exception {
        String selected=EndpointRace.first(List.of("slow","wrong-identity","reachable"),host->{
            if(host.equals("slow")){Thread.sleep(3000);return false;}
            return host.equals("reachable");
        },1000);
        assertEquals("reachable",selected);
    }
    @Test public void timeoutIsBoundedAndWorkersAreInterrupted() throws Exception {
        CountDownLatch stopped=new CountDownLatch(2);
        long start=System.nanoTime();
        try {
            EndpointRace.first(List.of("a","b"),host->{try{Thread.sleep(30000);return true;}finally{stopped.countDown();}},150);
            fail("unreachable candidates must fail");
        }catch(java.io.IOException expected){}
        assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-start)<2000);
        assertTrue(stopped.await(2,TimeUnit.SECONDS));
    }
    @Test public void concurrencyIsLimitedAndExceptionsDoNotPreventSuccess() throws Exception {
        AtomicInteger active=new AtomicInteger(),peak=new AtomicInteger();
        String selected=EndpointRace.first(List.of("1","2","3","4","5","6","7","8"),host->{
            int count=active.incrementAndGet();peak.accumulateAndGet(count,Math::max);
            try{Thread.sleep(20);if(host.equals("8"))return true;throw new java.io.IOException("test");}
            finally{active.decrementAndGet();}
        },2000);
        assertEquals("8",selected);assertTrue(peak.get()<=3);
    }
}
