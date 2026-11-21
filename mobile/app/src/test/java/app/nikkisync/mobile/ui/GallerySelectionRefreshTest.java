package app.nikkisync.mobile.ui;

import android.graphics.drawable.ColorDrawable;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageView;
import androidx.recyclerview.widget.RecyclerView;
import app.nikkisync.mobile.media.ImageLoader;
import app.nikkisync.mobile.model.Models.AssetSummary;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class GallerySelectionRefreshTest {
    @Test public void selectingAndHeartbeatRefreshKeepBoundPixelsAndSelection(){
        var context=RuntimeEnvironment.getApplication();var images=new ImageLoader(context);
        try{
            var asset=new AssetSummary("photo","photo","ready",null,null,1,100,100,false,false,null,null,null,null);
            var adapter=new GalleryAdapter(context,images,()->null,new GalleryAdapter.Listener(){
                public void onPhotoClick(AssetSummary a){} public boolean onPhotoLongClick(AssetSummary a){return false;}
            });
            adapter.setItems(List.of(asset));int position=1;
            var holder=adapter.onCreateViewHolder(new FrameLayout(context),adapter.getItemViewType(position));
            adapter.onBindViewHolder(holder,position);
            FrameLayout tile=(FrameLayout)holder.itemView;
            ImageView image=(ImageView)((FrameLayout)tile.getChildAt(0)).getChildAt(0);
            View mark=tile.getChildAt(2);
            var pixels=new ColorDrawable(0xffef9fb8);image.setImageDrawable(pixels);
            int[] fullRefresh={0},partial={0};
            adapter.registerAdapterDataObserver(new RecyclerView.AdapterDataObserver(){
                @Override public void onChanged(){fullRefresh[0]++;}
                @Override public void onItemRangeChanged(int start,int count,Object payload){
                    assertNotNull(payload);partial[0]++;
                    adapter.onBindViewHolder(holder,position,List.of(payload));
                }
            });
            adapter.toggle(asset);assertTrue(adapter.isSelected(asset));assertSame(pixels,image.getDrawable());
            assertEquals(View.VISIBLE,mark.getVisibility());assertTrue(mark.isActivated());
            adapter.setItems(List.of(asset));assertTrue(adapter.isSelected(asset));assertSame(pixels,image.getDrawable());
            adapter.clearSelection();assertFalse(adapter.hasSelection());assertSame(pixels,image.getDrawable());
            assertEquals(View.GONE,mark.getVisibility());assertFalse(mark.isActivated());
            assertEquals(0,fullRefresh[0]);assertEquals(2,partial[0]);
        }finally{images.shutdown();}
    }
}
