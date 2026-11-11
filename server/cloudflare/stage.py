#!/usr/bin/env python3
"""Stage an existing immutable release without changing its URLs or file hashes."""
import argparse,hashlib,html,json,pathlib,shutil
p=argparse.ArgumentParser();p.add_argument('--publication',required=True);p.add_argument('--retain',action='append',default=[]);p.add_argument('--output',default=str(pathlib.Path(__file__).parent/'.assets'));a=p.parse_args()
out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=True)
current=json.loads((pathlib.Path(a.publication)/'manifest.json').read_text())
for folder in [*a.retain,a.publication]:
 base=pathlib.Path(folder);m=json.loads((base/'manifest.json').read_text());sources=json.loads((base/'sources.json').read_text())
 for url,item in m['files'].items():
  if '/chunks/' in url:continue
  rel=pathlib.PurePosixPath(url.lstrip('/'))
  if '..' in rel.parts:raise ValueError('Unsafe manifest path')
  dest=out/rel
  data=pathlib.Path(sources[item['sha256']]['path']).read_bytes()
  if len(data)!=item['size'] or hashlib.sha256(data).hexdigest()!=item['sha256']:raise ValueError('Release source hash mismatch: '+url)
  if len(data)>25*1024*1024:raise ValueError('Asset exceeds Cloudflare limit: '+url)
  dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data)
entry=html.escape(current['entry'],quote=True);icon=current['entry'].split('?')[0].rsplit('/',1)[0]+'/favicon.ico'
(out/'index.html').write_text(f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>S.T.A.L.K.E.R. — Call of Pripyat</title><link rel="icon" href="{icon}" type="image/x-icon"><style>html,body{{margin:0;width:100%;height:100%;overflow:hidden;background:#000}}iframe{{display:block;width:100%;height:100%;border:0}}</style><iframe src="{entry}" title="S.T.A.L.K.E.R.: Call of Pripyat" allowfullscreen></iframe></html>''')
(out/'_headers').write_text('''/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  Cache-Control: no-store
/releases/*
  Cache-Control: public, max-age=31536000, immutable
/packs/*
  Cache-Control: public, max-age=31536000, immutable
''')
(out/'_redirects').write_text('/ /index.html 200\n/packs/:pack/chunks/* https://assets.stalker-online.xyz/chunks/:splat.gz 302\n')
count=sum(1 for f in out.rglob('*') if f.is_file())
if count>20000:raise ValueError('Too many static assets')
print(json.dumps({'files':count,'entry':current['entry'],'output':str(out)}))
