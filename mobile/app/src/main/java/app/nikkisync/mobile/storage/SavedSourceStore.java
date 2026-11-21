package app.nikkisync.mobile.storage;
import android.content.*;
import android.database.Cursor;
import android.database.sqlite.*;
import app.nikkisync.mobile.model.Models.AssetSummary;
import org.json.JSONObject;
/** Source descriptors for saved/linked photos survive changes to the shared gallery scope. */
public final class SavedSourceStore extends SQLiteOpenHelper {
    public SavedSourceStore(Context context){super(context.getApplicationContext(),"nikkisync-saved-sources.db",null,1);}
    @Override public void onCreate(SQLiteDatabase db){db.execSQL("CREATE TABLE sources(asset_id TEXT PRIMARY KEY,summary TEXT NOT NULL)");}
    @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion){throw new IllegalStateException("Unsupported saved source schema");}
    public synchronized void put(AssetSummary asset){putAll(java.util.List.of(asset));}
    public synchronized void putAll(java.util.List<AssetSummary> assets){
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();try(var insert=db.compileStatement("INSERT OR REPLACE INTO sources(asset_id,summary) VALUES(?,?)")){
            for(AssetSummary asset:assets){JSONObject row=FavoritePhotoStore.encode(asset);
                if(asset.sourcePath()==null||asset.uid()==null){AssetSummary old=get(asset.assetId());if(old!=null){JSONObject previous=FavoritePhotoStore.encode(old);for(String key:new String[]{"uid","sourcePath","sourceFolder","sizeBytes"})if(!row.has(key)&&previous.has(key))row.put(key,previous.get(key));}}
                insert.clearBindings();insert.bindString(1,asset.assetId());insert.bindString(2,row.toString());insert.executeInsert();
            }db.setTransactionSuccessful();
        }catch(Exception ignored){}finally{db.endTransaction();}
    }
    public synchronized AssetSummary get(String id){try(Cursor row=getReadableDatabase().rawQuery("SELECT summary FROM sources WHERE asset_id=?",new String[]{id})){if(row.moveToFirst())return FavoritePhotoStore.decode(new JSONObject(row.getString(0)));}catch(Exception ignored){}return null;}
    public synchronized java.util.Map<String,AssetSummary> all(){var out=new java.util.HashMap<String,AssetSummary>();try(Cursor rows=getReadableDatabase().rawQuery("SELECT summary FROM sources",null)){while(rows.moveToNext())try{var asset=FavoritePhotoStore.decode(new JSONObject(rows.getString(0)));out.put(asset.assetId(),asset);}catch(Exception ignored){}}catch(Exception ignored){}return out;}
}
