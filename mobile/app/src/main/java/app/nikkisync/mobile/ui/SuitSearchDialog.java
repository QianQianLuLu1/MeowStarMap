package app.nikkisync.mobile.ui;

import android.app.Activity;
import app.nikkisync.mobile.ui.chrome.ChromePage;
import android.graphics.Typeface;
import android.os.Handler;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.Button;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import app.nikkisync.mobile.R;
import app.nikkisync.mobile.media.ImageLoader;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.model.Models.ClothingSearchResponse;
import app.nikkisync.mobile.model.Models.ClothingSearchResult;
import app.nikkisync.mobile.model.Models.SuitSearchResponse;
import app.nikkisync.mobile.model.Models.SuitSearchResult;
import app.nikkisync.mobile.net.NikkiSyncClient;

import java.util.List;
import java.util.concurrent.ExecutorService;

public final class SuitSearchDialog {
    private static final int MODE_ALL = 0;
    private static final int MODE_SUIT = 1;
    private static final int MODE_CLOTHING = 2;

    public interface Listener {
        void onPhotoClick(AssetSummary asset);
    }

    @FunctionalInterface
    public interface ContextListener {
        void onPhotoClick(AssetSummary asset, List<AssetSummary> displayedPhotos);
    }

    private SuitSearchDialog() {}

    public static void show(
            Activity activity,
            NikkiSyncClient client,
            ImageLoader images,
            ExecutorService io,
            Handler main,
            Listener listener
    ) {
        showWithContext(activity, client, images, io, main,
                (asset, displayedPhotos) -> listener.onPhotoClick(asset));
    }

    public static void showWithContext(
            Activity activity,
            NikkiSyncClient client,
            ImageLoader images,
            ExecutorService io,
            Handler main,
            ContextListener listener
    ) {
        showInternal(activity, client, images, io, main, listener, null, MODE_ALL, false);
    }

    public static void showSuit(
            Activity activity,
            NikkiSyncClient client,
            ImageLoader images,
            ExecutorService io,
            Handler main,
            Listener listener,
            String query
    ) {
        showSuitWithContext(activity, client, images, io, main,
                (asset, displayedPhotos) -> listener.onPhotoClick(asset), query);
    }

    public static void showSuitWithContext(
            Activity activity,
            NikkiSyncClient client,
            ImageLoader images,
            ExecutorService io,
            Handler main,
            ContextListener listener,
            String query
    ) {
        showInternal(activity, client, images, io, main, listener, query, MODE_SUIT, true);
    }

    public static void showClothing(
            Activity activity,
            NikkiSyncClient client,
            ImageLoader images,
            ExecutorService io,
            Handler main,
            Listener listener,
            String query
    ) {
        showClothingWithContext(activity, client, images, io, main,
                (asset, displayedPhotos) -> listener.onPhotoClick(asset), query);
    }

    public static void showClothingWithContext(
            Activity activity,
            NikkiSyncClient client,
            ImageLoader images,
            ExecutorService io,
            Handler main,
            ContextListener listener,
            String query
    ) {
        showInternal(activity, client, images, io, main, listener, query, MODE_CLOTHING, true);
    }

