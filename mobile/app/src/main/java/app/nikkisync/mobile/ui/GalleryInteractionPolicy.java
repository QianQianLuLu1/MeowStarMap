package app.nikkisync.mobile.ui;

public final class GalleryInteractionPolicy {
    public enum Action {
        OPEN_VIEWER,
        TOGGLE_SELECTION,
        OPEN_SINGLE_ADJUST
    }

    private GalleryInteractionPolicy() {}

    public static Action onClick(boolean selectionActive) {
        return Action.OPEN_VIEWER;
    }

    public static Action onLongPress(boolean selectionActive) {
        return selectionActive ? Action.OPEN_SINGLE_ADJUST : Action.TOGGLE_SELECTION;
    }
}
