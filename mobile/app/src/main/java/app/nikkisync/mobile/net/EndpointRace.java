package app.nikkisync.mobile.net;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;

/** Races a small explicit candidate set with bounded lifetime and concurrency. */
public final class EndpointRace {
    @FunctionalInterface public interface Probe { boolean test(String host)throws Exception; }
    private EndpointRace(){}
    public static String first(List<String> hosts,Probe probe,long timeoutMs)throws IOException{
        ExecutorService workers=Executors.newFixedThreadPool(Math.min(3,Math.max(1,hosts.size())),task->{
            Thread thread=new Thread(task,"Momo-endpoint");thread.setDaemon(true);return thread;
        });
        List<Future<String>> futures=new ArrayList<>();
        try{
            CompletionService<String> results=new ExecutorCompletionService<>(workers);
            for(String host:hosts.subList(0,Math.min(EndpointCandidates.LIMIT,hosts.size())))
                futures.add(results.submit(()->probe.test(host)?host:null));
            long end=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(timeoutMs);
            for(int left=futures.size();left>0;left--){
                long remaining=end-System.nanoTime();if(remaining<=0)break;
                Future<String> ready=results.poll(remaining,TimeUnit.NANOSECONDS);if(ready==null)break;
                try{String host=ready.get();if(host!=null)return host;}catch(ExecutionException ignored){}
            }
        }catch(InterruptedException error){Thread.currentThread().interrupt();throw new IOException("连接检查已取消",error);}
        finally{for(Future<?> future:futures)future.cancel(true);workers.shutdownNow();}
        throw new IOException("已尝试电脑的已知地址，暂时无法连接");
    }
}
