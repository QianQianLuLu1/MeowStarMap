package app.nikkisync.mobile.ui;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import app.nikkisync.mobile.R;
import app.nikkisync.mobile.media.ImageLoader;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.model.Models.SuitSearchPart;
import app.nikkisync.mobile.model.Models.SuitSearchPhoto;
import app.nikkisync.mobile.model.Models.SuitSearchResult;
import app.nikkisync.mobile.net.NikkiSyncClient;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class SuitSearchGrid {
    public interface Listener {
        void onPhotoClick(AssetSummary asset);
    }

    @FunctionalInterface
    public interface ContextListener {
        void onPhotoClick(AssetSummary asset, List<AssetSummary> displayedPhotos);
    }

    private static final int MAX_PHOTOS = 60;
    private static final String[] CATEGORY_ORDER = {
            "hair", "dresses", "outerwear", "tops", "bottoms", "socks", "shoes",
            "hairAccessories", "headwear", "earrings", "neckwear", "chokers", "bracelets",
            "gloves", "faceDecorations", "chestAccessories", "pendants", "backpieces",
            "rings", "armDecorations", "handhelds", "bodyPaint", "fullMakeup", "baseMakeup",
            "eyebrows", "eyelashes", "contacts", "lips", "skinTones"
    };

    private SuitSearchGrid() {}

    public static View create(
            Activity activity,
            NikkiSyncClient client,
            ImageLoader images,
            SuitSearchResult item,
            Listener listener
    ) {
        return createWithContext(activity, client, images, item,
                (asset, displayedPhotos) -> listener.onPhotoClick(asset));
    }

    public static View createWithContext(
            Activity activity,
            NikkiSyncClient client,
            ImageLoader images,
            SuitSearchResult item,
            ContextListener listener
    ) {
        LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);

        Map<String, Integer> partCounts = countCategories(item.photos());

        HorizontalScrollView filterScroll = new HorizontalScrollView(activity);
        filterScroll.setHorizontalScrollBarEnabled(false);
        filterScroll.setClipToPadding(false);

        LinearLayout filters = new LinearLayout(activity);
        filters.setOrientation(LinearLayout.HORIZONTAL);
        filters.setGravity(Gravity.CENTER_VERTICAL);
        filters.setPadding(0, 0, dp(activity, 8), dp(activity, 8));
        filterScroll.addView(filters, new HorizontalScrollView.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        root.addView(filterScroll);

        LinearLayout photoGrid = new LinearLayout(activity);
        photoGrid.setOrientation(LinearLayout.VERTICAL);
        root.addView(photoGrid, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        String[] selectedCategory = new String[]{""};
        Runnable rerender = () -> renderPhotoGrid(
                activity,
                client,
                images,
                item.photos(),
                selectedCategory[0],
                photoGrid,
                listener
        );

        Button all = filterButton(activity, "全部 " + item.photoCount(), true);
        all.setOnClickListener(v -> {
            selectedCategory[0] = "";
            styleFilterButtons(filters, all);
            rerender.run();
        });
        filters.addView(all, chipLayoutParams(activity));

        for (Map.Entry<String, Integer> entry : partCounts.entrySet()) {
            String category = entry.getKey();
            Button chip = filterButton(
                    activity,
                    categoryLabel(category) + " " + entry.getValue(),
                    false
            );
            chip.setOnClickListener(v -> {
                selectedCategory[0] = category;
                styleFilterButtons(filters, chip);
                rerender.run();
            });
            filters.addView(chip, chipLayoutParams(activity));
        }

        rerender.run();
        return root;
    }

    private static void renderPhotoGrid(
            Activity activity,
            NikkiSyncClient client,
            ImageLoader images,
            List<SuitSearchPhoto> allPhotos,
            String category,
            LinearLayout grid,
            ContextListener listener
    ) {
        grid.removeAllViews();

        List<SuitSearchPhoto> filtered = new ArrayList<>();
        for (SuitSearchPhoto photo : allPhotos) {
            if (category.isEmpty() || hasCategory(photo, category)) filtered.add(photo);
        }

        int limit = Math.min(filtered.size(), MAX_PHOTOS);
        List<AssetSummary> displayed = new ArrayList<>(limit);
        for (int i = 0; i < limit; i++) displayed.add(filtered.get(i).asset());
        List<AssetSummary> displayedPhotos = List.copyOf(displayed);
        int index = 0;
        while (index < limit) {
            LinearLayout row = new LinearLayout(activity);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.TOP);
            LinearLayout.LayoutParams rowLp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
            );
            if (index > 0) rowLp.topMargin = dp(activity, 7);

            for (int column = 0; column < 3; column++) {
                if (index >= limit) {
                    View spacer = new View(activity);
                    row.addView(spacer, new LinearLayout.LayoutParams(0, dp(activity, 1), 1));
                    continue;
                }
                SuitSearchPhoto photo = filtered.get(index++);
                LinearLayout.LayoutParams cellLp = new LinearLayout.LayoutParams(
                        0,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        1
                );
                if (column > 0) cellLp.leftMargin = dp(activity, 7);
                row.addView(photoCell(activity, client, images, photo, displayedPhotos, listener), cellLp);
            }
            grid.addView(row, rowLp);
        }

        if (filtered.isEmpty()) {
            TextView empty = label(
                    activity,
                    "这个部位暂时没有对应照片",
                    12,
                    false,
                    activity.getColor(R.color.text_secondary)
            );
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(dp(activity, 8), dp(activity, 24), dp(activity, 8), dp(activity, 24));
            grid.addView(empty);
        } else if (filtered.size() > limit) {
            TextView more = label(
                    activity,
                    "当前显示前 " + limit + " 张，共 " + filtered.size() + " 张",
                    11,
                    false,
                    activity.getColor(R.color.text_secondary)
            );
            more.setPadding(dp(activity, 4), dp(activity, 9), dp(activity, 4), 0);
            grid.addView(more);
        }
    }

    private static FrameLayout photoCell(
            Activity activity,
            NikkiSyncClient client,
            ImageLoader images,
            SuitSearchPhoto photo,
            List<AssetSummary> displayedPhotos,
            ContextListener listener
    ) {
        int width = activity.getResources().getDisplayMetrics().widthPixels;
        int cellSize = Math.max(dp(activity, 92), (width - dp(activity, 88)) / 3);

        FrameLayout cell = new FrameLayout(activity);
        cell.setBackgroundResource(R.drawable.bg_gallery_photo);
        cell.setClipToOutline(true);

        ImageView image = new ImageView(activity);
        image.setScaleType(ImageView.ScaleType.CENTER_CROP);
        image.setBackgroundResource(R.drawable.bg_gallery_photo);
        image.setClipToOutline(true);
        cell.addView(image, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                cellSize
        ));
        images.load(client, photo.asset(), image);

        TextView badge = label(
                activity,
                compactPartText(photo.matchedParts()),
                10,
                true,
                activity.getColor(R.color.text_primary)
        );
        badge.setSingleLine(true);
        badge.setMaxLines(1);
        badge.setPadding(dp(activity, 7), dp(activity, 4), dp(activity, 7), dp(activity, 4));
        badge.setBackgroundResource(R.drawable.bg_glass_chip);
        FrameLayout.LayoutParams badgeLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.START
        );
        badgeLp.setMargins(dp(activity, 7), 0, dp(activity, 7), dp(activity, 7));
        cell.addView(badge, badgeLp);

        if (photo.asset().hasMotion()) {
            TextView live = label(
                    activity,
                    "LIVE",
                    9,
                    true,
                    activity.getColor(R.color.text_primary)
            );
            live.setPadding(dp(activity, 6), dp(activity, 3), dp(activity, 6), dp(activity, 3));
            live.setBackgroundResource(R.drawable.bg_glass_chip);
            FrameLayout.LayoutParams liveLp = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.TOP | Gravity.START
            );
            liveLp.setMargins(dp(activity, 7), dp(activity, 7), 0, 0);
            cell.addView(live, liveLp);
        }

        cell.setOnClickListener(v -> listener.onPhotoClick(photo.asset(), displayedPhotos));
        return cell;
    }

    private static Map<String, Integer> countCategories(List<SuitSearchPhoto> photos) {
        Map<String, Integer> rawCounts = new LinkedHashMap<>();
        for (SuitSearchPhoto photo : photos) {
            List<String> seenInPhoto = new ArrayList<>();
            for (SuitSearchPart part : photo.matchedParts()) {
                String category = part.category();
                if (category == null || category.isBlank() || seenInPhoto.contains(category)) continue;
                seenInPhoto.add(category);
                rawCounts.put(category, rawCounts.getOrDefault(category, 0) + 1);
            }
        }

        Map<String, Integer> ordered = new LinkedHashMap<>();
        for (String category : CATEGORY_ORDER) {
            Integer count = rawCounts.remove(category);
            if (count != null) ordered.put(category, count);
        }
        ordered.putAll(rawCounts);
        return ordered;
    }

    private static boolean hasCategory(SuitSearchPhoto photo, String category) {
        for (SuitSearchPart part : photo.matchedParts()) {
            if (category.equals(part.category())) return true;
        }
        return false;
    }

    private static String compactPartText(List<SuitSearchPart> parts) {
        List<String> labels = new ArrayList<>();
        for (SuitSearchPart part : parts) {
            String value = categoryLabel(part.category());
            if (value == null || value.isBlank()) value = part.name();
            if (value == null || value.isBlank() || labels.contains(value)) continue;
            labels.add(value);
        }
        if (labels.isEmpty()) return "套装";
        if (labels.size() <= 2) return String.join(" · ", labels);
        return String.join(" · ", labels.subList(0, 2)) + " +" + (labels.size() - 2);
    }

    private static void styleFilterButtons(LinearLayout filters, Button selected) {
        for (int index = 0; index < filters.getChildCount(); index++) {
            View child = filters.getChildAt(index);
            if (!(child instanceof Button button)) continue;
            boolean active = button == selected;
            button.setTypeface(active ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
            button.setAlpha(active ? 1f : 0.62f);
            button.setBackgroundResource(active ? R.drawable.bg_glass_chip : android.R.color.transparent);
        }
    }

    private static Button filterButton(Activity activity, String value, boolean selected) {
        Button button = new Button(activity);
        button.setText(value);
        button.setTextSize(11);
        button.setAllCaps(false);
        button.setTextColor(activity.getColor(R.color.text_primary));
        button.setTypeface(selected ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
        button.setAlpha(selected ? 1f : 0.62f);
        button.setBackgroundResource(selected ? R.drawable.bg_glass_chip : android.R.color.transparent);
        button.setPadding(dp(activity, 10), 0, dp(activity, 10), 0);
        button.setMinHeight(dp(activity, 36));
        button.setMinimumHeight(dp(activity, 36));
        return button;
    }

    private static LinearLayout.LayoutParams chipLayoutParams(Activity activity) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                dp(activity, 36)
        );
        lp.rightMargin = dp(activity, 6);
        return lp;
    }

    private static String categoryLabel(String category) {
        if (category == null) return "";
        return switch (category) {
            case "hair" -> "发型";
            case "dresses" -> "连衣裙";
            case "outerwear" -> "外套";
            case "tops" -> "上衣";
            case "bottoms" -> "下装";
            case "socks" -> "袜子";
            case "shoes" -> "鞋子";
            case "hairAccessories" -> "发饰";
            case "headwear" -> "帽子";
            case "earrings" -> "耳饰";
            case "neckwear" -> "颈饰";
            case "bracelets" -> "腕饰";
            case "chokers" -> "项圈";
            case "gloves" -> "手套";
            case "faceDecorations" -> "面饰";
            case "chestAccessories" -> "胸饰";
            case "pendants" -> "挂饰";
            case "backpieces" -> "背饰";
            case "rings" -> "戒指";
            case "armDecorations" -> "臂饰";
            case "handhelds" -> "手持物";
            case "bodyPaint" -> "肤绘";
            case "fullMakeup" -> "全妆";
            case "baseMakeup" -> "底妆";
            case "eyebrows" -> "眉妆";
            case "eyelashes" -> "睫毛";
            case "contacts" -> "美瞳";
            case "lips" -> "唇妆";
            case "skinTones" -> "肤色";
            default -> category;
        };
    }

    private static TextView label(Activity activity, String value, int sp, boolean bold, int color) {
        TextView view = new TextView(activity);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT_BOLD);
        return view;
    }

    private static int dp(Activity activity, int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }
}
