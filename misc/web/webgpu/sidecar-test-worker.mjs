import {initializeShaderCompilerClient,loadShaderProgram} from './shader-compiler-client.mjs';
self.onmessage=async({data})=>{
  try {
    await initializeShaderCompilerClient(data.port);
    const results=data.requests.map(request=>loadShaderProgram(request));
    self.postMessage({results});
  } catch(error) {self.postMessage({error:String(error.stack||error)});}
};
