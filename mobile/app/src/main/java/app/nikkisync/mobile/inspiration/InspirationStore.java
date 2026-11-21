package app.nikkisync.mobile.inspiration;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.io.FileInputStream;
import java.security.MessageDigest;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Offline, user-owned inspiration notes. Resolver snapshots never replace the original share text. */
public final class InspirationStore extends SQLiteOpenHelper {
    public record Draft(String title, String rawCode, String codeType, String sourceText, String sourceUrl,
                        String notes, List<String> tags, List<String> categories, String status) {}
    public record Code(String id, String rawCode, String type, String sourceText, String sourceUrl,
                       String parsedState, String snapshotId, String snapshotJson,
                       String resolverVersion, String dictionaryVersion, long resolvedAt) {}
    public record Image(String id, String localName, String mimeType, long bytes, long addedAt) {}
    public record Entry(String id, String title, String notes, List<String> tags, List<String> categories,
                        String status, long createdAt, long updatedAt, long deletedAt, Code code, List<Image> images) {}

    private static final String DATABASE = "nikkisync-inspiration.db";
    public InspirationStore(Context context) { super(context.getApplicationContext(), DATABASE, null, 2); }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE inspiration_entries (id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL, "
                + "tags_json TEXT NOT NULL, categories_json TEXT NOT NULL, status TEXT NOT NULL, "
                + "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE INDEX inspiration_entries_updated ON inspiration_entries(updated_at, id)");
        db.execSQL("CREATE TABLE inspiration_codes (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL UNIQUE, "
                + "type TEXT NOT NULL, raw_code TEXT NOT NULL, source_text TEXT NOT NULL, source_url TEXT, "
                + "parsed_state TEXT NOT NULL, snapshot_id TEXT, FOREIGN KEY(entry_id) REFERENCES inspiration_entries(id))");
        db.execSQL("CREATE TABLE inspiration_snapshots (id TEXT PRIMARY KEY, code_id TEXT NOT NULL, payload_json TEXT NOT NULL, "
                + "resolver_version TEXT NOT NULL, dictionary_version TEXT NOT NULL, resolved_at INTEGER NOT NULL, "
                + "FOREIGN KEY(code_id) REFERENCES inspiration_codes(id))");
        db.execSQL("CREATE TABLE inspiration_images (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, "
                + "local_name TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL, bytes INTEGER NOT NULL, added_at INTEGER NOT NULL, "
                + "FOREIGN KEY(entry_id) REFERENCES inspiration_entries(id))");
        db.execSQL("CREATE INDEX inspiration_images_entry ON inspiration_images(entry_id, added_at)");
        createSyncTables(db);
    }

    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if(oldVersion<2)createSyncTables(db);
    }
    private static void createSyncTables(SQLiteDatabase db){
        db.execSQL("CREATE TABLE IF NOT EXISTS inspiration_sync_state (server_id TEXT NOT NULL, entry_id TEXT NOT NULL, revision INTEGER NOT NULL, local_hash TEXT NOT NULL, PRIMARY KEY(server_id,entry_id))");
        db.execSQL("CREATE TABLE IF NOT EXISTS inspiration_image_hash (local_name TEXT PRIMARY KEY, bytes INTEGER NOT NULL, modified INTEGER NOT NULL, sha256 TEXT NOT NULL)");
    }
    @Override public void onOpen(SQLiteDatabase db){super.onOpen(db);createSyncTables(db);}

    public synchronized Entry create(Draft draft, long now) {
        if (draft == null) throw new IllegalArgumentException("Missing inspiration draft");
        String title = limited(draft.title(), 200).trim();
        String code = limited(draft.rawCode(), 20000);
        String source = limited(draft.sourceText(), 20000);
        // A reference screenshot may be collected before anyone knows its share code.
        String type = oneOf(draft.codeType(), "unknown", "outfit", "dye");
        String status = oneOf(draft.status(), "self", "want", "tried", "reproduced", "archived");
        String id = UUID.randomUUID().toString(), codeId = UUID.randomUUID().toString();
        long time = Math.max(1L, now);
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            ContentValues entry = new ContentValues();
            entry.put("id", id); entry.put("title", title); entry.put("notes", limited(draft.notes(), 20000));
            entry.put("tags_json", jsonNames(draft.tags())); entry.put("categories_json", jsonNames(draft.categories()));
            entry.put("status", status); entry.put("created_at", time); entry.put("updated_at", time); entry.put("deleted_at", 0);
            db.insertOrThrow("inspiration_entries", null, entry);
            ContentValues shared = new ContentValues();
            shared.put("id", codeId); shared.put("entry_id", id); shared.put("type", type);
            shared.put("raw_code", code); shared.put("source_text", source);
            shared.put("source_url", cleanUrl(draft.sourceUrl())); shared.put("parsed_state", "pending");
            db.insertOrThrow("inspiration_codes", null, shared);
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        return get(id);
    }

    public synchronized Entry get(String id) {
        Entry found = readEntry(getReadableDatabase(), id, false);
        return found != null && found.deletedAt() == 0 ? found : null;
    }

    public synchronized void updateUserFields(String id, String title, String notes, List<String> tags,
                                              List<String> categories, String status, long now) {
        Entry before = get(id);
        if (before == null) throw new IllegalArgumentException("Inspiration entry not found");
        ContentValues values = new ContentValues();
        values.put("title", limited(title, 200).trim()); values.put("notes", limited(notes, 20000));
        values.put("tags_json", jsonNames(tags)); values.put("categories_json", jsonNames(categories));
        values.put("status", oneOf(status, "self", "want", "tried", "reproduced", "archived"));
        values.put("updated_at", Math.max(now, before.updatedAt() + 1));
        if (getWritableDatabase().update("inspiration_entries", values, "id = ? AND deleted_at = 0", new String[] {id}) != 1)
            throw new IllegalStateException("Inspiration update failed");
    }

    /** Explicit code correction only; ordinary note edits and resolver updates never call this method. */
    public synchronized void updateCode(String entryId, String rawCode, String type, long now) {
        Entry before = get(entryId);
        if (before == null) throw new IllegalArgumentException("Inspiration entry not found");
        ContentValues values = new ContentValues();
        values.put("raw_code", limited(rawCode, 20000));
        values.put("type", oneOf(type, "unknown", "outfit", "dye"));
        values.put("parsed_state", "pending"); values.putNull("snapshot_id");
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            db.update("inspiration_codes", values, "entry_id = ?", new String[] {entryId});
            touch(db, entryId, Math.max(now, before.updatedAt() + 1));
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    public synchronized void recordParseResult(String codeId, String state, String snapshotJson,
                                               String resolverVersion, String dictionaryVersion, long now) {
        String parsedState = oneOf(state, "pending", "success", "failed", "unsupported");
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            String entryId;
            try (Cursor cursor = db.query("inspiration_codes", new String[] {"entry_id"}, "id = ?",
                    new String[] {codeId}, null, null, null)) {
                if (!cursor.moveToFirst()) throw new IllegalArgumentException("Inspiration code not found");
                entryId = cursor.getString(0);
            }
            ContentValues code = new ContentValues(); code.put("parsed_state", parsedState);
            if ("success".equals(parsedState)) {
                if (snapshotJson == null || snapshotJson.isBlank()) throw new IllegalArgumentException("Missing parsed snapshot");
                String snapshotId = UUID.randomUUID().toString();
                ContentValues snapshot = new ContentValues();
                snapshot.put("id", snapshotId); snapshot.put("code_id", codeId);
                snapshot.put("payload_json", snapshotJson);
                snapshot.put("resolver_version", required(resolverVersion, "resolverVersion", 200));
                snapshot.put("dictionary_version", required(dictionaryVersion, "dictionaryVersion", 200));
                snapshot.put("resolved_at", Math.max(1L, now));
                db.insertOrThrow("inspiration_snapshots", null, snapshot);
                code.put("snapshot_id", snapshotId);
            }
            db.update("inspiration_codes", code, "id = ?", new String[] {codeId});
            touch(db, entryId, Math.max(1L, now));
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    public synchronized void attachImage(String entryId, String localName, String mimeType, long bytes, long now) {
        if (get(entryId) == null) throw new IllegalArgumentException("Inspiration entry not found");
        if (!localName.matches("[a-f0-9-]{36}\\.(jpg|png|webp|heic)")) throw new IllegalArgumentException("Invalid local image name");
        ContentValues values = new ContentValues();
        values.put("id", UUID.randomUUID().toString()); values.put("entry_id", entryId);
        values.put("local_name", localName); values.put("mime_type", required(mimeType, "mimeType", 80));
        values.put("bytes", bytes); values.put("added_at", Math.max(1L, now));
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            db.insertOrThrow("inspiration_images", null, values); touch(db, entryId, Math.max(1L, now));
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    /** Removes only this entry's reference link. The caller may then remove its private copy. */
    public synchronized boolean detachImage(String entryId, String imageId, long now) {
        if (get(entryId) == null) return false;
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            boolean removed=db.delete("inspiration_images","entry_id = ? AND id = ?",new String[]{entryId,imageId})==1;
            if(removed)touch(db,entryId,Math.max(1L,now));
            db.setTransactionSuccessful();return removed;
        } finally {db.endTransaction();}
    }

    /** Commit the user's text and reference links together; private files are staged by the caller. */
    public synchronized Entry saveWithImages(Entry existing, Draft draft, List<InspirationImageStore.Saved> images,
                                             List<String> removedIds, long now) {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            Entry current;
            if(existing==null)current=create(draft,now);
            else {
                current=get(existing.id());
                if(current==null)throw new IllegalArgumentException("Inspiration entry not found");
                if(current.updatedAt()!=existing.updatedAt())throw new IllegalStateException("灵感已在另一处更新，请重新打开后再编辑");
                updateUserFields(current.id(),draft.title(),draft.notes(),draft.tags(),draft.categories(),draft.status(),now);
                if(!draft.rawCode().equals(current.code().rawCode())||!draft.codeType().equals(current.code().type()))
                    updateCode(current.id(),draft.rawCode(),draft.codeType(),now+1);
            }
            for(InspirationImageStore.Saved image:images)attachImage(current.id(),image.localName(),image.mimeType(),image.bytes(),now);
            for(String id:removedIds)detachImage(current.id(),id,now);
            db.setTransactionSuccessful();return get(current.id());
        } finally {db.endTransaction();}
    }

    public synchronized void delete(String id, long now) {
        Entry before = get(id);
        if (before == null) return;
        long time = Math.max(now, before.updatedAt() + 1);
        ContentValues values = new ContentValues(); values.put("deleted_at", time); values.put("updated_at", time);
        getWritableDatabase().update("inspiration_entries", values, "id = ? AND deleted_at = 0", new String[] {id});
    }

    /** Tombstones included for future private backup/sync, never a public upload. */
    public synchronized List<Entry> changesAfter(long timestamp) {
        List<Entry> result = new ArrayList<>(); SQLiteDatabase db = getReadableDatabase();
        try (Cursor cursor = db.query("inspiration_entries", new String[] {"id"}, "updated_at > ?",
                new String[] {Long.toString(timestamp)}, null, null, "updated_at ASC, id ASC")) {
            while (cursor.moveToNext()) result.add(readEntry(db, cursor.getString(0), true));
        }
        return result;
    }

    public synchronized InspirationSyncEngine.Base syncBase(String server,String id){
        try(Cursor c=getReadableDatabase().query("inspiration_sync_state",new String[]{"revision","local_hash"},"server_id=? AND entry_id=?",new String[]{server,id},null,null,null)){
            return c.moveToFirst()?new InspirationSyncEngine.Base(c.getLong(0),c.getString(1)):null;
        }
    }
    public synchronized void markSyncBase(String server,String id,long revision,String hash){
        ContentValues row=new ContentValues();row.put("server_id",server);row.put("entry_id",id);row.put("revision",revision);row.put("local_hash",hash);
        getWritableDatabase().insertWithOnConflict("inspiration_sync_state",null,row,SQLiteDatabase.CONFLICT_REPLACE);
    }
    public synchronized Entry getIncludingDeleted(String id){return readEntry(getReadableDatabase(),id,true);}
    public synchronized JSONObject syncEntry(Entry entry,InspirationImageStore images)throws Exception{
        JSONObject code=new JSONObject().put("id",entry.code().id()).put("rawCode",entry.code().rawCode()).put("type",entry.code().type())
                .put("sourceText",entry.code().sourceText()).put("sourceUrl",entry.code().sourceUrl()==null?JSONObject.NULL:entry.code().sourceUrl())
                .put("parsedState",entry.code().parsedState()).put("snapshotJson",entry.code().snapshotJson()==null?JSONObject.NULL:entry.code().snapshotJson())
                .put("resolverVersion",entry.code().resolverVersion()==null?JSONObject.NULL:entry.code().resolverVersion())
                .put("dictionaryVersion",entry.code().dictionaryVersion()==null?JSONObject.NULL:entry.code().dictionaryVersion()).put("resolvedAt",entry.code().resolvedAt());
        JSONArray attached=new JSONArray();
        if(entry.deletedAt()==0)for(Image image:entry.images()){
            var file=images.resolve(image.localName());if(!file.isFile()||file.length()!=image.bytes()||file.length()>InspirationImageStore.MAX_BYTES)throw new java.io.IOException("参考图不可访问，请重新添加后同步");
            long modified=file.lastModified();String hash=null;
            try(Cursor cached=getReadableDatabase().query("inspiration_image_hash",new String[]{"sha256"},"local_name=? AND bytes=? AND modified=?",new String[]{image.localName(),Long.toString(image.bytes()),Long.toString(modified)},null,null,null)){if(cached.moveToFirst())hash=cached.getString(0);}
            if(hash==null){MessageDigest digest=MessageDigest.getInstance("SHA-256");try(var in=new FileInputStream(file)){byte[] b=new byte[65536];for(int n;(n=in.read(b))!=-1;)digest.update(b,0,n);}
                if(!file.isFile()||file.length()!=image.bytes()||file.lastModified()!=modified)throw new java.io.IOException("参考图已变化，请重新同步");
                hash=app.nikkisync.mobile.util.Hex.lower(digest.digest());ContentValues cached=new ContentValues();cached.put("local_name",image.localName());cached.put("bytes",image.bytes());cached.put("modified",modified);cached.put("sha256",hash);getWritableDatabase().insertWithOnConflict("inspiration_image_hash",null,cached,SQLiteDatabase.CONFLICT_REPLACE);
            }
            attached.put(new JSONObject().put("id",image.id()).put("sha256",hash).put("mimeType",image.mimeType()).put("bytes",image.bytes()).put("addedAt",image.addedAt()));
        }
        return new JSONObject().put("id",entry.id()).put("title",entry.title()).put("notes",entry.notes()).put("tags",new JSONArray(entry.tags()))
                .put("categories",new JSONArray(entry.categories())).put("status",entry.status()).put("createdAt",entry.createdAt()).put("deletedAt",entry.deletedAt()).put("code",code).put("images",attached);
    }

    /** Download and verify image copies before atomically replacing a still-unchanged local record. */
    public synchronized boolean applySyncEntry(JSONObject value,String expected,InspirationImageStore imageStore,InspirationSyncEngine.Remote remote)throws Exception{
        return applySyncEntry(value,expected,imageStore,remote,()->true);
    }
    public synchronized boolean applySyncEntry(JSONObject value,String expected,InspirationImageStore imageStore,InspirationSyncEngine.Remote remote,java.util.function.BooleanSupplier active)throws Exception{
        String id=syncUuid(value.getString("id"));JSONObject code=value.getJSONObject("code");String codeId=syncUuid(code.getString("id"));
        String title=limited(value.getString("title"),200),notes=limited(value.getString("notes"),20000);
        List<String> tags=names(value.getJSONArray("tags").toString()),categories=names(value.getJSONArray("categories").toString());
        String tagsJson=jsonNames(tags),categoryJson=jsonNames(categories),status=oneOf(value.getString("status"),"self","want","tried","reproduced","archived");
        long created=syncTime(value,"createdAt"),deleted=syncTime(value,"deletedAt");
        String raw=limited(code.getString("rawCode"),20000),type=oneOf(code.getString("type"),"unknown","outfit","dye"),source=limited(code.getString("sourceText"),20000);
        String url=cleanUrl(code.isNull("sourceUrl")?null:code.getString("sourceUrl"));
        String parsed=oneOf(code.getString("parsedState"),"pending","success","failed","unsupported");
        String snapshot=code.isNull("snapshotJson")?null:limited(code.getString("snapshotJson"),262144);
        String resolver=code.isNull("resolverVersion")?null:limited(code.getString("resolverVersion"),200);
        String dictionary=code.isNull("dictionaryVersion")?null:limited(code.getString("dictionaryVersion"),200);long resolvedAt=syncTime(code,"resolvedAt");
        JSONArray incoming=value.getJSONArray("images");if(incoming.length()>64||deleted>0&&incoming.length()>0)throw new IllegalArgumentException("Invalid reference images");
        List<InspirationImageStore.Saved> staged=new ArrayList<>();List<String> ids=new ArrayList<>();List<Long> times=new ArrayList<>();List<Image> oldImages=new ArrayList<>();boolean committed=false;
        try{
            for(int i=0;i<incoming.length();i++){
                JSONObject item=incoming.getJSONObject(i);String imageId=syncUuid(item.getString("id")),hash=item.getString("sha256"),mime=item.getString("mimeType");
                long size=syncTime(item,"bytes"),added=syncTime(item,"addedAt");if(ids.contains(imageId)||!hash.matches("[a-f0-9]{64}")||size<1||size>InspirationImageStore.MAX_BYTES)throw new IllegalArgumentException("Invalid reference image");
                byte[] data=remote.image(hash);if(data.length!=size||!app.nikkisync.mobile.util.Hex.lower(MessageDigest.getInstance("SHA-256").digest(data)).equals(hash))throw new java.io.IOException("参考图校验失败");
                staged.add(imageStore.copy(new java.io.ByteArrayInputStream(data),mime));ids.add(imageId);times.add(added);
            }
            SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
            try{
                if(!active.getAsBoolean()||Thread.currentThread().isInterrupted())throw new java.io.IOException("同步已中断");
                Entry before=readEntry(db,id,true);String current=before==null?null:InspirationSyncEngine.digest(syncEntry(before,imageStore));
                if(!java.util.Objects.equals(current,expected))return false;
                if(before!=null&&!before.code().id().equals(codeId))throw new IllegalArgumentException("Code identity changed");
                if(before!=null)oldImages.addAll(before.images());
                long updated=before==null?Math.max(1,System.currentTimeMillis()):Math.max(System.currentTimeMillis(),before.updatedAt()+1);
                ContentValues row=new ContentValues();row.put("title",title);row.put("notes",notes);row.put("tags_json",tagsJson);row.put("categories_json",categoryJson);row.put("status",status);row.put("created_at",created);row.put("updated_at",updated);row.put("deleted_at",deleted);
                if(before==null){row.put("id",id);db.insertOrThrow("inspiration_entries",null,row);}else db.update("inspiration_entries",row,"id=?",new String[]{id});
                ContentValues c=new ContentValues();c.put("type",type);c.put("raw_code",raw);c.put("source_text",source);c.put("source_url",url);c.put("parsed_state",parsed);
                if(snapshot==null)c.putNull("snapshot_id");else{
                    String snapshotId=UUID.randomUUID().toString();ContentValues s=new ContentValues();s.put("id",snapshotId);s.put("code_id",codeId);s.put("payload_json",snapshot);s.put("resolver_version",resolver==null?"":resolver);s.put("dictionary_version",dictionary==null?"":dictionary);s.put("resolved_at",resolvedAt);
                    // A new code row must exist before the snapshot's foreign key is inserted.
                    if(before==null){ContentValues initial=new ContentValues(c);initial.put("id",codeId);initial.put("entry_id",id);initial.putNull("snapshot_id");db.insertOrThrow("inspiration_codes",null,initial);}
                    db.insertOrThrow("inspiration_snapshots",null,s);c.put("snapshot_id",snapshotId);
                }
                if(before==null&&snapshot==null){c.put("id",codeId);c.put("entry_id",id);db.insertOrThrow("inspiration_codes",null,c);}
                else db.update("inspiration_codes",c,"entry_id=?",new String[]{id});
                db.delete("inspiration_images","entry_id=?",new String[]{id});
                for(int i=0;i<staged.size();i++){var image=staged.get(i);ContentValues r=new ContentValues();r.put("id",ids.get(i));r.put("entry_id",id);r.put("local_name",image.localName());r.put("mime_type",image.mimeType());r.put("bytes",image.bytes());r.put("added_at",times.get(i));db.insertOrThrow("inspiration_images",null,r);}
                db.setTransactionSuccessful();committed=true;
            }finally{db.endTransaction();}
            for(Image image:oldImages)try{imageStore.deleteLocal(image.localName());}catch(Exception ignored){}
            return true;
        }finally{if(!committed)for(var image:staged)try{imageStore.deleteLocal(image.localName());}catch(Exception ignored){}}
    }
    private static String syncUuid(String value){if(value==null||!value.matches("(?i)[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"))throw new IllegalArgumentException("Invalid identity");return value;}
    private static long syncTime(JSONObject value,String key)throws JSONException{long result=value.getLong(key);if(result<0)throw new IllegalArgumentException("Invalid time");return result;}

    public synchronized List<Entry> search(String query, String status, String category) {
        String term = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
        List<Entry> result = new ArrayList<>(); SQLiteDatabase db = getReadableDatabase();
        try (Cursor cursor = db.query("inspiration_entries", new String[] {"id"}, "deleted_at = 0",
                null, null, null, "updated_at DESC, id ASC")) {
            while (cursor.moveToNext()) {
                Entry entry = readEntry(db, cursor.getString(0), false);
                if (status != null && !status.isBlank() && !status.equals(entry.status())) continue;
                if (category != null && !category.isBlank() && !entry.categories().contains(category)) continue;
                if (!term.isEmpty()) {
                    String haystack = (entry.title() + "\n" + entry.notes() + "\n" + entry.code().rawCode()
                            + "\n" + entry.code().sourceText() + "\n"
                            + (entry.code().sourceUrl() == null ? "" : entry.code().sourceUrl())
                            + "\n" + String.join("\n", entry.tags()) + "\n" + String.join("\n", entry.categories()))
                            .toLowerCase(Locale.ROOT);
                    if (!haystack.contains(term)) continue;
                }
                result.add(entry);
            }
        }
        return result;
    }

    public synchronized List<String> categoryNames() {
        LinkedHashSet<String> result=new LinkedHashSet<>();
        try(Cursor cursor=getReadableDatabase().query("inspiration_entries",new String[]{"categories_json"},"deleted_at = 0",null,null,null,"updated_at DESC")) {
            while(cursor.moveToNext())result.addAll(names(cursor.getString(0)));
        }
        return List.copyOf(result);
    }

    private Entry readEntry(SQLiteDatabase db, String id, boolean includeDeleted) {
        try (Cursor cursor = db.query("inspiration_entries", null, "id = ?", new String[] {id}, null, null, null)) {
            if (!cursor.moveToFirst()) return null;
            long deletedAt = cursor.getLong(cursor.getColumnIndexOrThrow("deleted_at"));
            if (!includeDeleted && deletedAt != 0) return null;
            Code code = readCode(db, id);
            List<Image> images = readImages(db, id);
            return new Entry(id, cursor.getString(cursor.getColumnIndexOrThrow("title")),
                    cursor.getString(cursor.getColumnIndexOrThrow("notes")),
                    names(cursor.getString(cursor.getColumnIndexOrThrow("tags_json"))),
                    names(cursor.getString(cursor.getColumnIndexOrThrow("categories_json"))),
                    cursor.getString(cursor.getColumnIndexOrThrow("status")),
                    cursor.getLong(cursor.getColumnIndexOrThrow("created_at")),
                    cursor.getLong(cursor.getColumnIndexOrThrow("updated_at")), deletedAt, code, images);
        }
    }

    private Code readCode(SQLiteDatabase db, String entryId) {
        try (Cursor cursor = db.query("inspiration_codes", null, "entry_id = ?", new String[] {entryId}, null, null, null)) {
            if (!cursor.moveToFirst()) throw new IllegalStateException("Inspiration code missing");
            String snapshotId = cursor.getString(cursor.getColumnIndexOrThrow("snapshot_id"));
            String payload = null, resolver = null, dictionary = null; long resolvedAt = 0;
            if (snapshotId != null) try (Cursor snapshot = db.query("inspiration_snapshots", null, "id = ?",
                    new String[] {snapshotId}, null, null, null)) {
                if (snapshot.moveToFirst()) {
                    payload = snapshot.getString(snapshot.getColumnIndexOrThrow("payload_json"));
                    resolver = snapshot.getString(snapshot.getColumnIndexOrThrow("resolver_version"));
                    dictionary = snapshot.getString(snapshot.getColumnIndexOrThrow("dictionary_version"));
                    resolvedAt = snapshot.getLong(snapshot.getColumnIndexOrThrow("resolved_at"));
                }
            }
            return new Code(cursor.getString(cursor.getColumnIndexOrThrow("id")),
                    cursor.getString(cursor.getColumnIndexOrThrow("raw_code")),
                    cursor.getString(cursor.getColumnIndexOrThrow("type")),
                    cursor.getString(cursor.getColumnIndexOrThrow("source_text")),
                    cursor.getString(cursor.getColumnIndexOrThrow("source_url")),
                    cursor.getString(cursor.getColumnIndexOrThrow("parsed_state")),
                    snapshotId, payload, resolver, dictionary, resolvedAt);
        }
    }

    private List<Image> readImages(SQLiteDatabase db, String entryId) {
        List<Image> images = new ArrayList<>();
        try (Cursor cursor = db.query("inspiration_images", null, "entry_id = ?", new String[] {entryId},
                null, null, "added_at ASC, id ASC")) {
            while (cursor.moveToNext()) images.add(new Image(
                    cursor.getString(cursor.getColumnIndexOrThrow("id")),
                    cursor.getString(cursor.getColumnIndexOrThrow("local_name")),
                    cursor.getString(cursor.getColumnIndexOrThrow("mime_type")),
                    cursor.getLong(cursor.getColumnIndexOrThrow("bytes")),
                    cursor.getLong(cursor.getColumnIndexOrThrow("added_at"))));
        }
        return images;
    }

    private static void touch(SQLiteDatabase db, String id, long now) {
        db.execSQL("UPDATE inspiration_entries SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?",
                new Object[] {now, id});
    }
    private static String required(String value, String field, int max) {
        String result = limited(value, max).trim();
        if (result.isEmpty()) throw new IllegalArgumentException("Missing " + field);
        return result;
    }
    private static String limited(String value, int max) {
        if (value == null) return "";
        if (value.length() > max) throw new IllegalArgumentException("Inspiration field is too long");
        return value;
    }
    private static String oneOf(String value, String... options) {
        for (String option : options) if (option.equals(value)) return option;
        throw new IllegalArgumentException("Unsupported inspiration state: " + value);
    }
    private static String cleanUrl(String url) {
        if (url == null || url.isBlank()) return null;
        String value = required(url, "sourceUrl", 2000);
        if (!(value.startsWith("https://") || value.startsWith("http://")))
            throw new IllegalArgumentException("Source URL must be HTTP(S)");
        return value;
    }
    private static String jsonNames(List<String> input) {
        LinkedHashSet<String> names = new LinkedHashSet<>();
        if (input != null) for (String value : input) if (value != null && !value.isBlank()) {
            String name = value.trim();
            if (name.length() > 60 || names.size() >= 30) throw new IllegalArgumentException("Too many or too-long tags/categories");
            names.add(name);
        }
        return new JSONArray(new ArrayList<>(names)).toString();
    }
    private static List<String> names(String json) {
        try {
            JSONArray array = new JSONArray(json); List<String> result = new ArrayList<>();
            for (int i = 0; i < array.length(); i++) result.add(array.getString(i));
            return List.copyOf(result);
        } catch (JSONException error) { throw new IllegalStateException("Corrupt inspiration tags/categories", error); }
    }
}
