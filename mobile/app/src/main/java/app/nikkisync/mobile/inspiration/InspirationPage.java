package app.nikkisync.mobile.inspiration;

import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;
import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.PickVisualMediaRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import app.nikkisync.mobile.R;
import app.nikkisync.mobile.ui.GalleryUxStyle;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.LinkedHashSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Offline-first Outfit Inspiration notebook; no PC connection or game access is required. */
public final class InspirationPage implements AutoCloseable {
    private final android.app.Activity activity;
    private final Runnable requestSync;
    private boolean closed;
    private app.nikkisync.mobile.ui.chrome.ChromeNavigationHost navigation;
    private app.nikkisync.mobile.ui.chrome.ChromeHost chrome;
    private static final String[] TYPE_LABELS = {"待识别", "搭配码", "染色码"};
    private static final String[] TYPES = {"unknown", "outfit", "dye"};
    private static final String[] STATUS_LABELS = {"自搭", "想尝试", "试过了", "已复刻", "已归档"};
    private static final String[] STATUSES = {"self", "want", "tried", "reproduced", "archived"};
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ArrayList<Uri> pendingImages = new ArrayList<>();
    private final LinkedHashSet<String> removedImageIds = new LinkedHashSet<>();
    private final ActivityResultLauncher<PickVisualMediaRequest> referencePicker;
    private InspirationEditorForm editorForm;
    private InspirationStore.Entry editingEntry;
    private InspirationStore store;
    private InspirationImageStore imageStore;
    private LinearLayout results;
    private EditText search, categoryFilter;
    private TextView syncNote;
    private Spinner statusFilter;
    private app.nikkisync.mobile.ui.chrome.ChromeSheetLayout activeEditor;

    public InspirationPage(android.app.Activity activity) {this(activity,()->Toast.makeText(activity,"请回到相册主页并连接电脑后同步",Toast.LENGTH_LONG).show());}
    private InspirationPage(android.app.Activity activity,Runnable requestSync) {
        this.activity=activity;
        this.requestSync=requestSync;
        navigation=((app.nikkisync.mobile.ui.chrome.ChromePage.Owner)activity).navigationHost();
        referencePicker=((ComponentActivity)activity).getActivityResultRegistry().register(
                "inspiration-reference-"+java.util.UUID.randomUUID(),new ActivityResultContracts.PickMultipleVisualMedia(5),this::receiveReferenceImages);
        store=new InspirationStore(activity);imageStore=new InspirationImageStore(activity);
        buildScreen();refresh();
    }
    public static InspirationPage show(android.app.Activity activity) {return show(activity,()->{});}
    public static InspirationPage show(android.app.Activity activity,Runnable afterClose) {
        return show(activity,afterClose,()->Toast.makeText(activity,"请回到相册主页并连接电脑后同步",Toast.LENGTH_LONG).show());
    }
    public static InspirationPage show(android.app.Activity activity,Runnable afterClose,Runnable requestSync) {
        InspirationPage page=new InspirationPage(activity,requestSync);
        page.navigation.push(page.chrome,()->{page.close();afterClose.run();});return page;
    }
    public void setSyncStatus(String message){if(!closed&&syncNote!=null)syncNote.setText(message);}
    public void refreshAfterSync(){if(!closed)refresh();}
    public void receiveIntent(Intent intent) {
        InspirationShareImport.Incoming incoming=InspirationShareImport.from(intent);
        if(!incoming.sourceText().isBlank()||!incoming.imageUris().isEmpty())
            main.post(()->{if(!isFinishing()&&!isDestroyed())showEditor(null,incoming);});
    }
    @Override public void close() {
        if(closed)return;closed=true;
        referencePicker.unregister();chrome.backdrop().close();io.execute(store::close);io.shutdown();
    }
    private boolean isFinishing(){return closed||activity.isFinishing();}
    private boolean isDestroyed(){return activity.isDestroyed();}