    private static void showInternal(
            Activity activity,
            NikkiSyncClient client,
            ImageLoader images,
            ExecutorService io,
            Handler main,
            ContextListener listener,
            String initialQuery,
            int initialMode,
            boolean autoSearch
    ) {
        ChromePage dialog = new ChromePage(activity);
        dialog.useAmbientBackground();

        LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(activity.getColor(R.color.app_background));
        root.setPadding(dp(activity, 14), dp(activity, 10), dp(activity, 14), dp(activity, 18));

        LinearLayout header = new LinearLayout(activity);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = label(activity, "搜索照片", 22, true, activity.getColor(R.color.text_primary));
        header.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button close = button(activity, "完成");
        close.setOnClickListener(v -> dialog.dismiss());
        header.addView(close);
        root.addView(header);

        TextView description = label(
                activity,
                "按套装或散件查找照片，直接查看它们在图库中的使用记录。",
                12,
                false,
                activity.getColor(R.color.text_secondary)
        );
        description.setPadding(dp(activity, 2), dp(activity, 6), dp(activity, 2), dp(activity, 10));
        root.addView(description);

        LinearLayout searchRow = new LinearLayout(activity);
        searchRow.setGravity(Gravity.CENTER_VERTICAL);
        searchRow.setPadding(dp(activity, 10), dp(activity, 4), dp(activity, 4), dp(activity, 4));
        searchRow.setBackgroundResource(R.drawable.bg_glass_card);

        EditText query = new EditText(activity);
        query.setSingleLine(true);
        query.setHint("套装或散件名称");
        query.setTextSize(15);
        query.setTextColor(activity.getColor(R.color.text_primary));
        query.setHintTextColor(activity.getColor(R.color.text_secondary));
        query.setBackgroundColor(android.graphics.Color.TRANSPARENT);
        searchRow.addView(query, new LinearLayout.LayoutParams(0, dp(activity, 48), 1));

        Button search = button(activity, "搜索");
        searchRow.addView(search);
        root.addView(searchRow);

        LinearLayout modeRow = new LinearLayout(activity);
        modeRow.setGravity(Gravity.CENTER_VERTICAL);
        modeRow.setPadding(0, dp(activity, 8), 0, 0);
        Button allMode = button(activity, "全部");
        Button suitMode = button(activity, "套装");
        Button clothingMode = button(activity, "散件");
        modeRow.addView(allMode, new LinearLayout.LayoutParams(0, dp(activity, 38), 1));
        LinearLayout.LayoutParams suitModeLp = new LinearLayout.LayoutParams(0, dp(activity, 38), 1);
        suitModeLp.setMargins(dp(activity, 6), 0, dp(activity, 6), 0);
        modeRow.addView(suitMode, suitModeLp);
        modeRow.addView(clothingMode, new LinearLayout.LayoutParams(0, dp(activity, 38), 1));
        root.addView(modeRow);

        int[] searchMode = new int[]{initialMode};
        Button initialModeButton = initialMode == MODE_SUIT ? suitMode : initialMode == MODE_CLOTHING ? clothingMode : allMode;
        styleModeButtons(modeRow, initialModeButton);
        if (initialMode == MODE_SUIT) query.setHint("套装名称");
        else if (initialMode == MODE_CLOTHING) query.setHint("散件名称");
        if (initialQuery != null && !initialQuery.isBlank()) {
            query.setText(initialQuery);
            query.setSelection(initialQuery.length());
        }

        TextView recentLabel = label(activity, "最近搜索", 11, true, activity.getColor(R.color.text_secondary));
        recentLabel.setPadding(dp(activity, 2), dp(activity, 8), dp(activity, 2), dp(activity, 4));
        root.addView(recentLabel);

        HorizontalScrollView recentScroll = new HorizontalScrollView(activity);
        recentScroll.setHorizontalScrollBarEnabled(false);
        LinearLayout recentRow = new LinearLayout(activity);
        recentRow.setOrientation(LinearLayout.HORIZONTAL);
        recentRow.setPadding(0, 0, dp(activity, 8), dp(activity, 4));
        recentScroll.addView(recentRow, new HorizontalScrollView.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        root.addView(recentScroll);

        TextView status = label(activity, "输入套装或散件名称开始搜索", 12, false, activity.getColor(R.color.text_secondary));
        status.setPadding(dp(activity, 4), dp(activity, 10), dp(activity, 4), dp(activity, 8));
        root.addView(status);

        ScrollView scroll = new ScrollView(activity);
        LinearLayout results = new LinearLayout(activity);
        results.setOrientation(LinearLayout.VERTICAL);
        results.setPadding(0, 0, 0, dp(activity, 24));
        scroll.addView(results, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

        Runnable runSearch = () -> {
            String value = query.getText().toString().trim();
            if (value.isEmpty()) {
                status.setText(searchMode[0] == MODE_SUIT
                        ? "请输入套装名称"
                        : searchMode[0] == MODE_CLOTHING ? "请输入散件名称" : "请输入套装或散件名称");
                return;
            }
            int requestedMode = searchMode[0];
            search.setEnabled(false);
            status.setText("正在搜索“" + value + "”…");
            results.removeAllViews();
            io.execute(() -> {
                try {
                    SuitSearchResponse suitResponse = requestedMode == MODE_CLOTHING ? null : client.searchSuits(value);
                    ClothingSearchResponse clothingResponse = requestedMode == MODE_SUIT ? null : client.searchClothing(value);
                    main.post(() -> {
                        search.setEnabled(true);
                        SuitSearchHistory.record(activity, value);
                        renderRecentSearches(activity, recentLabel, recentScroll, recentRow, query, search);
                        renderSearchResults(
                                activity, client, images, suitResponse, clothingResponse,
                                requestedMode, results, status, listener
                        );
                    });
                } catch (Exception error) {
                    main.post(() -> {
                        search.setEnabled(true);
                        status.setText("搜索失败：" + message(error));
                    });
                }
            });
        };

        allMode.setOnClickListener(v -> {
            searchMode[0] = MODE_ALL;
            query.setHint("套装或散件名称");
            styleModeButtons(modeRow, allMode);
            if (!query.getText().toString().trim().isEmpty()) runSearch.run();
            else status.setText("输入套装或散件名称开始搜索");
        });
        suitMode.setOnClickListener(v -> {
            searchMode[0] = MODE_SUIT;
            query.setHint("套装名称");
            styleModeButtons(modeRow, suitMode);
            if (!query.getText().toString().trim().isEmpty()) runSearch.run();
            else status.setText("输入套装名称开始搜索");
        });
        clothingMode.setOnClickListener(v -> {
            searchMode[0] = MODE_CLOTHING;
            query.setHint("散件名称");
            styleModeButtons(modeRow, clothingMode);
            if (!query.getText().toString().trim().isEmpty()) runSearch.run();
            else status.setText("输入散件名称开始搜索");
        });

        search.setOnClickListener(v -> runSearch.run());
        query.setOnEditorActionListener((v, actionId, event) -> {
            runSearch.run();
            return true;
        });
        renderRecentSearches(activity, recentLabel, recentScroll, recentRow, query, search);

        dialog.setContentView(root);
        dialog.show();
        if (autoSearch && initialQuery != null && !initialQuery.isBlank()) {
            search.performClick();
        } else {
            query.requestFocus();
        }
    }

    private static void renderSearchResults(
            Activity activity,
            NikkiSyncClient client,
            ImageLoader images,
            SuitSearchResponse suitResponse,
            ClothingSearchResponse clothingResponse,
            int mode,
            LinearLayout results,
            TextView status,
            ContextListener listener
    ) {
        results.removeAllViews();

        int suitCount = suitResponse == null ? 0 : suitResponse.items().size();
        int clothingCount = clothingResponse == null ? 0 : clothingResponse.items().size();
        if (suitCount == 0 && clothingCount == 0) {
            status.setText(mode == MODE_SUIT
                    ? "没有找到包含该套装信息的照片"
                    : mode == MODE_CLOTHING ? "没有找到使用该散件的照片" : "没有找到相关套装或散件");
            TextView empty = label(
                    activity,
                    mode == MODE_SUIT
                            ? "当前照片需要已经解析出套装归属。旧照片在字典重新丰富后也会进入搜索结果。"
                            : "搜索基于 NikkiSync 已解析的穿搭信息，不进行图片识别。",
                    13,
                    false,
                    activity.getColor(R.color.text_secondary)
            );
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(dp(activity, 24), dp(activity, 36), dp(activity, 24), dp(activity, 36));
            results.addView(empty);
            return;
        }

        if (mode == MODE_ALL) {
            status.setText("套装 " + suitCount + " · 散件 " + clothingCount);
        } else if (mode == MODE_SUIT) {
            int photos = 0;
            for (SuitSearchResult item : suitResponse.items()) photos += item.photoCount();
            status.setText("找到 " + suitCount + " 个套装结果 · " + photos + " 张照片");
        } else {
            int photos = 0;
            for (ClothingSearchResult item : clothingResponse.items()) photos += item.photoCount();
            status.setText("找到 " + clothingCount + " 个散件结果 · " + photos + " 条使用记录");
        }

        if (suitCount > 0) {
            if (mode == MODE_ALL) results.addView(sectionTitle(activity, "套装"));
            for (SuitSearchResult item : suitResponse.items()) {
                results.addView(suitCard(activity, client, images, item, listener), resultCardParams(activity));
            }
        }

        if (clothingCount > 0) {
            if (mode == MODE_ALL) results.addView(sectionTitle(activity, "散件"));
            for (ClothingSearchResult item : clothingResponse.items()) {
                results.addView(clothingCard(activity, client, images, item, listener), resultCardParams(activity));
            }
        }
    }

    private static LinearLayout suitCard(
            Activity activity,
            NikkiSyncClient client,
            ImageLoader images,
            SuitSearchResult item,
            ContextListener listener
    ) {
        LinearLayout card = resultCard(activity);

        TextView name = label(activity, item.suitName(), 18, true, activity.getColor(R.color.text_primary));
        card.addView(name);

        String coverage = item.totalPartCount() == null
                ? "已发现 " + item.observedPartCount() + " 个部件"
                : "已发现 " + item.observedPartCount() + " / " + item.totalPartCount() + " 个部件";
        TextView summary = label(
                activity,
                coverage + " · " + item.photoCount() + " 张照片",
                12,
                false,
                activity.getColor(R.color.text_secondary)
        );
        summary.setPadding(0, dp(activity, 3), 0, dp(activity, 5));
        card.addView(summary);

        if (item.totalPartCount() != null && item.totalPartCount() > 0) {
            int totalParts = item.totalPartCount();
            int observedParts = Math.max(0, Math.min(item.observedPartCount(), totalParts));
            int percentage = Math.round(observedParts * 100f / totalParts);

            TextView coverageLabel = label(
                    activity,
                    "图库覆盖 " + percentage + "%",
                    11,
                    true,
                    activity.getColor(R.color.text_secondary)
            );
            coverageLabel.setPadding(0, 0, 0, dp(activity, 4));
            card.addView(coverageLabel);

            LinearLayout coverageTrack = new LinearLayout(activity);
            coverageTrack.setOrientation(LinearLayout.HORIZONTAL);
            coverageTrack.setBackgroundResource(R.drawable.bg_suit_coverage_track);
            if (observedParts > 0) {
                android.view.View fill = new android.view.View(activity);
                fill.setBackgroundResource(R.drawable.bg_suit_coverage_fill);
                coverageTrack.addView(fill, new LinearLayout.LayoutParams(0, dp(activity, 6), observedParts));
            }
            int remainingParts = totalParts - observedParts;
            if (remainingParts > 0) {
                coverageTrack.addView(new android.view.View(activity), new LinearLayout.LayoutParams(0, dp(activity, 6), remainingParts));
            }

            LinearLayout.LayoutParams coverageLp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    dp(activity, 6)
            );
            coverageLp.setMargins(0, 0, 0, dp(activity, 10));
            card.addView(coverageTrack, coverageLp);
        }

        card.addView(SuitSearchGrid.createWithContext(activity, client, images, item, listener::onPhotoClick));
        return card;
    }

    private static LinearLayout clothingCard(
            Activity activity,
            NikkiSyncClient client,
            ImageLoader images,
            ClothingSearchResult item,
            ContextListener listener
    ) {
        LinearLayout card = resultCard(activity);

        LinearLayout header = new LinearLayout(activity);
        header.setGravity(Gravity.CENTER_VERTICAL);

        ImageView clothingImage = new ImageView(activity);
        clothingImage.setScaleType(ImageView.ScaleType.CENTER_CROP);
        clothingImage.setBackgroundResource(R.drawable.bg_gallery_photo);
        clothingImage.setClipToOutline(true);
        header.addView(clothingImage, new LinearLayout.LayoutParams(dp(activity, 58), dp(activity, 58)));
        if (!item.photos().isEmpty()) {
            images.loadClothingThumbnail(
                    client,
                    item.photos().get(0).asset().assetId(),
                    item.clothingId(),
                    "",
                    clothingImage
            );
        }

        LinearLayout copy = new LinearLayout(activity);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.setPadding(dp(activity, 10), 0, 0, 0);

        String displayName = item.name() == null || item.name().isBlank()
                ? "服装 " + item.clothingId()
                : item.name();
        copy.addView(label(activity, displayName, 17, true, activity.getColor(R.color.text_primary)));

        String category = ClothingSearchGrid.categoryLabel(item.category());
        String meta = category
                + (item.suitName() == null || item.suitName().isBlank() ? "" : " · " + item.suitName())
                + " · " + item.photoCount() + " 张照片";
        TextView metaLabel = label(activity, meta, 12, false, activity.getColor(R.color.text_secondary));
        metaLabel.setPadding(0, dp(activity, 2), 0, 0);
        copy.addView(metaLabel);

        TextView idLabel = label(activity, "ID " + item.clothingId(), 10, false, activity.getColor(R.color.text_secondary));
        idLabel.setPadding(0, dp(activity, 2), 0, 0);
        copy.addView(idLabel);

        header.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        card.addView(header);

        LinearLayout.LayoutParams gridLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        gridLp.topMargin = dp(activity, 10);
        card.addView(ClothingSearchGrid.createWithContext(activity, client, images, item, listener::onPhotoClick), gridLp);
        return card;
    }

    private static LinearLayout resultCard(Activity activity) {
        LinearLayout card = new LinearLayout(activity);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(activity, 14), dp(activity, 13), dp(activity, 14), dp(activity, 14));
        card.setBackgroundResource(R.drawable.bg_glass_card);
        return card;
    }

