package app.nikkisync.mobile.storage;

import android.content.Context;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import app.nikkisync.mobile.model.Models.AssetSummary;
import app.nikkisync.mobile.model.Models.PairedServer;
import org.json.*;
import java.util.*;

/** User-owned pending intentions survive app/process restarts, independently of disposable thumbnail caches. */
public final class OrganizerStore extends SQLiteOpenHelper {
    private static final String ACTIVE="state IN ('local','preparing','pending','confirming','queued','checking','executing','cancel_requested')";
    public record Entry(String id,AssetSummary asset,String state,String message,boolean batchVerified) {
        public Entry(String id,AssetSummary asset,String state,String message){this(id,asset,state,message,false);}
        public boolean pending(){return Set.of("local","preparing","pending","confirming","queued","checking").contains(state);}
    }
    public OrganizerStore(Context context){super(context.getApplicationContext(),"nikkisync-organizer.db",null,2);setWriteAheadLoggingEnabled(true);}
    public static String scope(PairedServer server){return server==null?"":server.serverId()+":"+server.tlsFingerprintSha256();}
    @Override public void onCreate(SQLiteDatabase db){
        db.execSQL("CREATE TABLE library(scope TEXT NOT NULL,asset_id TEXT NOT NULL,summary TEXT NOT NULL,snapshot_position INTEGER NOT NULL,PRIMARY KEY(scope,asset_id))");
        db.execSQL("CREATE TABLE deletions(id TEXT PRIMARY KEY,scope TEXT NOT NULL,asset_id TEXT NOT NULL,summary TEXT NOT NULL,state TEXT NOT NULL,message TEXT NOT NULL,created INTEGER NOT NULL,approval TEXT NOT NULL DEFAULT '')");
    }
    @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion){
        if(oldVersion==1&&newVersion==2){
            db.execSQL("ALTER TABLE library ADD COLUMN snapshot_position INTEGER NOT NULL DEFAULT 0");
            // v1 wrote the complete online snapshot in insertion order. Recover that
            // order while offline; do not rebuild chronology from nullable dates or IDs.
            db.execSQL("UPDATE library SET snapshot_position=rowid");
            return;
        }
        throw new IllegalStateException("Unsupported organizer schema");
    }
    @Override public void onOpen(SQLiteDatabase db){super.onOpen(db);db.execSQL("CREATE INDEX IF NOT EXISTS deletions_scope_state ON deletions(scope,state,created)");db.execSQL("CREATE INDEX IF NOT EXISTS deletions_scope_receipt ON deletions(scope,approval,created)");db.execSQL("CREATE TABLE IF NOT EXISTS library_snapshots(scope TEXT PRIMARY KEY,revision INTEGER NOT NULL,photo_count INTEGER NOT NULL,snapshot_format INTEGER NOT NULL DEFAULT 0)");
        boolean format=false;try(Cursor columns=db.rawQuery("PRAGMA table_info(library_snapshots)",null)){while(columns.moveToNext())if("snapshot_format".equals(columns.getString(columns.getColumnIndexOrThrow("name"))))format=true;}if(!format)db.execSQL("ALTER TABLE library_snapshots ADD COLUMN snapshot_format INTEGER NOT NULL DEFAULT 0");
    }
    public synchronized void remember(String scope,List<AssetSummary> assets)throws Exception{
        remember(scope,assets,-1);
    }
    public synchronized void remember(String scope,List<AssetSummary> assets,long revision)throws Exception{
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();try{db.delete("library","scope=?",new String[]{scope});
            try(var insert=db.compileStatement("INSERT INTO library(scope,asset_id,summary,snapshot_position) VALUES(?,?,?,?)")){
                int position=0;for(AssetSummary asset:assets){insert.clearBindings();insert.bindString(1,scope);insert.bindString(2,asset.assetId());insert.bindString(3,FavoritePhotoStore.encode(asset).toString());insert.bindLong(4,position++);insert.executeInsert();}
            }
            db.delete("library_snapshots","scope=?",new String[]{scope});
            if(revision>=0){ContentValues snapshot=new ContentValues();snapshot.put("scope",scope);snapshot.put("revision",revision);snapshot.put("photo_count",assets.size());snapshot.put("snapshot_format",2);db.insertOrThrow("library_snapshots",null,snapshot);}
            db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }
    public synchronized List<AssetSummary> library(String scope){List<AssetSummary> out=new ArrayList<>();try(Cursor rows=getReadableDatabase().rawQuery("SELECT summary FROM library WHERE scope=? ORDER BY snapshot_position ASC, rowid ASC",new String[]{scope})){while(rows.moveToNext())try{out.add(FavoritePhotoStore.decode(new JSONObject(rows.getString(0))));}catch(Exception ignored){}}return out;}
    public synchronized List<String> libraryIds(String scope){List<String> out=new ArrayList<>();try(Cursor rows=getReadableDatabase().rawQuery("SELECT asset_id FROM library WHERE scope=?",new String[]{scope})){while(rows.moveToNext())out.add(rows.getString(0));}return out;}
    public synchronized List<AssetSummary> libraryForIds(String scope,Set<String> wanted){
        List<String> ids=new ArrayList<>(wanted);List<AssetSummary> out=new ArrayList<>();
        for(int from=0;from<ids.size();from+=500){List<String> chunk=ids.subList(from,Math.min(from+500,ids.size()));List<String> args=new ArrayList<>();args.add(scope);args.addAll(chunk);
            String placeholders=String.join(",",Collections.nCopies(chunk.size(),"?"));try(Cursor rows=getReadableDatabase().rawQuery("SELECT summary FROM library WHERE scope=? AND asset_id IN ("+placeholders+")",args.toArray(new String[0]))){while(rows.moveToNext())try{out.add(FavoritePhotoStore.decode(new JSONObject(rows.getString(0))));}catch(Exception ignored){}}
        }return out;
    }
    public synchronized app.nikkisync.mobile.net.LibraryPager.Snapshot snapshot(String scope){
        try(Cursor row=getReadableDatabase().rawQuery("SELECT revision,photo_count,snapshot_format FROM library_snapshots WHERE scope=?",new String[]{scope})){
            if(!row.moveToFirst()||row.getInt(2)!=2)return null;long revision=row.getLong(0),count=row.getLong(1);List<AssetSummary> items=library(scope);
            return revision>=0&&count==items.size()?new app.nikkisync.mobile.net.LibraryPager.Snapshot(items,revision):null;
        }
    }
    public synchronized List<Entry> entries(String scope){
        // Keep tombstones in SQLite for replay protection; only hydrate active work,
        // one protocol-sized receipt batch and the latest 50 completed summaries.
        String query="SELECT id,summary,state,message,approval FROM deletions WHERE scope=? AND ("+ACTIVE+
            " OR id IN (SELECT id FROM deletions WHERE scope=? AND approval='result:pending' ORDER BY created DESC,rowid DESC LIMIT 500)"+
            " OR id IN (SELECT id FROM deletions WHERE scope=? AND NOT ("+ACTIVE+") AND approval<>'result:pending' ORDER BY created DESC,rowid DESC LIMIT 50)) ORDER BY created DESC,rowid DESC";
        List<Entry> out=new ArrayList<>();try(Cursor rows=getReadableDatabase().rawQuery(query,new String[]{scope,scope,scope})){while(rows.moveToNext())try{out.add(new Entry(rows.getString(0),FavoritePhotoStore.decode(new JSONObject(rows.getString(1))),rows.getString(2),rows.getString(3),"batch:verified".equals(rows.getString(4))));}catch(Exception ignored){}}return out;
    }
    public synchronized void enqueue(String scope,List<AssetSummary> photos)throws Exception{
        if(scope.isBlank())throw new IllegalStateException("No paired computer");
        var existing=entries(scope);long count=existing.stream().filter(e->e.pending()||e.state().equals("executing")||e.state().equals("cancel_requested")).count();
        if(count+photos.size()>500)throw new IllegalStateException("待处理照片最多 500 张，请先连接电脑处理");
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();try{for(AssetSummary asset:photos){
            if(existing.stream().anyMatch(e->e.asset().assetId().equals(asset.assetId())&&(e.pending()||e.state().equals("executing"))))continue;
            ContentValues value=new ContentValues();value.put("id",UUID.randomUUID().toString());value.put("scope",scope);value.put("asset_id",asset.assetId());value.put("summary",FavoritePhotoStore.encode(asset).toString());value.put("state","local");value.put("message","仅手机记录 · 等待重连并由电脑确认");value.put("created",System.currentTimeMillis());db.insertOrThrow("deletions",null,value);
        }db.setTransactionSuccessful();}finally{db.endTransaction();}
    }
    public synchronized void cancel(String scope,Collection<String> ids){SQLiteDatabase db=getWritableDatabase();db.beginTransaction();try{for(String id:ids){
        ContentValues values=new ContentValues();values.put("state","cancel_requested");values.put("message","已在手机取消，重连后通知电脑；若电脑已开始处理，请检查回收站");
        db.update("deletions",values,"scope=? AND id=? AND state IN ('local','preparing','pending','confirming','queued','checking')",new String[]{scope,id});
    }db.setTransactionSuccessful();}finally{db.endTransaction();}}
    private String approval(String scope,String id){try(Cursor row=getReadableDatabase().rawQuery("SELECT approval FROM deletions WHERE scope=? AND id=?",new String[]{scope,id})){return row.moveToFirst()?row.getString(0):"";}}
    public synchronized JSONArray outgoing(String scope)throws Exception{
        JSONArray items=new JSONArray();List<Entry> entries=entries(scope),ordered=new ArrayList<>();
        for(Entry entry:entries)if(entry.pending()||entry.state().equals("executing")||entry.state().equals("cancel_requested"))ordered.add(entry);
        for(Entry entry:entries)if(!entry.pending()&&!entry.state().equals("executing")&&!entry.state().equals("cancel_requested")&&approval(scope,entry.id()).equals("result:pending"))ordered.add(entry);
        for(Entry entry:ordered){if(items.length()>=500)break;
            JSONObject item=new JSONObject().put("id",entry.id()).put("assetId",entry.asset().assetId()).put("revision",entry.asset().revision()).put("cancel",entry.state().equals("cancel_requested")).put("batchVerification",true);
            if(entry.asset().mediaFingerprint()!=null)item.put("mediaFingerprint",entry.asset().mediaFingerprint());
            String approval=approval(scope,entry.id());if(entry.state().equals("confirming"))item.put("approval",approval);
            if(approval.equals("result:pending"))item.put("resultAck",true);items.put(item);
        }return items;
    }
    public synchronized void acknowledge(String scope,JSONArray results)throws Exception{SQLiteDatabase db=getWritableDatabase();db.beginTransaction();try{
        for(int i=0;i<results.length();i++){JSONObject row=results.getJSONObject(i);String state=row.getString("state");
            if(!Set.of("preparing","pending","confirming","queued","checking","cancelled","recycled","rejected","changed","failed","executing").contains(state))continue;
            ContentValues values=new ContentValues();values.put("state",state);values.put("message",row.optString("message"));
            boolean terminal=Set.of("cancelled","recycled","rejected","changed","failed").contains(state);
            values.put("approval",terminal&&row.has("resultAcknowledged")&&!row.optBoolean("resultAcknowledged")?"result:pending":!terminal&&row.optBoolean("batchVerified")?"batch:verified":row.optString("approval",""));
            String where="scope=? AND id=?"+(Set.of("preparing","pending","confirming","queued","checking").contains(state)?" AND state<>'cancel_requested'":"");db.update("deletions",values,where,new String[]{scope,row.getString("id")});
        }db.setTransactionSuccessful();}finally{db.endTransaction();}}
    /** A new desktop challenge gets one prompt follow-up, not another 15-second polling interval. */
    public static boolean needsFollowUp(JSONArray sent,JSONArray received){
        for(int i=0;i<received.length();i++){JSONObject row=received.optJSONObject(i);if(row!=null&&Set.of("cancelled","recycled","rejected","changed","failed").contains(row.optString("state"))&&row.has("resultAcknowledged")&&!row.optBoolean("resultAcknowledged"))return true;}
        for(int i=0;i<received.length();i++){JSONObject row=received.optJSONObject(i);if(row==null||!"confirming".equals(row.optString("state")))continue;
            String approval=row.optString("approval","");if(approval.isBlank())continue;
            for(int j=0;j<sent.length();j++){JSONObject request=sent.optJSONObject(j);if(request!=null&&row.optString("id").equals(request.optString("id"))&&!request.optBoolean("cancel")&&!approval.equals(request.optString("approval","")))return true;}
        }return false;
    }
}