    private void buildScreen() {
        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(android.graphics.Color.TRANSPARENT);
        chrome=new app.nikkisync.mobile.ui.chrome.ChromeHost(activity);
        chrome.contentLayer().setBackgroundResource(R.drawable.bg_gallery_ambient);
        LinearLayout root = column(); root.setPadding(0, dp(8), 0, dp(24));
        scroll.addView(root);
        chrome.contentLayer().addView(scroll,new android.widget.FrameLayout.LayoutParams(-1,-1));
        LinearLayout header=new LinearLayout(activity);header.setGravity(Gravity.CENTER_VERTICAL);header.setPadding(0,dp(12),0,dp(12));
        TextView title=text("穿搭灵感库",26,true);header.addView(title,new LinearLayout.LayoutParams(0,-2,1));
        Button back=button("返回");back.setOnClickListener(v->navigation.dismiss(chrome));header.addView(back);
        chrome.installChrome(header,new android.widget.FrameLayout(activity),scroll);

        TextView subtitle = text("收藏搭配码和染色码，按分类与状态慢慢整理。", 13, false);
        subtitle.setTextColor(activity.getColor(R.color.text_secondary)); subtitle.setPadding(0, dp(5), 0, dp(15)); root.addView(subtitle);
        syncNote=text("灵感保存在手机本地，连接支持同步的电脑后可同步。",12,false);syncNote.setTextColor(activity.getColor(R.color.text_secondary));root.addView(syncNote);
        Button sync=button("立即同步");sync.setOnClickListener(v->requestSync.run());root.addView(sync,rowParams());
        Button add = button("＋ 记录新的灵感"); add.setOnClickListener(v -> showEditor(null, null)); root.addView(add, rowParams());

        search = field("搜索分享码或分类", "");
        root.addView(search, rowParams());
        categoryFilter = field("筛选自定义分类（可留空）", "");
        root.addView(categoryFilter, rowParams());
        statusFilter = spinner(new String[] {"全部状态", "自搭", "想尝试", "试过了", "已复刻", "已归档"}, 0);
        root.addView(statusFilter, rowParams());
        Button filter = button("搜索 / 刷新"); filter.setOnClickListener(v -> refresh()); root.addView(filter, rowParams());
        results = column(); root.addView(results);
    }

    private void refresh() {
        if (results == null) return;
        String query = search.getText().toString(), category = categoryFilter.getText().toString().trim();
        int selected = statusFilter.getSelectedItemPosition();
        String status = selected <= 0 ? null : STATUSES[selected - 1];
        io.execute(() -> {
            try {
                List<InspirationStore.Entry> entries = store.search(query, status, category);
                main.post(() -> { if (!isFinishing() && !isDestroyed()) render(entries); });
            } catch (Exception error) { showError(error); }
        });
    }

    private void render(List<InspirationStore.Entry> entries) {
        results.removeAllViews();
        if (entries.isEmpty()) {
            TextView empty = text("还没有符合条件的灵感。\n看到喜欢的搭配时，可以粘贴分享码，或从其他 App 分享到这里。", 14, false);
            empty.setTextColor(activity.getColor(R.color.text_secondary)); empty.setPadding(dp(8), dp(30), dp(8), dp(20));
            results.addView(empty); return;
        }
        for (InspirationStore.Entry entry : entries) {
            LinearLayout card = column(); card.setPadding(dp(14), dp(12), dp(14), dp(12));
            card.setBackgroundResource(R.drawable.bg_glass_card);
            if(!entry.images().isEmpty()) {
                ImageView cover=new ImageView(activity) {
                    @Override protected void onMeasure(int widthSpec,int heightSpec) {
                        int width=android.view.View.MeasureSpec.getSize(widthSpec);
                        super.onMeasure(widthSpec,android.view.View.MeasureSpec.makeMeasureSpec(width,android.view.View.MeasureSpec.EXACTLY));
                    }
                };cover.setScaleType(ImageView.ScaleType.FIT_CENTER);
                cover.setBackgroundResource(R.drawable.bg_gallery_photo);cover.setClipToOutline(true);
                LinearLayout.LayoutParams coverLp=new LinearLayout.LayoutParams(-1,-2);coverLp.bottomMargin=dp(8);card.addView(cover,coverLp);
                cover.setContentDescription("查看穿搭参考图");cover.setOnClickListener(v->showImages(entry));
                loadPrivateThumbnail(cover,entry.images().get(0).localName(),480);
            }
            card.addView(text(entry.title().isBlank()?typeLabel(entry.code().type()):entry.title(), 17, true));
            String code = entry.code().rawCode().isBlank() ? "尚未填写分享码" : entry.code().rawCode();
            TextView info = text(statusLabel(entry.status()) + " · " + typeLabel(entry.code().type())
                    + "\n" + code + (entry.categories().isEmpty() ? "" : "\n分类：" + String.join("、", entry.categories()))
                    + (entry.tags().isEmpty() ? "" : "\n标签：" + String.join("、", entry.tags()))
                    + (entry.images().isEmpty() ? "" : "\n参考图：" + entry.images().size() + " 张"), 13, false);
            info.setTextColor(activity.getColor(R.color.text_secondary)); info.setPadding(0, dp(6), 0, dp(8)); card.addView(info);
            LinearLayout actions = new LinearLayout(activity);
            Button copy = button("复制码"); copy.setEnabled(!entry.code().rawCode().isBlank());
            copy.setOnClickListener(v -> copyCode(entry.code().rawCode())); actions.addView(copy, weighted());
            Button edit = button("编辑"); edit.setOnClickListener(v -> showEditor(entry, null));
            actions.addView(edit, weighted()); card.addView(actions);
            Button delete=button("删除");delete.setOnClickListener(v->deleteEntry(entry));actions.addView(delete,weighted());
            LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(-1, -2);
            cardParams.topMargin = dp(10); results.addView(card, cardParams);
        }
    }

