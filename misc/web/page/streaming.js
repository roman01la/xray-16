// Optional URL-selected source. Imported games retain their original launch path.
export function validatePack(pack) {
  if(pack?.format!=='xray-stream-pack-v1'||pack.chunkBytes!==16*1024*1024||!Array.isArray(pack.files)||!pack.files.length||pack.files.length>4096)throw Error('Invalid streaming pack');
  const seen=new Set();
  for(const f of pack.files){
    if(!/^(resources|levels|localization|patches)\/[a-z0-9_-][a-z0-9_.-]*\.db[0-9]*$/.test(f.path)||f.path.includes('..')||seen.has(f.path)||!Number.isSafeInteger(f.size)||f.size<1)throw Error('Invalid archive entry');
    seen.add(f.path);
  }
  if(!pack.files.some(f=>f.path.startsWith('resources/'))||!pack.files.some(f=>f.path.startsWith('levels/')))throw Error('Missing game archives');
  return pack;
}
export function streamingConfig(source) {
  // Original patches remain in /stream/patches; engine overrides remain in OPFS.
  const aliases={arch_dir_levels:'levels',arch_dir_resources:'resources',arch_dir_localization:'localization'};
  let text=source.replace(/^(\$([^$]+)\$\s*=)[^\r\n]*$/gm,(line,prefix,name)=>aliases[name]?`${prefix} false| false| /stream/${aliases[name]}/`:line);
  text=text.replace(/^(\$arch_dir_patches\$)/m,'$arch_dir_stream_patches$ = false| false| /stream/patches/\n$1');
  return text;
}
// Called by the ingest worker. Only progress and the completed mount cross
// back to the page, so pack verification and OPFS writes stay off the UI thread.
export async function installStreaming(manifestURL, root, onProgress) {
  const report=detail=>onProgress({phase:'install',...detail});
  report({});
  try {
    const url=new URL(manifestURL,location.href);
    if(url.origin!==location.origin || !url.pathname.endsWith('/pack.json') || url.search || url.hash)throw Error('Game pack must be a same-origin /pack.json URL');
    const {ChunkReader,gameStorageError}=await import('./chunk-reader.mjs');
    const response=await fetch(url);if(!response.ok)throw Error('Cannot load game pack: HTTP '+response.status);
    const pack=validatePack(await response.json()),base=new URL('./',url);
    const install=()=>new ChunkReader({mode:'install',budget:0,onProgress:report}).install(
      pack.files.map(file=>({url:new URL(file.path,base).href,size:file.size})));
    if(navigator.locks)await navigator.locks.request('xray-game-pack-install',install);
    else await install();

    const opfs=await navigator.storage.getDirectory(),game=await opfs.getDirectoryHandle(root,{create:true});
    let firstInstall=false;
    try {
      firstInstall=true;
      for await(const [name,handle] of game.entries()) {
        if(handle.kind==='file'&&/^stream-[a-f0-9]{32}\.mount$/.test(name)&&(await handle.getFile()).size){
          firstInstall=false;
          break;
        }
      }
    } catch {firstInstall=false;}
    async function write(name,text){
      try {
        const file=await game.getFileHandle(name,{create:true}),writer=await file.createWritable();
        await writer.write(text);await writer.close();
      } catch(error) {throw gameStorageError(error);}
    }
    const config=await (await game.getFileHandle('fsgame.ltx')).getFile();
    const release=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(url.href));
    const suffix=Array.from(new Uint8Array(release).subarray(0,16),byte=>byte.toString(16).padStart(2,'0')).join('');
    const mount=`stream-${suffix}.mount`;
    await write('fsgame.streaming.ltx',streamingConfig(await config.text()));
    await write(mount,base.href.slice(0,-1)+'\n'+pack.files.map(f=>f.path).join('\n')+'\n');
    report({ready:true,firstInstall});
    return {root,config:`/opfs/${root}/fsgame.streaming.ltx`,mount:`/opfs/${root}/${mount}`,archives:pack.files.length};
  } catch(error) {report({error:error.message});throw error;}
}
