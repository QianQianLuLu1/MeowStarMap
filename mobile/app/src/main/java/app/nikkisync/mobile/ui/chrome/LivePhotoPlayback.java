package app.nikkisync.mobile.ui.chrome;

import android.content.Context;
import android.graphics.Color;
import android.view.*;
import android.widget.*;
import androidx.lifecycle.*;
import androidx.media3.common.*;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.PlayerView;
import app.nikkisync.mobile.R;
import app.nikkisync.mobile.media.SignedVideoDataSource;
import app.nikkisync.mobile.media.live.MotionPreviewLoader;
import app.nikkisync.mobile.net.NikkiSyncClient;
import java.io.File;

/** One photo's decoder, controls and first-frame gate. All state changes run on the UI thread. */
@UnstableApi
public final class LivePhotoPlayback implements AutoCloseable {
    interface Events {void firstFrame();void failed();}
    interface Engine extends AutoCloseable {View view();void playing(boolean value);void muted(boolean value);default long position(){return 0;}default long duration(){return 0;}default void seek(long position){}@Override void close();}
    interface Factory {Engine create(Context context,File file,Events events);}
    private final Context context;private final MotionPreviewLoader.Source source;private final Factory factory;
    private final FrameLayout surface;private final LinearLayout controls;private final Button play,sound;
    private final String label;private final SeekBar seek;
    private final android.os.Handler handler=new android.os.Handler(android.os.Looper.getMainLooper());
    private boolean seeking;
    private final Runnable updatePosition=new Runnable(){public void run(){if(closed)return;if(engine!=null&&seek!=null&&!seeking){long total=engine.duration();seek.setEnabled(total>0);if(total>0)seek.setProgress((int)Math.min(1000,Math.max(0,engine.position()*1000.0/total)));}handler.postDelayed(this,500);}};
    private Engine engine;private MotionPreviewLoader.Video video;private MotionPreviewLoader.Request request;
    private boolean eligible,foreground=true,closed,firstFrame,failed,loading,wantsPlay=true,muted=true;private int generation;
    private Lifecycle lifecycle;private LifecycleEventObserver observer;

