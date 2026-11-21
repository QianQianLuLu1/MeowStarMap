package app.nikkisync.mobile.privacy;

import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.util.Linkify;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.activity.ComponentActivity;
import app.nikkisync.mobile.R;
import app.nikkisync.mobile.ui.chrome.ChromeHost;
import app.nikkisync.mobile.ui.chrome.ChromeNavigationHost;
import app.nikkisync.mobile.ui.chrome.ChromeSheetLayout;

public final class PrivacyUi {
    private PrivacyUi(){}
    public static void showConsent(ComponentActivity activity,ChromeNavigationHost navigation,Runnable accepted){
        ChromeHost host=new ChromeHost(activity);host.contentLayer().setBackgroundResource(R.drawable.bg_gallery_ambient);host.limitTopBlurToHeader();
        host.addOnAttachStateChangeListener(new View.OnAttachStateChangeListener(){public void onViewAttachedToWindow(View v){}public void onViewDetachedFromWindow(View v){host.backdrop().close();}});
        LinearLayout content=column(activity);content.addView(text(activity,"欢迎使用喵星图",24,true));
        content.addView(text(activity,"我们会在你选择的电脑和手机之间传输照片，保存本地缓存、配对及昵称等设置。扫码时使用相机，发现电脑时使用附近设备权限。\n\n电脑的在线参数解析默认开启，可能向第三方发送游戏UID、编码参数与校验值，可在电脑的同步设置中关闭。关闭后仍可浏览、保存照片及已有参数。\n\n分享图昵称水印默认开启，可在设置中关闭，导出前请检查昵称和UID。EXIF相机名称固定为MomoCamera，镜头名称为Infinity Nikki。\n\n请阅读以下政策与协议，确认后再继续。",16,false));
        for(String[] doc:new String[][]{{"隐私政策","privacy"},{"用户协议","terms"},{"权限与数据说明","permissions"},{"第三方服务与组件","services"}}){
            Button button=action(activity,doc[0],()->openDocument(activity,navigation,doc[0],doc[1]));content.addView(button);
        }
        ScrollView scroll=new ScrollView(activity);scroll.setClipToPadding(false);scroll.addView(content);host.contentLayer().addView(scroll,new android.widget.FrameLayout.LayoutParams(-1,-1));
        TextView heading=text(activity,"隐私保护",20,true);heading.setPadding(dp(activity,12),dp(activity,16),dp(activity,12),dp(activity,16));
        LinearLayout footer=column(activity);
        footer.addView(action(activity,"同意并继续",()->{if(activity.isFinishing()||activity.isDestroyed())return;new PrivacyConsentStore(activity).accept();accepted.run();},true));
        footer.addView(action(activity,"不同意并退出",activity::finish));
        host.installChrome(heading,footer,scroll);
        navigation.setRoot(host);activity.setContentView(navigation);
    }
    public static void openDocument(ComponentActivity activity,ChromeNavigationHost navigation,String title,String kind){
        ChromeHost host=new ChromeHost(activity);host.contentLayer().setBackgroundResource(R.drawable.bg_gallery_ambient);host.limitTopBlurToHeader();
        LinearLayout content=column(activity);
        String body;try{body=PrivacyDocuments.display(PrivacyDocuments.read(activity,kind));}catch(java.io.IOException error){body="文档暂时无法读取，请通过 https://github.com/QianQianLuLu1/MeowStarMap/issues 反馈；请勿在未阅读政策时继续。";}
        TextView document=text(activity,body,14,false);document.setTextIsSelectable(true);Linkify.addLinks(document,Linkify.WEB_URLS);content.addView(document);
        ScrollView scroll=new ScrollView(activity);scroll.setClipToPadding(false);scroll.addView(content);host.contentLayer().addView(scroll,new android.widget.FrameLayout.LayoutParams(-1,-1));
        TextView heading=text(activity,title,20,true);heading.setPadding(dp(activity,12),dp(activity,16),dp(activity,12),dp(activity,16));
        Button close=action(activity,"返回",()->navigation.dismiss(host));host.installChrome(heading,close,scroll);
        navigation.push(host,()->host.backdrop().close());
    }
    public static void confirm(ComponentActivity activity,ChromeNavigationHost navigation,String title,String description,String confirm,Runnable action){
        LinearLayout footer=column(activity);TextView heading=text(activity,title,20,true);TextView body=text(activity,description,15,false);
        ChromeSheetLayout[] sheet={null};
        footer.addView(action(activity,confirm,()->{navigation.dismiss(sheet[0]);action.run();}));footer.addView(action(activity,"取消",()->navigation.dismiss(sheet[0])));
        sheet[0]=new ChromeSheetLayout(activity,heading,body,footer).wrapContentForm();navigation.showSheet(sheet[0]);
    }
    private static LinearLayout column(ComponentActivity a){LinearLayout box=new LinearLayout(a);box.setOrientation(LinearLayout.VERTICAL);box.setPadding(dp(a,12),dp(a,14),dp(a,12),dp(a,14));return box;}
    private static TextView text(ComponentActivity a,String value,int size,boolean bold){TextView view=new TextView(a);view.setText(value);view.setTextSize(size);view.setTextColor(a.getColor(R.color.text_primary));view.setLineSpacing(dp(a,4),1);view.setPadding(0,0,0,dp(a,14));if(bold)view.setTypeface(Typeface.DEFAULT_BOLD);return view;}
    private static Button action(ComponentActivity a,String value,Runnable run){return action(a,value,run,false);}
    private static Button action(ComponentActivity a,String value,Runnable run,boolean primary){
        Button button=new Button(a,null,0);button.setText(value);button.setTextSize(15);button.setAllCaps(false);
        button.setGravity(Gravity.CENTER);button.setTextColor(a.getColor(R.color.text_primary));
        GradientDrawable surface=new GradientDrawable();surface.setColor(primary?0xfff3b6bf:0xfffffbf8);
        surface.setCornerRadius(dp(a,24));surface.setStroke(dp(a,1),primary?0xffdf9eaa:0xffe4d1d5);
        button.setBackground(surface);button.setStateListAnimator(null);button.setElevation(dp(a,2));
        button.setMinHeight(dp(a,48));button.setMinimumHeight(dp(a,48));
        LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,dp(a,50));lp.bottomMargin=dp(a,8);
        button.setLayoutParams(lp);button.setOnClickListener(v->run.run());return button;
    }
    private static int dp(ComponentActivity a,int value){return Math.round(value*a.getResources().getDisplayMetrics().density);}
}
