#!/usr/bin/env python3
"""Run on the Fly Machine AFTER volume publication; copy and verify game chunks."""
import os,uuid
import argparse,base64,concurrent.futures,hashlib,json,pathlib,time
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
p=argparse.ArgumentParser();p.add_argument('--root',default='/data/web');p.add_argument('--credentials',default='/data/private/tigris.json');p.add_argument('--origin',default='https://roman-stalker-wan.fly.dev');p.add_argument('--prune-volume',action='store_true',help='Remove verified bulk chunks after CDN gateway cutover');args=p.parse_args()
root=pathlib.Path(args.root);creds_path=pathlib.Path(args.credentials)
if creds_path.stat().st_mode&0o077:raise SystemExit('Credentials must be private')
creds=json.loads(creds_path.read_text());bucket=creds['BUCKET_NAME']
s3=boto3.client('s3',endpoint_url=creds.get('AWS_ENDPOINT_URL_S3','https://t3.storage.dev'),region_name=creds.get('AWS_REGION','auto'),aws_access_key_id=creds['AWS_ACCESS_KEY_ID'],aws_secret_access_key=creds['AWS_SECRET_ACCESS_KEY'],config=Config(signature_version='s3v4',max_pool_connections=8,retries={'max_attempts':8,'mode':'standard'},connect_timeout=15,read_timeout=120))
s3.put_bucket_cors(Bucket=bucket,CORSConfiguration={'CORSRules':[{'AllowedOrigins':[args.origin],'AllowedMethods':['GET','HEAD'],'AllowedHeaders':['*'],'ExposeHeaders':['ETag','Content-Length'],'MaxAgeSeconds':86400}]})
manifest=json.loads((root/'active.json').read_text());chunks={}
for path,item in manifest['files'].items():
 if path.startswith('/packs/') and '/chunks/' in path and path.endswith('.bin'):chunks[item['sha256']]=item['size']
if not chunks:raise SystemExit('No published chunks; finish volume upload first')
def verified(key,digest,size):
 try:
  head=s3.head_object(Bucket=bucket,Key=key)
  return head['ContentLength']==size and head.get('Metadata',{}).get('sha256')==digest
 except ClientError as e:
  if str(e.response['Error']['Code']) in ['404','NoSuchKey','NotFound']:return False
  raise
def transfer(item):
 digest,size=item;key='chunks/'+digest+'.bin'
 if verified(key,digest,size):return size,True
 data=(root/'blobs'/digest).read_bytes()
 if len(data)!=size or hashlib.sha256(data).hexdigest()!=digest:raise ValueError('Local chunk integrity failed')
 s3.put_object(Bucket=bucket,Key=key,Body=data,ContentType='application/octet-stream',CacheControl='public, max-age=31536000, immutable',Metadata={'sha256':digest},ContentMD5=base64.b64encode(hashlib.md5(data).digest()).decode())
 if not verified(key,digest,size):raise ValueError('Remote object verification failed')
 return size,False
started=time.monotonic();total=done=skipped=0
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 for future in concurrent.futures.as_completed([pool.submit(transfer,item) for item in chunks.items()]):
  size,reused=future.result();done+=1;total+=size;skipped+=reused
  if done%10==0 or done==len(chunks):print(json.dumps({'verified':done,'objects':len(chunks),'bytes':total,'reused':skipped,'seconds':round(time.monotonic()-started,1)}),flush=True)
ready=root/('cdn-ready.'+uuid.uuid4().hex+'.tmp');ready.write_text(json.dumps(sorted(chunks)));ready.chmod(0o644);os.replace(ready,root/'cdn-ready.json')
removed=0
if args.prune_volume:
 # Preserve any blob also referenced by a same-origin frontend/non-chunk URL.
 retained={v['sha256'] for path,v in manifest['files'].items() if not (path.startswith('/packs/') and '/chunks/' in path and path.endswith('.bin'))}
 for digest in chunks.keys()-retained:
  blob=root/'blobs'/digest
  if blob.exists():blob.unlink();removed+=1
result={'bucket':bucket,'objects':done,'bytes':total,'reused':skipped,'seconds':time.monotonic()-started,'source':'Fly persistent volume','originalsRetained':not args.prune_volume,'removedVolumeBlobs':removed}
(root/'cdn-migration.json').write_text(json.dumps(result));print('CDN_COPY_VERIFIED',json.dumps(result),flush=True)
