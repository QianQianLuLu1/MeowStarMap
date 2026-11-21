package app.nikkisync.mobile.net;

import app.nikkisync.mobile.model.Models.PairedServer;
import java.io.IOException;
import java.util.function.LongSupplier;
import org.json.JSONObject;

/** Uses only time obtained from the pinned, identity-checked PC; never alters device time. */
final class VerifiedServerClock {
    record Sample(long serverMillis,long receivedElapsedMillis) {}
    interface Probe { Sample read() throws Exception; }
    private static final long REFRESH_MILLIS=30_000L;
    private final Probe probe;
    private final LongSupplier wall,elapsed;
    private Sample sample;
    private long lastAttempt=Long.MIN_VALUE;

    VerifiedServerClock(Probe probe,LongSupplier wall,LongSupplier elapsed){this.probe=probe;this.wall=wall;this.elapsed=elapsed;}
    synchronized long timestamp()throws java.io.InterruptedIOException{
        long now=elapsed.getAsLong();
        if(lastAttempt==Long.MIN_VALUE||now<lastAttempt||now-lastAttempt>=REFRESH_MILLIS){
            lastAttempt=now;
            try{sample=probe.read();}catch(Exception error){
                if(error instanceof InterruptedException||(error instanceof java.io.InterruptedIOException&&!(error instanceof java.net.SocketTimeoutException))||Thread.currentThread().isInterrupted()){
                    Thread.currentThread().interrupt();throw new java.io.InterruptedIOException("连接检查已取消");
                }
                // Retain a verified sample or fall back for older servers.
            }
            now=elapsed.getAsLong();
        }
        if(sample!=null&&now>=sample.receivedElapsedMillis()){
            long difference=now-sample.receivedElapsedMillis();
            if(difference<=15*60_000L&&sample.serverMillis()<=Long.MAX_VALUE-difference)return sample.serverMillis()+difference;
        }
        return wall.getAsLong();
    }
    static Sample fromVerifiedInfo(PairedServer server,JSONObject info,long date,long elapsed)throws Exception{
        VerifiedEndpointResolver.verifiedInfo(server,info);
        if(date<=0||elapsed<0)throw new IOException("电脑未提供可用时间");
        return new Sample(date,elapsed);
    }
}
