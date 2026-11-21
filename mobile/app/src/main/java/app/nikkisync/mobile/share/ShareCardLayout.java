package app.nikkisync.mobile.share;

import android.graphics.Paint;
import java.util.ArrayList;
import java.util.List;

/** Matches the mini-program's two-column icon grid and read-only camera controls. */
public final class ShareCardLayout {
    public static final int WIDTH=1440, MAX_HEIGHT=4096;
    static final int EFFECT_ICON_SIZE=100, EFFECT_TEXT_SIZE=32, EFFECT_LINE_HEIGHT=40, EFFECT_ROW_GAP=24;
    private static final int EFFECT_TEXT_WIDTH=510;
    private static final String[] ORDER={"焦距","光圈","晕影","柔光","柔光范围","亮度","曝光","对比度","饱和度","自然饱和","高光","阴影"};
    public record Part(ShareCardPayload.Item item, List<String> lines, int column, int y) {}
    public record Parameter(String label, String displayValue, Double ratio, boolean missing,
                            boolean effect, List<String> lines, int height) {}
    public record Page(List<Part> outfit, List<Parameter> parameters, int height) {}
    private ShareCardLayout() {}

    public static List<Page> pages(ShareCardPayload payload) {
        List<Parameter> parameters=new ArrayList<>();
        for(String label:ORDER) {
            String value="";
            for(var item:payload.cameraItems()) if(alias(item.label()).equals(label)) { value=item.value(); break; }
            parameters.add(parameter(label,value));
        }
        for(var item:payload.cameraItems()) if(!List.of(ORDER).contains(alias(item.label())))
            parameters.add(parameter(item.label(),item.value()));
        for(var item:payload.effectItems()) {
            List<String> lines=wrap(item.value(),EFFECT_TEXT_SIZE,EFFECT_TEXT_WIDTH);
            int height=Math.max(EFFECT_ICON_SIZE,lines.size()*EFFECT_LINE_HEIGHT)+EFFECT_ROW_GAP;
            parameters.add(new Parameter(item.label(),item.value(),null,false,true,lines,height));
        }
        int parameterHeight=parameters.stream().mapToInt(Parameter::height).sum()+76;
        if(parameterHeight>3690) throw new IllegalArgumentException("参数内容过长，无法生成分享图");
        List<Page> pages=new ArrayList<>();
        List<Part> parts=new ArrayList<>();
        int y=0;
        for(int i=0;i<payload.outfitItems().size();i+=2) {
            List<Part> pair=new ArrayList<>();
            int rowHeight=0;
            for(int column=0;column<2 && i+column<payload.outfitItems().size();column++) {
                var item=payload.outfitItems().get(i+column);
                var lines=item.value().isBlank()?List.<String>of():wrap(item.value(),23,174);
                pair.add(new Part(item,lines,column,0));
                rowHeight=Math.max(rowHeight,198+lines.size()*29);
            }
            if(rowHeight>3690) throw new IllegalArgumentException("服装名称过长，无法生成分享图");
            if(y+rowHeight>3690 && !parts.isEmpty()) {
                pages.add(page(parts,parameters,y,parameterHeight)); parts=new ArrayList<>(); y=0;
            }
            for(var part:pair) parts.add(new Part(part.item(),part.lines(),part.column(),y));
            y+=rowHeight;
        }
        if(!parts.isEmpty() || pages.isEmpty()) pages.add(page(parts,parameters,y,parameterHeight));
        return List.copyOf(pages);
    }
    private static Page page(List<Part> parts,List<Parameter> parameters,int y,int parameterHeight) {
        return new Page(List.copyOf(parts),List.copyOf(parameters),Math.max(1740,400+Math.max(y,parameterHeight)));
    }
    private static String alias(String label) {
        return switch(label) { case "柔光强度" -> "柔光"; case "鲜艳度" -> "自然饱和"; default -> label; };
    }
    public static Parameter parameter(String label,String value) {
        String raw=value==null?"":value.trim(), display=raw.isEmpty()?"—":raw;
        Double ratio=null;
        boolean percent=List.of("亮度","对比度","柔光","晕影").contains(label);
        try {
            double number=Double.parseDouble(raw);
            if(Double.isFinite(number)) {
                if(label.equals("焦距")) display=raw+"mm";
                else if(label.equals("光圈")) display="f/"+raw;
                else if(percent) display=raw+"%";
                if(percent && number>=0 && number<=100) ratio=number/100;
                else if(List.of("曝光","饱和度","自然饱和","高光","阴影").contains(label)
                        && number>=-1 && number<=1) ratio=(number+1)/2;
            }
        } catch(NumberFormatException ignored) {}
        return new Parameter(label,display,ratio,raw.isEmpty(),false,List.of(),86);
    }
    static List<String> wrap(String text,float size,float width) {
        Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG); paint.setTextSize(size);
        List<String> lines=new ArrayList<>(); StringBuilder line=new StringBuilder();
        for(int offset=0;offset<text.length();) {
            int cp=text.codePointAt(offset); String next=new String(Character.toChars(cp)); offset+=Character.charCount(cp);
            if(line.length()>0 && paint.measureText(line+next)>width) { lines.add(line.toString()); line.setLength(0); }
            line.append(next);
        }
        if(line.length()>0) lines.add(line.toString());
        return List.copyOf(lines);
    }
}