    private void showEditor(InspirationStore.Entry existing, InspirationShareImport.Incoming incoming) {
        if(activeEditor!=null)return;
        pendingImages.clear();
        removedImageIds.clear();editingEntry=existing;
        if(incoming!=null)pendingImages.addAll(incoming.imageUris());
        String initialCode=existing!=null?existing.code().rawCode():incoming==null||incoming.codeSuggestion().isBlank()?"":incoming.sourceText();
        var form=new InspirationEditorForm(activity,initialCode,existing==null?"outfit":existing.code().type(),
                existing==null?"want":existing.status(),existing==null?List.of():existing.categories());
        editorForm=form;
        if(existing==null&&incoming!=null&&!InspirationCodeExtractor.candidates(incoming.sourceText()).isEmpty())form.applyPastedText(incoming.sourceText());
        ScrollView scroll=new ScrollView(activity);scroll.setFillViewport(true);scroll.addView(form);
        TextView heading=text(existing==null?"记录穿搭灵感":"编辑穿搭灵感",20,true);
        heading.setPadding(0,0,0,dp(12));
        LinearLayout footer=new LinearLayout(activity);footer.setPadding(0,dp(10),0,0);
        Button cancel=button("取消"),save=button("保存");footer.addView(cancel,weighted());footer.addView(save,weighted());
        var editor=new app.nikkisync.mobile.ui.chrome.ChromeSheetLayout(activity,heading,scroll,footer);
        activeEditor=editor;cancel.setOnClickListener(v->navigation.dismiss(editor));
        form.onAddCategory(()->showNewCategory(form));
        form.onAddReference(()->{
            if(referenceCount()>=5){toast("一条灵感最多添加 5 张参考图");return;}
            try{referencePicker.launch(new PickVisualMediaRequest.Builder().setMediaType(ActivityResultContracts.PickVisualMedia.ImageOnly.INSTANCE).build());}
            catch(Exception ignored){toast("无法打开系统选图，请检查手机相册");}
        });
        renderEditorReferences();
        save.setOnClickListener(v->{
            String codeText=form.rawCode(),typeValue=form.codeType(),statusValue=form.status();
            String pastedSource=form.pastedSource();
            List<String> categoryList=form.categories();
            ArrayList<Uri> images=new ArrayList<>(pendingImages);
            LinkedHashSet<String> removals=new LinkedHashSet<>(removedImageIds);
            if(existing==null&&codeText.isBlank()&&images.isEmpty()&&(incoming==null||incoming.sourceText().isBlank())) {
                toast("请先填入染色码或搭配码");return;
            }
            save.setEnabled(false);cancel.setEnabled(false);
            io.execute(()->{
                List<InspirationImageStore.Saved> staged=new ArrayList<>();
                try {
                    try {for(Uri uri:images)staged.add(imageStore.copyUri(activity.getContentResolver(),uri));}
                    catch(Exception error){throw new IOException("参考图无法读取，请检查图片格式和大小（每张不超过 15 MB）",error);}
                    long now=System.currentTimeMillis();
                    // Hidden legacy fields and share text are user-owned, even when not shown in the form.
                    InspirationStore.Draft draft=existing==null
                            ?new InspirationStore.Draft("",codeText,typeValue,incoming==null?pastedSource:incoming.sourceText(),
                                    incoming==null?null:incoming.sourceUrl(),"",List.of(),categoryList,statusValue)
                            :new InspirationStore.Draft(existing.title(),codeText,typeValue,existing.code().sourceText(),
                                    existing.code().sourceUrl(),existing.notes(),existing.tags(),categoryList,statusValue);
                    store.saveWithImages(existing,draft,staged,List.copyOf(removals),now);
                    if(existing!=null)for(InspirationStore.Image old:existing.images())if(removals.contains(old.id())) {
                        try{imageStore.deleteLocal(old.localName());}catch(IOException ignored){}
                    }
                    main.post(()->{
                        if(isFinishing()||isDestroyed())return;
                        navigation.dismiss(editor);refresh();
                        toast("灵感已保存在手机");
                        requestSync.run();
                    });
                }catch(Exception error) {
                    for(InspirationImageStore.Saved image:staged)try{imageStore.deleteLocal(image.localName());}catch(IOException ignored){}
                    main.post(()->{if(activeEditor==editor){save.setEnabled(true);cancel.setEnabled(true);}showError(error);});
                }
            });
        });
        navigation.showSheet(editor,()->{if(activeEditor==editor){activeEditor=null;editorForm=null;editingEntry=null;pendingImages.clear();removedImageIds.clear();}});
        io.execute(()->{
            List<String> categories=store.categoryNames();
            main.post(()->{if(activeEditor==editor&&!isFinishing()&&!isDestroyed())form.availableCategories(categories);});
        });
    }

