package app.nikkisync.mobile.support;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import javax.net.ssl.HttpsURLConnection;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

final class SupportClient {
    private static final Pattern RECEIPT=Pattern.compile("NS1\\.([1-9][0-9]{0,11})\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}");
    private final URI origin;
    record Replies(boolean closed,JSONArray messages){}

    SupportClient(String configuredUrl){
        URI parsed=null;
        try{
            URI candidate=URI.create(configuredUrl.replaceAll("/+$",""));
            if("https".equalsIgnoreCase(candidate.getScheme())&&candidate.getHost()!=null&&candidate.getRawUserInfo()==null
                    &&candidate.getRawQuery()==null&&candidate.getRawFragment()==null)parsed=candidate;
        }catch(IllegalArgumentException ignored){}
        origin=parsed;
    }

    boolean enabled(){return origin!=null;}

    static String issueNumber(String receipt){
        if(receipt==null)return null;
        var match=RECEIPT.matcher(receipt);
        return match.matches()?match.group(1):null;
    }

    String submit(JSONObject report)throws IOException {
        JSONObject answer=request("/v1/reports",report,null,201);
        String receipt=answer.optString("receipt");
        if(issueNumber(receipt)==null||!issueNumber(receipt).equals(answer.optString("issue")))throw new IOException("Invalid receipt");
        return receipt;
    }

    Replies readReplies(String receipt)throws IOException {
        String issue=issueNumber(receipt);
        if(issue==null)throw new IOException("Invalid receipt");
        JSONObject answer=request("/v1/replies",null,receipt,200);
        JSONArray messages=answer.optJSONArray("replies");
        if(!issue.equals(answer.optString("issue"))||messages==null||messages.length()>12)throw new IOException("Invalid replies");
        return new Replies(answer.optBoolean("closed"),messages);
    }

    private JSONObject request(String path,JSONObject report,String receipt,int expectedStatus)throws IOException {
        if(origin==null)throw new IOException("Feedback unavailable");
        HttpsURLConnection connection=(HttpsURLConnection)URI.create(origin+path).toURL().openConnection();
        try{
            connection.setInstanceFollowRedirects(false);connection.setUseCaches(false);
            connection.setConnectTimeout(12000);connection.setReadTimeout(35000);
            connection.setRequestProperty("Accept","application/json");
            if(receipt!=null)connection.setRequestProperty("Authorization","Bearer "+receipt);
            if(report!=null){
                byte[] bytes=report.toString().getBytes(StandardCharsets.UTF_8);
                connection.setRequestMethod("POST");connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type","application/json");
                connection.setFixedLengthStreamingMode(bytes.length);
                try(var output=connection.getOutputStream()){output.write(bytes);}
            }
            if(connection.getResponseCode()!=expectedStatus)throw new IOException("Feedback request unavailable");
            try(var input=connection.getInputStream()){
                var output=new ByteArrayOutputStream();
                byte[] buffer=new byte[4096];
                for(int count;(count=input.read(buffer))!=-1;){
                    if(output.size()+count>64*1024)throw new IOException("Feedback response too large");
                    output.write(buffer,0,count);
                }
                return new JSONObject(new String(output.toByteArray(),StandardCharsets.UTF_8));
            }
        }catch(JSONException invalid){throw new IOException("Invalid feedback response");}
        finally{connection.disconnect();}
    }
}
