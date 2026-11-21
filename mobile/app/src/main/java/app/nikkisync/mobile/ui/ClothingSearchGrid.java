package app.nikkisync.mobile.ui;

import android.app.Activity;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import app.nikkisync.mobile.R;
import app.nikkisync.mobile.media.ImageLoader;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.model.Models.ClothingSearchPhoto;
import app.nikkisync.mobile.model.Models.ClothingSearchResult;
import app.nikkisync.mobile.net.NikkiSyncClient;

import java.util.List;
import java.util.ArrayList;

public final class ClothingSearchGrid {
    public interface Listener {
        void onPhotoClick(AssetSummary asset);
    }

    @FunctionalInterface
    public interface ContextListener {
        void onPhotoClick(AssetSummary asset, List<AssetSummary> displayedPhotos);
    }

    private static final int MAX_PHOTOS = 60;

    private ClothingSearchGrid() {}

    public static View create(
            Activity activity,
            NikkiSyncClient client,
            ImageLoader images,
            ClothingSearchResult item,
            Listener listener
    ) {
        return createWithContext(activity, client, images, item,
                (asset, displayedPhotos) -> listener.onPhotoClick(asset));
    }

    public static View createWithContext(
            Activity activity,
            NikkiSyncClient client,
            ImageLoader images,
            ClothingSearchResult item,
            ContextListener listener
    ) {
        LinearLayout grid = new LinearLayout(activity);
        grid.setOrientation(LinearLayout.VERTICAL);

        List<ClothingSearchPhoto> photos = item.photos();
        int limit = Math.min(photos.size(), MAX_PHOTOS);
        List<AssetSummary> displayed = new ArrayList<>(limit);
        for (int i = 0; i < limit; i++) displayed.add(photos.get(i).asset());
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
                    row.addView(new View(activity), new LinearLayout.LayoutParams(0, dp(activity, 1), 1));
                    continue;
                }
                ClothingSearchPhoto photo = photos.get(index++);
                LinearLayout.LayoutParams cellLp = new LinearLayout.LayoutParams(
                        0,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        1
                );
                if (column > 0) cellLp.leftMargin = dp(activity, 7);
                row.addView(photoCell(activity, client, images, item, photo, displayedPhotos, listener), cellLp);
            }
            grid.addView(row, rowLp);
        }

        if (photos.size() > limit) {
            TextView more = label(
                    activity,
                    "当前显示前 " + limit + " 张，共 " + photos.size() + " 张",
                    11,
                    false,
                    activity.getColor(R.color.text_secondary)
            );
            more.setPadding(dp(activity, 4), dp(activity, 9), dp(activity, 4), 0);
            grid.addView(more);
        }
        return grid;
    }

    private static FrameLayout photoCell(
            Activity activity,
            NikkiSyncClient client,
            ImageLoader images,
            ClothingSearchResult item,
            ClothingSearchPhoto photo,
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

        TextView category = label(
                activity,
                categoryLabel(item.category()),
                10,
                true,
                activity.getColor(R.color.text_primary)
        );
        category.setPadding(dp(activity, 7), dp(activity, 4), dp(activity, 7), dp(activity, 4));
        category.setBackgroundResource(R.drawable.bg_glass_chip);
        FrameLayout.LayoutParams categoryLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.START
        );
        categoryLp.setMargins(dp(activity, 7), 0, dp(activity, 7), dp(activity, 7));
        cell.addView(category, categoryLp);

        if (photo.asset().hasMotion()) {
            TextView live = label(activity, "LIVE", 9, true, activity.getColor(R.color.text_primary));
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

    public static String categoryLabel(String category) {
        if (category == null || category.isBlank()) return "散件";
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
