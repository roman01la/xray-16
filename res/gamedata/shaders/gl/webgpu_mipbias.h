#ifndef XR_WEBGPU_MIPBIAS_H
#define XR_WEBGPU_MIPBIAS_H
#ifdef XR_WEBGPU_FRAGMENT
// The shared compiler applies this to implicit/gradient texture sampling.
// Explicit LOD, integer fetches and comparison shadows retain their semantics.
uniform vec4 xr_webgpu_mip_bias;
#endif
#endif