    private static LinearLayout.LayoutParams resultCardParams(Activity activity) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        lp.setMargins(0, 0, 0, dp(activity, 12));
        return lp;
    }

    private static TextView sectionTitle(Activity activity, String value) {
        TextView title = label(activity, value, 14, true, activity.getColor(R.color.text_primary));
        title.setPadding(dp(activity, 4), dp(activity, 5), dp(activity, 4), dp(activity, 8));
        return title;
    }

    private static void styleModeButtons(LinearLayout row, Button selected) {
        for (int index = 0; index < row.getChildCount(); index++) {
            android.view.View child = row.getChildAt(index);
            if (!(child instanceof Button button)) continue;
            boolean active = child == selected;
            button.setTypeface(active ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
            button.setAlpha(active ? 1f : 0.58f);
            button.setBackgroundResource(active ? R.drawable.bg_glass_chip : android.R.color.transparent);
        }
    }

    private static void renderRecentSearches(
            Activity activity,
            TextView recentLabel,
            HorizontalScrollView recentScroll,
            LinearLayout recentRow,
            EditText query,
            Button search
    ) {
        List<String> recent = SuitSearchHistory.load(activity);
        boolean visible = !recent.isEmpty();
        recentLabel.setVisibility(visible ? android.view.View.VISIBLE : android.view.View.GONE);
        recentScroll.setVisibility(visible ? android.view.View.VISIBLE : android.view.View.GONE);
        recentRow.removeAllViews();
        for (String value : recent) {
            Button chip = button(activity, value);
            chip.setTextSize(11);
            chip.setOnClickListener(v -> {
                query.setText(value);
                query.setSelection(value.length());
                search.performClick();
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    dp(activity, 36)
            );
            lp.rightMargin = dp(activity, 6);
            recentRow.addView(chip, lp);
        }
    }

    private static TextView label(Activity activity, String value, int sp, boolean bold, int color) {
        TextView view = new TextView(activity);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT_BOLD);
        return view;
    }

    private static Button button(Activity activity, String value) {
        Button button = new Button(activity);
        button.setText(value);
        button.setTextSize(12);
        button.setAllCaps(false);
        button.setTextColor(activity.getColor(R.color.text_primary));
        button.setBackgroundResource(R.drawable.bg_glass_chip);
        button.setMinHeight(dp(activity, 38));
        button.setMinimumHeight(dp(activity, 38));
        return button;
    }

    private static int dp(Activity activity, int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }

    private static String message(Throwable error) {
        return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
    }
}
