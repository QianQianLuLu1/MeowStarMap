package app.nikkisync.mobile.media.live;

import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.media.MediaMetadataRetriever;
import java.io.File;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.util.ArrayList;
import java.util.List;

/** Bounded bitmap sampling; returns an actual sample PTS/index and reports failures instead of inventing zero. */
public final class CoverFrameMatcher {
    public record Match(long presentationUs,int sampleIndex,String source,double error){}
    private CoverFrameMatcher(){}
    public static Match find(File image,File video,VideoFacts facts,Long canonical)throws IOException{
        if(canonical!=null&&canonical>=0&&canonical<facts.durationUs())
            return new Match(canonical,facts.nearestIndex(canonical),"canonical",0);
        Bitmap reference=ImageDecoder.decodeBitmap(ImageDecoder.createSource(image),(decoder,info,source)->{
            decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);decoder.setTargetSize(64,64);
        });
        MediaMetadataRetriever retriever=new MediaMetadataRetriever();
        try{
            retriever.setDataSource(video.getAbsolutePath());int best=-1;double score=Double.POSITIVE_INFINITY;
            List<Integer> candidates=new ArrayList<>();long previous=Long.MIN_VALUE;
            for(int i=0;i<facts.sampleTimesUs().size();i++){
                long t=facts.sampleTimesUs().get(i);
                if(candidates.isEmpty()||t-previous>=250_000){candidates.add(i);previous=t;}
            }
            // Keep long clips bounded without assuming their frame rate.
            int stride=Math.max(1,(candidates.size()+119)/120);
            for(int n=0;n<candidates.size();n+=stride){int index=candidates.get(n);double s=score(retriever,facts.sampleTimesUs().get(index),reference);if(s<score){score=s;best=index;}}
            if(best>=0){long center=facts.sampleTimesUs().get(best);long radius=250_000L*stride;
                int lo=facts.nearestIndex(Math.max(0,center-radius)),hi=facts.nearestIndex(center+radius);
                int step=Math.max(1,(hi-lo+1+59)/60);
                for(int i=lo;i<=hi;i+=step){double s=score(retriever,facts.sampleTimesUs().get(i),reference);if(s<score){score=s;best=i;}}
            }
            if(best<0||!Double.isFinite(score)||score>0.20)throw new IOException("无法可靠匹配 Live 封面帧，未以 0 伪装成功");
            return new Match(facts.sampleTimesUs().get(best),best,"sample_match_v1",score);
        }catch(IOException e){throw e;}catch(Exception e){throw new IOException("Live 封面匹配失败",e);}finally{reference.recycle();try{retriever.release();}catch(Exception ignored){}}
    }
    private static double score(MediaMetadataRetriever r,long pts,Bitmap target)throws IOException{
        if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Live 封面匹配已取消");
        Bitmap frame=null,scaled=null;
        try{
            frame=r.getScaledFrameAtTime(pts,MediaMetadataRetriever.OPTION_CLOSEST,64,64);if(frame==null)return Double.POSITIVE_INFINITY;
            scaled=Bitmap.createScaledBitmap(frame,64,64,true);long sum=0;
            for(int y=0;y<64;y+=2)for(int x=0;x<64;x+=2){int a=target.getPixel(x,y),b=scaled.getPixel(x,y);
                sum+=Math.abs((a>>16&255)-(b>>16&255))+Math.abs((a>>8&255)-(b>>8&255))+Math.abs((a&255)-(b&255));}
            return sum/(32.0*32*3*255);
        }finally{if(scaled!=null&&scaled!=frame)scaled.recycle();if(frame!=null)frame.recycle();}
    }
}