package app.nikkisync.mobile.ui;

import android.content.Context;
import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.content.res.ColorStateList;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import app.nikkisync.mobile.R;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.storage.SavedViewState;
import app.nikkisync.mobile.ui.chrome.ChromePage;
import app.nikkisync.mobile.ui.chrome.ChromeNavigationHost;
import app.nikkisync.mobile.ui.chrome.ChromeSheetLayout;
import java.util.ArrayList;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.TreeSet;
import java.util.function.Function;

/** One bottom drawer for all filters; expanded source choices remain drafts until Apply. */
public final class SavedFilterSheet extends LinearLayout {
    public interface Listener {
        void onApply(int filter, int sort);
        void onRecoverHistoricalSavedPhotos();
        void onCancel();
    }

    private final Button[] filterButtons = new Button[4];
    private final Button[] sortButtons = new Button[2];
    private int filter;
    private int sort;
    private boolean actionSubmitted;
    private Listener listener;
    private final LinearLayout form;
    private final Button recover;
    private ChromeNavigationHost navigation;
    private final android.widget.ScrollView scrolling;
    private View openChoices;
    private Runnable refreshOpenChoice;
    private final List<Runnable> resetSources = new ArrayList<>();
    private String uid,folder,version;
    private enum Scope { UID, FOLDER, VERSION }
    public String selectedUid(){return uid;}
    public String selectedFolder(){return folder;}
    public String selectedVersion(){return version;}
    public SavedFilterSheet withSources(List<AssetSummary> assets,String currentUid,String currentFolder,boolean gallery){
        uid=currentUid;folder=currentFolder;
        var uids=new TreeSet<String>();var folders=new TreeSet<String>();
        for(var asset:assets){uids.add(asset.uid()==null?"":asset.uid());folders.add(asset.sourceFolder()==null?"":asset.sourceFolder());}
        if(uid!=null)uids.add(uid);if(folder!=null)folders.add(folder);
        int position=form.getChildCount()-1;
        form.addView(scopeChoice("所属 UID","source-uid",Scope.UID,new ArrayList<>(uids),
                value->value==null?"全部账号":value.isEmpty()?"未识别 UID":"UID "+value),position++);
        form.addView(scopeChoice("来源文件夹","source-folder",Scope.FOLDER,new ArrayList<>(folders),SourceFolderLabels::title),position);
        if(gallery){sortButtons[0].setText("最新拍摄");sortButtons[1].setText("最早拍摄");filterButtons[3].setVisibility(VISIBLE);recover.setVisibility(GONE);}
        return this;
    }
    public SavedFilterSheet withVersions(List<AssetSummary> assets,String currentVersion) {
        version=currentVersion;
        Map<String,Integer> counts=new LinkedHashMap<>();
        Map<String,String> labels=new LinkedHashMap<>();
        var groups=new ArrayList<>(GalleryVersionGroups.group(assets));
        groups.sort((left,right)->GalleryVersionGroups.compareSemanticVersions(right.version(),left.version()));
        for(var group:groups){
            String key=GalleryVersionGroups.filterKey(group.version());
            counts.put(key,group.items().size());
            labels.put(key,group.versionLabel());
        }
        if(version!=null)labels.putIfAbsent(version,GalleryVersionGroups.filterKey(null).equals(version)?"版本未知":version+" 版本");
        form.addView(scopeChoice("游戏版本","source-version",Scope.VERSION,new ArrayList<>(labels.keySet()),
                value->value==null?"全部版本":labels.get(value)+" · "+counts.getOrDefault(value,0)+" 张"),form.indexOfChild(recover));
        return this;
    }

    private String selected(Scope scope) {
        return switch(scope){case UID->uid;case FOLDER->folder;case VERSION->version;};
    }

    private void select(Scope scope,String value) {
        switch(scope){case UID->uid=value;case FOLDER->folder=value;case VERSION->version=value;}
    }

