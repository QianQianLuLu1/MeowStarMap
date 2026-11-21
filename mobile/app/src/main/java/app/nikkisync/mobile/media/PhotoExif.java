package app.nikkisync.mobile.media;

import android.content.Context;
import androidx.exifinterface.media.ExifInterface;
import android.net.Uri;
import java.nio.charset.StandardCharsets;
import org.json.*;

/** ASCII-safe, privacy-filtered game parameters. Shares its version catalog with the PC exporter. */
public final class PhotoExif {
 public static final String CAMERA="MomoCamera";
 public static final String LENS="InfinityNikki";
 private static volatile JSONArray releases;
 private PhotoExif(){}
 public static String versionName(Context context,String version)throws Exception{
  if(releases==null)synchronized(PhotoExif.class){if(releases==null)try(var in=context.getAssets().open("game-version-names.json")){
   releases=new JSONArray(new String(app.nikkisync.mobile.util.ByteStreams.readAllBytes(in),StandardCharsets.UTF_8));
  }}
  for(int i=0;i<releases.length();i++){var r=releases.getJSONObject(i);if(r.getString("version").equals(version==null?"":version.replaceFirst("^[vV]","")))return r.getString("name");}
  return "";
 }
 public static JSONObject metadata(Context context,String json,String capturedAt,String version)throws Exception{
  JSONObject source;try{source=new JSONObject(json==null?"{}":json);}catch(JSONException e){source=new JSONObject();}
  var out=new JSONObject();var camera=new JSONObject();var input=source.optJSONObject("camera");
  for(String key:new String[]{"focalLength","apertureSection","exposure","brightness","contrast","saturation","vibrance","highlights","shadows","vignetteIntensity","bloomIntensity","bloomThreshold","rotation","zoom","cameraYaw","cameraPitch"}){
   Object v=input==null?null:input.opt(key);if(v instanceof Number n&&Double.isFinite(n.doubleValue())&&Math.abs(n.doubleValue())<=100000)camera.put(key,v);
  }
  if(input!=null&&input.opt("portraitMode") instanceof Boolean)camera.put("portraitMode",input.getBoolean("portraitMode"));
  out.put("camera",camera);
  var identity=source.optJSONObject("identity");
  String actualVersion=identity==null?"":identity.optString("gameVersion","").trim();
  if(actualVersion.isBlank())actualVersion=version==null?"":version;
  if(actualVersion.matches("[vV]?\\d{1,3}(\\.\\d{1,3}){1,2}"))out.put("version",actualVersion.replaceFirst("^[vV]",""));
  String title=versionName(context,out.optString("version",""));
  if(title.isEmpty()&&identity!=null){String supplied=identity.optString("gameVersionEnglishName","");if(supplied.matches("[A-Za-z0-9][A-Za-z0-9 '\\-:,]{0,119}"))title=supplied;}
  if(!title.isEmpty()&&out.has("version"))out.put("versionName",title);
  var capture=source.optJSONObject("capture");String date=capture==null?"":capture.optString("capturedAt","");
  if(date.isBlank())date=capturedAt==null?"":capturedAt;
  try{out.put("capturedAt",java.time.Instant.parse(date).toString());}catch(Exception ignored){}
  for(String key:new String[]{"pose","action","filter","lighting","location"}){var v=source.optJSONObject(key);if(v!=null)out.put(key,item(v));}
  JSONObject dressing=source.optJSONObject("dressing");JSONArray clothes=dressing==null?null:dressing.optJSONArray("clothes");
  JSONArray safe=new JSONArray();if(clothes!=null)for(int i=0;i<Math.min(100,clothes.length());i++){var v=clothes.optJSONObject(i);if(v!=null)safe.put(item(v));}
  var dress=item(dressing);dress.put("clothes",safe);out.put("dressing",dress);
  JSONArray eureka=dressing==null?null:dressing.optJSONArray("eureka");JSONArray safeEureka=new JSONArray();
  if(eureka!=null)for(int i=0;i<Math.min(20,eureka.length());i++){var v=eureka.optJSONObject(i);if(v!=null)safeEureka.put(item(v));}
  dress.put("eureka",safeEureka);
  if(ascii(out.toString()).length()>24000)throw new java.io.IOException("拍摄参数过大，未写入");
  return out;
 }
 private static JSONObject item(JSONObject input)throws JSONException{
  var out=new JSONObject();if(input==null)return out;
  for(String key:new String[]{"id","name","category","suitId","suitName","poseId","actionId","strength"}){
   Object v=input.opt(key);if(v instanceof Number n&&Double.isFinite(n.doubleValue()))out.put(key,v);
   else if(v instanceof String s){String clean=s.replaceAll("[\\p{Cntrl}]"," ").trim();out.put(key,clean.substring(0,Math.min(120,clean.length())));}
  }return out;
 }
 public static String ascii(String text){
  StringBuilder b=new StringBuilder();for(int i=0;i<text.length();i++){char c=text.charAt(i);if(c>=32&&c<127)b.append(c);else b.append(String.format(java.util.Locale.ROOT,"\\u%04x",(int)c));}return b.toString();
 }
 public static void apply(ExifInterface exif,JSONObject metadata)throws Exception{
  // Gallery apps concatenate Make and Model; repeating the same brand displays it twice.
  exif.setAttribute(ExifInterface.TAG_MAKE,null);exif.setAttribute(ExifInterface.TAG_MODEL,CAMERA);
  exif.setAttribute(ExifInterface.TAG_SOFTWARE,"MomoCamera");
  exif.setAttribute(ExifInterface.TAG_LENS_MODEL,LENS);
  exif.setAttribute(ExifInterface.TAG_LENS_MAKE,metadata.optString("versionName","").isEmpty()?null:metadata.getString("versionName"));
  exif.setAttribute(ExifInterface.TAG_USER_COMMENT,ascii(metadata.toString()));
  exif.setAttribute(ExifInterface.TAG_IMAGE_DESCRIPTION,"Infinity Nikki virtual photography; game parameters: "+ascii(metadata.toString()));
  var camera=metadata.getJSONObject("camera");
  for(String[] pair:new String[][]{{"apertureSection",ExifInterface.TAG_F_NUMBER},{"focalLength",ExifInterface.TAG_FOCAL_LENGTH}}){
   double value=camera.optDouble(pair[0],0);exif.setAttribute(pair[1],value>0&&value<=10000?Double.toString(value):null);
  }
  if(metadata.has("capturedAt")){String date=java.time.format.DateTimeFormatter.ofPattern("yyyy:MM:dd HH:mm:ss").withZone(java.time.ZoneOffset.UTC).format(java.time.Instant.parse(metadata.getString("capturedAt")));
   exif.setAttribute(ExifInterface.TAG_DATETIME_ORIGINAL,date);exif.setAttribute(ExifInterface.TAG_OFFSET_TIME_ORIGINAL,"+00:00");
  }
  exif.saveAttributes();
 }
 public static void write(Context c,Uri uri,JSONObject metadata)throws Exception{
  try(var fd=c.getContentResolver().openFileDescriptor(uri,"rw")){if(fd==null)throw new java.io.IOException("无法写入照片");apply(new ExifInterface(fd.getFileDescriptor()),metadata);}
 }
}
