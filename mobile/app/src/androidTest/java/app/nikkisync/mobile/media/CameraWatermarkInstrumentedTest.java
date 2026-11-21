package app.nikkisync.mobile.media;
import android.media.ExifInterface;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
/** Uses the PC exporter fixture and the real Android metadata reader, never the user's photos. */
@RunWith(AndroidJUnit4.class)
public class CameraWatermarkInstrumentedTest {
    @Test public void unicodeCameraNameRemainsIntactWithLegacyReaderLimitation()throws Exception{
        byte[] bytes=android.util.Base64.decode("/9j/4QEoRXhpZgAASUkqAMYAAAAAAAAAAABNb21vIENhbWVyYQDmmZrmmJ/nmoTlpKfllrXnm7jmnLoAWmYfZoR2J1m1Vfh2OmcAAFVOSUNPREUA//5aZh9mhHYnWbVV+HY6ZwAATmlra2lTeW5jAEluZmluaXR5IE5pa2tpIHZpcnR1YWwgcGhvdG9ncmFwaHk7IGdhbWUgcGFyYW1ldGVyczogeyJjYW1lcmEiOnt9LCJjbG90aGVzIjpbXX0AAQCGkgcAGgAAAEAAAAAAAAAABwAOAQIAUAAAAGQAAAAPAQIADAAAAA4AAAAQAQIAFgAAABoAAAASAQMAAQAAAAEAAAAxAQIACgAAAFoAAABphwQAAQAAALQAAACcnAEAEAAAADAAAAAAAAAA/+IAFklDQ19QUk9GSUxFAG9yaWdpbmFs/8AACwgAQAAwAQERAP/aAAgBAQAAPwAJCP8AB//ZcHJpdmF0ZS1nYW1lLXRhaWw=",android.util.Base64.DEFAULT);
        ExifInterface exif=new ExifInterface(new java.io.ByteArrayInputStream(bytes));
        // The platform reader is ASCII-only for Model. This check must never be reported as
        // successful Chinese display in an OEM gallery; the UTF-8 and Unicode tags are intact.
        assertNotNull(exif.getAttribute(ExifInterface.TAG_MODEL));
        assertEquals("Momo Camera",exif.getAttribute(ExifInterface.TAG_MAKE));
        java.nio.ByteBuffer tiff=java.nio.ByteBuffer.wrap(bytes,12,bytes.length-12).slice().order(java.nio.ByteOrder.LITTLE_ENDIAN);
        int root=tiff.getInt(4),count=tiff.getShort(root)&65535;boolean model=false,comment=false;
        for(int i=0;i<count;i++){
            int entry=root+2+i*12,tag=tiff.getShort(entry)&65535,length=tiff.getInt(entry+4),position=tiff.getInt(entry+8);
            if(tag==0x110||tag==0x9c9c){byte[] value=new byte[length- (tag==0x110?1:2)];for(int n=0;n<value.length;n++)value[n]=tiff.get(position+n);
                assertEquals("晚星的大喵相机",new String(value,tag==0x110?java.nio.charset.StandardCharsets.UTF_8:java.nio.charset.StandardCharsets.UTF_16LE));
                if(tag==0x110)model=true;else comment=true;}
        }assertTrue(model);assertTrue(comment);
    }
}
