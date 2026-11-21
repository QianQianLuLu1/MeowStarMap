package app.nikkisync.mobile.storage;

import android.content.Context;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class SavedPhotoVerifier {
    private SavedPhotoVerifier() {}
    public static boolean mayRemoveRecord(SavedPhotoHealthStore.State phoneState,boolean computerExplicitlyDeleted){
        return phoneState==SavedPhotoHealthStore.State.MISSING&&computerExplicitlyDeleted;
    }
    public static Map<String,SavedPhotoHealthStore.Entry> verify(Context context,SavedPhotoHealthStore healthStore,List<SavedPhotoStore.Record> records){
        Map<String,SavedPhotoHealthStore.Entry> result=new LinkedHashMap<>();long checkedAt=System.currentTimeMillis();
        for(SavedPhotoStore.Record record:records){
            SavedPhotoHealthStore.State state=checkUri(context,record.uri());
            if(state==SavedPhotoHealthStore.State.ACTIVE){
                for(String companion:record.companionUris())if(checkUri(context,companion)!=SavedPhotoHealthStore.State.ACTIVE){state=SavedPhotoHealthStore.State.MOTION_MISSING;break;}
                if(state==SavedPhotoHealthStore.State.ACTIVE&&record.companionUris().isEmpty()
                    &&(record.format()!=null&&record.format().contains("OriginOS LIVE")||"vivo_legacy_pair".equals(record.motionProfileId())))state=SavedPhotoHealthStore.State.MOTION_UNVERIFIED;
            }
            healthStore.put(record.uri(),state,checkedAt);result.put(record.uri(),new SavedPhotoHealthStore.Entry(state,checkedAt));
        }return result;
    }
    public static Map<String,SavedPhotoHealthStore.Entry> verifyUris(Context context,SavedPhotoHealthStore healthStore,List<String> uris){
        Map<String,SavedPhotoHealthStore.Entry> result=new LinkedHashMap<>();long checkedAt=System.currentTimeMillis();
        for(String uri:uris){if(uri==null||uri.isBlank()||result.containsKey(uri))continue;
            SavedPhotoHealthStore.State state=checkUri(context,uri);
            healthStore.put(uri,state,checkedAt);result.put(uri,new SavedPhotoHealthStore.Entry(state,checkedAt));
        }return result;
    }
    public static SavedPhotoHealthStore.State checkUri(Context context,String uri){
        Uri parsed=Uri.parse(uri);
        if("media".equals(parsed.getAuthority()))try(android.database.Cursor row=context.getContentResolver().query(parsed,
                new String[]{android.provider.MediaStore.MediaColumns.IS_TRASHED},null,null,null)){
            if(row!=null&&row.moveToFirst()&&row.getInt(0)!=0)return SavedPhotoHealthStore.State.MISSING;
        }catch(Exception ignored){/* An unsupported query is not proof of deletion. */}
        try(ParcelFileDescriptor descriptor=context.getContentResolver().openFileDescriptor(parsed,"r")){
            return descriptor!=null?SavedPhotoHealthStore.State.ACTIVE:SavedPhotoHealthStore.State.UNAVAILABLE;
        }catch(java.io.FileNotFoundException missing){return SavedPhotoHealthStore.State.MISSING;}
        catch(Exception unavailable){return SavedPhotoHealthStore.State.UNAVAILABLE;}
    }
}
