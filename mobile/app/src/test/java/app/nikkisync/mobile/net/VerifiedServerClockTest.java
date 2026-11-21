package app.nikkisync.mobile.net;

import app.nikkisync.mobile.model.Models.PairedServer;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class VerifiedServerClockTest {
    private PairedServer server(){return new PairedServer("trusted-pc","PC","192.168.1.5",28080,"ab".repeat(32),"","",0);}
    @Test public void pcTimeUsesMonotonicElapsedTimeDespiteWrongOrChangedPhoneTime()throws Exception{
        AtomicLong wall=new AtomicLong(1_900_000_000_000L),elapsed=new AtomicLong(10_000L),calls=new AtomicLong();
        var clock=new VerifiedServerClock(()->{calls.incrementAndGet();return VerifiedServerClock.fromVerifiedInfo(server(),
                new JSONObject().put("serverId","trusted-pc").put("protocolVersion",1),1_800_000_000_000L,elapsed.get());},wall::get,elapsed::get);
        assertEquals(1_800_000_000_000L,clock.timestamp());
        elapsed.addAndGet(2000);wall.addAndGet(86_400_000L);assertEquals(1_800_000_002_000L,clock.timestamp());assertEquals(1,calls.get());
    }
    @Test public void wrongIdentityOrUnusableDateCannotSupplyASigningClock()throws Exception{
        assertThrows(Exception.class,()->VerifiedServerClock.fromVerifiedInfo(server(),new JSONObject().put("serverId","other").put("protocolVersion",1),1_800_000_000_000L,5));
        assertThrows(Exception.class,()->VerifiedServerClock.fromVerifiedInfo(server(),new JSONObject().put("serverId","trusted-pc").put("protocolVersion",2),1_800_000_000_000L,5));
        assertThrows(Exception.class,()->VerifiedServerClock.fromVerifiedInfo(server(),new JSONObject().put("serverId","trusted-pc").put("protocolVersion",1),0,5));
    }
    @Test public void failedOrUnsupportedProbeFallsBackAndRetriesWithoutBlockingOldComputers()throws Exception{
        AtomicLong elapsed=new AtomicLong(10_000L),calls=new AtomicLong(),wall=new AtomicLong(2000L);
        var clock=new VerifiedServerClock(()->{if(calls.incrementAndGet()==1)throw new java.io.IOException("older server");return new VerifiedServerClock.Sample(5000,elapsed.get());},wall::get,elapsed::get);
        assertEquals(2000,clock.timestamp());elapsed.addAndGet(1000);assertEquals(2000,clock.timestamp());
        elapsed.addAndGet(30_001);assertEquals(5000,clock.timestamp());assertEquals(2,calls.get());
    }
    @Test public void cancellationDoesNotContinueToSignARequest()throws Exception{
        var clock=new VerifiedServerClock(()->{throw new java.io.InterruptedIOException("cancelled");},()->2000L,()->10000L);
        try{assertThrows(java.io.InterruptedIOException.class,clock::timestamp);assertTrue(Thread.currentThread().isInterrupted());}
        finally{Thread.interrupted();}
    }
    @Test public void probeSocketTimeoutFallsBackWithoutPretendingTheUserCancelled()throws Exception{
        var clock=new VerifiedServerClock(()->{throw new java.net.SocketTimeoutException("slow old computer");},()->2000L,()->10000L);
        assertEquals(2000,clock.timestamp());assertFalse(Thread.currentThread().isInterrupted());
    }
}
