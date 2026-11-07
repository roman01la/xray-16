import { loadShaderProgram } from './shader-compiler-client.mjs';

// Engine-owned resource handles with explicit lifetime management.
export function createNativeHandles() {
  const h = {next:1};
  for (const kind of ['buffers','textures','queries','programs','shaders','samplers','vaos','framebuffers']) h[kind] = [null];
  h.getNewId = () => h.next++;
  return h;
}
export function allocateHandle(handles, kind, token = {}) {
  const id = handles.getNewId();
  token.name = id;
  handles[kind][id] = token;
  return id;
}
export function loadNativeProgram(renderer, handles, vertex, fragment, loadProgram = loadShaderProgram) {
  // Packaged v3 keys preserve the original fragment-then-vertex field order.
  const request = {sources:{frag:fragment ? handles.shaders[fragment].source : '#version 300 es\nvoid main() {}\n',
    vert:handles.shaders[vertex].source}, attributes:[]};
  const program = {meta:loadProgram(request),uniformLocsById:[],uniformNames:new Map()};
  const id = allocateHandle(handles,'programs',program);
  renderer.link(program);
  return id;
}
export function nativeUniformLocation(program, name) {
  if (program.uniformNames.has(name)) return program.uniformNames.get(name);
  const base = name.replace(/\[\d+\]$/,'');
  const index = Number(name.match(/\[(\d+)\]$/)?.[1] || 0);
  const uniform = program.meta.activeUniforms.find(u=>u.name.replace(/\[0\]$/,'')===base);
  if (!uniform || index >= uniform.size) return -1;
  // Engine array setters address elements as baseLocation + element. Reserve the
  // entire array so its locations cannot alias unrelated uniforms.
  const first = program.uniformLocsById.length;
  program.uniformNames.set(base,first);
  for (let element=0;element<uniform.size;element++) {
    const elementName = element ? `${base}[${element}]` : base;
    program.uniformLocsById.push({program,name:elementName});
    program.uniformNames.set(`${base}[${element}]`,first+element);
  }
  return first+index;
}
export function nativeSamplerParameter(renderer, token, parameter, value) {
  renderer.flushNativeBindings?.();
  const info = renderer.info(token);
  (info.params ??= new Map()).set(parameter,value);
  info.gpuSamplers = null;
  renderer.resourceGeneration++;
}
export function deleteNativeObject(renderer, handles, kind, id) {
  const token = handles[kind][id];
  if (!token) return;
  renderer.flushNativeStates?.();
  renderer.flushNativeBindings?.();
  renderer.flushNativeUniforms?.();
  if (kind === 'samplers') {
    for (let n=0;n<renderer.samplers.length;n++) if(renderer.samplers[n]===token) renderer.samplers[n]=null;
    renderer.resourceGeneration++;
  }
  if (kind === 'framebuffers') {
    if(renderer.fbo===token) renderer.fbo=null;
    if(renderer.readFbo===token) renderer.readFbo=null;
  }
  if (kind === 'vaos' && renderer.vaoObject===token) renderer.selectNativeVertexArray(null);
  if (kind === 'programs' && renderer.program===token) renderer.selectNativeProgram(null);
  token.deleted=true;
  handles[kind][id]=null;
}
