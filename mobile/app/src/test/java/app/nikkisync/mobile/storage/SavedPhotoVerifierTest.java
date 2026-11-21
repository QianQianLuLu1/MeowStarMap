package app.nikkisync.mobile.storage;

import static org.junit.Assert.*;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import java.io.FileNotFoundException;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.shadows.ShadowContentResolver;

@RunWith(RobolectricTestRunner.class)
public class SavedPhotoVerifierTest {
    @Test public void permissionFailureIsNotDeletion(){
        var context=RuntimeEnvironment.getApplication();
        ContentProvider provider=new ContentProvider(){
            @Override public boolean onCreate(){return true;}
            @Override public String getType(Uri uri){return "image/jpeg";}
            @Override public Cursor query(Uri u,String[] p,String s,String[] a,String o){return null;}
            @Override public Uri insert(Uri u,ContentValues v){return null;}
            @Override public int delete(Uri u,String s,String[] a){return 0;}
            @Override public int update(Uri u,ContentValues v,String s,String[] a){return 0;}
            @Override public ParcelFileDescriptor openFile(Uri uri,String mode)throws FileNotFoundException{
                if(uri.getPath().contains("denied"))throw new SecurityException("no access");
                throw new FileNotFoundException();
            }
        };
        var info=new android.content.pm.ProviderInfo();info.authority="saved.check";provider.attachInfo(context,info);
        ShadowContentResolver.registerProviderInternal("saved.check",provider);
        assertEquals(SavedPhotoHealthStore.State.MISSING,SavedPhotoVerifier.checkUri(context,"content://saved.check/missing"));
        assertEquals(SavedPhotoHealthStore.State.UNAVAILABLE,SavedPhotoVerifier.checkUri(context,"content://saved.check/denied"));
    }
    @Test public void removeOnlyWhenBothSidesAreConfirmedDeleted(){
        assertTrue(SavedPhotoVerifier.mayRemoveRecord(SavedPhotoHealthStore.State.MISSING,true));
        assertFalse(SavedPhotoVerifier.mayRemoveRecord(SavedPhotoHealthStore.State.MISSING,false));
        assertFalse(SavedPhotoVerifier.mayRemoveRecord(SavedPhotoHealthStore.State.UNAVAILABLE,true));
        assertFalse(SavedPhotoVerifier.mayRemoveRecord(SavedPhotoHealthStore.State.ACTIVE,true));
    }
    @Test public void oldCleanupResultCannotRemoveAReplacedRecord(){
        var context=RuntimeEnvironment.getApplication();var store=new SavedPhotoStore(context);
        var first=new app.nikkisync.mobile.model.Models.AssetSummary("old","photo","ready",null,null,1,null,null,false,false,null,null,null,null);
        var replacement=new app.nikkisync.mobile.model.Models.AssetSummary("new","photo","ready",null,null,1,null,null,false,false,null,null,null,null);
        Uri uri=Uri.parse("content://saved.check/reused");store.record(first,uri,0,"jpeg");var old=store.load().stream().filter(r->r.uri().equals(uri.toString())).findFirst().orElseThrow();
        store.record(replacement,uri,0,"jpeg");store.removeIfUnchanged(old);
        assertTrue(store.load().stream().anyMatch(r->r.uri().equals(uri.toString())&&r.assetId().equals("new")));
        store.removeUri(uri.toString());
    }
}
