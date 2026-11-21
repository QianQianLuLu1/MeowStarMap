package app.nikkisync.mobile.ui.chrome;
import android.content.Context;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.json.*;

/** Disposable palette cache, independent of pairing and the library databases. */
final class MonetPaletteCache {
    static final String ALGORITHM="nikki-photolayout-v1";
    private final File directory;
    MonetPaletteCache(Context context){directory=new File(context.getFilesDir(),"monet-palettes-v1");}
    MonetPalette get(String key){
        try{File file=file(key);if(!file.isFile()||file.length()>8192)return null;
            JSONObject j=new JSONObject(new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8));
            return new MonetPalette(colors(j.getJSONArray("atmosphere")),colors(j.getJSONArray("accents")),j.getLong("hash"),(float)j.getDouble("mood"),(float)j.getDouble("dark"));
        }catch(Exception ignored){return null;}
    }
    void put(String key,MonetPalette palette){
        File temp=null;try{directory.mkdirs();temp=File.createTempFile("palette-",".tmp",directory);
            JSONObject j=new JSONObject().put("atmosphere",new JSONArray(palette.atmosphere())).put("accents",new JSONArray(palette.accents())).put("hash",palette.sourceHash()).put("mood",palette.mood()).put("dark",palette.darkRatio());
            Files.write(temp.toPath(),j.toString().getBytes(StandardCharsets.UTF_8));Files.move(temp.toPath(),file(key).toPath(),StandardCopyOption.REPLACE_EXISTING);
        }catch(Exception ignored){}finally{if(temp!=null)temp.delete();}
    }
    private File file(String key)throws Exception{byte[] hash=MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8));StringBuilder name=new StringBuilder();for(byte b:hash)name.append(String.format("%02x",b));return new File(directory,name+".json");}
    private static List<Integer> colors(JSONArray a)throws Exception{if(a.length()>6)throw new IOException("invalid palette");List<Integer> result=new ArrayList<>();for(int i=0;i<a.length();i++)result.add(a.getInt(i));return result;}
}