    private View scopeChoice(String title,String tag,Scope scope,List<String> options,Function<String,String> name){
        LinearLayout box=new LinearLayout(getContext());box.setOrientation(VERTICAL);box.addView(section(title,12));
        List<String> values=new ArrayList<>();values.add(null);values.addAll(options);
        var contexts=scope==Scope.FOLDER?SourceFolderLabels.contexts(values):Map.<String,String>of();
        Button choices=button("");choices.setTag(tag);
        choices.setGravity(Gravity.START|Gravity.CENTER_VERTICAL);choices.setPadding(dp(14),dp(10),dp(14),dp(10));
        box.addView(choices,new LayoutParams(-1,-2));
        android.widget.ListView list=new android.widget.ListView(getContext());
        Runnable refresh=()->{
            String value=selected(scope),titleText=name.apply(value);
            if(scope==Scope.FOLDER&&value!=null&&!value.isEmpty())titleText+="\n"+contexts.getOrDefault(value,value);
            boolean expanded=list.getVisibility()==VISIBLE;
            choices.setText(titleText+(expanded?"  ⌃":"  ⌄"));
            choices.setContentDescription(title+"，"+name.apply(value)+(expanded?"，已展开":"，已收起"));
        };
        sourceOptions(list,values,scope,contexts,name,this::closeChoices);
        list.setVisibility(GONE);refresh.run();
        LayoutParams optionsLp=new LayoutParams(-1,dp(Math.min(224,values.size()*(scope==Scope.FOLDER?88:56))));
        optionsLp.topMargin=dp(8);box.addView(list,optionsLp);
        choices.setOnClickListener(v->{
            boolean expand=list.getVisibility()!=VISIBLE;
            closeChoices();
            if(!expand)return;
            list.setVisibility(VISIBLE);
            openChoices=list;refreshOpenChoice=refresh;refresh.run();
            scrolling.getViewTreeObserver().addOnGlobalLayoutListener(new android.view.ViewTreeObserver.OnGlobalLayoutListener(){
                public void onGlobalLayout(){
                    scrolling.getViewTreeObserver().removeOnGlobalLayoutListener(this);
                    if(list.getVisibility()==VISIBLE)scrolling.scrollTo(0,box.getTop());
                }
            });
        });
        resetSources.add(()->{select(scope,null);refresh.run();((android.widget.BaseAdapter)list.getAdapter()).notifyDataSetChanged();});
        return box;
    }

    private void closeChoices(){
        if(openChoices==null)return;
        openChoices.setVisibility(GONE);
        refreshOpenChoice.run();
        openChoices=null;refreshOpenChoice=null;
    }

    private void sourceOptions(android.widget.ListView list,List<String> values,Scope scope,Map<String,String> contexts,Function<String,String> labels,Runnable close){
        list.setDivider(null);list.setSelector(android.R.color.transparent);list.setBackgroundColor(Color.TRANSPARENT);
        list.setOnTouchListener((view,event)->{if(event.getActionMasked()==android.view.MotionEvent.ACTION_DOWN)view.getParent().requestDisallowInterceptTouchEvent(list.canScrollVertically(1)||list.canScrollVertically(-1));if(event.getActionMasked()==android.view.MotionEvent.ACTION_UP||event.getActionMasked()==android.view.MotionEvent.ACTION_CANCEL)view.getParent().requestDisallowInterceptTouchEvent(false);return false;});
        list.setAdapter(new android.widget.BaseAdapter(){
            public int getCount(){return values.size();}public String getItem(int position){return values.get(position);}public long getItemId(int position){return position;}
            public View getView(int position,View convert,ViewGroup parent){
                String value=getItem(position);boolean selected=Objects.equals(value,selected(scope));
                LinearLayout option=new LinearLayout(getContext());option.setOrientation(HORIZONTAL);option.setGravity(Gravity.CENTER_VERTICAL);option.setPadding(dp(12),dp(12),dp(12),dp(12));option.setMinimumHeight(dp(48));option.setTag(value);
                android.graphics.drawable.GradientDrawable surface=new android.graphics.drawable.GradientDrawable();surface.setColor(selected?0xFFF4DCE5:0xEDFFF8FA);surface.setCornerRadius(dp(16));surface.setStroke(dp(1),0xB3FFFFFF);option.setBackground(surface);
                LinearLayout text=new LinearLayout(getContext());text.setOrientation(VERTICAL);option.addView(text,new LayoutParams(0,-2,1));
                String name=labels.apply(value);
                TextView heading=label(name,14,selected,getContext().getColor(R.color.text_primary));heading.setSingleLine(false);text.addView(heading,new LayoutParams(-1,-2));
                if(scope==Scope.FOLDER&&value!=null&&!value.isEmpty()){
                    TextView path=label(contexts.getOrDefault(value,value),12,false,getContext().getColor(R.color.text_secondary));path.setPadding(0,dp(6),0,0);path.setContentDescription("展开完整路径："+value);
                    path.setOnClickListener(v->path.setText(value));
                    path.setOnLongClickListener(v->{var clipboard=(android.content.ClipboardManager)getContext().getSystemService(Context.CLIPBOARD_SERVICE);clipboard.setPrimaryClip(android.content.ClipData.newPlainText("来源文件夹",value));android.widget.Toast.makeText(getContext(),"已复制完整路径",android.widget.Toast.LENGTH_SHORT).show();return true;});text.addView(path,new LayoutParams(-1,-2));
                }
                TextView check=label(selected?"✓":"",16,true,getContext().getColor(R.color.text_primary));check.setGravity(Gravity.CENTER);option.addView(check,new LayoutParams(dp(24),-2));
                option.setContentDescription(name+(selected?"，已选中":""));option.setFocusable(true);
                option.setOnClickListener(v->{select(scope,value);close.run();notifyDataSetChanged();});
                android.widget.FrameLayout spacing=new android.widget.FrameLayout(getContext());spacing.setPadding(0,0,0,dp(8));spacing.addView(option,new android.widget.FrameLayout.LayoutParams(-1,-2));return spacing;
            }
        });
    }

