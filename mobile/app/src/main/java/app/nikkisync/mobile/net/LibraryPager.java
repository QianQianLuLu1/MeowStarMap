package app.nikkisync.mobile.net;

import app.nikkisync.mobile.model.Models.*;
import java.util.*;
import java.util.concurrent.CancellationException;
import java.util.function.BooleanSupplier;
import java.util.function.IntConsumer;

/** Keyset pagination has no photo-count ceiling; reject broken cursors instead of large albums. */
public final class LibraryPager {
    private LibraryPager(){}
    @FunctionalInterface public interface Source {AssetPage read(String cursor,int limit)throws Exception;}
    public record Snapshot(List<AssetSummary> items,long revision){}
    public record Result(List<AssetSummary> items,long baselineRevision,long latestRevision,boolean fromSnapshot){
        public Result(List<AssetSummary> items,long baselineRevision,long latestRevision){this(items,baselineRevision,latestRevision,false);}
    }
    public static Result read(Source source,BooleanSupplier current,IntConsumer progress)throws Exception{
        return read(source,current,progress,null);
    }
    public static Result read(Source source,BooleanSupplier current,IntConsumer progress,Snapshot local)throws Exception{
        if(local!=null&&local.revision()>=0){
            if(!current.getAsBoolean())throw new CancellationException("Library session changed");
            AssetPage head=source.read(null,1);
            if(!current.getAsBoolean())throw new CancellationException("Library session changed");
            if(head==null||head.items()==null||head.libraryRevision()<0)throw new IllegalStateException("图库版本响应无效");
            boolean sameHead=head.items().isEmpty()?local.items().isEmpty():!local.items().isEmpty()&&head.items().get(0).assetId().equals(local.items().get(0).assetId())&&head.items().get(0).revision()==local.items().get(0).revision();
            if(sameHead&&!head.items().isEmpty()&&head.items().get(0).sourcePath()!=null)sameHead=Objects.equals(head.items().get(0).sourcePath(),local.items().get(0).sourcePath())&&Objects.equals(head.items().get(0).sizeBytes(),local.items().get(0).sizeBytes());
            if(head.libraryRevision()==local.revision()&&sameHead){if(progress!=null)progress.accept(local.items().size());return new Result(List.copyOf(local.items()),local.revision(),local.revision(),true);}
        }
        LinkedHashMap<String,AssetSummary> photos=new LinkedHashMap<>();Set<String> cursors=new HashSet<>();
        String cursor=null;long baseline=-1,latest=0;
        while(true){
            if(!current.getAsBoolean())throw new CancellationException("Library session changed");
            AssetPage page=source.read(cursor,500);
            if(!current.getAsBoolean())throw new CancellationException("Library session changed");
            if(page==null||page.items()==null||page.libraryRevision()<0)throw new IllegalStateException("图库分页响应无效");
            if(baseline<0)baseline=page.libraryRevision();latest=Math.max(latest,page.libraryRevision());
            int before=photos.size();
            for(AssetSummary asset:page.items()){
                if(asset==null||asset.assetId()==null||asset.assetId().isBlank())throw new IllegalStateException("图库照片标识无效");
                AssetSummary previous=photos.get(asset.assetId());if(previous==null||asset.revision()>=previous.revision())photos.put(asset.assetId(),asset);
            }
            if(progress!=null)progress.accept(photos.size());
            String next=page.nextCursor();
            if(next==null)return new Result(List.copyOf(photos.values()),baseline,latest);
            if(next.isBlank()||!cursors.add(next)||photos.size()==before)throw new IllegalStateException("图库分页未继续前进，请重新同步");
            cursor=next;
        }
    }
}