    public LivePhotoPlayback(Context context,MotionPreviewLoader.Source source){this(context,source,MediaEngine::new);}
    LivePhotoPlayback(Context context,MotionPreviewLoader.Source source,Factory factory){this(context,source,factory,"LIVE",false);}
    public static LivePhotoPlayback remoteVideo(Context context,NikkiSyncClient client,String assetId){
        MotionPreviewLoader.Source source=callback->{
            android.os.Handler main=new android.os.Handler(android.os.Looper.getMainLooper());
            Runnable ready=()->callback.ready(new MotionPreviewLoader.Video(){public File file(){return null;}public void close(){}});
            main.post(ready);return ()->main.removeCallbacks(ready);
        };
        return new LivePhotoPlayback(context,source,(c,file,events)->MediaEngine.remote(c,client,assetId,events),"视频",true);
    }
    private LivePhotoPlayback(Context context,MotionPreviewLoader.Source source,Factory factory,String label,boolean seekable){
        this.context=context;this.source=source;this.factory=factory;this.label=label;
        surface=new FrameLayout(context);surface.setTag("live-video-surface");surface.setAlpha(0f);surface.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        controls=new LinearLayout(context);controls.setGravity(Gravity.CENTER);controls.setTag("live-playback-controls");
        controls.setPadding(dp(6),dp(2),dp(6),dp(2));controls.setBackgroundResource(R.drawable.bg_glass_chip);
        play=button();sound=button();controls.addView(play,new LinearLayout.LayoutParams(-2,dp(44)));
        if(seekable){
            seek=new SeekBar(context);seek.setMax(1000);seek.setEnabled(false);seek.setContentDescription("视频播放进度");controls.addView(seek,new LinearLayout.LayoutParams(dp(110),dp(44)));
            seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener(){
                public void onProgressChanged(SeekBar bar,int value,boolean user){}
                public void onStartTrackingTouch(SeekBar bar){seeking=true;}
                public void onStopTrackingTouch(SeekBar bar){if(engine!=null&&engine.duration()>0)engine.seek((long)(engine.duration()*(bar.getProgress()/1000.0)));seeking=false;}
            });
            handler.post(updatePosition);
        }else seek=null;
        controls.addView(sound,new LinearLayout.LayoutParams(-2,dp(44)));
        play.setOnClickListener(v->{if(failed){failed=false;wantsPlay=true;start();}else wantsPlay=!wantsPlay;update();});
        sound.setOnClickListener(v->{muted=!muted;update();});
        if(context instanceof LifecycleOwner owner){
            lifecycle=owner.getLifecycle();foreground=lifecycle.getCurrentState().isAtLeast(Lifecycle.State.STARTED);
            observer=(owner1,event)->{if(event==Lifecycle.Event.ON_STOP)setForeground(false);else if(event==Lifecycle.Event.ON_START)setForeground(true);else if(event==Lifecycle.Event.ON_DESTROY)close();};lifecycle.addObserver(observer);
        }
        update();
    }
    public FrameLayout surface(){return surface;}
    public LinearLayout controls(){return controls;}
    public void setEligible(boolean value){eligible=value;if(value)start();update();}
    void setForeground(boolean value){if(closed||foreground==value)return;foreground=value;if(!value)release();else start();update();}
    private void start(){
        if(closed||!foreground||!eligible||loading||engine!=null||failed)return;
        loading=true;int ticket=++generation;update();
        request=source.load(new MotionPreviewLoader.Callback(){
            @Override public void ready(MotionPreviewLoader.Video result){
                if(closed||!foreground||ticket!=generation){result.close();return;}loading=false;video=result;
                try{
                    Engine created=factory.create(context,result.file(),new Events(){
                        public void firstFrame(){if(!closed&&ticket==generation){firstFrame=true;update();}}
                        public void failed(){if(!closed&&ticket==generation){release();failed=true;update();}}
                    });
                    engine=created;surface.addView(created.view(),new FrameLayout.LayoutParams(-1,-1));update();
                }catch(RuntimeException error){release();failed=true;update();}
            }
            @Override public void failed(){if(!closed&&ticket==generation){loading=false;failed=true;update();}}
        });
    }
    private void update(){
        boolean active=!closed&&foreground&&eligible;
        surface.setAlpha(active&&firstFrame&&!failed?1f:0f);
        if(engine!=null){engine.muted(muted);engine.playing(active&&wantsPlay&&!failed);}
        play.setEnabled(!closed&&!loading);play.setText(failed?label+" · 重试":loading?label+" · 正在读取":label+" · "+(wantsPlay?"暂停":"播放"));
        sound.setEnabled(!closed&&!failed);sound.setText(muted?"开启声音":"静音");sound.setContentDescription(label+(muted?"当前静音，点击开启声音":"当前有声，点击静音"));
    }
    private void release(){
        generation++;loading=false;firstFrame=false;surface.setAlpha(0f);
        if(request!=null){request.cancel();request=null;}
        if(engine!=null){engine.close();engine=null;}surface.removeAllViews();
        if(video!=null){video.close();video=null;}
    }
    @Override public void close(){if(closed)return;closed=true;handler.removeCallbacks(updatePosition);release();if(lifecycle!=null&&observer!=null)lifecycle.removeObserver(observer);update();}
    private Button button(){Button b=new Button(context);b.setAllCaps(false);b.setTextColor(0xff513d46);b.setTextSize(12);b.setMinWidth(0);b.setMinimumWidth(0);b.setPadding(dp(12),0,dp(12),0);b.setBackgroundColor(Color.TRANSPARENT);return b;}
    private int dp(int value){return Math.round(value*context.getResources().getDisplayMetrics().density);}

    private static final class MediaEngine implements Engine {
        final PlayerView view;final ExoPlayer player;Boolean isMuted;
        MediaEngine(Context context,File file,Events events){
            this(context,new ExoPlayer.Builder(context).setHandleAudioBecomingNoisy(true).build(),MediaItem.fromUri(android.net.Uri.fromFile(file)),events,true);
        }
        static MediaEngine remote(Context context,NikkiSyncClient client,String assetId,Events events){
            var media=new DefaultMediaSourceFactory(()->new SignedVideoDataSource(client,assetId));
            return new MediaEngine(context,new ExoPlayer.Builder(context).setHandleAudioBecomingNoisy(true).setMediaSourceFactory(media).build(),
                MediaItem.fromUri("https://nikkisync.invalid/video.mp4"),events,false);
        }
        MediaEngine(Context context,ExoPlayer player,MediaItem item,Events events,boolean loop){
            view=(PlayerView)LayoutInflater.from(context).inflate(R.layout.live_photo_playback,null,false);
            this.player=player;
            player.setVolume(0f);player.setRepeatMode(loop?Player.REPEAT_MODE_ONE:Player.REPEAT_MODE_OFF);
            player.addListener(new Player.Listener(){
                @Override public void onRenderedFirstFrame(){events.firstFrame();}
                @Override public void onPlayerError(PlaybackException error){events.failed();}
            });
            try{view.setPlayer(player);player.setMediaItem(item);player.prepare();}
            catch(RuntimeException error){view.setPlayer(null);player.release();throw error;}
        }
        public View view(){return view;}
        public void playing(boolean value){player.setPlayWhenReady(value);}
        public void muted(boolean value){if(isMuted!=null&&isMuted==value)return;isMuted=value;player.setAudioAttributes(new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(),!value);player.setVolume(value?0f:1f);}
        public long position(){return player.getCurrentPosition();}public long duration(){long value=player.getDuration();return value==C.TIME_UNSET?0:value;}public void seek(long position){player.seekTo(position);}
        public void close(){view.setPlayer(null);player.release();}
    }
}
