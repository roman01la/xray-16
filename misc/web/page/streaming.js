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
export async function prepareStreaming(manifestURL, root='stream-cop') {
  const url=new URL(manifestURL,location.href);
  if(url.origin!==location.origin || !url.pathname.endsWith('/pack.json') || url.search || url.hash)throw Error('Streaming pack must be a same-origin /pack.json URL');
  const response=await fetch(url);if(!response.ok)throw Error('Cannot load game pack: '+response.status);
  const pack=validatePack(await response.json());
  const opfs=await navigator.storage.getDirectory(),game=await opfs.getDirectoryHandle(root,{create:true});
  async function write(name,text){const file=await game.getFileHandle(name,{create:true}),writer=await file.createWritable();await writer.write(text);await writer.close();}
  const config=await (await game.getFileHandle('fsgame.ltx')).getFile();
  await write('fsgame.streaming.ltx',streamingConfig(await config.text()));
  await write('stream.mount',url.href.slice(0,-'/pack.json'.length)+'\n'+pack.files.map(f=>f.path).join('\n')+'\n');
  return {root,config:`/opfs/${root}/fsgame.streaming.ltx`,mount:`/opfs/${root}/stream.mount`,archives:pack.files.length};
}
