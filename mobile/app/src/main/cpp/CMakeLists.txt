cmake_minimum_required(VERSION 3.15)
project(momo_jpeg C)
include(ExternalProject)
set(JPEG_BUILD "${CMAKE_CURRENT_BINARY_DIR}/jpeg-build")
set(JPEG_SOURCE "${CMAKE_CURRENT_BINARY_DIR}/jpeg-source")
# An existing local archive can be used for offline builds; URL_HASH still verifies it.
set(JPEG_ARCHIVE_URL "https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/3.2.0/libjpeg-turbo-3.2.0.tar.gz")
if(DEFINED ENV{MOMO_LIBJPEG_ARCHIVE} AND NOT "$ENV{MOMO_LIBJPEG_ARCHIVE}" STREQUAL "")
 file(TO_CMAKE_PATH "$ENV{MOMO_LIBJPEG_ARCHIVE}" JPEG_ARCHIVE_URL)
endif()
ExternalProject_Add(momo_jpeg_vendor
 URL "${JPEG_ARCHIVE_URL}"
 URL_HASH SHA256=6f30092cef9fb839779646608f4ee14ae3cbac989c47fa05e841b0841f09878e
 SOURCE_DIR "${JPEG_SOURCE}" BINARY_DIR "${JPEG_BUILD}"
 CMAKE_ARGS -DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE} -DCMAKE_MAKE_PROGRAM=${CMAKE_MAKE_PROGRAM} -DANDROID_ABI=${ANDROID_ABI}
 -DANDROID_PLATFORM=android-33 -DCMAKE_BUILD_TYPE=Release -DCMAKE_POSITION_INDEPENDENT_CODE=ON
 -DCMAKE_OBJECT_PATH_MAX=180 -DENABLE_SHARED=OFF -DENABLE_STATIC=ON -DWITH_SIMD=OFF
 -DWITH_TURBOJPEG=OFF -DWITH_TOOLS=OFF -DWITH_TESTS=OFF
 BUILD_COMMAND "${CMAKE_COMMAND}" --build <BINARY_DIR> --target jpeg-static
 BUILD_BYPRODUCTS "${JPEG_BUILD}/libjpeg.a" INSTALL_COMMAND "")
add_library(momo_vendor_jpeg STATIC IMPORTED)
set_target_properties(momo_vendor_jpeg PROPERTIES IMPORTED_LOCATION "${JPEG_BUILD}/libjpeg.a")
set(MOMO_SOURCES jpeg_rotation.c bounded_memory.c pixel_rotation.c "${JPEG_SOURCE}/src/transupp.c")
set_source_files_properties("${JPEG_SOURCE}/src/transupp.c" PROPERTIES GENERATED TRUE)
add_library(momo_jpeg SHARED ${MOMO_SOURCES})
add_dependencies(momo_jpeg momo_jpeg_vendor)
target_include_directories(momo_jpeg PRIVATE "${JPEG_SOURCE}/src" "${JPEG_BUILD}")
target_compile_options(momo_jpeg PRIVATE -fvisibility=hidden -Wall -Wextra -Wno-unused-parameter)
target_link_options(momo_jpeg PRIVATE -Wl,-z,max-page-size=16384 -Wl,--exclude-libs,ALL)
target_link_libraries(momo_jpeg momo_vendor_jpeg m)
add_executable(momo_jpeg_probe EXCLUDE_FROM_ALL ${MOMO_SOURCES})
add_dependencies(momo_jpeg_probe momo_jpeg_vendor)
target_compile_definitions(momo_jpeg_probe PRIVATE MOMO_STANDALONE=1)
target_include_directories(momo_jpeg_probe PRIVATE "${JPEG_SOURCE}/src" "${JPEG_BUILD}")
target_link_libraries(momo_jpeg_probe momo_vendor_jpeg m)
