package app.nikkisync.mobile.storage;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import java.nio.charset.StandardCharsets;

/** Private, disposable detail responses. Separate from the user's Saved-photo recovery snapshots. */
public final class AssetDetailCache extends SQLiteOpenHelper {
    private static AssetDetailCache shared;
    public static synchronized AssetDetailCache shared(Context context) {
        if(shared==null) shared=new AssetDetailCache(context.getApplicationContext());
        return shared;
    }
    private final long maxBytes;
    private final int maxEntries;
    private long lastAccess;
    private final java.util.Map<String,Long> generations=new java.util.HashMap<>();
    public synchronized long generation(String namespace) {return generations.getOrDefault(namespace,0L);}
    public AssetDetailCache(Context context) { this(context,32L*1024*1024,5000); }
    public AssetDetailCache(Context context,long maxBytes,int maxEntries) {
        super(context.getApplicationContext(),"nikkisync-detail-cache.db",null,1);
        this.maxBytes=maxBytes;this.maxEntries=maxEntries;
        setWriteAheadLoggingEnabled(true);
    }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE details (namespace TEXT NOT NULL, asset_id TEXT NOT NULL, revision INTEGER NOT NULL, "
                +"response TEXT, bytes INTEGER NOT NULL DEFAULT 0, accessed INTEGER NOT NULL, PRIMARY KEY(namespace,asset_id))");
        db.execSQL("CREATE INDEX detail_lru ON details(accessed)");
    }
    @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion) {
        db.execSQL("DROP TABLE IF EXISTS details");onCreate(db);
    }
    private long access() {return lastAccess=Math.max(System.currentTimeMillis(),lastAccess+1);}
    public synchronized String get(String namespace,String assetId) {
        SQLiteDatabase db=getWritableDatabase();String response=null;
        try(Cursor row=db.query("details",new String[]{"response"},"namespace=? AND asset_id=?",new String[]{namespace,assetId},null,null,null)) {
            if(row.moveToFirst()&&!row.isNull(0)) response=row.getString(0);
        }
        if(response!=null) {ContentValues values=new ContentValues();values.put("accessed",access());
            db.update("details",values,"namespace=? AND asset_id=?",new String[]{namespace,assetId});}
        return response;
    }
    private long revision(String namespace,String assetId) {
        try(Cursor row=getReadableDatabase().query("details",new String[]{"revision"},"namespace=? AND asset_id=?",new String[]{namespace,assetId},null,null,null)) {
            return row.moveToFirst()?row.getLong(0):-2;
        }
    }
    public synchronized void begin(String namespace,String assetId) {
        if(revision(namespace,assetId)!=-2)return;
        ContentValues values=row(namespace,assetId,-1);values.put("bytes",0);
        getWritableDatabase().insertWithOnConflict("details",null,values,SQLiteDatabase.CONFLICT_IGNORE);trim();
    }
    /** Revision markers also reject a response that finishes after a newer change notification. */
    public synchronized void observe(String namespace,String assetId,long revision) {
        long previous=revision(namespace,assetId);
        if(previous==-2||revision<0||revision<=previous) return;
        ContentValues values=row(namespace,assetId,revision);values.putNull("response");values.put("bytes",0);
        getWritableDatabase().insertWithOnConflict("details",null,values,SQLiteDatabase.CONFLICT_REPLACE);trim();
    }
    public synchronized void put(String namespace,String assetId,long revision,String response) {
        if(response==null||revision<revision(namespace,assetId)) return;
        long bytes=response.getBytes(StandardCharsets.UTF_8).length;
        if(bytes>Math.min(maxBytes,1024L*1024)) return;
        ContentValues values=row(namespace,assetId,revision);values.put("response",response);values.put("bytes",bytes);
        getWritableDatabase().insertWithOnConflict("details",null,values,SQLiteDatabase.CONFLICT_REPLACE);trim();
    }
    private ContentValues row(String namespace,String assetId,long revision) {
        ContentValues values=new ContentValues();values.put("namespace",namespace);values.put("asset_id",assetId);
        values.put("revision",revision);values.put("accessed",access());return values;
    }
    public synchronized void discard(String namespace,String assetId) {
        ContentValues values=new ContentValues();values.putNull("response");values.put("bytes",0);
        getWritableDatabase().update("details",values,"namespace=? AND asset_id=?",new String[]{namespace,assetId});
    }
    public synchronized void clear(String namespace) {
        generations.put(namespace,generation(namespace)+1);
        getWritableDatabase().delete("details","namespace=?",new String[]{namespace});
    }
    public synchronized long sizeBytes() {try(Cursor rows=getReadableDatabase().rawQuery("SELECT COALESCE(SUM(bytes),0) FROM details",null)) {rows.moveToFirst();return rows.getLong(0);}}
    private void trim() {
        SQLiteDatabase db=getWritableDatabase();long bytes=sizeBytes();long count;
        try(Cursor rows=db.rawQuery("SELECT COUNT(*) FROM details",null)) {rows.moveToFirst();count=rows.getLong(0);}
        if(bytes<=maxBytes&&count<=maxEntries) return;
        try(Cursor rows=db.rawQuery("SELECT rowid,bytes FROM details ORDER BY accessed,rowid",null)) {
            while((bytes>maxBytes||count>maxEntries)&&rows.moveToNext()) {
                db.delete("details","rowid=?",new String[]{Long.toString(rows.getLong(0))});bytes-=rows.getLong(1);count--;
            }
        }
    }
}
