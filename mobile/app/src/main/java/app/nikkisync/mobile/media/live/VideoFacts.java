package app.nikkisync.mobile.media.live;

import android.media.MediaExtractor;
import android.media.MediaFormat;
import java.io.File;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Real track sample PTS, never duration * guessed 30fps. */
public record VideoFacts(int width,int height,int rotation,long durationUs,boolean hasAudio,
                         boolean hdr,List<Long> sampleTimesUs) {
    public VideoFacts { sampleTimesUs=List.copyOf(sampleTimesUs); }
    public int displayWidth(){return QuarterTurn.outputWidth(width,height,rotation);}
    public int displayHeight(){return QuarterTurn.outputHeight(width,height,rotation);}
    public long frameToleranceUs(){
        long max=50_000;for(int i=1;i<sampleTimesUs.size();i++)max=Math.max(max,sampleTimesUs.get(i)-sampleTimesUs.get(i-1));return max;
    }
    public int nearestIndex(long time){
        int p=Collections.binarySearch(sampleTimesUs,time);if(p>=0)return p;p=-p-1;
        if(p==0)return 0;if(p==sampleTimesUs.size())return p-1;
        return time-sampleTimesUs.get(p-1)<=sampleTimesUs.get(p)-time?p-1:p;
    }
    public static VideoFacts read(File file)throws IOException{
        MediaExtractor e=new MediaExtractor();
        try{
            e.setDataSource(file.getAbsolutePath());int video=-1,audio=0;MediaFormat f=null;
            for(int i=0;i<e.getTrackCount();i++){
                MediaFormat t=e.getTrackFormat(i);String mime=t.getString(MediaFormat.KEY_MIME);
                if(mime!=null&&mime.startsWith("video/")){if(video!=-1)throw new IOException("暂不支持多视频轨 Live");video=i;f=t;}
                if(mime!=null&&mime.startsWith("audio/"))audio++;
            }
            if(video<0||f==null)throw new IOException("动态资源没有视频轨");
            if(audio>1)throw new IOException("多音轨 Live 暂不支持，避免丢失音轨");
            int width=f.getInteger(MediaFormat.KEY_WIDTH),height=f.getInteger(MediaFormat.KEY_HEIGHT);
            int rotation=QuarterTurn.normalize(f.containsKey(MediaFormat.KEY_ROTATION)?f.getInteger(MediaFormat.KEY_ROTATION):0);
            int transfer=f.containsKey(MediaFormat.KEY_COLOR_TRANSFER)?f.getInteger(MediaFormat.KEY_COLOR_TRANSFER):0;
            int standard=f.containsKey(MediaFormat.KEY_COLOR_STANDARD)?f.getInteger(MediaFormat.KEY_COLOR_STANDARD):0;
            boolean hdr=transfer==MediaFormat.COLOR_TRANSFER_ST2084||transfer==MediaFormat.COLOR_TRANSFER_HLG||standard==MediaFormat.COLOR_STANDARD_BT2020;
            int sarW=f.containsKey("sar-width")?f.getInteger("sar-width"):1;
            int sarH=f.containsKey("sar-height")?f.getInteger("sar-height"):1;
            if(sarW!=sarH)throw new IOException("暂不支持非方形像素视频，拒绝改变画幅");
            long duration=f.containsKey(MediaFormat.KEY_DURATION)?f.getLong(MediaFormat.KEY_DURATION):0;
            e.selectTrack(video);List<Long> pts=new ArrayList<>();
            while(true){long time=e.getSampleTime();if(time==-1)break;
                if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Live 已取消");
                if(time<0)throw new IOException("负时间戳视频需单独规范化，未修改源资源");
                pts.add(time);if(pts.size()>36_000)throw new IOException("Live 视频帧数超过当前安全处理上限，未裁剪");if(!e.advance())break;
            }
            if(pts.isEmpty())throw new IOException("动态资源没有可读视频样本");Collections.sort(pts);
            long step=pts.size()>1?Math.max(1,pts.get(pts.size()-1)-pts.get(pts.size()-2)):50_000;
            duration=Math.max(duration,pts.get(pts.size()-1)+step);
            return new VideoFacts(width,height,rotation,duration,audio>0,hdr,pts);
        }catch(IOException e1){throw e1;}catch(RuntimeException e1){throw new IOException("无法读取 Live 视频结构",e1);}finally{e.release();}
    }
    public void verifyRotated(VideoFacts after,int degrees)throws IOException{
        JpegSegments.require(after.rotation==0,"编码器仍输出方向标签，拒绝仅旋转封面");
        JpegSegments.require(after.width==QuarterTurn.outputWidth(displayWidth(),displayHeight(),degrees)
            &&after.height==QuarterTurn.outputHeight(displayWidth(),displayHeight(),degrees),"编码器改变了目标分辨率/画幅");
        JpegSegments.require(after.hasAudio==hasAudio,"旋转后音轨丢失/被无故添加");
        JpegSegments.require(after.sampleTimesUs.size()==sampleTimesUs.size(),"旋转后视频帧数改变，拒绝静默丢帧");
        long span=sampleTimesUs.get(sampleTimesUs.size()-1)-sampleTimesUs.get(0);
        long newSpan=after.sampleTimesUs.get(after.sampleTimesUs.size()-1)-after.sampleTimesUs.get(0);
        JpegSegments.require(Math.abs(span-newSpan)<=Math.max(frameToleranceUs(),after.frameToleranceUs()),"旋转后视频时间轴改变");
        JpegSegments.require(Math.abs(durationUs-after.durationUs)<=Math.max(150_000,frameToleranceUs()),"旋转后视频被裁短或变速");
        JpegSegments.require(!after.hdr,"意外 HDR 输出，未发布到系统相册");
    }
}