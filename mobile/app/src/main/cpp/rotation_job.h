#ifndef MOMO_ROTATION_JOB_H
#define MOMO_ROTATION_JOB_H
#include <stdio.h>
#include <setjmp.h>
#include "jpeglib.h"
#ifndef MOMO_STANDALONE
#include <jni.h>
#endif
typedef struct rotation_job rotation_job;
typedef struct { struct jpeg_error_mgr base; rotation_job *job; } momo_error;
struct rotation_job {
 struct jpeg_decompress_struct src;
 struct jpeg_compress_struct dst;
 momo_error source_error,dest_error;
 jmp_buf jump;
 FILE *input,*output,*pixels;
 unsigned char *band,*row;
 int source_created,dest_created,output_created,spill_count,status;
 const char *scratch;
 char message[JMSG_LENGTH_MAX];
#ifndef MOMO_STANDALONE
 JNIEnv *env; jobject thread; jmethodID interrupted;
#endif
};
void momo_check_cancel(j_common_ptr info);
void momo_rotate_pixels(rotation_job *job,const char *output,int operation);
#endif
