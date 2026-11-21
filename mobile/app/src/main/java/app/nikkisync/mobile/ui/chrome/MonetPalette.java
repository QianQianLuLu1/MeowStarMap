package app.nikkisync.mobile.ui.chrome;
import java.util.List;
public record MonetPalette(List<Integer> atmosphere,List<Integer> accents,long sourceHash,float mood,float darkRatio) {
    public MonetPalette(List<Integer> atmosphere,List<Integer> accents,long sourceHash){this(atmosphere,accents,sourceHash,.5f,0);}
    public MonetPalette {atmosphere=List.copyOf(atmosphere);accents=List.copyOf(accents);}
}
