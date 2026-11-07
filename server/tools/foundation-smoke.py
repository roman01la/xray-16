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
    def admin(*args, source=None):
        return json.loads(subprocess.check_output(['python3',str(binary.parents[2]/'tools/admin.py'),source or database,*args],text=True))
    def scene_count(count):
        for _ in range(80):
            state=call('/metrics')
            if state['persistentEntities']==count: return
            time.sleep(.1)
        raise AssertionError('Scene runtime did not converge')
    try:
        process=start()
        a,b=secrets.token_hex(32),secrets.token_hex(32)
        pa=call('/identity/register',body={'secret':a})['principalId']
        pb=call('/identity/register',body={'secret':b})['principalId']
        entity=admin('provision',pa)['entityId']
        admin('publish',entity,'synthetic-flat-v1','4','5');scene_count(1)
        denied=call('/identity/transfer',a,{'requestId':'scene-test','entityId':entity,'expectedRevision':0,'recipient':pb},expected=409)
        assert denied['error']=='live scene authorization required'
        backup=str(Path(directory)/'backup.sqlite')
        admin('backup',backup)
        assert subprocess.run(['python3',str(binary.parents[2]/'tools/admin.py'),database,'backup',backup],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0
        duplicate_env=dict(env,ZONE_HTTP_ADDR=f'127.0.0.1:{port+1}',ZONE_UDP_ADDR=f'127.0.0.1:{udp+1}')
        duplicate=subprocess.run([str(binary)],env=duplicate_env,capture_output=True,timeout=10)
        assert duplicate.returncode!=0 and b'database already owned' in duplicate.stderr
        rotated=admin('rotate',pb)
        call('/identity/resume',body={'secret':b},expected=401)
        assert call('/identity/resume',body={'secret':rotated['secret']})['principalId']==pb
        admin('revoke',pa)
        call('/identity/resume',body={'secret':a},expected=401)
        call('/identity/register',body={'secret':a},expected=401)
        admin('unpublish',entity);scene_count(0)
        process.terminate();assert process.wait(timeout=15)==0;process=None
        restored=str(Path(directory)/'restored.sqlite')
        admin('restore',restored,source=backup)
        env['ZONE_DATABASE']=restored
        process=start();scene_count(1)
        assert call('/identity/resume',body={'secret':a})['principalId']==pa
        assert call('/identity/entities',a)['entities'][0]['id']==entity
        assert call('/health')['healthy']
        process.terminate();assert process.wait(timeout=15)==0;process=None
        print('PASS: live scene polling, offline policy denial, online backup, no overwrite, single-server lock, credential rotation/revocation, graceful SIGTERM, restored identity/scene/ownership')
    finally:
        if process and process.poll() is None:
            process.kill();process.wait()
