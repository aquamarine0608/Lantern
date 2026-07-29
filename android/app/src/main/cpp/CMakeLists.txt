cmake_minimum_required(VERSION 3.22)

project(lantern_qwen3_tts LANGUAGES C CXX)

if(NOT ANDROID)
    message(FATAL_ERROR "Lantern's JNI target must be built with the Android NDK")
endif()

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_VISIBILITY_INLINES_HIDDEN ON)

set(QWEN3_TTS_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../../../external/qwen3-tts.cpp")
set(GGML_DIR "${QWEN3_TTS_ROOT}/ggml")

if(NOT EXISTS "${QWEN3_TTS_ROOT}/src/qwen3_tts_jni.cpp")
    message(FATAL_ERROR
        "Missing android/external/qwen3-tts.cpp. Follow android/README.md and check out the pinned native revision."
    )
endif()
if(NOT EXISTS "${GGML_DIR}/CMakeLists.txt")
    message(FATAL_ERROR
        "Missing qwen3-tts.cpp's recursive ggml dependency. Run its recursive submodule update described in android/README.md."
    )
endif()

# Start with the reference's proven CPU path. Optional acceleration backends
# need separate device, correctness, and thermal validation before enabling.
set(GGML_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(GGML_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(GGML_BACKEND_DL OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_VULKAN OFF CACHE BOOL "" FORCE)
set(GGML_OPENCL OFF CACHE BOOL "" FORCE)
set(GGML_METAL OFF CACHE BOOL "" FORCE)
set(GGML_CUDA OFF CACHE BOOL "" FORCE)
set(GGML_HIP OFF CACHE BOOL "" FORCE)
set(GGML_SYCL OFF CACHE BOOL "" FORCE)

add_subdirectory("${GGML_DIR}" "${CMAKE_CURRENT_BINARY_DIR}/ggml")
find_package(Threads REQUIRED)

function(lantern_link_ggml target_name)
    target_link_libraries(${target_name} PUBLIC ggml ggml-base ggml-cpu)
endfunction()

add_library(text_tokenizer STATIC
    "${QWEN3_TTS_ROOT}/src/text_tokenizer.cpp"
    "${QWEN3_TTS_ROOT}/src/gguf_loader.cpp"
    "${QWEN3_TTS_ROOT}/src/tokenizer_unicode.cpp"
    "${QWEN3_TTS_ROOT}/src/tokenizer_unicode_data.cpp"
)
target_include_directories(text_tokenizer PUBLIC "${QWEN3_TTS_ROOT}/src" "${GGML_DIR}/include")
lantern_link_ggml(text_tokenizer)
target_link_libraries(text_tokenizer PUBLIC Threads::Threads)

add_library(tts_transformer STATIC
    "${QWEN3_TTS_ROOT}/src/gguf_loader.cpp"
    "${QWEN3_TTS_ROOT}/src/tts_transformer.cpp"
    "${QWEN3_TTS_ROOT}/src/transformer/transformer_cache.cpp"
    "${QWEN3_TTS_ROOT}/src/transformer/transformer_debug.cpp"
    "${QWEN3_TTS_ROOT}/src/transformer/transformer_embeddings.cpp"
    "${QWEN3_TTS_ROOT}/src/transformer/transformer_graph_code_pred.cpp"
    "${QWEN3_TTS_ROOT}/src/transformer/transformer_graph_talker.cpp"
    "${QWEN3_TTS_ROOT}/src/transformer/transformer_loader.cpp"
    "${QWEN3_TTS_ROOT}/src/transformer/transformer_loader_metadata.cpp"
    "${QWEN3_TTS_ROOT}/src/transformer/transformer_loader_tensors.cpp"
    "${QWEN3_TTS_ROOT}/src/transformer/transformer_runtime.cpp"
    "${QWEN3_TTS_ROOT}/src/transformer/transformer_runtime_code_pred.cpp"
    "${QWEN3_TTS_ROOT}/src/transformer/transformer_generate.cpp"
    "${QWEN3_TTS_ROOT}/src/coreml_code_predictor_stub.cpp"
)
target_include_directories(tts_transformer PUBLIC "${QWEN3_TTS_ROOT}/src" "${GGML_DIR}/include")
lantern_link_ggml(tts_transformer)
target_link_libraries(tts_transformer PUBLIC Threads::Threads)

add_library(audio_tokenizer_encoder STATIC
    "${QWEN3_TTS_ROOT}/src/audio_tokenizer_encoder.cpp"
    "${QWEN3_TTS_ROOT}/src/encoder/encoder_frontend.cpp"
    "${QWEN3_TTS_ROOT}/src/encoder/encoder_graph.cpp"
    "${QWEN3_TTS_ROOT}/src/encoder/encoder_loader.cpp"
    "${QWEN3_TTS_ROOT}/src/encoder/encoder_runtime.cpp"
    "${QWEN3_TTS_ROOT}/src/gguf_loader.cpp"
)
target_include_directories(audio_tokenizer_encoder PUBLIC "${QWEN3_TTS_ROOT}/src" "${GGML_DIR}/include")
lantern_link_ggml(audio_tokenizer_encoder)
target_link_libraries(audio_tokenizer_encoder PUBLIC Threads::Threads)

add_library(speech_tokenizer_encoder STATIC
    "${QWEN3_TTS_ROOT}/src/speech_tokenizer_encoder.cpp"
    "${QWEN3_TTS_ROOT}/src/gguf_loader.cpp"
)
target_include_directories(speech_tokenizer_encoder PUBLIC "${QWEN3_TTS_ROOT}/src" "${GGML_DIR}/include")
lantern_link_ggml(speech_tokenizer_encoder)
target_link_libraries(speech_tokenizer_encoder PUBLIC Threads::Threads)

add_library(audio_tokenizer_decoder STATIC
    "${QWEN3_TTS_ROOT}/src/decoder/decoder_cache.cpp"
    "${QWEN3_TTS_ROOT}/src/decoder/decoder_graph.cpp"
    "${QWEN3_TTS_ROOT}/src/decoder/decoder_layers.cpp"
    "${QWEN3_TTS_ROOT}/src/decoder/decoder_loader.cpp"
    "${QWEN3_TTS_ROOT}/src/decoder/decoder_runtime.cpp"
    "${QWEN3_TTS_ROOT}/src/gguf_loader.cpp"
)
target_include_directories(audio_tokenizer_decoder PUBLIC "${QWEN3_TTS_ROOT}/src" "${GGML_DIR}/include")
lantern_link_ggml(audio_tokenizer_decoder)
target_link_libraries(audio_tokenizer_decoder PUBLIC Threads::Threads)

add_library(qwen3_tts STATIC
    "${QWEN3_TTS_ROOT}/src/common/audio_io.cpp"
    "${QWEN3_TTS_ROOT}/src/common/icl_prompt_io.cpp"
    "${QWEN3_TTS_ROOT}/src/common/speaker_embedding_io.cpp"
    "${QWEN3_TTS_ROOT}/src/pipeline/pipeline_models.cpp"
    "${QWEN3_TTS_ROOT}/src/pipeline/pipeline_runtime.cpp"
    "${QWEN3_TTS_ROOT}/src/pipeline/pipeline_synthesize.cpp"
    "${QWEN3_TTS_ROOT}/src/qwen3_tts.cpp"
    "${QWEN3_TTS_ROOT}/src/qwen3_tts_c.cpp"
)
target_include_directories(qwen3_tts PUBLIC "${QWEN3_TTS_ROOT}/src" "${GGML_DIR}/include")
target_link_libraries(qwen3_tts PUBLIC
    text_tokenizer
    tts_transformer
    audio_tokenizer_encoder
    speech_tokenizer_encoder
    audio_tokenizer_decoder
    Threads::Threads
)
target_compile_definitions(qwen3_tts PRIVATE QWEN3_TTS_EXPORT)

add_library(qwen3_tts_jni SHARED
    "${QWEN3_TTS_ROOT}/src/qwen3_tts_jni.cpp"
)
target_include_directories(qwen3_tts_jni PRIVATE "${QWEN3_TTS_ROOT}/src")
target_compile_definitions(qwen3_tts_jni PRIVATE QWEN3_TTS_STATIC)

find_library(ANDROID_LOG_LIBRARY log REQUIRED)
target_link_libraries(qwen3_tts_jni PRIVATE qwen3_tts "${ANDROID_LOG_LIBRARY}")

# NDK r28 already emits 16 KiB-compatible ELF alignment. Keep the final-link
# flags explicit so the requirement remains visible if the toolchain changes.
target_link_options(qwen3_tts_jni PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384"
)

