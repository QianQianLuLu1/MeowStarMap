package app.nikkisync.mobile.media.live;

import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/** Diagnose unsupported full-resolution rotation before allocating a cover/starting codecs. */
final class RotationVideoSupport {
 @FunctionalInterface interface Capability { boolean supports(int width,int height); }
 private RotationVideoSupport(){}
 static void requireSupported(VideoFacts source,int clockwise)throws IOException{
  List<Capability> encoders=new ArrayList<>();
  try{
   for(MediaCodecInfo codec:new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos()){
    if(!codec.isEncoder())continue;
    for(String type:codec.getSupportedTypes())if("video/avc".equalsIgnoreCase(type)){
     encoders.add((w,h)->codec.getCapabilitiesForType(type).getVideoCapabilities().isSizeSupported(w,h));break;
    }
   }
  }catch(RuntimeException unavailable){return;} // Let Media3 report the real codec error if OEM discovery fails.
  requireSupported(source,clockwise,encoders);
 }
 static void requireSupported(VideoFacts source,int clockwise,List<Capability> encoders)throws IOException{
  int w=QuarterTurn.outputWidth(source.displayWidth(),source.displayHeight(),clockwise);
  int h=QuarterTurn.outputHeight(source.displayWidth(),source.displayHeight(),clockwise);
  boolean unknown=false;
  for(Capability codec:encoders)try{if(codec.supports(w,h))return;}catch(RuntimeException unavailable){unknown=true;}
  if(!unknown)throw new IOException("当前手机编码器不支持 "+w+"×"+h+" 的旋转视频，可保存原方向；未降低分辨率");
 }
}
