#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/resource.h>
#include "jpeglib.h"
#include "jerror.h"
#include "transupp.h"
#include "rotation_job.h"

static void fail(j_common_ptr info){
 momo_error *error=(momo_error *)info->err;
 (*info->err->format_message)(info,error->job->message);
 longjmp(error->job->jump,1);
}
static void emit(j_common_ptr info,int level){if(level<0)fail(info);}
void momo_check_cancel(j_common_ptr info){
#ifndef MOMO_STANDALONE
 rotation_job *job=(rotation_job *)info->client_data;
 if(job&&job->thread&&(*job->env)->CallBooleanMethod(job->env,job->thread,job->interrupted)){
  snprintf(job->message,sizeof(job->message),"JPEG rotation cancelled");longjmp(job->jump,1);
 }
#endif
}
static int rotate_file(rotation_job *job,const char *input,const char *output,int operation,long memory){
 job->status=-1;
 job->src.err=jpeg_std_error(&job->source_error.base);job->source_error.job=job;
 job->dst.err=jpeg_std_error(&job->dest_error.base);job->dest_error.job=job;
 job->source_error.base.error_exit=fail;job->dest_error.base.error_exit=fail;
 job->source_error.base.emit_message=emit;job->dest_error.base.emit_message=emit;
 if(setjmp(job->jump))goto cleanup;
 job->input=fopen(input,"rb");
 if(!job->input){snprintf(job->message,sizeof(job->message),"Cannot read JPEG input");goto cleanup;}
 struct stat st;if(fstat(fileno(job->input),&st)||st.st_size<4||st.st_size>64L*1024*1024){
  snprintf(job->message,sizeof(job->message),"JPEG input exceeds supported byte limit");goto cleanup;
 }
 job->source_created=1;jpeg_create_decompress(&job->src);job->src.client_data=job;
 job->dest_created=1;jpeg_create_compress(&job->dst);job->dst.client_data=job;
 job->src.mem->max_memory_to_use=memory;job->dst.mem->max_memory_to_use=memory;
 jpeg_stdio_src(&job->src,job->input);jcopy_markers_setup(&job->src,JCOPYOPT_ALL);
 jpeg_read_header(&job->src,TRUE);
 if(job->src.data_precision!=8||((uint64_t)job->src.image_width)*job->src.image_height>180000000ULL){
  snprintf(job->message,sizeof(job->message),"Unsupported JPEG precision or pixel count");goto cleanup;
 }
 jpeg_transform_info transform;memset(&transform,0,sizeof(transform));
 transform.transform=(JXFORM_CODE)operation;transform.perfect=TRUE;transform.trim=FALSE;
 if(!jtransform_request_workspace(&job->src,&transform)){
  momo_rotate_pixels(job,output,operation);goto finish;
 }
 jvirt_barray_ptr *source=jpeg_read_coefficients(&job->src);
 jpeg_copy_critical_parameters(&job->src,&job->dst);
 jvirt_barray_ptr *destination=jtransform_adjust_parameters(&job->src,&job->dst,source,&transform);
 int fd=open(output,O_WRONLY|O_CREAT|O_EXCL,0600);
 if(fd<0){snprintf(job->message,sizeof(job->message),"Cannot create new JPEG output");goto cleanup;}
 job->output_created=1;job->output=fdopen(fd,"wb");
 if(!job->output){close(fd);snprintf(job->message,sizeof(job->message),"Cannot open JPEG output stream");goto cleanup;}
 jpeg_stdio_dest(&job->dst,job->output);jpeg_write_coefficients(&job->dst,destination);
 jcopy_markers_execute(&job->src,&job->dst,JCOPYOPT_ALL);
 jtransform_execute_transformation(&job->src,&job->dst,source,&transform);
 jpeg_finish_compress(&job->dst);jpeg_finish_decompress(&job->src);
finish:
 if(fflush(job->output)||ferror(job->output)){snprintf(job->message,sizeof(job->message),"JPEG output storage failed");goto cleanup;}
 momo_check_cancel((j_common_ptr)&job->src);job->status=0;
cleanup:
 if(job->dest_created)jpeg_destroy_compress(&job->dst);
 if(job->source_created)jpeg_destroy_decompress(&job->src);
 if(job->pixels)fclose(job->pixels);free(job->band);free(job->row);
 if(job->input)fclose(job->input);if(job->output)fclose(job->output);
 if(job->output_created&&job->status!=0)unlink(output);
 return job->status;
}

#ifndef MOMO_STANDALONE
JNIEXPORT jint JNICALL Java_app_nikkisync_mobile_media_live_LosslessJpegRotation_transform(
 JNIEnv *env,jclass cls,jstring in,jstring out,jstring scratch,jint operation){
 if(operation<0||operation>7)return 1;
 const char *a=(*env)->GetStringUTFChars(env,in,NULL),*b=(*env)->GetStringUTFChars(env,out,NULL),*c=(*env)->GetStringUTFChars(env,scratch,NULL);
 if(!a||!b||!c){if(a)(*env)->ReleaseStringUTFChars(env,in,a);if(b)(*env)->ReleaseStringUTFChars(env,out,b);if(c)(*env)->ReleaseStringUTFChars(env,scratch,c);return -1;}
 rotation_job *job=calloc(1,sizeof(*job));
 if(!job){(*env)->ReleaseStringUTFChars(env,in,a);(*env)->ReleaseStringUTFChars(env,out,b);(*env)->ReleaseStringUTFChars(env,scratch,c);(*env)->ThrowNew(env,(*env)->FindClass(env,"java/io/IOException"),"JPEG rotation allocation failed");return -1;}
 job->scratch=c;job->env=env;
 jclass thread=(*env)->FindClass(env,"java/lang/Thread");
 job->thread=(*env)->CallStaticObjectMethod(env,thread,(*env)->GetStaticMethodID(env,thread,"currentThread","()Ljava/lang/Thread;"));
 job->interrupted=(*env)->GetMethodID(env,thread,"isInterrupted","()Z");
 int result=rotate_file(job,a,b,operation,16L*1024*1024);
 (*env)->ReleaseStringUTFChars(env,in,a);(*env)->ReleaseStringUTFChars(env,out,b);(*env)->ReleaseStringUTFChars(env,scratch,c);
 if(result<0)(*env)->ThrowNew(env,(*env)->FindClass(env,"java/io/IOException"),job->message[0]?job->message:"JPEG rotation failed");
 free(job);return result;
}
#else
int main(int argc,char **argv){
 if(argc!=6)return 2;rotation_job *job=calloc(1,sizeof(*job));if(!job)return 2;
 job->scratch=argv[4];int result=rotate_file(job,argv[1],argv[2],atoi(argv[3]),atol(argv[5])*1024*1024);
 struct rusage usage;getrusage(RUSAGE_SELF,&usage);
 printf("{\"status\":%d,\"spills\":%d,\"peakRssKiB\":%ld}\n",result,job->spill_count,usage.ru_maxrss);
 if(result<0)fprintf(stderr,"%s\n",job->message);free(job);return result==0?0:(result==1?3:1);
}
#endif
