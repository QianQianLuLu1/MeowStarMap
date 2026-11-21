package app.nikkisync.mobile.ui;

import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import androidx.recyclerview.widget.RecyclerView;

/** Horizontal sweep starts selection. Vertical swipes continue to scroll normally. */
public final class GalleryDragSelection extends RecyclerView.SimpleOnItemTouchListener {
    private final RecyclerView list;
    private final GalleryAdapter adapter;
    private final int slop, edge;
    private float downX, downY, x, y;
    private int anchor = RecyclerView.NO_POSITION;
    private boolean dragging;
    private final Runnable autoScroll = new Runnable() {
        @Override public void run() {
            if (!dragging || !list.isAttachedToWindow()) return;
            int dy = y < edge ? -edge / 5 : y > list.getHeight() - edge ? edge / 5 : 0;
            if (dy != 0 && list.canScrollVertically(Integer.signum(dy))) {
                list.scrollBy(0, dy);
                extend();
            }
            list.postOnAnimation(this);
        }
    };

    public GalleryDragSelection(RecyclerView list, GalleryAdapter adapter) {
        this.list = list;
        this.adapter = adapter;
        slop = ViewConfiguration.get(list.getContext()).getScaledTouchSlop();
        edge = Math.round(48 * list.getResources().getDisplayMetrics().density);
        adapter.registerAdapterDataObserver(new RecyclerView.AdapterDataObserver() {
            @Override public void onChanged() { finish(); }
        });
    }
    @Override public boolean onInterceptTouchEvent(RecyclerView rv, MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
            finish();
            downX = x = event.getX();
            downY = y = event.getY();
            anchor = position(x, y);
        } else if (event.getActionMasked() == MotionEvent.ACTION_MOVE && adapter.hasSelection()
                && Math.abs(event.getX() - downX) > slop
                && Math.abs(event.getX() - downX) > Math.abs(event.getY() - downY)) {
            dragging = adapter.beginRangeSelection(anchor);
            if (dragging) {
                x = event.getX(); y = event.getY();
                rv.getParent().requestDisallowInterceptTouchEvent(true);
                extend();
                list.postOnAnimation(autoScroll);
            }
            return dragging;
        }
        return false;
    }
    @Override public void onTouchEvent(RecyclerView rv, MotionEvent event) {
        if (event.getPointerCount() != 1 || event.getActionMasked() == MotionEvent.ACTION_UP
                || event.getActionMasked() == MotionEvent.ACTION_CANCEL) {
            finish();
            return;
        }
        x = event.getX(); y = event.getY();
        extend();
    }
    private int position(float px, float py) {
        View child = list.findChildViewUnder(px, py);
        return child == null ? RecyclerView.NO_POSITION : list.getChildAdapterPosition(child);
    }
    private void extend() {
        adapter.extendRangeSelection(position(x, Math.max(0, Math.min(list.getHeight() - 1, y))));
    }
    public void finish() {
        dragging = false;
        anchor = RecyclerView.NO_POSITION;
        list.removeCallbacks(autoScroll);
        adapter.endRangeSelection();
    }
}
