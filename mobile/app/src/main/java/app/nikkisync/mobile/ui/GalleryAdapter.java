package app.nikkisync.mobile.ui;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Button;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import app.nikkisync.mobile.R;
import app.nikkisync.mobile.media.ImageLoader;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.net.NikkiSyncClient;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Supplier;

public final class GalleryAdapter extends RecyclerView.Adapter<RecyclerView.ViewHolder> {
    public interface Listener {
        void onPhotoClick(AssetSummary asset);
        boolean onPhotoLongClick(AssetSummary asset);
        default void onSelectionChanged() {}
    }

    private static final int TYPE_HEADER = 0;
    private static final int TYPE_PHOTO = 1;
    private static final Object SELECTION = new Object();

    private final Context context;
    private final ImageLoader images;
    private final Supplier<NikkiSyncClient> client;
    private final Listener listener;
    private final List<Row> rows = new ArrayList<>();
    private final List<AssetSummary> items = new ArrayList<>();
    private Set<String> recentIds = Set.of();
    private final Set<String> selected = new HashSet<>();
    private boolean singleAdjustDispatch;
    private boolean groupSelectionEnabled;
    private Set<String> rangeStartSelection;
    private int rangeAnchor = -1, rangeEnd = -1;
    private boolean rangeSelect;
    public void enableGroupSelection() { groupSelectionEnabled = true; }
    private app.nikkisync.mobile.model.Models.PairedServer offlineServer;
    public void setOfflineServer(app.nikkisync.mobile.model.Models.PairedServer server){offlineServer=server;}

    public GalleryAdapter(Context context, ImageLoader images, Supplier<NikkiSyncClient> client, Listener listener) {
        this.context = context;
        this.images = images;
        this.client = client;
        this.listener = listener;
    }

    public void setItems(List<AssetSummary> next) {
        setItems(next, Set.of());
    }

    public void setItems(List<AssetSummary> next, Set<String> recent) {
        Set<String> nextRecent = recent == null ? Set.of() : Set.copyOf(recent);
        if (items.equals(next) && recentIds.equals(nextRecent)) return;
        endRangeSelection();
        items.clear();
        items.addAll(next);
        recentIds = nextRecent;
        rows.clear();
        for (GalleryVersionGroups.Group group : GalleryVersionGroups.group(next, recentIds)) {
            rows.add(Row.header(group));
            for (AssetSummary asset : group.items()) rows.add(Row.photo(asset));
        }
        Set<String> available = new HashSet<>();
        for (AssetSummary item : next) available.add(item.assetId());
        selected.retainAll(available);
        notifyDataSetChanged();
    }

    public boolean isHeader(int position) {
        return position >= 0 && position < rows.size() && rows.get(position).group != null;
    }

    public int selectedCount() { return selected.size(); }
    public boolean isPhoto(int position) {
        return position >= 0 && position < rows.size() && rows.get(position).asset != null;
    }
    public boolean beginRangeSelection(int position) {
        if (!isPhoto(position) || !hasSelection()) return false;
        rangeStartSelection = new HashSet<>(selected);
        rangeAnchor = rangeEnd = position;
        rangeSelect = !selected.contains(rows.get(position).asset.assetId());
        extendRangeSelection(position);
        return true;
    }
    public void extendRangeSelection(int position) {
        if (rangeAnchor < 0 || !isPhoto(position)) return;
        int first = Math.min(rangeAnchor, position), last = Math.max(rangeAnchor, position);
        int dirtyFirst = Math.min(first, rangeEnd), dirtyLast = Math.max(last, rangeEnd);
        boolean wasEmpty = selected.isEmpty();
        for (int i = dirtyFirst; i <= dirtyLast; i++) {
            if (!isPhoto(i)) continue;
            String id = rows.get(i).asset.assetId();
            boolean checked = i >= first && i <= last ? rangeSelect : rangeStartSelection.contains(id);
            if (checked) selected.add(id); else selected.remove(id);
        }
        rangeEnd = position;
        if (wasEmpty != selected.isEmpty()) notifyItemRangeChanged(0, rows.size(), SELECTION);
        else notifyItemRangeChanged(dirtyFirst, dirtyLast - dirtyFirst + 1, SELECTION);
        listener.onSelectionChanged();
    }
    public void endRangeSelection() {
        rangeAnchor = rangeEnd = -1;
        rangeStartSelection = null;
    }
    private void toggleGroup(GalleryVersionGroups.Group group) {
        boolean all = group.items().stream().allMatch(this::isSelected);
        for (AssetSummary asset : group.items()) {
            if (all) selected.remove(asset.assetId()); else selected.add(asset.assetId());
        }
        notifyItemRangeChanged(0, rows.size(), SELECTION);
        listener.onSelectionChanged();
    }
    public boolean isSelected(AssetSummary asset){return selected.contains(asset.assetId());}
    public List<AssetSummary> visiblePhotos(){
        List<AssetSummary> photos=new ArrayList<>();for(Row row:rows)if(row.asset!=null)photos.add(row.asset);return photos;
    }

