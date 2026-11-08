#!/usr/bin/env python3
"""Exercise online backup and isolated restore without replacing the live world."""
import argparse
import hashlib
import json
from pathlib import Path
import secrets
import time
from admin import backup, connection


def fingerprint(db):
    digest = hashlib.sha256()
    for line in db.iterdump():
        digest.update(line.encode())
        digest.update(b'\n')
    return digest.digest()


def drill(source, directory):
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.stat().st_mode & 0o077:
        raise ValueError('Drill directory must be private')
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + secrets.token_hex(4)
    saved = directory / ('backup-' + stamp + '.sqlite')
    restored = directory / ('restore-' + stamp + '.sqlite')
    live = connection(source)
    try:
        backup(live, saved)
    finally:
        live.close()
    snapshot = connection(saved)
    try:
        backup(snapshot, restored)
        recovered = connection(restored)
        try:
            assert fingerprint(snapshot) == fingerprint(recovered), 'Restored contents differ'
            counts = {table: recovered.execute('SELECT count(*) FROM ' + table).fetchone()[0]
                      for table in ['principals', 'owned_entities', 'scene_entities']}
            result = {'integrity': recovered.execute('PRAGMA integrity_check').fetchone()[0],
                      'foreignKeyErrors': len(recovered.execute('PRAGMA foreign_key_check').fetchall()),
                      'schema': recovered.execute('PRAGMA user_version').fetchone()[0],
                      'contentsMatch': True, 'counts': counts, 'liveDatabaseReplaced': False,
                      'serverBootFromRestore': 'not tested', 'backup': saved.name}
            assert result['integrity'] == 'ok' and result['foreignKeyErrors'] == 0
        finally:
            recovered.close()
    finally:
        snapshot.close()
    # Retain the verified backup; the disposable restored database is unnecessary.
    restored.unlink()
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database')
    parser.add_argument('directory')
    args = parser.parse_args()
    print(json.dumps(drill(args.database, args.directory)))
