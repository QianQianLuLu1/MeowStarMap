/* Momo Camera backing store for the documented IJG memory-manager interface.
 * Original application code; upstream libjpeg-turbo sources stay unmodified.
 * Large coefficient arrays spill to anonymous files inside this export job.
 */
#define JPEG_INTERNALS
#include "jinclude.h"
#include "jpeglib.h"
#include "jerror.h"
#include "jmemsys.h"
#include "rotation_job.h"
#include <unistd.h>
#include <limits.h>

GLOBAL(void *) jpeg_get_small(j_common_ptr cinfo,size_t size){return malloc(size);}
GLOBAL(void) jpeg_free_small(j_common_ptr cinfo,void *ptr,size_t size){free(ptr);}
GLOBAL(void *) jpeg_get_large(j_common_ptr cinfo,size_t size){return malloc(size);}
GLOBAL(void) jpeg_free_large(j_common_ptr cinfo,void *ptr,size_t size){free(ptr);}
GLOBAL(size_t) jpeg_mem_available(j_common_ptr cinfo,size_t min,size_t max,size_t allocated){
 size_t budget=(size_t)cinfo->mem->max_memory_to_use;
 return allocated<budget?budget-allocated:0;
}
static void read_store(j_common_ptr cinfo,backing_store_ptr store,void *buffer,long offset,long size){
 momo_check_cancel(cinfo);
 if(fseeko(store->temp_file,(off_t)offset,SEEK_SET)!=0)ERREXIT(cinfo,JERR_TFILE_SEEK);
 if(fread(buffer,1,(size_t)size,store->temp_file)!=(size_t)size)ERREXIT(cinfo,JERR_TFILE_READ);
}
static void write_store(j_common_ptr cinfo,backing_store_ptr store,void *buffer,long offset,long size){
 momo_check_cancel(cinfo);
 if(fseeko(store->temp_file,(off_t)offset,SEEK_SET)!=0)ERREXIT(cinfo,JERR_TFILE_SEEK);
 if(fwrite(buffer,1,(size_t)size,store->temp_file)!=(size_t)size)ERREXIT(cinfo,JERR_TFILE_WRITE);
}
static void close_store(j_common_ptr cinfo,backing_store_ptr store){
 if(store->temp_file){fclose(store->temp_file);store->temp_file=NULL;}
}
GLOBAL(void) jpeg_open_backing_store(j_common_ptr cinfo,backing_store_ptr store,long total){
 rotation_job *job=(rotation_job *)cinfo->client_data;
 if(!job||total<0||total>180000000L*8L)ERREXIT(cinfo,JERR_OUT_OF_MEMORY);
 char name[PATH_MAX];int n=snprintf(name,sizeof(name),"%s/.momo-dct-XXXXXX",job->scratch);
 if(n<0||(size_t)n>=sizeof(name))ERREXIT(cinfo,JERR_TFILE_SEEK);
 int fd=mkstemp(name);
 if(fd<0)ERREXIT(cinfo,JERR_FILE_WRITE);
 /* Unlink immediately: cancellation/crash cannot leave a named giant cache file. */
 if(unlink(name)!=0){close(fd);ERREXIT(cinfo,JERR_FILE_WRITE);}
 if(ftruncate(fd,(off_t)total)!=0){close(fd);ERREXIT(cinfo,JERR_FILE_WRITE);}
 store->temp_file=fdopen(fd,"w+b");
 if(!store->temp_file){close(fd);ERREXIT(cinfo,JERR_FILE_WRITE);}
 store->temp_name[0]=0;store->read_backing_store=read_store;store->write_backing_store=write_store;store->close_backing_store=close_store;
 job->spill_count++;
}
GLOBAL(long) jpeg_mem_init(j_common_ptr cinfo){return 16L*1024*1024;}
GLOBAL(void) jpeg_mem_term(j_common_ptr cinfo){}
