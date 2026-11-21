package app.nikkisync.mobile.storage;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import app.nikkisync.mobile.model.Models.AssetSummary;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

public final class SavedPhotoStore {
    private static final String PREFS = "nikkisync_saved_photos";
    private static final String KEY_RECORDS = "records";
    private static final int LIMIT = 2000;

    public static final class Record {
        private final String assetId, uri, capturedAt, gameVersion, format;
        private final long savedAt;
        private final boolean hasMotion;
        private final int rotationDegrees;
        private final List<String> companionUris;
        private final String motionProfileId, timestampSource;
        private final Boolean exportHasMotion;
        private final long presentationUs;

        /** Backwards-compatible historical record: source motion is not verified export evidence. */
        public Record(String assetId, String uri, long savedAt, boolean hasMotion, int rotationDegrees,
                      String capturedAt, String gameVersion, String format) {
            this(assetId,uri,savedAt,hasMotion,rotationDegrees,capturedAt,gameVersion,format,List.of(),null,null,-1,null);
        }

        public Record(String assetId, String uri, long savedAt, boolean hasMotion, int rotationDegrees,
                      String capturedAt, String gameVersion, String format,List<String> companionUris,
                      String motionProfileId,Boolean exportHasMotion,long presentationUs,String timestampSource) {
            this.assetId=assetId;this.uri=uri;this.savedAt=savedAt;this.hasMotion=hasMotion;
            this.rotationDegrees=rotationDegrees;this.capturedAt=capturedAt;this.gameVersion=gameVersion;this.format=format;
            this.companionUris=List.copyOf(companionUris);this.motionProfileId=motionProfileId;
            this.exportHasMotion=exportHasMotion;this.presentationUs=presentationUs;this.timestampSource=timestampSource;
        }

        public String assetId() { return assetId; }
        public String uri() { return uri; }
        public long savedAt() { return savedAt; }
        public boolean hasMotion() { return exportHasMotion==null?hasMotion:exportHasMotion; }
        public boolean sourceHasMotion() { return hasMotion; }
        public Boolean exportHasMotion() { return exportHasMotion; }
        public int rotationDegrees() { return rotationDegrees; }
        public String capturedAt() { return capturedAt; }
        public String gameVersion() { return gameVersion; }
        public String format() { return format; }
        public Uri mediaUri() { return Uri.parse(uri); }
        public List<String> companionUris(){return companionUris;}
        public String motionProfileId(){return motionProfileId;}
        public long presentationUs(){return presentationUs;}
        public String timestampSource(){return timestampSource;}
        public String galleryPlaybackValidation(){return "unknown";}
    }

    private final SharedPreferences prefs;
    private final Context context;
    public SavedPhotoStore(Context context) {
        this.context=context.getApplicationContext();
        prefs=this.context.getSharedPreferences(PREFS,Context.MODE_PRIVATE);
    }

