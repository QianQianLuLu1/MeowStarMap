package app.nikkisync.mobile.media.live;

import app.nikkisync.mobile.model.Models.MediaResource;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.*;
import java.util.*;
import javax.net.ssl.HttpsURLConnection;

/** Private, bounded playback copies. A lease protects a playing file from LRU/clear. */
public final class MotionPreviewCache {
    public static final long BUDGET=256L*1024*1024,MAX_SOURCE=128L*1024*1024;
    private static final Object LOCK=new Object();
    private static final Map<String,Integer> LEASES=new HashMap<>();
    private static final Set<String> WRITING=new HashSet<>();
    private final File root;private final long budget;
    public interface ConnectionSource {HttpsURLConnection open()throws Exception;}
    public interface StreamSource {InputStream open()throws IOException;}
    public MotionPreviewCache(File root){this(root,BUDGET);}
    public MotionPreviewCache(File root,long budget){this.root=root;this.budget=budget;}
    public final class Lease implements AutoCloseable {
        private final File file;private boolean closed;
        private Lease(File file){this.file=file;LEASES.merge(file.getAbsolutePath(),1,Integer::sum);file.setLastModified(System.currentTimeMillis());}
        public File file(){return file;}
        @Override public void close(){
            synchronized(LOCK){if(closed)return;closed=true;String key=file.getAbsolutePath();int count=LEASES.getOrDefault(key,1)-1;if(count==0)LEASES.remove(key);else LEASES.put(key,count);}
            // Releasing a decoder happens during a swipe: disk housekeeping must stay off the UI thread.
            java.util.concurrent.CompletableFuture.runAsync(()->{synchronized(LOCK){prune(false);}});
        }
    }
    public Lease remote(String pc,MediaResource resource,ConnectionSource source)throws Exception{
        if(resource==null||resource.sizeBytes()<28||resource.sizeBytes()>MAX_SOURCE||resource.sha256()==null||!resource.sha256().matches("(?i)[a-f0-9]{64}"))
            throw new IOException("动态视频大小或校验信息无效");
        String key=key("remote-v1\n"+pc+"\n"+resource.resourceId()+"\n"+resource.sha256().toLowerCase(Locale.ROOT)+"\n"+resource.sizeBytes());
        Lease hit=find(key);if(hit!=null)return hit;MotionPreviewFile.checkCancelled();File part=temporary();
        HttpsURLConnection connection=null;
        try{
            connection=source.open();connection.setInstanceFollowRedirects(false);
            if(connection.getResponseCode()!=200)throw new IOException("暂时无法读取电脑上的动态视频");
            long length=connection.getContentLengthLong();if(length>=0&&length!=resource.sizeBytes())throw new IOException("动态视频长度不一致");
            String checksum;
            try(InputStream in=connection.getInputStream()){checksum=copy(in,part,resource.sizeBytes());}
            if(!checksum.equalsIgnoreCase(resource.sha256()))throw new IOException("动态视频校验失败");
            MotionPreviewFile.prepare(part,false);return publish(key,part);
        }finally{if(connection!=null)connection.disconnect();discard(part);}
    }
    public Lease local(String identity,StreamSource source,boolean embedded)throws IOException{
        File part=temporary();
        try{
            String checksum;try(InputStream in=source.open()){if(in==null)throw new IOException("本地动态视频不存在");checksum=copy(in,part,-1);}
            String key=key("local-v1\n"+identity+"\n"+checksum);Lease hit=find(key);if(hit!=null)return hit;
            MotionPreviewFile.prepare(part,embedded);return publish(key,part);
        }finally{discard(part);}
    }
    private Lease find(String key)throws IOException{
        MotionPreviewFile.checkCancelled();
        File[] files;synchronized(LOCK){files=root.listFiles((dir,name)->name.startsWith(key+"_")&&name.endsWith(".mp4"));}if(files==null)return null;
        for(File file:files){
            Lease candidate;synchronized(LOCK){if(!file.isFile())continue;candidate=new Lease(file);}
            boolean valid=false;
            try{
                String expected=file.getName().substring(key.length()+1,file.getName().length()-4);
                // Hashing a large cache hit must not hold the lease lock needed by the main thread.
                valid=expected.matches("[a-f0-9]{64}")&&file.length()>0&&file.length()<=MAX_SOURCE&&expected.equals(digest(file));
                if(valid)return candidate;
            }finally{if(!valid)candidate.close();}
            synchronized(LOCK){if(!LEASES.containsKey(file.getAbsolutePath()))file.delete();}
        }
        return null;
    }
    private File temporary()throws IOException{
        synchronized(LOCK){if(!root.isDirectory()&&!root.mkdirs())throw new IOException("无法创建动态预览缓存");prune(false);File file=File.createTempFile("download-",".part",root);WRITING.add(file.getAbsolutePath());return file;}
    }
    private void discard(File file){synchronized(LOCK){WRITING.remove(file.getAbsolutePath());file.delete();}}
    private Lease publish(String key,File part)throws IOException{
        MotionPreviewFile.checkCancelled();String hash=digest(part);
        Lease existing=find(key);if(existing!=null)return existing;
        Lease lease;boolean raced;
        synchronized(LOCK){
            File target=new File(root,key+"_"+hash+".mp4");
            raced=target.isFile();
            if(!target.isFile())Files.move(part.toPath(),target.toPath());
            lease=new Lease(target);prune(false);
        }
        // A simultaneous publisher may have won the move. Verify without holding the UI lease lock;
        // an externally damaged file already leased by another viewer must not be accepted either.
        if(raced)try{if(!hash.equals(digest(lease.file())))throw new IOException("动态预览缓存损坏，请重试");}catch(IOException error){lease.close();throw error;}
        return lease;
    }
    public void clear(){synchronized(LOCK){prune(true);}}
    private void prune(boolean all){
        File[] files=root.listFiles();if(files==null)return;Arrays.sort(files,Comparator.comparingLong(File::lastModified));long bytes=0;
        for(File f:files)bytes+=f.length();
        for(File file:files){
            if(LEASES.containsKey(file.getAbsolutePath())||WRITING.contains(file.getAbsolutePath()))continue;
            if(all||bytes>budget||file.getName().endsWith(".part")){long size=file.length();if(file.delete())bytes-=size;}
        }
    }
    private static String copy(InputStream in,File part,long expected)throws IOException{
        MessageDigest sha=sha();long total=0;byte[] buffer=new byte[128*1024];
        try(OutputStream out=new BufferedOutputStream(new FileOutputStream(part))){
            for(int count;(count=in.read(buffer))!=-1;){
                MotionPreviewFile.checkCancelled();total+=count;if(total>MAX_SOURCE||expected>=0&&total>expected)throw new IOException("动态视频超出预览大小限制");
                out.write(buffer,0,count);sha.update(buffer,0,count);
            }
        }
        if(total==0||expected>=0&&total!=expected)throw new IOException("动态视频未读取完整");return hex(sha.digest());
    }
    private static String digest(File file)throws IOException{
        MessageDigest sha=sha();try(InputStream in=new BufferedInputStream(new FileInputStream(file))){byte[] buffer=new byte[128*1024];for(int n;(n=in.read(buffer))!=-1;){MotionPreviewFile.checkCancelled();sha.update(buffer,0,n);}}return hex(sha.digest());
    }
    private static MessageDigest sha(){try{return MessageDigest.getInstance("SHA-256");}catch(NoSuchAlgorithmException impossible){throw new AssertionError(impossible);}}
    private static String key(String value){return hex(sha().digest(value.getBytes(StandardCharsets.UTF_8)));}
    private static String hex(byte[] bytes){return app.nikkisync.mobile.util.Hex.lower(bytes);}
}
