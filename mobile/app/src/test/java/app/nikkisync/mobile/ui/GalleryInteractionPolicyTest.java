package app.nikkisync.mobile.ui;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class GalleryInteractionPolicyTest {
    @Test public void normalClickOpensViewer() {
        assertEquals(
                GalleryInteractionPolicy.Action.OPEN_VIEWER,
                GalleryInteractionPolicy.onClick(false)
        );
    }

    @Test public void normalLongPressStartsSelection() {
        assertEquals(
                GalleryInteractionPolicy.Action.TOGGLE_SELECTION,
                GalleryInteractionPolicy.onLongPress(false)
        );
    }

    @Test public void selectionModePhotoClickStillOpensPreview() {
        assertEquals(
                GalleryInteractionPolicy.Action.OPEN_VIEWER,
                GalleryInteractionPolicy.onClick(true)
        );
    }

    @Test public void selectionModeLongPressOpensSinglePhotoAdjust() {
        assertEquals(
                GalleryInteractionPolicy.Action.OPEN_SINGLE_ADJUST,
                GalleryInteractionPolicy.onLongPress(true)
        );
    }
}