    private int referenceCount(){return pendingImages.size()+(editingEntry==null?0:(int)editingEntry.images().stream().filter(image->!removedImageIds.contains(image.id())).count());}
    void receiveReferenceImages(List<Uri> images){
        if(activeEditor==null||editorForm==null||images==null)return;
        boolean limited=false;
        for(Uri uri:images){
            if(uri==null||!"content".equals(uri.getScheme())||pendingImages.contains(uri))continue;
            if(referenceCount()>=5){limited=true;break;}
            pendingImages.add(uri);
        }
        renderEditorReferences();if(limited)toast("一条灵感最多添加 5 张参考图");
    }
    private void renderEditorReferences(){
        InspirationEditorForm form=editorForm;if(form==null)return;
        form.clearReferences(referenceCount());
        if(editingEntry!=null)for(InspirationStore.Image image:editingEntry.images())if(!removedImageIds.contains(image.id())){
            ImageView view=form.addReferenceThumbnail(image.id(),()->{removedImageIds.add(image.id());renderEditorReferences();});
            loadPrivateThumbnail(view,image.localName(),240);
        }
        for(Uri uri:List.copyOf(pendingImages)){
            ImageView view=form.addReferenceThumbnail(uri.toString(),()->{pendingImages.remove(uri);renderEditorReferences();});
            io.execute(()->{try {
                Bitmap bitmap=activity.getContentResolver().loadThumbnail(uri,new android.util.Size(240,240),null);
                main.post(()->{if(!closed&&uri.toString().equals(view.getTag()))view.setImageBitmap(bitmap);});
            }catch(Exception ignored) {}});
        }
    }
    private void loadPrivateThumbnail(ImageView view,String localName,int max){
        io.execute(()->{try{
            String path=imageStore.resolve(localName).getAbsolutePath();
            BitmapFactory.Options bounds=new BitmapFactory.Options();bounds.inJustDecodeBounds=true;BitmapFactory.decodeFile(path,bounds);
            BitmapFactory.Options options=new BitmapFactory.Options();options.inSampleSize=Math.max(1,Math.max(bounds.outWidth,bounds.outHeight)/max);
            Bitmap bitmap=BitmapFactory.decodeFile(path,options);
            main.post(()->{if(!closed&&bitmap!=null)view.setImageBitmap(bitmap);});
        }catch(Exception ignored){}});
    }

