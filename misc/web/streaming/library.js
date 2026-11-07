// Override only WasmFS's fetch backend implementation. OPFS remains untouched.
// Use its existing C++ proxy worker so synchronous engine reads can await network
// without blocking the browser main thread or adding Asyncify to the engine.
addToLibrary({
  _wasmfs_create_fetch_backend_js__deps: ['$wasmFS$backends', '_wasmfs_fetch_get_file_url'],
  _wasmfs_create_fetch_backend_js: function(backend) {
    // C++ setup is synchronous: install operations immediately, await import
    // inside operations rather than leaving an unregistered backend during boot.
    var ready = import(new URL('./chunk-reader.mjs', import.meta.url).href).then(module=>new module.ChunkReader());
    function url(file) { var u = new URL(UTF8ToString(__wasmfs_fetch_get_file_url(file)), self.location.origin); u.pathname = u.pathname.replace(/\/{2,}/g, '/'); return u.href; }
    wasmFS$backends[backend] = {
      allocFile: async () => {}, freeFile: async () => {},
      write: async () => -{{{ cDefs.EROFS }}},
      setSize: async () => -{{{ cDefs.EROFS }}},
      getSize: async function(file) {
        try { return (await (await ready).descriptor(url(file))).size; }
        catch(error) { err('Archive stat failed: ' + error.stack); return -{{{ cDefs.EIO }}}; }
      },
      read: async function(file, buffer, length, offset) {
        try { return await (await ready).read(url(file), Number(offset), Number(length), (bytes,at)=>HEAPU8.set(bytes,Number(buffer)+at)); }
        catch(error) { err('Archive read failed: ' + error.stack); return -{{{ cDefs.EIO }}}; }
      }
    };
  }
});