    public void show(Activity activity){navigation=((ChromePage.Owner)activity).navigationHost();navigation.showSheetWithOwnControls(this);}
    public void dismiss(){if(navigation!=null)navigation.dismiss(this);}
    @Override protected void onMeasure(int widthSpec,int heightSpec){int maximum=View.MeasureSpec.getSize(heightSpec);super.onMeasure(widthSpec,View.MeasureSpec.makeMeasureSpec(Math.round(maximum*.88f),View.MeasureSpec.AT_MOST));}

    public SavedFilterSheet(Context context, int currentFilter, int currentSort) {
        super(context);
        filter=currentFilter;
        sort=currentSort;
        setOrientation(VERTICAL);
        setPadding(0,0,0,0);
        GradientDrawable surface=new GradientDrawable();surface.setColor(0xF7FFF8FA);surface.setCornerRadius(dp(28));surface.setStroke(dp(1),0xE6FFFFFF);setBackground(surface);
        form=new LinearLayout(context);form.setOrientation(VERTICAL);
        scrolling=new android.widget.ScrollView(context);scrolling.setFillViewport(false);scrolling.addView(form,new android.widget.ScrollView.LayoutParams(-1,-2));scrolling.setFocusableInTouchMode(true);

        LinearLayout header=new LinearLayout(context);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView title=label("筛选与排序",22,true,context.getColor(R.color.text_primary));
        header.addView(title,new LayoutParams(0,ViewGroup.LayoutParams.WRAP_CONTENT,1));
        Button cancel=button("取消");
        cancel.setOnClickListener(v->{if(listener!=null)listener.onCancel();});
        header.addView(cancel);

        form.addView(section("照片类型",10));
        LinearLayout filters=row();
        filterButtons[0]=choice(filters,"全部",SavedViewState.FILTER_ALL,true);
        filterButtons[1]=choice(filters,"LIVE",SavedViewState.FILTER_MOTION,true);
        filterButtons[2]=choice(filters,"普通",SavedViewState.FILTER_STILL,true);
        filterButtons[3]=choice(filters,"视频",3,true);filterButtons[3].setVisibility(GONE);
        form.addView(filters);

        form.addView(section("排序方式",14));
        LinearLayout sorts=row();
        sortButtons[0]=choice(sorts,"最近保存",SavedViewState.SORT_SAVED,false);
        sortButtons[1]=choice(sorts,"拍摄时间",SavedViewState.SORT_CAPTURED,false);
        form.addView(sorts);

        Button apply=button("应用");
        apply.setTextColor(Color.WHITE);apply.setTypeface(Typeface.DEFAULT_BOLD);apply.setBackground(buttonSurface(0xFF8B3D58));
        apply.setOnClickListener(v->{
            if(listener==null||actionSubmitted)return;
            actionSubmitted=true;
            apply.setEnabled(false);
            listener.onApply(filter,sort);
        });
        Button reset=button("重置");
        reset.setOnClickListener(v->{filter=0;sort=0;closeChoices();resetSources.forEach(Runnable::run);updateChoices();});
        LinearLayout footer=row();footer.setPadding(0,dp(12),0,0);
        footer.addView(reset,new LayoutParams(0,-2,1));
        LayoutParams applyLp=new LayoutParams(0,-2,2);applyLp.leftMargin=dp(8);footer.addView(apply,applyLp);
        addView(new ChromeSheetLayout(context,header,scrolling,footer).wrapContentForm(480),new LayoutParams(-1,-2));

        recover=button("找回历史保存");
        recover.setTextColor(context.getColor(R.color.text_secondary));
        LayoutParams recoverLp=new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,-2);
        recoverLp.topMargin=dp(12);
        recover.setOnClickListener(v->{
            if(listener==null||actionSubmitted)return;
            actionSubmitted=true;
            recover.setEnabled(false);
            listener.onRecoverHistoricalSavedPhotos();
        });
        form.addView(recover,recoverLp);
        updateChoices();
    }

    public void setListener(Listener next) {listener=next;}

    public static String triggerLabel(int filter,int sort) {
        String type=switch(filter) {
            case SavedViewState.FILTER_MOTION -> "LIVE";
            case SavedViewState.FILTER_STILL -> "普通";
            default -> "全部";
        };
        return "筛选 · "+type+" · "+(sort==SavedViewState.SORT_CAPTURED?"拍摄时间":"最近保存");
    }

    private Button choice(LinearLayout row,String title,int value,boolean isFilter) {
        Button choice=button(title);
        choice.setPadding(dp(4),dp(8),dp(4),dp(8));
        choice.setOnClickListener(v->{if(isFilter)filter=value;else sort=value;updateChoices();});
        LayoutParams lp=new LayoutParams(0,-2,1);
        if(row.getChildCount()>0)lp.leftMargin=dp(6);
        row.addView(choice,lp);
        return choice;
    }

    private void updateChoices() {
        for(int i=0;i<filterButtons.length;i++)style(filterButtons[i],filter==i);
        for(int i=0;i<sortButtons.length;i++)style(sortButtons[i],sort==i);
    }

    private void style(Button button,boolean selected) {
        button.setTypeface(selected?Typeface.DEFAULT_BOLD:Typeface.DEFAULT);
        button.setTextColor(selected?0xFF78364E:getContext().getColor(R.color.text_primary));
        button.setBackground(buttonSurface(selected?0xFFF3DCE5:0xFFFFFCFD));
        button.setSelected(selected);
    }

    private LinearLayout row() {LinearLayout row=new LinearLayout(getContext());row.setGravity(Gravity.CENTER_VERTICAL);return row;}
    private TextView section(String value,int topMargin) {
        TextView heading=label(value,12,true,getContext().getColor(R.color.text_secondary));
        heading.setPadding(dp(2),dp(topMargin),dp(2),dp(7));
        return heading;
    }
    private TextView label(String value,int sp,boolean bold,int color) {
        TextView label=new TextView(getContext());label.setText(value);label.setTextSize(sp);label.setTextColor(color);
        if(bold)label.setTypeface(Typeface.DEFAULT_BOLD);
        return label;
    }
    private Button button(String value) {
        Button button=new Button(getContext(),null,0);button.setText(value);button.setTextSize(14);button.setAllCaps(false);button.setStateListAnimator(null);button.setMinWidth(0);button.setMinimumWidth(0);button.setPadding(dp(12),dp(8),dp(12),dp(8));
        button.setGravity(Gravity.CENTER);
        button.setTextColor(getContext().getColor(R.color.text_primary));button.setBackground(buttonSurface(0xFFFFFCFD));
        button.setMinHeight(dp(48));button.setMinimumHeight(dp(48));return button;
    }
    private RippleDrawable buttonSurface(int color){
        GradientDrawable fill=new GradientDrawable();fill.setColor(color);fill.setCornerRadius(dp(16));fill.setStroke(dp(1),0x30A66D7F);
        return new RippleDrawable(ColorStateList.valueOf(0x268B3D58),fill,null);
    }
    private int dp(int value) {return Math.round(value*getResources().getDisplayMetrics().density);}
}
