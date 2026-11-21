package app.nikkisync.mobile.support;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import app.nikkisync.mobile.BuildConfig;
import app.nikkisync.mobile.R;
import org.json.JSONArray;
import org.json.JSONException;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;

public final class SupportPanel extends LinearLayout {
    private final Activity activity;
    private final Executor worker;
    private final SupportClient client=new SupportClient(BuildConfig.SUPPORT_URL);
    private final Handler main=new Handler(Looper.getMainLooper());
    private final TextView status;
    private final Button send,bind,refresh;
    private final LinearLayout tickets;
    private String selected;
    private boolean busy,closed;

    public SupportPanel(Activity activity,Executor worker,Runnable export){
        super(activity);
        this.activity=activity;this.worker=worker;
        setOrientation(VERTICAL);setPadding(dp(14),dp(12),dp(14),dp(14));
        setBackgroundResource(R.drawable.bg_glass_card);
        addView(description("日志包含应用和系统版本、错误代码与次数。可以先导出到手机文件。"));
        addButton(this,"导出日志",export);
        send=addButton(this,"发送诊断",this::confirmSubmit);
        bind=addButton(this,"绑定电脑反馈",this::promptReceipt);
        refresh=addButton(this,"查收回复",this::read);
        status=description(client.enabled()?"反馈发给项目维护者，回复会显示在对应工单下。":"在线反馈暂未开通，可以先导出日志。");
        status.setAccessibilityLiveRegion(ACCESSIBILITY_LIVE_REGION_POLITE);
        addView(status);
        tickets=new LinearLayout(activity);tickets.setOrientation(VERTICAL);addView(tickets);
        List<String> saved=receipts();
        if(!saved.isEmpty())selected=saved.get(0);
        updateActions();
    }

    public void readLatest(){
        if(client.enabled()&&selected!=null)read();
    }

    public void close(){closed=true;}

    private void confirmSubmit(){
        if(!client.enabled()||busy)return;
        var report=SupportDiagnostics.snapshot(activity);
        new AlertDialog.Builder(activity).setTitle("预览诊断日志")
                .setMessage("以下内容将发送到项目的私有 CNB 工单。\n\n"+report)
                .setNegativeButton("取消",null).setPositiveButton("确认发送",(dialog,which)->{
                    busy=true;status.setText("正在提交诊断…");updateActions();
                    worker.execute(()->{
                        try {
                            String receipt=client.submit(report);
                            boolean saved=remember(receipt);
                            main.post(()->{
                                if(closed)return;
                                selected=receipt;busy=false;updateActions();
                                status.setText("已提交工单 #"+SupportClient.issueNumber(receipt)+"。");
                                if(!saved)showReceipt(receipt,"本机保存回执失败，请先复制回执码。");
                            });
                        }catch(IOException error){failure("发送失败，日志仍可导出。");}
                    });
                }).show();
    }

    private void promptReceipt(){
        if(!client.enabled()||busy)return;
        var code=new EditText(activity);
        code.setHint("粘贴电脑端的回执码");code.setSingleLine(true);
        new AlertDialog.Builder(activity).setTitle("绑定电脑反馈").setView(code)
                .setNegativeButton("取消",null).setPositiveButton("查收",(dialog,which)->{
                    String receipt=code.getText().toString().trim();
                    if(SupportClient.issueNumber(receipt)==null){
                        status.setText("回执码格式有误，请完整粘贴。");return;
                    }
                    fetchReplies(receipt,true);
                }).show();
    }

    private void read(){
        if(!client.enabled()||selected==null||busy)return;
        fetchReplies(selected,false);
    }

    private void fetchReplies(String receipt,boolean bindReceipt){
        busy=true;status.setText("正在查收回复…");updateActions();
        worker.execute(()->{
            try{
                var result=client.readReplies(receipt);
                boolean saved=!bindReceipt||remember(receipt);
                main.post(()->{
                    if(closed)return;
                    selected=receipt;busy=false;updateActions();
                    StringBuilder message=new StringBuilder("工单 #"+SupportClient.issueNumber(receipt))
                            .append(result.closed()?" · 已关闭":" · 处理中");
                    if(result.messages().length()==0)message.append("\n暂无回复");
                    for(int i=0;i<result.messages().length();i++){
                        var reply=result.messages().optJSONObject(i);
                        if(reply!=null)message.append("\n\n").append(reply.optString("message"));
                    }
                    status.setText(message.toString());
                    if(!saved)showReceipt(receipt,"本机保存回执失败，请先复制回执码。");
                });
            }catch(IOException error){failure("暂时无法查收。请检查网络和回执码。");}
        });
    }

    private void failure(String message){
        main.post(()->{if(!closed){busy=false;status.setText(message);updateActions();}});
    }

    private void showReceipt(String receipt,String message){
        new AlertDialog.Builder(activity).setTitle("反馈回执").setMessage(message+"\n\n"+receipt)
                .setPositiveButton("完成",null).setNeutralButton("复制回执码",(d,w)->activity.getSystemService(ClipboardManager.class)
                        .setPrimaryClip(ClipData.newPlainText("反馈回执",receipt))).show();
    }

    private void updateActions(){
        send.setEnabled(client.enabled()&&!busy);
        bind.setEnabled(client.enabled()&&!busy);
        refresh.setEnabled(client.enabled()&&selected!=null&&!busy);
        tickets.removeAllViews();
        for(String receipt:receipts()){
            String number=SupportClient.issueNumber(receipt);
            boolean current=receipt.equals(selected);
            Button item=addButton(tickets,"工单 #"+number+(current?" · 当前":""),()->{selected=receipt;read();});
            item.setEnabled(client.enabled()&&!busy);
            item.setOnLongClickListener(v->{showReceipt(receipt,"回执码可在另一台手机查收这条工单。");return true;});
        }
    }

    private List<String> receipts(){
        var prefs=activity.getSharedPreferences("momo.feedback",Context.MODE_PRIVATE);
        var result=new ArrayList<String>();
        try{
            var list=new JSONArray(prefs.getString("receipts","[]"));
            for(int i=0;i<Math.min(list.length(),10);i++){
                String receipt=list.optString(i);
                if(SupportClient.issueNumber(receipt)!=null)result.add(receipt);
            }
        }catch(JSONException ignored){}
        return result;
    }

    private boolean remember(String receipt){
        synchronized(SupportPanel.class){
            List<String> saved=receipts();saved.remove(receipt);saved.add(0,receipt);
            return activity.getSharedPreferences("momo.feedback",Context.MODE_PRIVATE).edit()
                    .putString("receipts",new JSONArray(saved.subList(0,Math.min(saved.size(),10))).toString()).commit();
        }
    }

    private Button addButton(LinearLayout target,String label,Runnable action){
        var button=new Button(activity);button.setText(label);button.setAllCaps(false);
        button.setTextColor(activity.getColor(R.color.text_primary));button.setBackgroundResource(R.drawable.bg_glass_chip);
        button.setMinimumHeight(dp(48));
        var layout=new LayoutParams(-1,-2);layout.topMargin=dp(8);target.addView(button,layout);
        button.setOnClickListener(view->action.run());
        return button;
    }

    private TextView description(String message){
        var description=new TextView(activity);description.setText(message);description.setTextSize(14);
        description.setTextColor(activity.getColor(R.color.text_secondary));description.setPadding(0,dp(10),0,dp(6));
        return description;
    }

    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
}