    private void showNewCategory(InspirationEditorForm form) {
        EditText name=field("例如：日常、拍照","");
        name.setTextColor(activity.getColor(R.color.text_primary));name.setHintTextColor(activity.getColor(R.color.text_secondary));
        name.setPadding(dp(14),dp(12),dp(14),dp(12));name.setMinimumHeight(dp(52));
        var material=new android.graphics.drawable.GradientDrawable();material.setColor(0xe6ffffff);material.setCornerRadius(dp(14));
        material.setStroke(dp(1),0xffb79ca8);name.setBackground(material);
        name.setSingleLine(true);name.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(60)});
        LinearLayout footer=new LinearLayout(activity);Button cancel=button("取消"),add=button("添加");
        footer.addView(cancel,weighted());footer.addView(add,weighted());
        var sheet=new app.nikkisync.mobile.ui.chrome.ChromeSheetLayout(activity,text("新增分类",20,true),name,footer).wrapContentForm();
        cancel.setOnClickListener(v->navigation.dismiss(sheet));
        add.setOnClickListener(v->{
            String value=name.getText().toString().trim();
            if(value.isEmpty()){name.setError("请填写分类名称");return;}
            if(form.categories().size()>=30&&!form.categories().contains(value)){name.setError("每条灵感最多选择 30 个分类");return;}
            form.addCategory(value);navigation.dismiss(sheet);
        });
        navigation.showSheet(sheet);
    }

    private void deleteEntry(InspirationStore.Entry entry) {
        new AlertDialog.Builder(activity).setTitle("删除这条灵感？")
                .setMessage("只移除本地记录，不会删除系统相册或来源图片。")
                .setNegativeButton("取消",null).setPositiveButton("删除",(d,w)->io.execute(()->{
                    store.delete(entry.id(),System.currentTimeMillis());
                    for(InspirationStore.Image image:entry.images())try{imageStore.deleteLocal(image.localName());}catch(IOException ignored){}
                    main.post(()->{refresh();requestSync.run();});
                })).show();
    }

    private void showImages(InspirationStore.Entry entry) {
        ScrollView scroll = new ScrollView(activity); LinearLayout holder = column();
        holder.setPadding(dp(12), dp(12), dp(12), dp(12)); scroll.addView(holder);
        AlertDialog dialog = new AlertDialog.Builder(activity).setTitle(entry.title() + " · 参考图")
                .setView(scroll).setPositiveButton("完成", null).create(); dialog.show();
        io.execute(() -> {
            for (InspirationStore.Image image : entry.images()) {
                try {
                    String path = imageStore.resolve(image.localName()).getAbsolutePath();
                    BitmapFactory.Options bounds = new BitmapFactory.Options(); bounds.inJustDecodeBounds = true;
                    BitmapFactory.decodeFile(path, bounds);
                    BitmapFactory.Options options = new BitmapFactory.Options();
                    options.inSampleSize = Math.max(1, Math.max(bounds.outWidth, bounds.outHeight) / 900);
                    Bitmap bitmap = BitmapFactory.decodeFile(path, options);
                    main.post(() -> {
                        if (!dialog.isShowing() || bitmap == null) return;
                        ImageView view = new ImageView(activity); view.setImageBitmap(bitmap);
                        view.setAdjustViewBounds(true); view.setScaleType(ImageView.ScaleType.FIT_CENTER);
                        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.bottomMargin = dp(10);
                        holder.addView(view, params);
                    });
                } catch (Exception ignored) { /* Missing private copy remains a visible record, never an invented image. */ }
            }
        });
    }

    private void copyCode(String value) {
        ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
        if (clipboard == null || value.isBlank()) return;
        clipboard.setPrimaryClip(ClipData.newPlainText("暖暖分享码", value)); toast("分享码已复制");
    }
    private void showError(Exception error) {
        main.post(() -> { if (!isFinishing() && !isDestroyed()) toast("保存失败：" + error.getMessage()); });
    }
    private void toast(String message) { Toast.makeText(activity, message, Toast.LENGTH_LONG).show(); }
    private LinearLayout column() { LinearLayout view = new LinearLayout(activity); view.setOrientation(LinearLayout.VERTICAL); return view; }
    private TextView text(String value, int sp, boolean bold) {
        TextView view = new TextView(activity); view.setText(value); view.setTextSize(sp); view.setTextColor(activity.getColor(R.color.text_primary));
        if (bold) view.setTypeface(Typeface.DEFAULT_BOLD); return view;
    }
    private EditText field(String hint, String value) {
        EditText view = new EditText(activity); view.setHint(hint); view.setText(value); view.setTextSize(14);
        view.setSingleLine(false); view.setMaxLines(5); return view;
    }
    private Button button(String label) {
        Button view = new Button(activity); view.setText(label); view.setAllCaps(false); view.setTextSize(13);
        view.setTextColor(activity.getColor(R.color.text_primary));
        view.setBackground(GalleryUxStyle.glassButton(activity)); return view;
    }
    private Spinner spinner(String[] labels, int selected) {
        Spinner spinner = new Spinner(activity); ArrayAdapter<String> adapter = new ArrayAdapter<>(activity,
                android.R.layout.simple_spinner_dropdown_item, labels); spinner.setAdapter(adapter); spinner.setSelection(selected); return spinner;
    }
    private LinearLayout.LayoutParams rowParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.bottomMargin = dp(9); return params;
    }
    private LinearLayout.LayoutParams weighted() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(42), 1); params.rightMargin = dp(5); return params;
    }
    private int dp(int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }
    private static int indexOf(String[] values, String value) {
        for (int i = 0; i < values.length; i++) if (values[i].equals(value)) return i;
        return 0;
    }
    private static String statusLabel(String value) { return STATUS_LABELS[indexOf(STATUSES, value)]; }
    private static String typeLabel(String value) { return TYPE_LABELS[indexOf(TYPES, value)]; }
}
