package app.nikkisync.mobile.media.live;

import java.io.IOException;
import java.util.concurrent.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class LiveExportGuardTest {
    @Test public void outOfMemoryIsRecoverableAndNextSaveCanRun() throws Exception {
        boolean[] cleaned={false};
        IOException error=assertThrows(IOException.class,()->LiveExportGuard.run(()->{
            try {throw new OutOfMemoryError("synthetic");}finally{cleaned[0]=true;}
        }));
        assertTrue(cleaned[0]);assertTrue(error.getMessage().contains("内存"));
        assertEquals("next save",LiveExportGuard.run(()->"next save"));
    }
    @Test public void concurrentSaveCannotDoubleTheExportWorkingSet() throws Exception {
        var entered=new CountDownLatch(1);var release=new CountDownLatch(1);
        var executor=Executors.newSingleThreadExecutor();
        try {
            var first=executor.submit(()->LiveExportGuard.run(()->{entered.countDown();if(!release.await(10,TimeUnit.SECONDS))throw new AssertionError("timeout");return 1;}));
            assertTrue(entered.await(5,TimeUnit.SECONDS));
            assertThrows(IOException.class,()->LiveExportGuard.run(()->{throw new AssertionError("second export entered");}));
            release.countDown();assertEquals(Integer.valueOf(1),first.get(5,TimeUnit.SECONDS));
            assertEquals(Integer.valueOf(2),LiveExportGuard.run(()->2));
        } finally {release.countDown();executor.shutdownNow();}
    }
    @Test public void ordinaryIoFailuresDoNotPoisonSubsequentJobs() throws Exception {
        var expected=new IOException("synthetic disk failure");
        assertSame(expected,assertThrows(IOException.class,()->LiveExportGuard.run(()->{throw expected;})));
        assertEquals("retry",LiveExportGuard.run(()->"retry"));
    }
}
