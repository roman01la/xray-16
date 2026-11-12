#!/usr/bin/env python3
"""Stage immutable single-player release URLs for Cloudflare publication."""
import argparse,hashlib,json,os,pathlib,shutil,subprocess
P=pathlib.Path
parser=argparse.ArgumentParser();parser.add_argument('--frontend',required=True);parser.add_argument('--pack',required=True);parser.add_argument('--output',required=True);parser.add_argument('--game',choices=('cop','soc','cs'),default='cop');parser.add_argument('--wasm-symbols',type=P);args=parser.parse_args()
repo=P(__file__).resolve().parents[2];output=P(args.output).resolve();output.mkdir(parents=True,exist_ok=True)
frontend_dir=P(args.frontend).resolve()
if json.loads((frontend_dir/'engine_data.json').read_text()).get('gameId','cop')!=args.game:
 raise ValueError('Frontend is staged for a different game')
blobs={};entries={}
def record(path):
 data=path.read_bytes();digest=hashlib.sha256(data).hexdigest();blobs[digest]={'path':str(path.resolve()),'size':len(data)};return {'sha256':digest,'size':len(data)}
def collect(root,skip=False):
 result={}
 for directory,dirs,files in os.walk(root,followlinks=True):
  dirs.sort()
  for name in sorted(files):
   path=P(directory)/name;relative=path.relative_to(root).as_posix()
   if skip and ('-test.' in name or name in ('index.html','developer.html')):continue
   result[relative]=record(path)
 return result
frontend=collect(frontend_dir,True)
frontend['License.txt']=record(repo/'License.txt')
page=(repo/'server/web/game.html').read_text()
if args.game!='cop':
 title,store={'soc':('Shadow of Chernobyl','/app/4500/'),'cs':('Clear Sky','/app/20510/')}[args.game]
 page=(page.replace('data-game="cop"',f'data-game="{args.game}"')
       .replace('Call of Pripyat',title)
       .replace('/app/41700/STALKER_Call_of_Pripyat/',store))
index=output/'index.html'
index.write_text(page)
frontend['index.html']=record(index)
for name in ['compatibility.mjs','game-ui.mjs','singleplayer-ui.mjs','release-cache.mjs','opfs-store.mjs','analytics-client.mjs','analytics-movement.mjs','crash-reporter.mjs']:frontend[name]=record(repo/'server/web'/name)
bundle_dir=output/'bundles'
subprocess.run(['node',str(repo/'misc/web/tools/bundle-web.mjs'),str(frontend_dir),str(bundle_dir)],check=True)
frontend={name:item for name,item in frontend.items() if not name.endswith(('.js','.mjs','.map'))}
for path in sorted(bundle_dir.rglob('*')):
 if path.is_file() and path.suffix in ('.js','.mjs'):
  frontend[path.relative_to(bundle_dir).as_posix()]=record(path)
wallpaper='startup-wallpaper.webp' if args.game=='cop' else f'startup-wallpaper-{args.game}.webp'
frontend['startup-wallpaper.webp']=record(repo/'server/web'/wallpaper)
bootstrap={'index.html','game-ui.mjs','release-cache.mjs','release-files.json','favicon.ico','startup-wallpaper.webp'}
release_index=output/'release-files.json'
release_index.write_text(json.dumps({name:item for name,item in frontend.items() if name not in bootstrap},sort_keys=True,separators=(',',':')))
frontend['release-files.json']=record(release_index)
pack=collect(P(args.pack).resolve())
version=lambda value:hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
release,pack_id=version(frontend),version(pack)
if args.wasm_symbols:
 symbols=output/'private-symbols'/release
 symbols.mkdir(parents=True,exist_ok=True)
 shutil.copyfile(frontend_dir/'xr_3da.wasm',symbols/'xr_3da.wasm')
 shutil.copyfile(args.wasm_symbols,symbols/'xr_3da.js.symbols')
for kind,digest,files in [('releases',release,frontend),('packs',pack_id,pack)]:
 entries.update({f'/{kind}/{digest}/{name}':value for name,value in files.items()})
query=f'stream=/packs/{pack_id}/pack.json'
manifest={'format':1,'mode':'singleplayer','gameId':args.game,'entry':f'/releases/{release}/index.html?{query}','files':entries}
(output/'manifest.json').write_text(json.dumps(manifest));(output/'sources.json').write_text(json.dumps(blobs));
print(json.dumps({'files':len(entries),'uniqueBlobs':len(blobs),'bytes':sum(x['size'] for x in blobs.values()),'release':release,'pack':pack_id}),flush=True)