    public synchronized void record(AssetSummary asset,Uri uri,int rotationDegrees,String format) {
        recordInternal(new Record(asset.assetId(),uri.toString(),System.currentTimeMillis(),asset.hasMotion(),rotationDegrees,
            asset.capturedAt(),asset.gameVersion(),format),false);
    }
    public synchronized void recordRecovered(AssetSummary asset,Uri uri,long savedAt,String format) {
        recordInternal(new Record(asset.assetId(),uri.toString(),savedAt>0?savedAt:System.currentTimeMillis(),asset.hasMotion(),0,
            asset.capturedAt(),asset.gameVersion(),format),false);
    }
    /** Called only after a complete Live product has passed structural verification and publication. */
    public synchronized void recordMotion(AssetSummary asset,Uri uri,List<Uri> companions,int rotationDegrees,
                                         String format,String profileId,long presentationUs,String timestampSource) {
        List<String> linked=new ArrayList<>();for(Uri item:companions)if(item!=null&&!linked.contains(item.toString()))linked.add(item.toString());
        recordInternal(new Record(asset.assetId(),uri.toString(),System.currentTimeMillis(),asset.hasMotion(),rotationDegrees,
            asset.capturedAt(),asset.gameVersion(),format,linked,profileId,true,presentationUs,timestampSource),true);
    }
    private void recordInternal(Record record,boolean durable) {
        List<Record> next=load();next.removeIf(item->record.uri().equals(item.uri()));next.add(record);
        next.sort(Comparator.comparingLong(Record::savedAt).reversed());if(next.size()>LIMIT)next=new ArrayList<>(next.subList(0,LIMIT));save(next,durable);
    }
    public synchronized List<Record> load() {
        List<Record> records=new ArrayList<>();String raw=prefs.getString(KEY_RECORDS,"[]");
        try {
            JSONArray rows=new JSONArray(raw==null?"[]":raw);
            for(int index=0;index<rows.length();index++) {
                JSONObject row=rows.optJSONObject(index);if(row==null)continue;
                String assetId=row.optString("assetId","").trim(),uri=row.optString("uri","").trim();if(assetId.isEmpty()||uri.isEmpty())continue;
                List<String> companions=new ArrayList<>();JSONArray linked=row.optJSONArray("companionUris");
                if(linked!=null)for(int i=0;i<linked.length();i++){String value=linked.optString(i,"").trim();if(!value.isEmpty()&&!value.equals(uri)&&!companions.contains(value))companions.add(value);}
                Boolean exported=row.has("exportHasMotion")&&!row.isNull("exportHasMotion")?row.optBoolean("exportHasMotion"):null;
                records.add(new Record(assetId,uri,row.optLong("savedAt",0L),row.optBoolean("sourceHasMotion",row.optBoolean("hasMotion",false)),
                    row.optInt("rotationDegrees",0),optional(row,"capturedAt"),optional(row,"gameVersion"),optional(row,"format"),
                    companions,optional(row,"motionProfileId"),exported,row.optLong("presentationUs",-1),optional(row,"timestampSource")));
            }
        }catch(Exception ignored){/* Corrupt old history must not prevent application startup. */}
        records.sort(Comparator.comparingLong(Record::savedAt).reversed());return records;
    }
    public synchronized void removeUri(String uri){List<Record> next=load();next.removeIf(record->uri.equals(record.uri()));save(next,false);}
    public synchronized void removeIfUnchanged(Record expected){
        List<Record> next=load();
        if(next.removeIf(record->record.uri().equals(expected.uri())&&record.assetId().equals(expected.assetId())&&record.savedAt()==expected.savedAt()))save(next,false);
    }
    private void save(List<Record> records,boolean durable) {
        JSONArray rows=new JSONArray();
        for(Record record:records){JSONObject row=new JSONObject();try{
            row.put("assetId",record.assetId());row.put("uri",record.uri());row.put("savedAt",record.savedAt());
            row.put("hasMotion",record.hasMotion());row.put("sourceHasMotion",record.sourceHasMotion());row.put("rotationDegrees",record.rotationDegrees());
            if(record.capturedAt()!=null)row.put("capturedAt",record.capturedAt());if(record.gameVersion()!=null)row.put("gameVersion",record.gameVersion());if(record.format()!=null)row.put("format",record.format());
            if(record.exportHasMotion()!=null)row.put("exportHasMotion",record.exportHasMotion());
            if(record.motionProfileId()!=null)row.put("motionProfileId",record.motionProfileId());
            row.put("companionUris",new JSONArray(record.companionUris()));row.put("presentationUs",record.presentationUs());
            if(record.timestampSource()!=null)row.put("timestampSource",record.timestampSource());row.put("galleryPlaybackValidation","unknown");rows.put(row);
        }catch(Exception error){if(durable)throw new IllegalStateException("Live 媒体已写入，但保存记录编码失败",error);}}
        SharedPreferences.Editor editor=prefs.edit().putString(KEY_RECORDS,rows.toString());
        if(durable){if(!editor.commit())throw new IllegalStateException("Live 媒体已写入，但保存记录持久化失败");}else editor.apply();
        app.nikkisync.mobile.widget.PhotoAlbumWidgetProvider.refreshAll(context);
    }
    private static String optional(JSONObject row,String key){if(!row.has(key)||row.isNull(key))return null;String value=row.optString(key,"").trim();return value.isEmpty()?null:value;}
}
