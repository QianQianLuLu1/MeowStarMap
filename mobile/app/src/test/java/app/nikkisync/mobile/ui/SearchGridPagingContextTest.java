package app.nikkisync.mobile.ui;

import static org.junit.Assert.assertEquals;

import android.app.Activity;
import android.view.View;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;

import app.nikkisync.mobile.media.ImageLoader;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.model.Models.ClothingSearchPhoto;
import app.nikkisync.mobile.model.Models.ClothingSearchResult;
import app.nikkisync.mobile.model.Models.SuitSearchPart;
import app.nikkisync.mobile.model.Models.SuitSearchPhoto;
import app.nikkisync.mobile.model.Models.SuitSearchResult;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.ArrayList;
import java.util.List;
import java.util.stream.IntStream;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public final class SearchGridPagingContextTest {
    @Test public void clothingClickReceivesOnlySixtyDisplayedPhotosInOrder() {
        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        ImageLoader images = new ImageLoader(activity);
        try {
            List<ClothingSearchPhoto> photos = IntStream.range(0, 62)
                    .mapToObj(i -> new ClothingSearchPhoto(asset(i))).toList();
            ClothingSearchResult result = new ClothingSearchResult(
                    "clothing", "name", "hair", null, null, 62, photos);
            List<String>[] clickedContext = new List[]{null};
            String[] clickedId = new String[1];
            View grid = ClothingSearchGrid.createWithContext(activity, null, images, result,
                    (asset, context) -> {
                        clickedId[0] = asset.assetId();
                        clickedContext[0] = ids(context);
                    });

            LinearLayout lastRow = (LinearLayout) ((LinearLayout) grid).getChildAt(19);
            lastRow.getChildAt(2).performClick();
            assertEquals("asset-59", clickedId[0]);
            assertEquals(IntStream.range(0, 60).mapToObj(i -> "asset-" + i).toList(), clickedContext[0]);
        } finally {
            images.shutdown();
        }
    }

    @Test public void suitCategoryClickReceivesCurrentFilteredPhotosIncludingBeyondAllCap() {
        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        ImageLoader images = new ImageLoader(activity);
        try {
            List<SuitSearchPhoto> photos = new ArrayList<>();
            for (int i = 0; i < 62; i++) {
                String category = i == 0 || i == 2 || i == 61 ? "hair" : "shoes";
                photos.add(new SuitSearchPhoto(asset(i),
                        List.of(new SuitSearchPart("part-" + i, "part", category))));
            }
            SuitSearchResult result = new SuitSearchResult("suit", "name", 2, null, 62, photos);
            List<String>[] clickedContext = new List[]{null};
            String[] clickedId = new String[1];
            LinearLayout root = (LinearLayout) SuitSearchGrid.createWithContext(
                    activity, null, images, result,
                    (asset, context) -> {
                        clickedId[0] = asset.assetId();
                        clickedContext[0] = ids(context);
                    });

            LinearLayout filters = (LinearLayout) ((HorizontalScrollView) root.getChildAt(0)).getChildAt(0);
            filters.getChildAt(1).performClick();
            LinearLayout grid = (LinearLayout) root.getChildAt(1);
            LinearLayout row = (LinearLayout) grid.getChildAt(0);
            row.getChildAt(2).performClick();
            assertEquals("asset-61", clickedId[0]);
            assertEquals(List.of("asset-0", "asset-2", "asset-61"), clickedContext[0]);
        } finally {
            images.shutdown();
        }
    }

    private static AssetSummary asset(int i) {
        return new AssetSummary("asset-" + i, "image", "ready", null, null, i,
                null, null, false, false, null, null, null, null);
    }

    private static List<String> ids(List<AssetSummary> assets) {
        return assets.stream().map(AssetSummary::assetId).toList();
    }
}
