// Logical storage separation; this is not an OPFS permissions sandbox.
const validRoot=root=>typeof root==='string' && /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,95}$/.test(root) && root!=='.' && root!=='..' && !root.endsWith('.') && !root.endsWith(' ');
export function storageLayout(root){
  if(!validRoot(root))throw new Error('Invalid game asset root');
  return Object.freeze({assetRoot:`/opfs/${root}`,configName:'fsgame.multiplayer.ltx',configPath:`/opfs/${root}/fsgame.multiplayer.ltx`,appDirectory:'_multiplayer_/v1',appPath:`/opfs/${root}/_multiplayer_/v1`});
}
export function multiplayerFsConfig(source){
  if(typeof source!=='string' || source.length>65536)throw new Error('Invalid filesystem configuration');
  const lines=source.split(/\r?\n/);let app=0;const required=new Set(['$logs$','$screenshots$','$game_saves$','$downloads$']);
  const result=lines.map(line=>{
    if(/^\s*;/.test(line))return line;
    const match=line.match(/^\s*(\$[a-z_]+\$)\s*=\s*(.*)$/i);if(!match)return line;
    const key=match[1].toLowerCase(),parts=match[2].split('|').map(x=>x.trim());
    if(key==='$app_data_root$'){
      if(++app!==1 || parts[2]!=='$fs_root$')throw new Error('Unsupported app-data root');
      return '$app_data_root$ = true| false| $fs_root$| _multiplayer_\\v1\\';
    }
    if(required.has(key)){
      if(parts[2]!=='$app_data_root$' || (parts[3] && !/^(logs|screenshots|savedgames)\\?$/.test(parts[3])))throw new Error('Unsafe writable alias');
      required.delete(key);
    }else if(['$logs$','$screenshots$','$game_saves$','$downloads$'].includes(key))throw new Error('Duplicate writable alias');
    return line;
  });
  if(app!==1 || required.size)throw new Error('Missing writable aliases');
  return result.join('\n');
}
export async function prepareMultiplayerStorage(opfs,root){
  const layout=storageLayout(root),assets=await opfs.getDirectoryHandle(root);
  const original=await (await assets.getFileHandle('fsgame.ltx')).getFile();
  const config=multiplayerFsConfig(await original.text()); // Validate before writes.
  let app=assets;for(const part of layout.appDirectory.split('/'))app=await app.getDirectoryHandle(part,{create:true});
  for(const sub of ['logs','savedgames','screenshots'])await app.getDirectoryHandle(sub,{create:true});
  const handle=await assets.getFileHandle(layout.configName,{create:true}),stream=await handle.createWritable();
  try{await stream.write(config);await stream.close();}catch(error){await stream.abort().catch(()=>{});throw error;}
  return layout;
}
