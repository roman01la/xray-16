#!/usr/bin/env python3
"""Run on the Fly Machine AFTER volume publication; copy and verify game chunks."""
import os,uuid,gzip
import argparse,base64,concurrent.futures,hashlib,json,pathlib,time
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
p=argparse.ArgumentParser();p.add_argument('--root',default='/data/web');p.add_argument('--credentials',default='/data/private/tigris.json');p.add_argument('--origin',default='https://roman-stalker-wan.fly.dev');p.add_argument('--workers',type=int,choices=range(1,5),default=1);p.add_argument('--prune-volume',action='store_true',help='Remove verified bulk chunks after CDN gateway cutover');args=p.parse_args()
root=pathlib.Path(args.root);creds_path=pathlib.Path(args.credentials)
if creds_path.stat().st_mode&0o077:raise SystemExit('Credentials must be private')
creds=json.loads(creds_path.read_text());bucket=creds['BUCKET_NAME']
s3=boto3.client('s3',endpoint_url=creds.get('AWS_ENDPOINT_URL_S3','https://t3.storage.dev'),region_name=creds.get('AWS_REGION','auto'),aws_access_key_id=creds['AWS_ACCESS_KEY_ID'],aws_secret_access_key=creds['AWS_SECRET_ACCESS_KEY'],config=Config(signature_version='s3v4',max_pool_connections=8,retries={'max_attempts':8,'mode':'standard'},connect_timeout=15,read_timeout=120))
s3.put_bucket_cors(Bucket=bucket,CORSConfiguration={'CORSRules':[{'AllowedOrigins':[args.origin],'AllowedMethods':['GET','HEAD'],'AllowedHeaders':['*'],'ExposeHeaders':['ETag','Content-Length','Content-Encoding'],'MaxAgeSeconds':86400}]})
manifest=json.loads((root/'active.json').read_text());chunks={}
for path,item in manifest['files'].items():
 if path.startswith('/packs/') and '/chunks/' in path and path.endswith('.bin'):chunks[item['sha256']]=item['size']
if not chunks:raise SystemExit('No published chunks; finish volume upload first')
def transfer(item):
 digest,size=item;key='chunks/'+digest+'.bin.gz'
 # Resume only after verifying the encoded object by decoding its actual body.
 try:
  response=s3.get_object(Bucket=bucket,Key=key)
  encoded=response['Body'].read()
  data=gzip.decompress(encoded)
  if response.get('ContentEncoding')=='gzip' and len(data)==size and hashlib.sha256(data).hexdigest()==digest:
   return size,True,len(encoded)
 except ClientError as e:
  if str(e.response['Error']['Code']) not in ['404','NoSuchKey','NotFound']:raise
 except (OSError,EOFError):
  pass
 blob=root/'blobs'/digest
 # Old raw CDN objects are migration input only, never a download fallback.
 data=blob.read_bytes() if blob.exists() else s3.get_object(Bucket=bucket,Key='chunks/'+digest+'.bin')['Body'].read()
 if len(data)!=size or hashlib.sha256(data).hexdigest()!=digest:raise ValueError('Source chunk integrity failed')
 encoded=gzip.compress(data,compresslevel=6,mtime=0)
 encoded_hash=hashlib.sha256(encoded).hexdigest()
 s3.put_object(Bucket=bucket,Key=key,Body=encoded,ContentType='application/octet-stream',ContentEncoding='gzip',CacheControl='public, max-age=31536000, immutable',Metadata={'sha256':digest,'encoded-sha256':encoded_hash},ContentMD5=base64.b64encode(hashlib.md5(encoded).digest()).decode())
 response=s3.get_object(Bucket=bucket,Key=key)
 downloaded=response['Body'].read()
 if response.get('ContentEncoding')!='gzip' or hashlib.sha256(downloaded).hexdigest()!=encoded_hash or gzip.decompress(downloaded)!=data:
  raise ValueError('Compressed remote chunk integrity failed')
 return size,False,len(encoded)
started=time.monotonic();total=done=skipped=wire=0
with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
 futures=[pool.submit(transfer,item) for item in chunks.items()]
 for future in concurrent.futures.as_completed(futures):
  try:size,reused,encoded_size=future.result()
  except Exception:
   for pending in futures:pending.cancel()
   print('CDN_COPY_FAILED; pending work cancelled, readiness unchanged',flush=True)
   raise
  done+=1;total+=size;skipped+=reused;wire+=encoded_size
  if done%10==0 or done==len(chunks):print(json.dumps({'verified':done,'objects':len(chunks),'bytes':total,'reused':skipped,'seconds':round(time.monotonic()-started,1)}),flush=True)
ready=root/('cdn-ready.'+uuid.uuid4().hex+'.tmp');ready.write_text(json.dumps(sorted(chunks)));ready.chmod(0o644);os.replace(ready,root/'cdn-ready.json')
removed=0
if args.prune_volume:
 # Preserve any blob also referenced by a same-origin frontend/non-chunk URL.
 retained={v['sha256'] for path,v in manifest['files'].items() if not (path.startswith('/packs/') and '/chunks/' in path and path.endswith('.bin'))}
 for digest in chunks.keys()-retained:
  blob=root/'blobs'/digest
  if blob.exists():blob.unlink();removed+=1
result={'bucket':bucket,'objects':done,'bytes':total,'compressedTransferBytes':wire,'gzipObjects':done,'reused':skipped,'seconds':time.monotonic()-started,'source':'Fly persistent volume','originalsRetained':not args.prune_volume,'removedVolumeBlobs':removed}
(root/'cdn-migration.json').write_text(json.dumps(result));print('CDN_COPY_VERIFIED',json.dumps(result),flush=True)