    /**
     * MainActivity uses this to decide whether a tap should toggle selection or open the viewer.
     * During a multi-select long-press we intentionally report false only for the synchronous
     * viewer dispatch, while keeping the real selected set untouched. This lets one photo open
     * for adjustment without clearing, rebuilding, or otherwise mutating the batch selection.
     */
    public boolean hasSelection() { return !singleAdjustDispatch && !selected.isEmpty(); }

    public boolean toggle(AssetSummary asset) {
        boolean wasEmpty=selected.isEmpty();
        if (!selected.add(asset.assetId())) selected.remove(asset.assetId());
        if(wasEmpty!=selected.isEmpty())notifyItemRangeChanged(0,rows.size(),SELECTION);
        else for(int i=0;i<rows.size();i++)if(rows.get(i).asset!=null&&rows.get(i).asset.assetId().equals(asset.assetId()))notifyItemChanged(i,SELECTION);
        return selected.contains(asset.assetId());
    }

    public List<AssetSummary> selectedItems() {
        List<AssetSummary> result = new ArrayList<>();
        for (AssetSummary item : items) if (selected.contains(item.assetId())) result.add(item);
        return result;
    }

    public void clearSelection() {
        endRangeSelection();
        if(selected.isEmpty())return;
        selected.clear();
        notifyItemRangeChanged(0,rows.size(),SELECTION);
    }

    @Override public int getItemCount() { return rows.size(); }

    @Override public int getItemViewType(int position) {
        return isHeader(position) ? TYPE_HEADER : TYPE_PHOTO;
    }

