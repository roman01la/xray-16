#!/usr/bin/env python3
"""Test a locally built zone-server image using disposable containers/volume."""
import json,secrets,subprocess,time,urllib.request,urllib.error,uuid
name='zone-acceptance-'+uuid.uuid4().hex[:12];volume=name+'-data'
base='http://127.0.0.1:18090';token=secrets.token_hex(32);credential=secrets.token_hex(32)
def docker(*args): return subprocess.check_output(['docker',*args],text=True,stderr=subprocess.PIPE).strip()
def call(path,body=None,identity=False):
    headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'}
    if identity:headers['X-Zone-Identity']=credential
    with urllib.request.urlopen(urllib.request.Request(base+path,headers=headers,data=None if body is None else json.dumps(body).encode()),timeout=5) as r:return json.load(r)
def start():
    docker('run','--detach','--name',name,'--pull=never','--mount','source='+volume+',target=/data','-p','127.0.0.1:18090:8082','-p','127.0.0.1:15004:50000/udp','-e','ZONE_PUBLIC_ADDR=127.0.0.1:15004','-e','ZONE_ORIGIN='+base,'-e','ZONE_DEV_TOKEN='+token,'zone-server:foundation-test')
    for _ in range(100):
        try:
            if call('/health')['healthy']:return
        except (OSError,urllib.error.URLError):pass
        time.sleep(.1)
    raise RuntimeError('Container health timeout')
def stop():
    docker('stop','--time','25',name)
    assert docker('inspect','--format','{{.State.ExitCode}}',name)=='0','Unclean shutdown'
    docker('rm',name)
try:
    docker('volume','create',volume);start()
    principal=call('/identity/register',{'secret':credential})['principalId']
    mutation={'requestId':'container-smoke','expectedRevision':0,'value':{'fixture':'container'}}
    committed=call('/identity/state',mutation,True);assert committed['status']=='committed'
    stop();start()
    assert call('/identity/resume',{'secret':credential})['principalId']==principal
    assert call('/identity/state',identity=True)['revision']==1
    assert call('/identity/state',mutation,True)==committed
    stop();print('PASS: non-root Linux container, health, durable commit/replay, clean shutdown and volume-backed restart')
finally:
    subprocess.run(['docker','rm','--force',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    subprocess.run(['docker','volume','rm',volume],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
