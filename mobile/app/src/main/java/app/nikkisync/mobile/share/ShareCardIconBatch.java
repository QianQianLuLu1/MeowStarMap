package app.nikkisync.mobile.share;

import java.io.File;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.BooleanSupplier;
import java.util.function.BiConsumer;

/** Only job-local IO workers; no bitmap ownership crosses worker boundaries. */
final class ShareCardIconBatch {
    interface Loader {File load(String id) throws Exception;}
    private record Result(String id,File file) {}
    static Map<String,File> load(List<String> ids,BooleanSupplier active,Loader loader) throws Exception {
        return load(ids,active,loader,(done,total)->{});
    }
    static Map<String,File> load(List<String> ids,BooleanSupplier active,Loader loader,BiConsumer<Integer,Integer> progress) throws Exception {
        List<String> unique=new ArrayList<>(new LinkedHashSet<>(ids));unique.removeIf(String::isEmpty);
        Map<String,File> result=new HashMap<>();if(unique.isEmpty())return result;
        var workers=Executors.newFixedThreadPool(Math.min(4,unique.size()));
        var completion=new ExecutorCompletionService<Result>(workers);
        try {
            ShareCardPreparation.check(active);progress.accept(0,unique.size());
            for(String id:unique) completion.submit(()->{
                ShareCardPreparation.check(active);
                try {return new Result(id,loader.load(id));}
                catch(Exception error) {ShareCardPreparation.check(active);return new Result(id,null);}
            });
            int done=0;
            while(done<unique.size()) {
                ShareCardPreparation.check(active);var ready=completion.poll(100,TimeUnit.MILLISECONDS);if(ready==null)continue;
                Result icon=ready.get();if(icon.file()!=null)result.put(icon.id(),icon.file());
                progress.accept(++done,unique.size());
            }
            ShareCardPreparation.check(active);return result;
        } finally {workers.shutdownNow();}
    }
}
