#!/usr/bin/env python3
"""Stage versioned game URLs and resumably upload verified, optionally gzipped blobs."""
import argparse,concurrent.futures,gzip,hashlib,json,os,pathlib,tempfile,time,urllib.request,urllib.error
P=pathlib.Path
parser=argparse.ArgumentParser();parser.add_argument('--frontend',required=True);parser.add_argument('--pack',required=True);parser.add_argument('--output',required=True);parser.add_argument('--url');parser.add_argument('--token-file');parser.add_argument('--publish',action='store_true');parser.add_argument('--unified',action='store_true');parser.add_argument('--mode',choices=['multiplayer','singleplayer'],default='multiplayer');args=parser.parse_args()
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
   if skip and ('-test.' in name or name in ['index.html','public-ui.mjs']):continue
   result[relative]=record(path)
 return result
frontend=collect(P(args.frontend).resolve(),args.mode=='multiplayer' or args.unified)
frontend['License.txt']=record(repo/'License.txt')
if args.unified:
 frontend['index.html']=record(repo/'server/web/game.html')
 for name in ['game-ui.mjs','singleplayer-ui.mjs','public-ui.mjs','release-cache.mjs','opfs-store.mjs','analytics-client.mjs','startup-wallpaper.webp']:frontend[name]=record(repo/'server/web'/name)
 bootstrap={'index.html','game-ui.mjs','release-cache.mjs','opfs-store.mjs','analytics-client.mjs','release-files.json','favicon.ico','startup-wallpaper.webp'}
 release_index=output/'release-files.json'
 release_index.write_text(json.dumps({name:item for name,item in frontend.items() if name not in bootstrap},sort_keys=True,separators=(',',':')))
 frontend['release-files.json']=record(release_index)
elif args.mode=='multiplayer':
 frontend['identity.mjs']=record(repo/'misc/web/multiplayer/identity.mjs')
 frontend['index.html']=record(repo/'server/web/index.html');frontend['public-ui.mjs']=record(repo/'server/web/public-ui.mjs')
else:
 frontend['index.html']=record(repo/'server/web/singleplayer.html');frontend['singleplayer-ui.mjs']=record(repo/'server/web/singleplayer-ui.mjs')
pack=collect(P(args.pack).resolve())
version=lambda value:hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
release,pack_id=version(frontend),version(pack)
for kind,digest,files in [('releases',release,frontend),('packs',pack_id,pack)]:
 entries.update({f'/{kind}/{digest}/{name}':value for name,value in files.items()})
query=f'stream=/packs/{pack_id}/pack.json'+('&map=zaton&slot=public' if args.mode=='multiplayer' and not args.unified else '')
manifest={'format':1,'mode':args.mode,'entry':f'/releases/{release}/index.html?{query}','files':entries}
(output/'manifest.json').write_text(json.dumps(manifest));(output/'sources.json').write_text(json.dumps(blobs));
print(json.dumps({'files':len(entries),'uniqueBlobs':len(blobs),'bytes':sum(x['size'] for x in blobs.values()),'release':release,'pack':pack_id}),flush=True)
if not args.url:raise SystemExit()
if not args.token_file:parser.error('--token-file is required for upload')
if not args.url.startswith('https://'):parser.error('Upload requires HTTPS')
token_path=P(args.token_file)
if token_path.stat().st_mode&0o077:raise SystemExit('Token file must be private')
token=token_path.read_text().strip();base=args.url.rstrip('/')
def call(path,method='GET',data=None,headers=None):
 req=urllib.request.Request(base+path,data=data,method=method,headers={'Authorization':'Bearer '+token,**(headers or {})})
 return urllib.request.urlopen(req,timeout=1800)
def upload(item):
 digest,meta=item;path='/_deploy/blobs/'+digest
 for attempt in range(4):
  try:
   with call(path,'HEAD') as res:
    if int(res.headers['Content-Length'])==meta['size']:return (0,0,True)
   break
  except urllib.error.HTTPError as error:
   if error.code==404:break
   if error.code not in [408,429,500,502,503,504] or attempt==3:raise
  except (urllib.error.URLError,TimeoutError,ConnectionError):
   if attempt==3:raise
  time.sleep(2**attempt)
 data=P(meta['path']).read_bytes();compressed=gzip.compress(data,compresslevel=3);use=len(compressed)<len(data)*.97
 payload=compressed if use else data
 for attempt in range(4):
  try:
   with call(path,'PUT',payload,{'Content-Encoding':'gzip' if use else 'identity'}) as res:res.read()
   return (len(data),len(payload),False)
  except (urllib.error.URLError,TimeoutError):
   if attempt==3:raise
   time.sleep(2**attempt)
started=time.monotonic();original=sent=skipped=done=0
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
 for future in concurrent.futures.as_completed([pool.submit(upload,item) for item in blobs.items()]):
  a,b,c=future.result();original+=a;sent+=b;skipped+=c;done+=1
  if (not c and a>1024*1024) or done%100==0 or done==len(blobs):print(json.dumps({'done':done,'total':len(blobs),'skipped':skipped,'sourceBytes':original,'uploadedBytes':sent,'seconds':round(time.monotonic()-started,1)}),flush=True)
if args.publish:
 with call('/_deploy/publish','POST',json.dumps(manifest).encode(),{'Content-Type':'application/json'}) as res:print('Published',res.read().decode(),flush=True)
else:print('Upload complete; release has not been activated.',flush=True)
(output/'upload-result.json').write_text(json.dumps({'originalBytes':original,'uploadedBytes':sent,'skipped':skipped,'seconds':time.monotonic()-started}))
