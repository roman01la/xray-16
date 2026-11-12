#!/usr/bin/env python3
"""Stage an existing immutable release without changing its URLs or file hashes."""
import argparse,hashlib,html,json,pathlib,re,shutil
p=argparse.ArgumentParser();p.add_argument('--publication',required=True);p.add_argument('--soc-publication');p.add_argument('--retain',action='append',default=[]);p.add_argument('--retained-assets',type=pathlib.Path);p.add_argument('--output',default=str(pathlib.Path(__file__).parent/'.assets'));a=p.parse_args()
web=pathlib.Path(__file__).resolve().parents[1]/'web'
out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=True)
def publication(folder, game):
    manifest=json.loads((pathlib.Path(folder)/'manifest.json').read_text())
    entry=manifest['entry']
    if (manifest.get('gameId','cop')!=game or not
            re.fullmatch(r'/releases/[a-f0-9]{64}/index\.html\?stream=/packs/[a-f0-9]{64}/pack\.json',entry)):
        raise ValueError(f'Invalid {game} publication: {folder}')
    return manifest

current=publication(a.publication,'cop')
soc=publication(a.soc_publication,'soc') if a.soc_publication else None
def stage_files(folder, retained_assets=None):
 base=pathlib.Path(folder);m=json.loads((base/'manifest.json').read_text());sources=json.loads((base/'sources.json').read_text())
 for url,item in m['files'].items():
  if '/chunks/' in url:continue
  rel=pathlib.PurePosixPath(url.lstrip('/'))
  if '..' in rel.parts:raise ValueError('Unsafe manifest path')
  dest=out/rel
  source=pathlib.Path(sources[item['sha256']]['path'])
  if retained_assets and (retained_assets/rel).is_file():
   source=retained_assets/rel
  data=source.read_bytes()
  if len(data)!=item['size'] or hashlib.sha256(data).hexdigest()!=item['sha256']:raise ValueError('Release source hash mismatch: '+url)
  if len(data)>25*1024*1024:raise ValueError('Asset exceeds Cloudflare limit: '+url)
  if source.resolve()!=dest.resolve():
   dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data)

for folder in a.retain:
 stage_files(folder,a.retained_assets)
stage_files(a.publication)
if soc:
 stage_files(a.soc_publication)
entry=html.escape(current['entry'],quote=True);icon=current['entry'].split('?')[0].rsplit('/',1)[0]+'/favicon.ico'
if soc:
    picker=(web/'game-picker.html').read_text()
    picker=picker.replace('__COP_ENTRY__',entry).replace('__SOC_ENTRY__',html.escape(soc['entry'],quote=True))
    (out/'index.html').write_text(picker)
    shutil.copyfile(out/icon.lstrip('/'),out/'favicon.ico')
    shutil.copyfile(out/'favicon.ico',out/'favicon-cop.ico')
    soc_icon=soc['entry'].split('?')[0].rsplit('/',1)[0]+'/favicon.ico'
    shutil.copyfile(out/soc_icon.lstrip('/'),out/'favicon-soc.ico')
    for name in ('startup-wallpaper.webp','startup-wallpaper-soc.webp','game-card-cop.webp','game-card-soc.webp'):
        shutil.copyfile(web/name,out/name)
else:
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
print(json.dumps({'files':count,'entry':current['entry'],'socEntry':soc['entry'] if soc else None,'output':str(out)}))
