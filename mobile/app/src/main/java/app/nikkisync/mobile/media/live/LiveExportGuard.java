package app.nikkisync.mobile.media.live;

import java.io.IOException;
import java.util.concurrent.Callable;
import java.util.concurrent.Semaphore;

/** Different UI workers may request LIVE simultaneously; keep only one export working set. */
public final class LiveExportGuard {
    private static final Semaphore SLOT=new Semaphore(1);
    private LiveExportGuard(){}
    public static <T> T run(Callable<T> operation)throws Exception {
        if(!SLOT.tryAcquire())throw new IOException("另一个 Live 正在保存，请完成后重试");
        try{return operation.call();}
        catch(OutOfMemoryError error){throw memoryFailure(error);}
        finally{SLOT.release();}
    }
    static IOException memoryFailure(OutOfMemoryError error){
        return new IOException("当前内存不足，Live 未保存完成；请关闭其他应用后重试，也可先保存原视频",error);
    }
}
