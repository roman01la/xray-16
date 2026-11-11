#!/usr/bin/env python3
"""Stage immutable single-player release URLs for Cloudflare publication."""
import argparse,hashlib,json,os,pathlib
P=pathlib.Path
parser=argparse.ArgumentParser();parser.add_argument('--frontend',required=True);parser.add_argument('--pack',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
repo=P(__file__).resolve().parents[2];output=P(args.output).resolve();output.mkdir(parents=True,exist_ok=True)
blobs={};entries={}
def record(path):
 data=path.read_bytes();digest=hashlib.sha256(data).hexdigest();blobs[digest]={'path':str(path.resolve()),'size':len(data)};return {'sha256':digest,'size':len(data)}
def collect(root,skip=False):
 result={}
 for directory,dirs,files in os.walk(root,followlinks=True):
  dirs.sort()
  for name in sorted(files):
   path=P(directory)/name;relative=path.relative_to(root).as_posix()
   if skip and ('-test.' in name or name == 'index.html'):continue
   result[relative]=record(path)
 return result
frontend=collect(P(args.frontend).resolve(),True)
frontend['License.txt']=record(repo/'License.txt')
frontend['index.html']=record(repo/'server/web/game.html')
for name in ['compatibility.mjs','game-ui.mjs','singleplayer-ui.mjs','release-cache.mjs','opfs-store.mjs','analytics-client.mjs','startup-wallpaper.webp']:frontend[name]=record(repo/'server/web'/name)
bootstrap={'compatibility.mjs','index.html','game-ui.mjs','release-cache.mjs','opfs-store.mjs','analytics-client.mjs','release-files.json','favicon.ico','startup-wallpaper.webp'}
release_index=output/'release-files.json'
release_index.write_text(json.dumps({name:item for name,item in frontend.items() if name not in bootstrap},sort_keys=True,separators=(',',':')))
frontend['release-files.json']=record(release_index)
pack=collect(P(args.pack).resolve())
version=lambda value:hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
release,pack_id=version(frontend),version(pack)
for kind,digest,files in [('releases',release,frontend),('packs',pack_id,pack)]:
 entries.update({f'/{kind}/{digest}/{name}':value for name,value in files.items()})
query=f'stream=/packs/{pack_id}/pack.json'
manifest={'format':1,'mode':'singleplayer','entry':f'/releases/{release}/index.html?{query}','files':entries}
(output/'manifest.json').write_text(json.dumps(manifest));(output/'sources.json').write_text(json.dumps(blobs));
print(json.dumps({'files':len(entries),'uniqueBlobs':len(blobs),'bytes':sum(x['size'] for x in blobs.values()),'release':release,'pack':pack_id}),flush=True)
