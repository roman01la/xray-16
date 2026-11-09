#!/usr/bin/env python3
"""Trusted test-only fixture provisioning after a record-mode load run.
Use only a disposable acceptance database. There is no public mint endpoint.
"""
import argparse,json,secrets,sqlite3
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('database');parser.add_argument('--allow-test-fixtures',action='store_true',required=True)
args=parser.parse_args();path=Path(args.database).resolve(strict=True)
with sqlite3.connect(path,timeout=5) as db:
    db.execute('PRAGMA foreign_keys=ON');db.execute('PRAGMA synchronous=FULL');db.execute('BEGIN IMMEDIATE')
    assert db.execute('PRAGMA user_version').fetchone()[0] in (4,5,6,7,8,9,10,11,12,13,14,15,16)
    owners=[p for p,value in db.execute('SELECT principal,value FROM records') if isinstance(json.loads(value),dict) and json.loads(value).get('fixture')=='load']
    assert 1<=len(owners)<=200,'Expected 1–200 load principals'
    inserted=0
    for owner in owners:
        existing=[json.loads(v) for v, in db.execute('SELECT value FROM owned_entities WHERE owner=?',(owner,))]
        if any(isinstance(v,dict) and v.get('fixture')=='load-owned' for v in existing): continue
        db.execute('INSERT INTO owned_entities VALUES(?,?,0,?)',(secrets.token_hex(16),owner,'{"fixture":"load-owned"}'));inserted+=1
print(json.dumps({'loadPrincipals':len(owners),'insertedFixtures':inserted}))
