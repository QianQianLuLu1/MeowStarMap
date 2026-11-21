package app.nikkisync.mobile.ui;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public final class GalleryTileLayoutTest {
    @Test public void selectionOutlineUsesExactlyThePhotoRadiusAndBounds() {
        var activity=Robolectric.buildActivity(Activity.class).setup().get();
        GalleryAdapter adapter=new GalleryAdapter(activity,null,()->null,null);
        ViewGroup tile=(ViewGroup)adapter.onCreateViewHolder(new FrameLayout(activity),1).itemView;
        ViewGroup photoFrame=(ViewGroup)tile.getChildAt(0);
        photoFrame.getChildAt(1).setVisibility(View.VISIBLE);
        checkWidths(tile,true);
        View image=photoFrame.getChildAt(0),selection=photoFrame.getChildAt(1);
        android.graphics.Outline photo=new android.graphics.Outline(),selected=new android.graphics.Outline();
        assertTrue(photoFrame.getClipToOutline());
        photoFrame.getBackground().getOutline(photo);selection.getBackground().getOutline(selected);
        assertEquals(photo.getRadius(),selected.getRadius(),.01f);
        assertEquals(image.getLeft(),selection.getLeft());assertEquals(image.getRight(),selection.getRight());
        assertEquals(image.getTop(),selection.getTop());assertEquals(image.getBottom(),selection.getBottom());
        activity.finish();
    }
    @Test public void galleryPhotoAndSelectionStaySquareAfterWidthChanges() {
        var controller = Robolectric.buildActivity(Activity.class).setup();
        try {
            Activity activity = controller.get();
            GalleryAdapter adapter = new GalleryAdapter(activity, null, () -> null, null);
            ViewGroup tile = (ViewGroup) adapter.onCreateViewHolder(new FrameLayout(activity), 1).itemView;
            checkWidths(tile, true);
        } finally { controller.pause().stop().destroy(); }
    }

    @Test public void savedPhotosUseTheSameSquareGeometry() {
        var controller = Robolectric.buildActivity(Activity.class).setup();
        SavedPhotoAdapter adapter = new SavedPhotoAdapter(controller.get(), null);
        try {
            ViewGroup tile = (ViewGroup) adapter.onCreateViewHolder(new FrameLayout(controller.get()), 1).itemView;
            checkWidths(tile, false);
        } finally { adapter.shutdown(); controller.pause().stop().destroy(); }
    }

    private void checkWidths(ViewGroup tile, boolean selection) {
        for (int width : new int[]{94, 132, 210}) {
            tile.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
            tile.layout(0, 0, tile.getMeasuredWidth(), tile.getMeasuredHeight());
            assertEquals("square cell after changing width", width, tile.getMeasuredHeight());
            View image = tile.getChildAt(0);
            assertEquals("photo stays square", image.getMeasuredWidth(), image.getMeasuredHeight());
            if (selection) {
                ViewGroup frame = (ViewGroup) image;
                View pixels = frame.getChildAt(0), overlay = frame.getChildAt(1);
                assertEquals("photo pixels fill the clipped tile", image.getWidth(), pixels.getWidth());
                assertEquals("selection bounds follow photo", pixels.getLayoutParams().height, overlay.getLayoutParams().height);
            }
        }
    }
}