    @NonNull @Override public RecyclerView.ViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        if (viewType == TYPE_HEADER) return new HeaderHolder(new HeaderView(context));
        return new PhotoHolder(new Cell(context));
    }

    @Override public void onBindViewHolder(@NonNull RecyclerView.ViewHolder holder,int position,@NonNull List<Object> payloads){
        if(!payloads.isEmpty()&&holder instanceof PhotoHolder photo){bindSelection(photo,rows.get(position).asset);return;}
        onBindViewHolder(holder,position);
    }
    private void bindSelection(PhotoHolder photo,AssetSummary asset){
        boolean checked=selected.contains(asset.assetId());
        photo.cell.bind(asset,checked);
        photo.cell.check.setVisibility(selected.isEmpty()?View.GONE:View.VISIBLE);
        photo.cell.check.setActivated(checked);
        photo.cell.check.setContentDescription(checked?"取消选择照片":"选择照片");
    }
    @Override public void onBindViewHolder(@NonNull RecyclerView.ViewHolder holder, int position) {
        Row row = rows.get(position);
        if (holder instanceof HeaderHolder header) {
            header.view.bind(row.group);
            return;
        }
        PhotoHolder photo = (PhotoHolder) holder;
        AssetSummary asset = row.asset;
        photo.cell.image.setScaleType(asset.isVideo()?ImageView.ScaleType.CENTER_INSIDE:ImageView.ScaleType.CENTER_CROP);
        bindSelection(photo,asset);
        photo.cell.check.setOnClickListener(v->listener.onPhotoLongClick(asset));
        NikkiSyncClient current = client.get();
        if (current != null && images!=null) images.load(current, asset, photo.cell.image);
        else if(offlineServer!=null&&images!=null)images.loadOffline(offlineServer,asset,photo.cell.image);
        else photo.cell.image.setImageDrawable(null);
        photo.cell.setOnClickListener(v -> listener.onPhotoClick(asset));
        photo.cell.setOnLongClickListener(v -> {
            GalleryInteractionPolicy.Action action = GalleryInteractionPolicy.onLongPress(!selected.isEmpty());
            if (action == GalleryInteractionPolicy.Action.OPEN_SINGLE_ADJUST) {
                singleAdjustDispatch = true;
                try {
                    listener.onPhotoClick(asset);
                    return true;
                } finally {
                    singleAdjustDispatch = false;
                }
            }
            return listener.onPhotoLongClick(asset);
        });
    }

    private static final class Row {
        final GalleryVersionGroups.Group group;
        final AssetSummary asset;

        private Row(GalleryVersionGroups.Group group, AssetSummary asset) {
            this.group = group;
            this.asset = asset;
        }

        static Row header(GalleryVersionGroups.Group group) { return new Row(group, null); }
        static Row photo(AssetSummary asset) { return new Row(null, asset); }
    }

    private static final class HeaderHolder extends RecyclerView.ViewHolder {
        final HeaderView view;
        HeaderHolder(HeaderView view) { super(view); this.view = view; }
    }

    private static final class PhotoHolder extends RecyclerView.ViewHolder {
        final Cell cell;
        PhotoHolder(Cell cell) { super(cell); this.cell = cell; }
    }

    private final class HeaderView extends LinearLayout {
        private final TextView title;
        private final TextView count;
        private final Button selectAll;

        HeaderView(Context context) {
            super(context);
            setGravity(Gravity.CENTER_VERTICAL);
            setPadding(dp(14), dp(6), dp(14), dp(4));
            setMinimumHeight(dp(40));

            title = label(16, true, context.getColor(R.color.text_primary));
            title.setSingleLine(true);
            addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

            count = label(11, false, context.getColor(R.color.text_secondary));
            count.setSingleLine(true);
            addView(count);
            selectAll = new Button(context);
            selectAll.setAllCaps(false);
            selectAll.setTextSize(12);
            selectAll.setTextColor(context.getColor(R.color.selection_mark));
            selectAll.setMinHeight(0);
            selectAll.setMinimumHeight(0);
            selectAll.setMinWidth(0);
            selectAll.setMinimumWidth(0);
            selectAll.setPadding(dp(10), 0, dp(10), 0);
            selectAll.setBackground(GalleryUxStyle.glassButton(context));
            LayoutParams selectParams = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(36));
            selectParams.setMarginStart(dp(10));
            addView(selectAll, selectParams);
        }

        void bind(GalleryVersionGroups.Group group) {
            title.setText(group.versionLabel());
            count.setText(group.items().size() + " 张" + (group.inferred() ? " · 自动推测" : ""));
            boolean all = group.items().stream().allMatch(GalleryAdapter.this::isSelected);
            selectAll.setVisibility(groupSelectionEnabled ? VISIBLE : GONE);
            selectAll.setText(all ? "取消全选" : "全选");
            selectAll.setContentDescription(group.versionLabel() + (all ? "取消全选" : "全选当前筛选下的照片"));
            selectAll.setOnClickListener(v -> toggleGroup(group));
        }

        private TextView label(int sp, boolean bold, int color) {
            TextView view = new TextView(context);
            view.setTextSize(sp);
            view.setIncludeFontPadding(false);
            view.setTextColor(color);
            if (bold) view.setTypeface(Typeface.DEFAULT_BOLD);
            return view;
        }
    }

    private final class Cell extends FrameLayout {
        final FrameLayout photoFrame;
        final ImageView image;
        final View selectedOverlay;
        final TextView live;
        final View check;

        Cell(Context context) {
            super(context);
            int gap = dp(3);
            setPadding(gap, gap, gap, gap);
            setMinimumHeight(dp(138));

            photoFrame = new FrameLayout(context);
            photoFrame.setBackgroundResource(R.drawable.bg_gallery_photo);
            photoFrame.setClipToOutline(true);
            addView(photoFrame, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(132)));

            image = new ImageView(context);
            image.setScaleType(ImageView.ScaleType.CENTER_CROP);
            photoFrame.addView(image, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

            selectedOverlay = new View(context);
            selectedOverlay.setBackgroundResource(R.drawable.bg_selected_glass);
            selectedOverlay.setVisibility(GONE);
            photoFrame.addView(selectedOverlay, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

            live = badge("LIVE");
            FrameLayout.LayoutParams lpLive = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.TOP | Gravity.START
            );
            lpLive.setMargins(dp(8), dp(8), 0, 0);
            addView(live, lpLive);

            check = new View(context);
            check.setBackgroundResource(R.drawable.photo_selection_mark);
            FrameLayout.LayoutParams lpCheck = new FrameLayout.LayoutParams(dp(30), dp(30), Gravity.BOTTOM | Gravity.END);
            lpCheck.setMarginEnd(dp(6));
            lpCheck.bottomMargin = dp(6);
            addView(check, lpCheck);
        }

        void bind(AssetSummary asset, boolean isSelected) {
            live.setText(asset.isVideo()?"视频":"LIVE");
            live.setVisibility(asset.isVideo()||asset.hasMotion() ? VISIBLE : GONE);
            selectedOverlay.setVisibility(isSelected ? VISIBLE : GONE);
            setAlpha(1f);
        }

        @Override protected void onMeasure(int widthSpec, int heightSpec) {
            int width = MeasureSpec.getSize(widthSpec);
            if (width > 0) {
                int edge = Math.max(1, width - getPaddingLeft() - getPaddingRight());
                photoFrame.getLayoutParams().height = edge;
                heightSpec = MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY);
            }
            super.onMeasure(widthSpec, heightSpec);
        }

        private TextView badge(String text) {
            TextView view = new TextView(context);
            view.setText(text);
            view.setTextColor(Color.rgb(54, 50, 48));
            view.setTextSize(10);
            view.setTypeface(Typeface.DEFAULT_BOLD);
            view.setPadding(dp(8), dp(4), dp(8), dp(4));
            view.setBackground(GalleryUxStyle.glassChip(context));
            return view;
        }
    }

    private int dp(int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
