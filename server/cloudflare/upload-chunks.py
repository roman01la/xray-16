#!/usr/bin/env python3
"""Upload and verify gzip chunks through the same authenticated API as Wrangler."""
import argparse,concurrent.futures,gzip,hashlib,json,os,pathlib,threading,time,tomllib,urllib.request,urllib.error
p=argparse.ArgumentParser();p.add_argument('--publication',required=True);p.add_argument('--account',required=True);p.add_argument('--bucket',required=True);p.add_argument('--state',required=True);p.add_argument('--workers',type=int,default=4);p.add_argument('--source-base');p.add_argument('--token-file');a=p.parse_args()
base=pathlib.Path(a.publication);m=json.loads((base/'manifest.json').read_text());sources={} if a.source_base else json.loads((base/'sources.json').read_text());state=pathlib.Path(a.state)
chunks={v['sha256']:v['size'] for k,v in m['files'].items() if '/chunks/' in k}
verified=json.loads(state.read_text()) if state.exists() else {}
configs=[pathlib.Path.home()/'Library/Preferences/.wrangler/config/default.toml',pathlib.Path.home()/'.config/.wrangler/config/default.toml']
def token():
 if a.token_file:return pathlib.Path(a.token_file).read_text().strip()
 if os.environ.get('CLOUDFLARE_API_TOKEN'):return os.environ['CLOUDFLARE_API_TOKEN']
 return tomllib.loads(next(p for p in configs if p.exists()).read_text())['oauth_token']
def request(key,method='GET',data=None):
 url=f'https://api.cloudflare.com/client/v4/accounts/{a.account}/r2/buckets/{a.bucket}/objects/{key}'
 headers={'Authorization':'Bearer '+token(),'Accept-Encoding':'gzip','User-Agent':'Mozilla/5.0'}
 if method=='PUT':headers.update({'Content-Type':'application/octet-stream','Content-Encoding':'gzip','Cache-Control':'public, max-age=31536000, immutable'})
 for attempt in range(5):
  try:
   with urllib.request.urlopen(urllib.request.Request(url,data=data,method=method,headers=headers),timeout=180) as r:return r.read(),r.headers
  except urllib.error.HTTPError as e:
   if e.code not in [404,408,429,500,502,503,504] or attempt==4:raise
  except (urllib.error.URLError,TimeoutError):
   if attempt==4:raise
  time.sleep(2**attempt)
def upload(item):
 digest,size=item
 if digest in verified:return digest,verified[digest],True
 key='chunks/'+digest+'.bin.gz'
 if a.source_base:
  req=urllib.request.Request(a.source_base.rstrip('/')+'/'+key,headers={'Accept-Encoding':'gzip','User-Agent':'Mozilla/5.0'})
  with urllib.request.urlopen(req,timeout=180) as response:encoded=response.read()
  data=gzip.decompress(encoded)
 else:
  data=pathlib.Path(sources[digest]['path']).read_bytes()
  encoded=gzip.compress(data,compresslevel=6,mtime=0)
 if len(data)!=size or hashlib.sha256(data).hexdigest()!=digest:raise ValueError('Source hash mismatch')
 del data
 request(key,'PUT',encoded)
 body,headers=request(key)
 if headers.get('Content-Encoding')!='gzip' or hashlib.sha256(gzip.decompress(body)).hexdigest()!=digest:raise ValueError('R2 integrity check failed: '+digest)
 return digest,{'original':size,'compressed':len(body)},False
started=time.monotonic()
with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
 futures=[pool.submit(upload,item) for item in chunks.items()]
 for done,f in enumerate(concurrent.futures.as_completed(futures),1):
  try:digest,value,reused=f.result()
  except Exception:
   for pending in futures:pending.cancel()
   raise
  verified[digest]=value;state.parent.mkdir(parents=True,exist_ok=True);tmp=state.with_suffix('.tmp');tmp.write_text(json.dumps(verified));tmp.replace(state)
  if done%10==0 or done==len(chunks):print(json.dumps({'verified':done,'total':len(chunks),'seconds':round(time.monotonic()-started,1)}),flush=True)
print('R2_VERIFIED',json.dumps({'chunks':len(chunks),'compressedBytes':sum(verified[h]['compressed'] for h in chunks)}),flush=True)
