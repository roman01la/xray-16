#!/usr/bin/env python3
"""Trusted local administration. No game assets or client-controlled actor data.
Backups use SQLite's online backup API; restore targets a NEW path only.
"""
import argparse, hashlib, json, math, os, secrets, sqlite3, sys
from pathlib import Path

def connection(path):
    path=Path(path).resolve(strict=True)
    db=sqlite3.connect(str(path),timeout=5)
    db.execute('PRAGMA foreign_keys=ON');db.execute('PRAGMA synchronous=FULL')
    if db.execute('PRAGMA user_version').fetchone()[0] not in (4,5,6): raise ValueError('Start current server to migrate database before administration')
    return db

def backup(source,destination):
    target=Path(destination).resolve()
    if target.exists(): raise ValueError('Destination already exists; backups/restores never overwrite')
    temporary=target.with_name(target.name+'.tmp-'+secrets.token_hex(8))
    try:
        fd=os.open(temporary,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        os.close(fd)
        out=sqlite3.connect(str(temporary))
        try:
            source.backup(out)
            if out.execute('PRAGMA quick_check').fetchone()[0]!='ok': raise ValueError('Backup integrity failure')
        finally: out.close()
        with temporary.open('rb') as stream: os.fsync(stream.fileno())
        os.link(temporary,target);temporary.unlink()
        fd=os.open(target.parent,os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        if temporary.exists(): temporary.unlink()
    return {'path':str(target),'integrity':'ok'}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database');sub=parser.add_subparsers(dest='command',required=True)
    sub.add_parser('status')
    for cmd in ['backup','restore']:
        p=sub.add_parser(cmd);p.add_argument('destination')
    p=sub.add_parser('provision');p.add_argument('owner');p.add_argument('--value',default='{"fixture":true}')
    p=sub.add_parser('publish');p.add_argument('entity');p.add_argument('world',choices=['synthetic-flat-v1','zaton-static-v1']);p.add_argument('x',type=float);p.add_argument('z',type=float);p.add_argument('--yaw',type=float,default=0)
    p=sub.add_parser('unpublish');p.add_argument('entity')
    for cmd in ['revoke','rotate']:
        p=sub.add_parser(cmd);p.add_argument('principal')
    args=parser.parse_args();db=connection(args.database)
    try:
        if args.command in ['backup','restore']: print(json.dumps(backup(db,args.destination)));return
        if args.command=='status':
            print(json.dumps({'schema':db.execute('PRAGMA user_version').fetchone()[0],'integrity':db.execute('PRAGMA quick_check').fetchone()[0],'principals':db.execute('SELECT count(*) FROM principals').fetchone()[0],'entities':db.execute('SELECT count(*) FROM owned_entities').fetchone()[0],'scenes':db.execute('SELECT count(*) FROM scene_entities').fetchone()[0],'authEpoch':db.execute('SELECT auth_epoch FROM runtime_meta').fetchone()[0]}));return
        db.execute('BEGIN IMMEDIATE')
        if args.command=='provision':
            value=json.dumps(json.loads(args.value),separators=(',',':'),allow_nan=False)
            if len(value.encode())>4096: raise ValueError('Payload exceeds 4 KiB')
            entity=secrets.token_hex(16);db.execute('INSERT INTO owned_entities(id,owner,revision,value) VALUES(?,?,0,?)',(entity,args.owner,value));result={'entityId':entity}
        elif args.command=='publish':
            if not all(math.isfinite(v) for v in [args.x,args.z,args.yaw]) or abs(args.x)>2000 or abs(args.z)>2000 or abs(args.yaw)>math.tau: raise ValueError('Invalid transform')
            exists=db.execute('SELECT 1 FROM scene_entities WHERE entity=?',(args.entity,)).fetchone()
            if not exists and db.execute('SELECT count(*) FROM scene_entities').fetchone()[0]>=1024: raise ValueError('Scene capacity exceeded')
            db.execute("INSERT INTO scene_entities VALUES(?,?,'stalker',?,?,?) ON CONFLICT(entity) DO UPDATE SET world=excluded.world,x=excluded.x,z=excluded.z,yaw=excluded.yaw",(args.entity,args.world,args.x,args.z,args.yaw));result={'published':args.entity}
        elif args.command=='unpublish':
            db.execute('DELETE FROM scene_entities WHERE entity=?',(args.entity,));result={'unpublished':args.entity}
        elif args.command=='revoke':
            if db.execute('UPDATE principals SET revoked=1 WHERE id=?',(args.principal,)).rowcount!=1: raise ValueError('Unknown principal')
            result={'revoked':args.principal}
        else:
            secret=secrets.token_hex(32);digest=hashlib.sha256(('zone-identity-v1\n'+secret).encode()).hexdigest()
            if db.execute('UPDATE principals SET credential_hash=?,revoked=0 WHERE id=?',(digest,args.principal)).rowcount!=1: raise ValueError('Unknown principal')
            result={'principalId':args.principal,'secret':secret}
        db.commit();print(json.dumps(result))
    finally: db.close()
if __name__=='__main__':
    try: main()
    except Exception as error: print(str(error),file=sys.stderr);sys.exit(1)
