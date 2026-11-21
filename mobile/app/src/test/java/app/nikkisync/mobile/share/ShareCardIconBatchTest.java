package app.nikkisync.mobile.share;

import static org.junit.Assert.*;
import java.io.File;
import java.io.InterruptedIOException;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.junit.Test;

public class ShareCardIconBatchTest {
    @Test public void overlapsFourDownloadsDeduplicatesAndKeepsFailuresOptional() throws Exception {
        var caller=Executors.newSingleThreadExecutor();
        var fourStarted=new CountDownLatch(4);var release=new CountDownLatch(1);
        var concurrent=new AtomicInteger();var maximum=new AtomicInteger();var calls=new AtomicInteger();
        try {
            var result=caller.submit(()->ShareCardIconBatch.load(List.of("1","2","3","4","5","1","missing"),()->true,id->{
                int running=concurrent.incrementAndGet();maximum.accumulateAndGet(running,Math::max);calls.incrementAndGet();
                fourStarted.countDown();
                try {assertTrue(release.await(5,TimeUnit.SECONDS));if(id.equals("missing"))throw new java.io.IOException("missing");return new File(id);}
                finally {concurrent.decrementAndGet();}
            }));
            assertTrue("Independent icon downloads must overlap",fourStarted.await(5,TimeUnit.SECONDS));
            release.countDown();var icons=result.get(5,TimeUnit.SECONDS);
            assertEquals(4,maximum.get());assertEquals(6,calls.get());assertEquals(5,icons.size());
            assertEquals(new File("1"),icons.get("1"));assertFalse(icons.containsKey("missing"));
        } finally {release.countDown();caller.shutdownNow();}
    }
    @Test public void cancellingStopsWaitAndInterruptsDownloads() throws Exception {
        var caller=Executors.newSingleThreadExecutor();var active=new AtomicBoolean(true);
        var started=new CountDownLatch(1);var stopped=new CountDownLatch(1);
        try {
            var result=caller.submit(()->ShareCardIconBatch.load(List.of("1"),active::get,id->{
                started.countDown();try {new CountDownLatch(1).await();return new File(id);}finally {stopped.countDown();}
            }));
            assertTrue(started.await(5,TimeUnit.SECONDS));active.set(false);
            try {result.get(2,TimeUnit.SECONDS);fail("Cancelled work must not produce an icon batch");}
            catch(ExecutionException expected){assertTrue(expected.getCause() instanceof InterruptedIOException);}
            assertTrue(stopped.await(2,TimeUnit.SECONDS));
        } finally {caller.shutdownNow();}
    }
}
