#include <shaderc/shaderc.h>
#include <emscripten/emscripten.h>
#include <cstring>

// A single compiler instance lives for the worker lifetime. Results are copied
// out by JS before the next call; the previous result is released on every call.
static shaderc_compiler_t compiler = nullptr;
static shaderc_compilation_result_t result = nullptr;
extern "C" {
EMSCRIPTEN_KEEPALIVE int compile_shader(const char* source, int fragment, int preprocess) {
    if (!compiler) compiler = shaderc_compiler_initialize();
    if (result) shaderc_result_release(result);
    auto options = shaderc_compile_options_initialize();
    shaderc_compile_options_set_target_env(options, shaderc_target_env_vulkan, shaderc_env_version_vulkan_1_1);
    if (!preprocess) shaderc_compile_options_set_optimization_level(options, shaderc_optimization_level_performance);
    const auto kind = fragment ? shaderc_fragment_shader : shaderc_vertex_shader;
    result = preprocess
        ? shaderc_compile_into_preprocessed_text(compiler, source, std::strlen(source), kind, "shader", "main", options)
        : shaderc_compile_into_spv(compiler, source, std::strlen(source), kind, "shader", "main", options);
    shaderc_compile_options_release(options);
    return static_cast<int>(shaderc_result_get_compilation_status(result));
}
EMSCRIPTEN_KEEPALIVE const char* result_bytes() { return shaderc_result_get_bytes(result); }
EMSCRIPTEN_KEEPALIVE size_t result_length() { return shaderc_result_get_length(result); }
EMSCRIPTEN_KEEPALIVE const char* result_error() { return shaderc_result_get_error_message(result); }
}
