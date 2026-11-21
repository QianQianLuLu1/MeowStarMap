package app.nikkisync.mobile.ui;

import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.recyclerview.widget.RecyclerView;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.storage.SavedPhotoGroups;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
public class CompactSectionHeaderTest {
    @Test public void galleryVersionHeaderLeavesMoreSpaceForPhotographs() {
        var context=RuntimeEnvironment.getApplication();
        var adapter=new GalleryAdapter(context,null,()->null,new GalleryAdapter.Listener(){
            @Override public void onPhotoClick(AssetSummary asset) {}
            @Override public boolean onPhotoLongClick(AssetSummary asset) {return true;}
        });
        adapter.setItems(List.of(new AssetSummary("photo","photo","ready","2026-09-12T10:00:00Z",null,1,
                100,100,false,true,null,null,"2.9","inferred")));
        var header=adapter.onCreateViewHolder(new FrameLayout(context),adapter.getItemViewType(0));
        adapter.onBindViewHolder(header,0);
        measureHeader(header.itemView,context.getResources().getDisplayMetrics().density);
        assertTrue("the version heading must fit in one compact row; measured="+header.itemView.getMeasuredHeight()+" max="+dp(context,52),header.itemView.getMeasuredHeight()<=dp(context,52));
        assertTrue("version inference must remain visible",allText(header.itemView).contains("自动推测"));
    }

    @Test public void savedDateStaysPrimaryAndVersionMovesToQuietTrailingMetadata() {
        var activity=Robolectric.buildActivity(android.app.Activity.class).setup().get();
        var adapter=new SavedPhotoAdapter(activity,new SavedPhotoAdapter.Listener(){
            @Override public void onOriginalClick(app.nikkisync.mobile.storage.SavedPhotoStore.Record record) {}
            @Override public void onEditedClick(app.nikkisync.mobile.storage.EditedVariantStore.Variant variant) {}
        });
        try {
            adapter.setGroups(List.of(new SavedPhotoGroups.Group("source",List.of(),
                    1_779_000_000_000L,false,"2026-09-20T10:00:00Z","2.9")));
            RecyclerView.ViewHolder holder=adapter.onCreateViewHolder(new FrameLayout(activity),adapter.getItemViewType(0));
            adapter.onBindViewHolder(holder,0);
            measureHeader(holder.itemView,activity.getResources().getDisplayMetrics().density);
            LinearLayout row=(LinearLayout)holder.itemView;
            assertFalse("the date heading should not include the version",((TextView)row.getChildAt(0)).getText().toString().contains("版本"));
            assertTrue("version remains visible",((TextView)row.getChildAt(1)).getText().toString().contains("2.9"));
            assertTrue("saved heading measured="+holder.itemView.getMeasuredHeight()+" max="+dp(activity,48),holder.itemView.getMeasuredHeight()<=dp(activity,48));
        } finally {adapter.shutdown();activity.finish();}
    }

    private static void measureHeader(View view,float density) {
        view.measure(View.MeasureSpec.makeMeasureSpec(Math.round(360*density),View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(Math.round(300*density),View.MeasureSpec.AT_MOST));
    }
    private static int dp(android.content.Context context,int value) {return Math.round(value*context.getResources().getDisplayMetrics().density);}
    private static String allText(View view) {
        if(view instanceof TextView text)return text.getText().toString();
        if(view instanceof android.view.ViewGroup group){StringBuilder result=new StringBuilder();for(int i=0;i<group.getChildCount();i++)result.append(allText(group.getChildAt(i)));return result.toString();}
        return "";
    }
}
