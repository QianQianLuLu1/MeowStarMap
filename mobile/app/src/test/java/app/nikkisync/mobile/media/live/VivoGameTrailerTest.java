package app.nikkisync.mobile.media.live;

import java.io.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.junit.*;
import static org.junit.Assert.*;

/** Reproduces the real game's envelope without including any player's media or encoded parameters. */
public final class VivoGameTrailerTest {
 private File directory,jpeg,video;
 private static final String ID="1760000000000"+"abcdef0"+"00000000";
 private static final byte[] MOVIE={0,0,0,20,'f','t','y','p','i','s','o','m',0,0,0,0,'i','s','o','m',
     0,0,0,8,'m','o','o','v',0,0,0,12,'m','d','a','t',1,2,3,4};
 private static final MotionContainer.Options OPTIONS=new MotionContainer.Options(500000,15,30,1000000,ID,"synthetic");
 @Before public void setup()throws Exception{
  directory=Files.createTempDirectory("vivo-trailer-test-").toFile();
  jpeg=new File(directory,"source.jpg");video=new File(directory,"source.mp4");
  Files.write(jpeg.toPath(),new byte[]{(byte)255,(byte)216,(byte)255,(byte)218,0,8,1,1,0,0,63,0,1,2,(byte)255,(byte)217});
 }
 @After public void cleanup()throws Exception{try(var paths=Files.walk(directory.toPath())){for(var p:paths.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(p);}}
 static byte[] trailer(){
  return ("%PAPERGAMES%"+"A".repeat(704)+"%PAPERGAMES%"+"B".repeat(43)+"=").getBytes(StandardCharsets.US_ASCII);
 }
 static byte[] concat(byte[]... arrays)throws Exception{var out=new ByteArrayOutputStream();for(var a:arrays)out.write(a);return out.toByteArray();}
 private MotionContainer.Product write(byte[] bytes)throws Exception{
  Files.write(video.toPath(),bytes);File out=new File(directory,UUID.randomUUID().toString());assertTrue(out.mkdir());
  return MotionContainer.write(LivePhotoProfile.VIVO_LEGACY_PAIR,jpeg,video,out,OPTIONS);
 }
 @Test public void gameTailBecomesFiniteFreeBoxAndAllSourceBytesAreRetained()throws Exception{
  byte[] input=concat(MOVIE,trailer()),originalJpeg=Files.readAllBytes(jpeg.toPath());
  var product=write(input);MotionContainerVerifier.verify(LivePhotoProfile.VIVO_LEGACY_PAIR,product,video,OPTIONS);
  byte[] result=Files.readAllBytes(product.companions().get(0).toPath());
  assertArrayEquals(MOVIE,Arrays.copyOfRange(result,0,MOVIE.length));
  assertEquals(trailer().length+8,ByteBuffer.wrap(result).getInt(MOVIE.length));
  assertEquals("free",new String(result,MOVIE.length+4,4,StandardCharsets.US_ASCII));
  assertArrayEquals(trailer(),Arrays.copyOfRange(result,MOVIE.length+8,MOVIE.length+8+trailer().length));
  assertEquals("uuid",new String(result,input.length+8+4,4,StandardCharsets.US_ASCII));
  assertEquals(ID,VivoLegacyMetadata.readId(product.primary()));
  assertEquals(ID,VivoLegacyMetadata.readId(product.companions().get(0)));
  assertArrayEquals(input,Files.readAllBytes(video.toPath()));assertArrayEquals(originalJpeg,Files.readAllBytes(jpeg.toPath()));
 }
 @Test public void finiteMp4StillCopiesByteForByteAndAcceptsLargeSizeBoxes()throws Exception{
  byte[] large=ByteBuffer.allocate(20).putInt(1).put("free".getBytes(StandardCharsets.US_ASCII)).putLong(20).putInt(0).array();
  byte[] input=concat(MOVIE,large);var p=write(input);
  MotionContainerVerifier.verify(LivePhotoProfile.VIVO_LEGACY_PAIR,p,video,OPTIONS);
  assertArrayEquals(input,Arrays.copyOf(Files.readAllBytes(p.companions().get(0).toPath()),input.length));
 }
 @Test public void malformedBoxesAndUnknownOrIncompleteTrailersAreStillRejected()throws Exception{
  byte[] broken=Arrays.copyOf(MOVIE,MOVIE.length);ByteBuffer.wrap(broken).putInt(28,999999);
  byte[] zero=Arrays.copyOf(MOVIE,MOVIE.length);ByteBuffer.wrap(zero).putInt(28,0);
  for(byte[] bad:new byte[][]{concat(broken,trailer()),concat(MOVIE,new byte[]{1,2,3,4}),concat(MOVIE,"%PAPERGAMES%".getBytes(StandardCharsets.US_ASCII)),
     concat(MOVIE,Arrays.copyOf(trailer(),trailer().length-1)),concat(MOVIE,trailer(),new byte[]{42}),zero}){
   try{write(bad);fail("Must reject malformed source");}catch(IOException expected){}
  }
 }
 @Test public void independentVerifierRejectsChangedFreeHeaderOrGameTrailer()throws Exception{
  for(int index:new int[]{MOVIE.length,MOVIE.length+4,MOVIE.length+8,MOVIE.length+8+trailer().length-1}){
   var p=write(concat(MOVIE,trailer()));byte[] bytes=Files.readAllBytes(p.companions().get(0).toPath());bytes[index]^=1;
   Files.write(p.companions().get(0).toPath(),bytes);
   try{MotionContainerVerifier.verify(LivePhotoProfile.VIVO_LEGACY_PAIR,p,video,OPTIONS);fail("Must detect output damage");}catch(IOException expected){}
  }
 }
}
