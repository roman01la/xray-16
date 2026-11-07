#!/usr/bin/env python3
"""Create a small source-only Fly build context; never include assets or target/."""
from pathlib import Path
import shutil,tempfile
repo=Path(__file__).resolve().parents[2]
target=Path(tempfile.mkdtemp(prefix='zone-fly-build-'))
files=[repo/'server/Cargo.toml',repo/'server/Cargo.lock',repo/'server/deploy/Dockerfile.fly',repo/'server/deploy/fly-entrypoint.sh']
files+=list((repo/'server/src').rglob('*.rs'))
files+=[p for p in (repo/'misc/web/multiplayer').iterdir() if p.is_file() and p.suffix in {'.mjs','.html','.json'}]
for source in files:
    destination=target/source.relative_to(repo);destination.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,destination)
config=(repo/'server/deploy/fly.toml').read_text().replace('dockerfile = "Dockerfile.fly"','dockerfile = "server/deploy/Dockerfile.fly"')
(target/'fly.toml').write_text(config)
size=sum(p.stat().st_size for p in target.rglob('*') if p.is_file())
assert size<5*1024*1024,'Unexpected build context size'
print(target)
