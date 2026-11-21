package app.nikkisync.mobile.ui;

import android.app.Activity;
import android.os.Handler;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.*;
import androidx.recyclerview.widget.*;
import app.nikkisync.mobile.R;
import app.nikkisync.mobile.media.ImageLoader;
import app.nikkisync.mobile.model.Models.*;
import app.nikkisync.mobile.net.NikkiSyncClient;
import app.nikkisync.mobile.storage.OrganizerStore;
import app.nikkisync.mobile.ui.chrome.ChromePage;
import java.util.*;
import java.util.concurrent.Executor;

/** This page cancels intentions only; it never deletes files on either device. */
public final class OrganizerPage {
    private final Activity activity;private final OrganizerStore store;private final String scope;private final Executor worker;private final Handler main;private final Runnable changed;
    private final GalleryAdapter adapter;private final TextView note;private final Button cancel;private List<OrganizerStore.Entry> entries=List.of();private boolean closed;private boolean loading,refreshAgain;private final ChromePage page;
    private String syncFailure;private boolean syncStatusChanged;
    public void setSyncFailure(String failure){if(Objects.equals(syncFailure,failure))return;syncFailure=failure;syncStatusChanged=true;refresh();}
    public boolean isOpen(){return !closed&&page.isShowing();}
    public OrganizerPage(Activity activity,OrganizerStore store,PairedServer server,NikkiSyncClient client,ImageLoader images,Executor worker,Handler main,Runnable changed){
        this.activity=activity;this.store=store;this.scope=OrganizerStore.scope(server);this.worker=worker;this.main=main;this.changed=changed;
        page=new ChromePage(activity);page.useAmbientBackground();LinearLayout body=new LinearLayout(activity);body.setOrientation(1);int pad=(int)(16*activity.getResources().getDisplayMetrics().density);body.setPadding(pad,pad,pad,pad);
        LinearLayout header=new LinearLayout(activity);header.setOrientation(LinearLayout.VERTICAL);header.setPadding(0,dp(8),0,dp(8));
        LinearLayout titleRow=new LinearLayout(activity);titleRow.setGravity(Gravity.CENTER_VERTICAL);
        TextView title=new TextView(activity);title.setText("最近删除");title.setTextSize(22);title.setSingleLine(true);title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);title.setTextColor(activity.getColor(R.color.text_primary));title.setIncludeFontPadding(false);
        titleRow.addView(title,new LinearLayout.LayoutParams(0,-2,1));Button close=glassButton("关闭");close.setOnClickListener(v->{closed=true;page.dismiss();});titleRow.addView(close,new LinearLayout.LayoutParams(dp(72),dp(44)));header.addView(titleRow,new LinearLayout.LayoutParams(-1,dp(52)));
        note=new TextView(activity);note.setText("正在读取本机整理记录…");note.setTextSize(12);note.setMaxLines(3);note.setTextColor(activity.getColor(R.color.text_secondary));note.setPadding(0,dp(6),0,dp(10));header.addView(note,new LinearLayout.LayoutParams(-1,-2));
        cancel=glassButton("取消所选删除");cancel.setEnabled(false);header.addView(cancel,new LinearLayout.LayoutParams(-1,dp(44)));body.addView(header);
        RecyclerView grid=new RecyclerView(activity);GridLayoutManager layout=new GridLayoutManager(activity,3);grid.setLayoutManager(layout);
        adapter=new GalleryAdapter(activity,images,()->client,new GalleryAdapter.Listener(){
            public void onPhotoClick(AssetSummary asset){toggle(asset);}
            public boolean onPhotoLongClick(AssetSummary asset){toggle(asset);return true;}
        });adapter.setOfflineServer(server);layout.setSpanSizeLookup(new GridLayoutManager.SpanSizeLookup(){public int getSpanSize(int position){return adapter.isHeader(position)?3:1;}});grid.setAdapter(adapter);grid.setItemAnimator(null);body.addView(grid,new LinearLayout.LayoutParams(-1,0,1));
        cancel.setOnClickListener(v->{List<String> ids=new ArrayList<>();for(var asset:adapter.selectedItems())for(var entry:entries)if(entry.asset().assetId().equals(asset.assetId())&&entry.pending())ids.add(entry.id());
            if(ids.isEmpty()){Toast.makeText(activity,"请先选择待删除照片",Toast.LENGTH_SHORT).show();return;}
            cancel.setEnabled(false);worker.execute(()->{store.cancel(scope,ids);main.post(()->{adapter.clearSelection();refresh();changed.run();});});});
        page.setContentView(body);page.addGlassControl(close);page.addGlassControl(cancel);page.show();refresh();
    }
    private void toggle(AssetSummary asset){var entry=entries.stream().filter(e->e.asset().assetId().equals(asset.assetId())).findFirst().orElse(null);if(entry==null)return;
        if(entry.pending()){adapter.toggle(asset);cancel.setEnabled(adapter.selectedCount()>0);note.setText("已选 "+adapter.selectedCount()+" 张 · 取消可撤回待删除记录\n已处理照片请从电脑回收站恢复。");}
        else Toast.makeText(activity,entry.message(),Toast.LENGTH_LONG).show();}
    private int dp(int value){return Math.round(value*activity.getResources().getDisplayMetrics().density);}
    private Button glassButton(String title){Button button=new Button(activity,null,0);button.setText(title);button.setAllCaps(false);button.setTextSize(13);button.setGravity(Gravity.CENTER);button.setIncludeFontPadding(false);button.setPadding(dp(12),0,dp(12),0);button.setMinWidth(0);button.setMinimumWidth(0);button.setMinHeight(0);button.setMinimumHeight(0);button.setStateListAnimator(null);button.setTextColor(activity.getColor(R.color.text_primary));button.setBackground(GalleryUxStyle.glassChip(activity));return button;}
    public void refresh(){if(closed)return;if(loading){refreshAgain=true;return;}loading=true;worker.execute(()->{var next=store.entries(scope);main.post(()->{loading=false;if(closed||activity.isFinishing())return;boolean unchanged=entries.equals(next);entries=next;
        Map<String,AssetSummary> photos=new LinkedHashMap<>();for(var entry:next)if(!entry.state().equals("cancelled")&&!entry.state().equals("rejected"))photos.putIfAbsent(entry.asset().assetId(),entry.asset());
        adapter.setItems(new ArrayList<>(photos.values()));long pending=next.stream().filter(OrganizerStore.Entry::pending).count();
        cancel.setEnabled(adapter.selectedCount()>0);
        long processing=next.stream().filter(entry->Set.of("preparing","queued","checking","executing").contains(entry.state())).count();
        boolean verified=processing>0&&next.stream().filter(entry->Set.of("preparing","queued","checking","executing").contains(entry.state())).allMatch(OrganizerStore.Entry::batchVerified);
        if(syncStatusChanged||!unchanged||!adapter.hasSelection()){
            note.setText(syncFailure!=null?syncFailure+"\n记录仍保留；恢复连接后核对处理结果。":processing>0?"正在核对或移入回收站 "+processing+" 张 · 结果自动更新\n"+(verified?"本批已核对，可关闭 App；完成后可从电脑回收站恢复。":"请保持 App 打开，尚未开始的照片仍可取消。 "):"待处理 "+pending+" 张 · 点选照片可取消待删除\n电脑确认后移入回收站，可从回收站恢复。");
            syncStatusChanged=false;
        }
        if(refreshAgain){refreshAgain=false;refresh();}
    });});}
}
