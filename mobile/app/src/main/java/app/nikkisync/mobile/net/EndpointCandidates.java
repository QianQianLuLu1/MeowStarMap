package app.nikkisync.mobile.net;

import java.util.ArrayList;
import java.util.List;

/** Bounded known endpoints only. Supplementary names never trigger DNS or subnet scans. */
public final class EndpointCandidates {
    public static final int LIMIT=8;
    private EndpointCandidates(){}
    public static List<String> normalize(String primary,List<String> supplied){
        ArrayList<String> result=new ArrayList<>();result.add(primary);
        if(supplied!=null)for(String host:supplied){
            if(result.size()>=LIMIT)break;
            if(ipv4(host)&&!result.contains(host))result.add(host);
        }
        return List.copyOf(result);
    }
    public static boolean ipv4(String host){
        if(host==null||host.length()>15)return false;
        String[] parts=host.split("\\.",-1);if(parts.length!=4)return false;
        int first=0,second=0;
        for(int i=0;i<4;i++){
            String part=parts[i];if(!part.matches("0|[1-9][0-9]{0,2}"))return false;
            int value=Integer.parseInt(part);if(value>255)return false;
            if(i==0)first=value;if(i==1)second=value;
        }
        return first>0&&first!=127&&first<224&&!(first==169&&second==254);
    }
}
