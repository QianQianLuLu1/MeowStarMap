package app.nikkisync.mobile.ui;

import static org.junit.Assert.*;
import android.widget.FrameLayout;
import app.nikkisync.mobile.storage.EditedVariantStore;
import app.nikkisync.mobile.storage.SavedPhotoGroups;
import app.nikkisync.mobile.storage.SavedPhotoHealthStore;
import app.nikkisync.mobile.storage.SavedPhotoStore;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
@org.robolectric.annotation.Config(sdk={30,31,32,35})
public class SavedMissingPhotoTest {
    @Test public void missingOriginalOpensViewerAndLongPressStillOffersRemoval() {
        var controller=Robolectric.buildActivity(android.app.Activity.class).setup();
        var record=new SavedPhotoStore.Record("a","content://missing/photo",100,false,0,null,null,"JPEG");
        AtomicInteger opened=new AtomicInteger(), removed=new AtomicInteger();
        var adapter=new SavedPhotoAdapter(controller.get(),new SavedPhotoAdapter.Listener(){
            @Override public void onOriginalClick(SavedPhotoStore.Record item){opened.incrementAndGet();}
            @Override public void onEditedClick(EditedVariantStore.Variant item){}
            @Override public void onRemoveOriginal(SavedPhotoStore.Record item){removed.incrementAndGet();}
        });
        try {
            adapter.setGroups(SavedPhotoGroups.select(List.of(record),List.of(),0,0));
            adapter.setHealth(Map.of(record.uri(),new SavedPhotoHealthStore.Entry(SavedPhotoHealthStore.State.MISSING,1)));
            var holder=adapter.onCreateViewHolder(new FrameLayout(controller.get()),1);adapter.onBindViewHolder(holder,1);
            holder.itemView.performClick();assertEquals(1,opened.get());assertEquals(0,removed.get());
            holder.itemView.performLongClick();assertEquals(1,removed.get());
        } finally {adapter.shutdown();controller.pause().stop().destroy();}
    }
}
