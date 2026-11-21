package app.nikkisync.mobile.share;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.*;
import android.widget.*;
import app.nikkisync.mobile.R;
import app.nikkisync.mobile.ui.OperationProgressDialog;
import app.nikkisync.mobile.ui.chrome.*;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Executor;

/** One bounded preview bitmap in the shared navigation stack, including predictive return. */
public final class ShareCardPreviewDialog extends Dialog {
    private final Activity activity;
    private final ShareCardPreparation.Prepared prepared;
    private final ShareCardExportCoordinator coordinator;
    private final ShareCardExportCoordinator.OriginalSave original;
    private final Executor worker;
    private final Handler main=new Handler(Looper.getMainLooper());
    private final Map<Integer,Uri> saved=new HashMap<>();
    private final ChromeNavigationHost navigation;
    private final ChromeHost host;
    private final ImageView image;
    private final Button previous,next,save,both;
    private final TextView pageText,status;
    private Bitmap bitmap;
    private int page,sequence;
    private boolean closed,visible,loading,saving,originalSaved;
    private OperationProgressDialog progress;
    public ShareCardPreviewDialog(Activity activity,ShareCardPreparation.Prepared prepared,
            ShareCardExportCoordinator coordinator,Executor worker,boolean missing){
        this(activity,prepared,coordinator,worker,missing,null);
    }
    public ShareCardPreviewDialog(Activity activity,ShareCardPreparation.Prepared prepared,
            ShareCardExportCoordinator coordinator,Executor worker,boolean missing,ShareCardExportCoordinator.OriginalSave original){
        super(activity);this.activity=activity;this.prepared=prepared;this.coordinator=coordinator;this.worker=worker;this.original=original;
        navigation=activity instanceof ChromePage.Owner owner?owner.navigationHost():null;
        host=new ChromeHost(activity);host.contentLayer().setBackgroundResource(R.drawable.bg_gallery_ambient);
        LinearLayout header=new LinearLayout(activity);header.setPadding(0,dp(14),0,dp(14));
        TextView title=new TextView(activity);title.setText("穿搭与参数分享图");title.setTextSize(20);title.setTextColor(activity.getColor(R.color.text_primary));header.addView(title);
        ScrollView scroll=new ScrollView(activity);image=new ImageView(activity);image.setAdjustViewBounds(true);image.setScaleType(ImageView.ScaleType.FIT_CENTER);
        scroll.addView(image,new ScrollView.LayoutParams(-1,-2));host.contentLayer().addView(scroll,new FrameLayout.LayoutParams(-1,-1));
        LinearLayout dock=new LinearLayout(activity);dock.setOrientation(LinearLayout.VERTICAL);
        pageText=new TextView(activity);pageText.setGravity(Gravity.CENTER);dock.addView(pageText);
        status=new TextView(activity);status.setTextSize(12);status.setTextColor(activity.getColor(R.color.text_secondary));status.setPadding(dp(10),dp(6),dp(10),dp(8));
        status.setText((missing?"没有离线参数快照，当前图只含已有信息。":"可保存当前页分享图。")+(prepared.missingIcons()>0?" 部分部件图标暂缺。":""));dock.addView(status);
        LinearLayout pages=new LinearLayout(activity);previous=button("上一页");next=button("下一页");pages.addView(previous,new LinearLayout.LayoutParams(0,dp(48),1));pages.addView(next,new LinearLayout.LayoutParams(0,dp(48),1));dock.addView(pages);
        save=button("保存分享图");both=button("保存原图+分享图");Button close=button("关闭");
        for(Button button:new Button[]{save,both,close}){LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,dp(48));lp.topMargin=dp(6);dock.addView(button,lp);host.addDockEffect(button);}
        host.addDockEffect(previous);host.addDockEffect(next);host.installChrome(header,dock,scroll);
        previous.setOnClickListener(v->{page--;load();});next.setOnClickListener(v->{page++;load();});
        save.setOnClickListener(v->save(false));both.setOnClickListener(v->save(true));close.setOnClickListener(v->{if(!saving)dismiss();});
        if(navigation==null){setContentView(host);setOnDismissListener(d->release());}
    }
    @Override public void show(){
        if(closed||visible)return;visible=true;
        if(navigation!=null)navigation.push(host,this::release);
        else{super.show();getWindow().setLayout(-1,-1);}load();
    }
    @Override public void dismiss(){if(closed)return;closed=true;sequence++;if(navigation!=null)navigation.dismiss(host);else super.dismiss();}
    @Override public boolean isShowing(){return visible&&!closed;}
    private void release(){
        closed=true;visible=false;sequence++;image.setImageDrawable(null);
        if(bitmap!=null){bitmap.recycle();bitmap=null;}prepared.close();host.backdrop().close();
    }
    private void save(boolean includeOriginal){
        if(saving||loading)return;final int selected=page;saving=true;update();
        progress=new OperationProgressDialog(activity,includeOriginal?"保存原图与分享图":"保存分享图",null);progress.show();
        ShareCardExportCoordinator.SaveListener listener=new ShareCardExportCoordinator.SaveListener(){
            public void onProgress(String stage,long done,long total){if(progress!=null)progress.update(stage,done,total);}
            private void finish(){saving=false;if(progress!=null){progress.dismiss();progress=null;}}
            public void onSuccess(Uri uri){saved.put(selected,uri);if(includeOriginal)originalSaved=true;finish();if(closed)return;status.setText(includeOriginal?"原图和当前页分享图已保存。":"当前页分享图已保存。");update();}
            public void onFailure(Exception error){if(error instanceof ShareCardExportCoordinator.PartialSaveException partial)saved.put(selected,partial.shareUri);finish();if(closed)return;status.setText("可重试："+error.getMessage());update();}
        };
        if(includeOriginal&&original!=null)coordinator.saveBoth(prepared,selected,saved.get(selected),originalSaved?p->Uri.EMPTY:original,listener);
        else coordinator.save(prepared,selected,listener);
    }
    private void load(){
        int token=++sequence,selected=page;loading=true;update();
        worker.execute(()->{try{Bitmap result=prepared.preview(selected);if(result==null)throw new IllegalStateException("分享图无法预览");
            main.post(()->{if(closed||token!=sequence){result.recycle();return;}image.setImageBitmap(result);Bitmap old=bitmap;bitmap=result;if(old!=null)old.recycle();loading=false;update();});
        }catch(Exception error){main.post(()->{if(closed||token!=sequence)return;loading=false;status.setText("预览失败："+error.getMessage());update();});}});
    }
    private void update(){
        pageText.setText((page+1)+" / "+prepared.pageCount()+(loading?" · 正在加载…":""));
        previous.setVisibility(prepared.pageCount()>1?View.VISIBLE:View.GONE);next.setVisibility(previous.getVisibility());
        previous.setEnabled(!loading&&!saving&&page>0);next.setEnabled(!loading&&!saving&&page+1<prepared.pageCount());
        save.setEnabled(!loading&&!saving&&!saved.containsKey(page));
        both.setEnabled(!loading&&!saving&&original!=null&&!(originalSaved&&saved.containsKey(page)));
    }
    private Button button(String text){Button button=new Button(activity,null,0);button.setStateListAnimator(null);button.setGravity(Gravity.CENTER);button.setText(text);button.setAllCaps(false);button.setTextSize(14);button.setTextColor(activity.getColor(R.color.text_primary));button.setBackgroundColor(android.graphics.Color.TRANSPARENT);button.setMinHeight(dp(48));return button;}
    private int dp(int value){return Math.round(value*activity.getResources().getDisplayMetrics().density);}
}
