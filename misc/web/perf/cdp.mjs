import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';

export class CDP extends EventEmitter {
  constructor(socket) {
    super();this.socket=socket;this.serial=0;this.pending=new Map();
    socket.addEventListener('message',({data})=>{
      const message=JSON.parse(data);
      if(message.method)this.emit(message.method,message.params,message.sessionId);
      const pending=this.pending.get(message.id);
      if(!pending)return;
      this.pending.delete(message.id);clearTimeout(pending.timer);
      message.error?pending.reject(Error(`${pending.method}: ${message.error.message}`)):pending.resolve(message.result);
    });
    socket.addEventListener('close',()=>{
      for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(Error('Chrome disconnected'));}
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket=new WebSocket(url);
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    return new CDP(socket);
  }
  send(method,params={},sessionId,timeoutMs=30000) {
    return new Promise((resolve,reject)=>{
      if(this.socket.readyState!==WebSocket.OPEN){reject(Error('Chrome disconnected'));return;}
      const id=++this.serial;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(`${method} timed out`));},timeoutMs);
      this.pending.set(id,{resolve,reject,timer,method});
      this.socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
    });
  }
  async evaluate(expression,sessionId) {
    const response=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId,60000);
    if(response.exceptionDetails)throw Error(response.exceptionDetails.exception?.description||response.exceptionDetails.text);
    return response.result.value;
  }
  waitFor(method,timeoutMs=30000) {
    return new Promise((resolve,reject)=>{
      const done=params=>{clearTimeout(timer);this.off(method,done);resolve(params);};
      const timer=setTimeout(()=>{this.off(method,done);reject(Error(`No ${method} event`));},timeoutMs);
      this.on(method,done);
    });
  }
  close(){this.socket.close();}
}

export async function launchChrome({binary,profile,log,viewport}) {
  profile=resolve(profile);
  await mkdir(profile,{recursive:true});
  profile=await realpath(profile);
  const marker=join(profile,'.xray-perf-profile');
  try{await readFile(marker);}
  catch(error){
    if(error.code!=='ENOENT')throw error;
    const {readdir}=await import('node:fs/promises');
    if((await readdir(profile)).length)throw Error('Use an empty directory or an existing X-Ray performance profile.');
    await writeFile(marker,'Dedicated automated game performance profile\n');
  }
  // A single benchmark owns this profile. Never remove another run's lock.
  const {open}=await import('node:fs/promises');
  const lock=await open(join(profile,'.xray-perf-running'),'wx').catch(()=>{throw Error('This performance profile is already in use.');});
  let chrome,cdp;
  const close=async()=>{
    if(chrome?.pid && chrome.exitCode===null){
      const exited=once(chrome,'exit').catch(()=>{});
      if(cdp)await Promise.race([cdp.send('Browser.close').catch(()=>{}),sleep(2000)]);
      if(chrome.exitCode===null)chrome.kill('SIGTERM');
      await Promise.race([exited,sleep(3000)]);
      if(chrome.exitCode===null){chrome.kill('SIGKILL');await exited;}
    }
    cdp?.close();await lock.close();await rm(join(profile,'.xray-perf-running'),{force:true});
  };
  try{
    await rm(join(profile,'DevToolsActivePort'),{force:true});
    chrome=spawn(binary,[
      '--headless=new','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',
      '--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update',
      '--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows',
      `--window-size=${viewport.width},${viewport.height}`,`--user-data-dir=${profile}`,'about:blank',
    ],{stdio:['ignore','ignore','pipe']});
    let launchError;
    chrome.on('error',error=>{launchError=error;});
    chrome.stderr.on('data',data=>log.write(data));
    let port;
    for(let attempt=0;attempt<150&&!port;attempt++){
      if(launchError)throw launchError;
      if(chrome.exitCode!==null)throw Error('Chrome exited before opening its debugging endpoint.');
      try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{}
      if(!port)await sleep(100);
    }
    if(!port)throw Error('Chrome did not open its debugging endpoint.');
    const version=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    cdp=await CDP.connect(version.webSocketDebuggerUrl);
    return {cdp,close,profile};
  }catch(error){await close();throw error;}
}
