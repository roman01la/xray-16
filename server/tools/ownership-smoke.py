#!/usr/bin/env python3
"""Isolated optimized-server integration test; creates only disposable fixtures.
No client mint endpoint: a trusted test fixture seeds the temporary database.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import secrets
import sqlite3
import socket
import subprocess
import tempfile
import time
import urllib.request
import urllib.error

binary = Path(__file__).resolve().parents[1] / 'target/release/zone-server'
port = int(os.environ.get('ZONE_TEST_HTTP_PORT', '18088'))
udp = int(os.environ.get('ZONE_TEST_UDP_PORT', '15002'))
base = f'http://127.0.0.1:{port}'
# Refuse occupied ports rather than accidentally targeting another local server.
for kind, chosen in [(socket.SOCK_STREAM, port), (socket.SOCK_DGRAM, udp)]:
    with socket.socket(socket.AF_INET, kind) as probe:
        if kind == socket.SOCK_STREAM:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', chosen))

def call(path, secret=None, body=None, expected=200):
    headers = {'Content-Type': 'application/json'}
    if secret:
        headers['X-Zone-Identity'] = secret
    req = urllib.request.Request(base + path, headers=headers,
        data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            code, value = response.status, json.load(response)
    except urllib.error.HTTPError as error:
        code = error.code
        raw = error.read().decode()
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            value = {'message': raw}
    assert code == expected, (path, code, value)
    return value

with tempfile.TemporaryDirectory(prefix='zone-ownership-smoke-') as directory:
    database = str(Path(directory) / 'test.sqlite')
    env = dict(os.environ, ZONE_DATABASE=database, ZONE_HTTP_ADDR=f'127.0.0.1:{port}',
               ZONE_UDP_ADDR=f'127.0.0.1:{udp}', ZONE_ORIGIN=base)
    # Tests deliberately use the synthetic world regardless of caller shell.
    for key in ['ZONE_COLLISION_MANIFEST', 'ZONE_DEV_TOKEN', 'ZONE_PUBLIC_ADDR']:
        env.pop(key, None)
    process = None
    def start():
        p = subprocess.Popen([str(binary)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            if p.poll() is not None:
                raise RuntimeError('Isolated test server failed to start')
            try:
                call('/world.json')
                return p
            except (OSError, urllib.error.URLError):
                time.sleep(.05)
        p.kill(); p.wait()
        raise RuntimeError('Isolated test server startup timed out')
    try:
        process = start()
        credentials = [secrets.token_hex(32) for _ in range(4)]
        principals = [call('/identity/register', body={'secret': s})['principalId'] for s in credentials]
        entity = secrets.token_hex(16)
        with sqlite3.connect(database) as db:
            db.execute('PRAGMA foreign_keys=ON')
            db.execute('INSERT INTO owned_entities(id,owner,revision,value) VALUES(?,?,0,?)',
                       (entity, principals[0], json.dumps({'fixture': 'ownership-smoke'})))
        with sqlite3.connect(database) as db:
            db.execute('PRAGMA foreign_keys=ON')
            db.executemany('INSERT INTO owned_entities(id,owner,revision,value) VALUES(?,?,0,?)',
                          [(secrets.token_hex(16),principals[3],'null') for _ in range(103)])
        first = call('/identity/entities',credentials[3])
        assert len(first['entities']) == 100 and first['generation'] == 103
        with sqlite3.connect(database) as db:
            db.execute('UPDATE owned_entities SET value=? WHERE id=?',('42',first['entities'][0]['id']))
        stale = call('/identity/entities?after='+first['nextCursor']+'&generation='+str(first['generation']),credentials[3],expected=409)
        assert stale['status'] == 'conflict' and 'entities' not in stale
        fresh = call('/identity/entities',credentials[3])
        last = call('/identity/entities?after='+fresh['nextCursor']+'&generation='+str(fresh['generation']),credentials[3])
        assert len(last['entities']) == 3 and last['generation'] == fresh['generation']
        command = {'requestId': 'transfer', 'entityId': entity, 'expectedRevision': 0, 'recipient': principals[1]}
        assert call('/identity/entities', credentials[1])['entities'] == []
        assert call('/identity/transfer', credentials[1], {**command, 'requestId': 'theft'})['reason'] == 'not_owned'
        call('/identity/transfer', credentials[0], {**command, 'owner': principals[1]}, expected=422)
        call('/identity/entities', secrets.token_hex(32), expected=401)
        call('/identity/entities?after=invalid', credentials[0], expected=400)
        commands = [command, {**command, 'requestId': 'competitor', 'recipient': principals[2]}]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda c: call('/identity/transfer', credentials[0], c), commands))
        assert sum(r['status'] == 'committed' for r in responses) == 1
        winner = next(i for i, r in enumerate(responses) if r['status'] == 'committed')
        recipient_index = winner + 1
        assert call('/identity/entities', credentials[0])['entities'] == []
        owned = call('/identity/entities', credentials[recipient_index])['entities']
        assert len(owned) == 1 and owned[0]['id'] == entity and owned[0]['revision'] == 1
        call('/identity/transfer', credentials[0], {**commands[winner], 'expectedRevision': 1}, expected=409)
        process.kill(); process.wait(); process = start()
        assert call('/identity/resume', body={'secret': credentials[0]})['principalId'] == principals[0]
        assert call('/identity/entities', credentials[recipient_index])['entities'] == owned
        for command, response in zip(commands, responses):
            assert call('/identity/transfer', credentials[0], command) == response
        print(json.dumps({'status': 'PASS', 'checks': [
            'owner-only listing', 'unauthorized transfer rejected', 'identity spoof fields rejected',
            'bounded cursor validation', 'mixed-generation pagination rejected and restarted', 'concurrent transfer has one winner', 'changed replay rejected',
            'forced restart preserves identity and owner', 'success and rejection replay survive restart'
        ]}, indent=2))
    finally:
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait()
