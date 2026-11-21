package app.nikkisync.mobile.ui;

import java.util.*;

/** Short labels preserve the distinguishing end of a path, including moved game installs. */
public final class SourceFolderLabels {
    private SourceFolderLabels() {}
    private static final class Suffix {int count;final Map<String,Suffix> children=new HashMap<>();}
    private static String normalized(String path){return path.replace('\\','/').replaceAll("/+$","");}
    private static String[] parts(String path){return Arrays.stream(normalized(path).split("/")).filter(s->!s.isEmpty()).toArray(String[]::new);}

    public static String title(String path){
        if(path==null)return "全部文件夹";
        if(path.isBlank())return "未知目录";
        String[] tokens=parts(path);if(tokens.length==0)return path;
        String name=tokens[tokens.length-1];
        if(name.equalsIgnoreCase("ScreenShot"))return "游戏截图 · ScreenShot";
        if(name.equalsIgnoreCase("GamePlayPhotos"))return "游戏相册 · GamePlayPhotos";
        if(name.equalsIgnoreCase("Videos"))return "实况视频 · Videos";
        if(name.matches("[0-9]+")&&tokens.length>1&&tokens[tokens.length-2].equalsIgnoreCase("GamePlayPhotos"))return "账号相册 · UID "+name;
        return name;
    }

    public static Map<String,String> contexts(Collection<String> folders){
        Suffix root=new Suffix();Map<String,String[]> paths=new LinkedHashMap<>();
        for(String path:folders){
            if(path==null||path.isBlank()||paths.containsKey(path))continue;
            String[] tokens=parts(path);paths.put(path,tokens);Suffix node=root;
            for(int i=tokens.length-1;i>=0;i--){node=node.children.computeIfAbsent(tokens[i].toLowerCase(Locale.ROOT),key->new Suffix());node.count++;}
        }
        Map<String,String> labels=new HashMap<>();
        for(var entry:paths.entrySet()){
            String[] tokens=entry.getValue();Suffix node=root;int length=0;
            while(length<tokens.length){node=node.children.get(tokens[tokens.length-1-length].toLowerCase(Locale.ROOT));length++;if(length>=3&&node.count==1)break;}
            labels.put(entry.getKey(),length==tokens.length?normalized(entry.getKey()):"…/"+String.join("/",Arrays.copyOfRange(tokens,tokens.length-length,tokens.length)));
        }
        return labels;
    }
}
