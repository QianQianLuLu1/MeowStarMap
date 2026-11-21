/* Full-pixel edge fallback. Keep a bounded source band in RAM and the rotated
 * raster in an anonymous export-cache file. No dimension trimming/downsampling. */
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <limits.h>
#include <fcntl.h>
#include <unistd.h>
#include "rotation_job.h"
#include "jerror.h"
#include "transupp.h"

void momo_rotate_pixels(rotation_job *job,const char *output,int op){
 j_decompress_ptr src=&job->src;j_compress_ptr dst=&job->dst;
 unsigned w=src->image_width,h=src->image_height;
 int transpose=op==3||op==4||op==5||op==7;
 unsigned ow=transpose?h:w,oh=transpose?w:h;
 char name[PATH_MAX];int n=snprintf(name,sizeof(name),"%s/.momo-rgb-XXXXXX",job->scratch);
 if(n<0||(size_t)n>=sizeof(name))ERREXIT(src,JERR_TFILE_SEEK);
 int fd=mkstemp(name);
 if(fd<0)ERREXIT(src,JERR_FILE_WRITE);
 if(unlink(name)!=0){close(fd);ERREXIT(src,JERR_FILE_WRITE);}
 job->pixels=fdopen(fd,"w+b");
 if(!job->pixels){close(fd);ERREXIT(src,JERR_FILE_WRITE);}
 if(ftruncate(fd,(off_t)w*h*3)!=0)ERREXIT(src,JERR_FILE_WRITE);
 job->spill_count++;
 src->out_color_space=JCS_RGB;jpeg_start_decompress(src);
 unsigned bandRows=(8*1024*1024)/(w*3);if(bandRows>128)bandRows=128;if(!bandRows)bandRows=1;
 job->band=malloc((size_t)w*3*bandRows);job->row=malloc((size_t)(ow>bandRows?ow:bandRows)*3);
 if(!job->band||!job->row)ERREXIT(src,JERR_OUT_OF_MEMORY);
 for(unsigned y=0;y<h;y+=bandRows){
  momo_check_cancel((j_common_ptr)src);
  unsigned count=h-y<bandRows?h-y:bandRows;
  for(unsigned k=0;k<count;k++){
   JSAMPROW row=job->band+(size_t)k*w*3;
   if(jpeg_read_scanlines(src,&row,1)!=1)ERREXIT(src,JERR_FILE_READ);
  }
  if(transpose){
   for(unsigned x=0;x<w;x++){
    unsigned dy=(op==4||op==7)?w-1-x:x;
    unsigned dx=(op==4||op==5)?h-y-count:y;
    for(unsigned k=0;k<count;k++){
     unsigned sy=(op==4||op==5)?count-1-k:k;
     memcpy(job->row+k*3,job->band+((size_t)sy*w+x)*3,3);
    }
    if(pwrite(fd,job->row,count*3,((off_t)dy*ow+dx)*3)!=(ssize_t)count*3)ERREXIT(src,JERR_FILE_WRITE);
   }
  }else{
   for(unsigned k=0;k<count;k++){
    unsigned dy=(op==2||op==6)?h-1-y-k:y+k;
    unsigned char *row=job->band+(size_t)k*w*3;
    if(op==1||op==6){for(unsigned x=0;x<w;x++)memcpy(job->row+x*3,row+(w-1-x)*3,3);row=job->row;}
    if(pwrite(fd,row,w*3,(off_t)dy*ow*3)!=(ssize_t)w*3)ERREXIT(src,JERR_FILE_WRITE);
   }
  }
 }
 free(job->band);job->band=NULL;
 if(fseeko(job->pixels,0,SEEK_SET)!=0)ERREXIT(src,JERR_TFILE_SEEK);
 int outputFd=open(output,O_WRONLY|O_CREAT|O_EXCL,0600);
 if(outputFd<0)ERREXIT(dst,JERR_FILE_WRITE);
 job->output_created=1;job->output=fdopen(outputFd,"wb");
 if(!job->output){close(outputFd);ERREXIT(dst,JERR_FILE_WRITE);}
 dst->image_width=ow;dst->image_height=oh;dst->input_components=3;dst->in_color_space=JCS_RGB;
 jpeg_set_defaults(dst);jpeg_set_quality(dst,100,TRUE);
 // Avoid additional chroma subsampling when re-encoding edge-sized covers.
 for(int i=0;i<3;i++){dst->comp_info[i].h_samp_factor=1;dst->comp_info[i].v_samp_factor=1;}
 jpeg_stdio_dest(dst,job->output);jpeg_start_compress(dst,TRUE);
 jcopy_markers_execute(src,dst,JCOPYOPT_ALL);
 while(dst->next_scanline<oh){
  momo_check_cancel((j_common_ptr)dst);
  if(fread(job->row,1,(size_t)ow*3,job->pixels)!=(size_t)ow*3)ERREXIT(dst,JERR_TFILE_READ);
  JSAMPROW row=job->row;if(jpeg_write_scanlines(dst,&row,1)!=1)ERREXIT(dst,JERR_FILE_WRITE);
 }
 jpeg_finish_compress(dst);jpeg_finish_decompress(src);
}
