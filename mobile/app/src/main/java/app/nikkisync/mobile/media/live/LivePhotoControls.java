package app.nikkisync.mobile.media.live;

import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import app.nikkisync.mobile.storage.SavedPhotoStore;
import app.nikkisync.mobile.storage.SavedPhotoHealthStore;
import java.util.function.IntConsumer;
import app.nikkisync.mobile.R;
import app.nikkisync.mobile.ui.GalleryUxStyle;

/** Live-specific controls; the Activity owns per-photo rotation state, never a global batch angle. */
public final class LivePhotoControls {
    private static final String PREFS="nikkisync_live_export",KEY="profile_override";
    private LivePhotoControls(){}
    private static int dp(Context context,int value){return Math.round(value*context.getResources().getDisplayMetrics().density);}
    private static Button action(Context context,String text){
        Button button=new Button(context);button.setText(text);button.setAllCaps(false);button.setTextSize(13);
        button.setTextColor(context.getColor(R.color.text_primary));
        button.setBackground(GalleryUxStyle.glassButton(context));
        button.setMinHeight(dp(context,44));button.setPadding(dp(context,14),dp(context,8),dp(context,14),dp(context,8));button.setStateListAnimator(null);
        LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,ViewGroup.LayoutParams.WRAP_CONTENT);lp.setMargins(dp(context,4),dp(context,6),dp(context,4),dp(context,6));button.setLayoutParams(lp);return button;
    }
    public static void attachSaved(Context context,LinearLayout parent,SavedPhotoStore.Record record,SavedPhotoHealthStore.Entry health){
        if(!record.hasMotion())return;
        String warning=health==null?null:health.motionWarning();
        if(warning!=null&&!warning.isBlank()){
            TextView status=new TextView(context);status.setTextSize(12);
            status.setTextColor(context.getColor(R.color.photo_detail_text_secondary));
            status.setText(warning);parent.addView(status);
        }
        if(!record.companionUris().isEmpty()){
            Button video=action(context,"播放动态视频");
            video.setEnabled(health==null||health.state()!=SavedPhotoHealthStore.State.MOTION_MISSING);
            video.setOnClickListener(v->{try{context.startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(record.companionUris().get(0)),"video/mp4").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));}
                catch(Exception e){Toast.makeText(context,"无法打开动态视频，请检查文件或播放器",Toast.LENGTH_LONG).show();}});parent.addView(video);
        }
    }
    public static LivePhotoProfile selectedProfile(Context context){
        String id=context.getSharedPreferences(PREFS,Context.MODE_PRIVATE).getString(KEY,"");
        if(id!=null&&!id.isEmpty())try{return LivePhotoProfile.fromId(id);}catch(IllegalArgumentException ignored){}
        return LivePhotoProfile.defaultFor(Build.MANUFACTURER,Build.BRAND);
    }
    public static IntConsumer attach(Context context,LinearLayout parent,ImageView preview,int initial,IntConsumer remember){
        int[] degrees={QuarterTurn.normalize(initial)};LinearLayout row=new LinearLayout(context);row.setGravity(Gravity.CENTER_VERTICAL);
        Button left=action(context,"左转 90°"),right=action(context,"右转 90°");
        TextView value=new TextView(context);value.setTextColor(context.getColor(R.color.photo_detail_text));value.setGravity(Gravity.CENTER);value.setText(degrees[0]+"°");
        IntConsumer rotate=delta->{degrees[0]=QuarterTurn.normalize(degrees[0]+delta);preview.setRotation(degrees[0]);value.setText(degrees[0]+"°");remember.accept(degrees[0]);};
        left.setOnClickListener(v->rotate.accept(-90));right.setOnClickListener(v->rotate.accept(90));
        row.addView(left);row.addView(value,new LinearLayout.LayoutParams(0,ViewGroup.LayoutParams.WRAP_CONTENT,1));row.addView(right);parent.addView(row);
        Button profile=action(context,"Live 格式："+selectedProfile(context).label);
        profile.setOnClickListener(v->{
            LivePhotoProfile[] all=LivePhotoProfile.values();String[] labels=new String[all.length+1];labels[0]="自动选择（推荐）";
            for(int i=0;i<all.length;i++)labels[i+1]=all[i].label;
            String override=context.getSharedPreferences(PREFS,Context.MODE_PRIVATE).getString(KEY,"");int selected=0;
            for(int i=0;i<all.length;i++)if(all[i].id.equals(override))selected=i+1;
            new AlertDialog.Builder(context).setTitle("选择 Live 格式").setSingleChoiceItems(labels,selected,(dialog,which)->{
                context.getSharedPreferences(PREFS,Context.MODE_PRIVATE).edit().putString(KEY,which==0?"":all[which-1].id).apply();
                profile.setText("Live 格式："+selectedProfile(context).label);dialog.dismiss();
            }).setNegativeButton("取消",null).show();
        });parent.addView(profile);
        return rotate;
    }
}
