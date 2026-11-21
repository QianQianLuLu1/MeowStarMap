package app.nikkisync.mobile.ui;
import app.nikkisync.mobile.model.Models.AssetSummary;
public final class PhotoScopeFilter {
    private PhotoScopeFilter(){}
    private static String clean(String value){return value==null?"":value;}
    public static boolean matches(AssetSummary asset,int type,String uid,String folder){
        return (type==0||asset!=null&&(type==1?asset.hasMotion():type==2?!asset.hasMotion()&&!asset.isVideo():type==3&&asset.isVideo()))
            &&(uid==null||uid.equals(asset==null?"":clean(asset.uid())))
            &&(folder==null||folder.equals(asset==null?"":clean(asset.sourceFolder())));
    }
    public static String tail(String path){if(path==null||path.isBlank())return "未知目录";String normalized=path.replace('\\','/');int slash=normalized.lastIndexOf('/');return slash>=0?"…/"+normalized.substring(slash+1):path;}
}
