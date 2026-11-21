package app.nikkisync.mobile.ui;

import android.widget.Button;
import android.widget.FrameLayout;
import android.view.ViewGroup;
import app.nikkisync.mobile.model.Models.AssetSummary;
import java.util.List;
import java.util.Set;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.Robolectric;
import android.app.Activity;
import android.view.MotionEvent;
import android.view.View;
import androidx.recyclerview.widget.RecyclerView;
import androidx.recyclerview.widget.GridLayoutManager;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
public class GalleryBatchSelectionTest {
    private AssetSummary asset(String id, String version) {
        return new AssetSummary(id,"photo","ready",null,null,1,100,100,false,true,null,null,version,"inferred");
    }
    private GalleryAdapter adapter() {
        return new GalleryAdapter(RuntimeEnvironment.getApplication(),null,()->null,new GalleryAdapter.Listener() {
            public void onPhotoClick(AssetSummary a) {}
            public boolean onPhotoLongClick(AssetSummary a) { return false; }
        });
    }
    @Test public void horizontalSweepUsesVisibleTilesWhileVerticalMovementKeepsScrolling() {
        var controller=Robolectric.buildActivity(Activity.class).setup();
        try {
            Activity activity=controller.get();
            var adapter=adapter();
            var a=asset("a","2.11");var b=asset("b","2.11");var c=asset("c","2.11");var d=asset("d","2.10");
            adapter.setItems(List.of(a,b,c,d));adapter.toggle(d);
            RecyclerView list=new RecyclerView(activity);
            GridLayoutManager layout=new GridLayoutManager(activity,3);
            layout.setSpanSizeLookup(new GridLayoutManager.SpanSizeLookup() {
                @Override public int getSpanSize(int position) { return adapter.isHeader(position)?3:1; }
            });
            list.setLayoutManager(layout);list.setAdapter(adapter);activity.setContentView(list);
            list.measure(View.MeasureSpec.makeMeasureSpec(900,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(1600,View.MeasureSpec.EXACTLY));
            list.layout(0,0,900,1600);
            View start=list.findViewHolderForAdapterPosition(1).itemView,end=list.findViewHolderForAdapterPosition(3).itemView;
            float x=start.getLeft()+start.getWidth()/2f,y=start.getTop()+start.getHeight()/2f;
            var gesture=new GalleryDragSelection(list,adapter);
            MotionEvent down=MotionEvent.obtain(0,0,MotionEvent.ACTION_DOWN,x,y,0);
            MotionEvent vertical=MotionEvent.obtain(0,50,MotionEvent.ACTION_MOVE,x,y+100,0);
            assertFalse(gesture.onInterceptTouchEvent(list,down));
            assertFalse(gesture.onInterceptTouchEvent(list,vertical));
            assertEquals(1,adapter.selectedCount());
            gesture.onInterceptTouchEvent(list,down);
            MotionEvent sweep=MotionEvent.obtain(0,100,MotionEvent.ACTION_MOVE,end.getLeft()+end.getWidth()/2f,y,0);
            assertTrue(gesture.onInterceptTouchEvent(list,sweep));assertEquals(4,adapter.selectedCount());
            MotionEvent cancel=MotionEvent.obtain(0,110,MotionEvent.ACTION_CANCEL,x,y,0);
            gesture.onTouchEvent(list,cancel);adapter.extendRangeSelection(1);assertEquals(4,adapter.selectedCount());
            down.recycle();vertical.recycle();sweep.recycle();cancel.recycle();
        } finally { controller.pause().stop().destroy(); }
    }
    @Test public void groupButtonSelectsOnlyItsVisibleVersionAndCanUndo() {
        var adapter=adapter();
        var a=asset("a","2.11");var b=asset("b","2.11");var c=asset("c","2.10");
        adapter.setItems(List.of(a,b,c));adapter.enableGroupSelection();adapter.toggle(c);
        var holder=adapter.onCreateViewHolder(new FrameLayout(RuntimeEnvironment.getApplication()),0);
        adapter.onBindViewHolder(holder,0);
        Button button=(Button)((ViewGroup)holder.itemView).getChildAt(2);
        assertEquals("全选",button.getText().toString());button.performClick();
        assertEquals(3,adapter.selectedCount());
        adapter.onBindViewHolder(holder,0);
        assertEquals("取消全选",button.getText().toString());button.performClick();
        assertEquals(List.of(c),adapter.selectedItems());
    }
    @Test public void recentHeaderSelectsOnlyCurrentBatchAndCanUndo() {
        var adapter=adapter();
        var old=asset("old","2.11");var newOne=asset("new-one","2.11");var newTwo=asset("new-two","2.10");
        adapter.setItems(List.of(newOne,newTwo,old),Set.of("new-one","new-two"));adapter.enableGroupSelection();
        var holder=adapter.onCreateViewHolder(new FrameLayout(RuntimeEnvironment.getApplication()),0);
        adapter.onBindViewHolder(holder,0);
        Button button=(Button)((ViewGroup)holder.itemView).getChildAt(2);
        assertEquals("全选",button.getText().toString());button.performClick();
        assertEquals(List.of(newOne,newTwo),adapter.selectedItems());
        adapter.onBindViewHolder(holder,0);button.performClick();
        assertTrue(adapter.selectedItems().isEmpty());
    }
    @Test public void sweepCrossesVersionHeadersAndBacktrackingRestoresPriorSelections() {
        var adapter=adapter();
        var a=asset("a","2.11");var b=asset("b","2.11");var c=asset("c","2.10");var d=asset("d","2.10");
        adapter.setItems(List.of(a,b,c,d));adapter.toggle(d);
        assertTrue(adapter.beginRangeSelection(1));adapter.extendRangeSelection(4);
        assertEquals(4,adapter.selectedCount());
        adapter.extendRangeSelection(1);
        assertEquals(List.of(a,d),adapter.selectedItems());
        adapter.endRangeSelection();adapter.extendRangeSelection(5);
        assertEquals(List.of(a,d),adapter.selectedItems());
        assertTrue(adapter.beginRangeSelection(1));adapter.extendRangeSelection(5);
        assertEquals(0,adapter.selectedCount());
        adapter.endRangeSelection();
    }
}
