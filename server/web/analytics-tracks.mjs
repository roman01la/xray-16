function installTrackViewer() {
  const panel = document.querySelector('#movement');
  const user = panel.querySelector('[name=user]');
  const session = panel.querySelector('[name=session]');
  const map = panel.querySelector('[name=map]');
  const status = panel.querySelector('[role=status]');
  const canvas = panel.querySelector('canvas');
  const zoom = panel.querySelector('[name=zoom]');
  const context = canvas.getContext('2d');
  const tooltip = panel.querySelector('output');
  let metadata = {}, points = [], background, controller, rendered = [];
  let selection = 0;
  const option = (value,text) => { const item = document.createElement('option'); item.value=value; item.textContent=text; return item; };
  const date = time => new Date(time).toLocaleString();
  const endpoint = (params = {}) => '/analytics/tracks?' + new URLSearchParams({game:panel.dataset.game,...params});
  async function json(url,signal) {
    const response = await fetch(url,{signal});
    if (!response.ok) throw Error('Could not load movement data (HTTP '+response.status+').');
    return response.json();
  }
  function draw() {
    if (canvas.hidden) return;
    const aspect = background ? background.naturalWidth/background.naturalHeight : 1;
    const width = Math.max(1,Math.min(panel.querySelector('.track-map').clientWidth,innerHeight*0.65*aspect) * Number(zoom.value));
    const height = width/aspect;
    const dpr = Math.min(devicePixelRatio || 1,2);
    canvas.width = Math.round(width*dpr); canvas.height = Math.round(height*dpr);
    canvas.style.width = width+'px'; canvas.style.height = height+'px';
    context.setTransform(dpr,0,0,dpr,0,0);
    const selected=points.filter(p=>p.map===map.value);
    let bounds=metadata[map.value]?.bounds;
    if (background) context.drawImage(background,0,0,width,height);
    else {
      context.fillStyle='#1a211c'; context.fillRect(0,0,width,height);
      context.strokeStyle='#3e4d40'; context.lineWidth=1;
      for(let i=0;i<=10;i++){context.beginPath();context.moveTo(width*i/10,0);context.lineTo(width*i/10,height);context.moveTo(0,height*i/10);context.lineTo(width,height*i/10);context.stroke();}
      bounds=selected.reduce((b,p)=>[Math.min(b[0],p.x-10),Math.min(b[1],p.z-10),Math.max(b[2],p.x+10),Math.max(b[3],p.z+10)],[Infinity,Infinity,-Infinity,-Infinity]);
    }
    const [x1,z1,x2,z2] = bounds;
    rendered = [];
    let previous;
    context.lineWidth=2.5; context.strokeStyle='#ffdb6e';
    context.beginPath();
    for (const point of points) {
      if (point.map !== map.value) { previous=undefined; continue; }
      const x=(point.x-x1)/(x2-x1)*width, y=(z2-point.z)/(z2-z1)*height;
      const item={...point,px:x,py:y};
      rendered.push(item);
      if (previous && point.t-previous.t<=25000 && Math.hypot(point.x-previous.x,point.z-previous.z)<150) context.lineTo(x,y);
      else context.moveTo(x,y);
      previous=point;
    }
    context.stroke();
    context.fillStyle='#fff5d1';
    for (const p of rendered) { context.beginPath(); context.arc(p.px,p.py,2.5,0,Math.PI*2); context.fill(); }
    for (const [p,color] of [[rendered[0],'#76ef97'],[rendered.at(-1),'#ff9466']]) {
      if (!p) continue;
      context.beginPath(); context.arc(p.px,p.py,5,0,Math.PI*2); context.fillStyle=color; context.fill();
      context.strokeStyle='#10160f'; context.lineWidth=1; context.stroke();
    }
    status.textContent = rendered.length ? rendered.length+' samples · '+date(rendered[0].t)+' — '+date(rendered.at(-1).t)+'. Green starts the track, orange ends it. Hover a point for time and coordinates.' : 'No samples on this map.';
    if (!background) status.textContent+=' This level has no map artwork. The track uses a coordinate grid.';
  }
  async function chooseMap() {
    const id = ++selection;
    tooltip.textContent=''; background=undefined; canvas.hidden=true;
    const info=metadata[map.value];
    if (!info?.image) { canvas.hidden=false; draw(); return; }
    status.textContent='Loading map…';
    const image = new Image();
    image.src='/analytics-maps/'+panel.dataset.game+'/'+info.image;
    try {
      await image.decode();
      if (id!==selection) return;
      background=image; canvas.hidden=false; draw();
    } catch { if(id===selection) status.textContent='Could not load the map image.'; }
  }
  async function chooseSession() {
    controller?.abort(); controller=new AbortController();
    const {signal}=controller;
    selection++; background=undefined;
    points=[]; rendered=[]; canvas.hidden=true; map.replaceChildren();
    if (!session.value) return;
    status.textContent='Loading track…';
    try {
      let after=0;
      do {
        const data=await json(endpoint({browser:user.value,session:session.value,after}),signal);
        points.push(...data.points); after=data.next;
      } while(after!==null && !signal.aborted);
      for (const name of new Set(points.map(point=>point.map))) map.append(option(name,name));
      if (!points.length) { status.textContent='No movement recorded for this session.'; return; }
      void chooseMap();
    } catch(error) { if(!signal.aborted) status.textContent=error.message; }
  }
  async function chooseUser() {
    controller?.abort(); controller=new AbortController();
    const {signal}=controller;
    selection++; background=undefined; canvas.hidden=true; session.replaceChildren(); map.replaceChildren(); tooltip.textContent='';
    if (!user.value) return;
    status.textContent='Loading sessions…';
    try {
      const data=await json(endpoint({browser:user.value}),signal);
      for (const row of data.sessions) session.append(option(row.session_id,date(row.first_seen)+' — '+date(row.last_seen)+' · '+row.samples+' samples'));
      if (!data.sessions.length) { status.textContent='No movement recorded for this user.'; return; }
      void chooseSession();
    } catch(error) { if(!signal.aborted) status.textContent=error.message; }
  }
  canvas.addEventListener('mousemove',event=>{
    const rect=canvas.getBoundingClientRect();
    const x=event.clientX-rect.left,y=event.clientY-rect.top;
    let closest, distance=12;
    for(const point of rendered) {
      const d=Math.hypot(point.px-x,point.py-y);
      if(d<distance){closest=point;distance=d;}
    }
    tooltip.textContent=closest ? date(closest.t)+' · X '+closest.x.toFixed(1)+' · Y '+closest.y.toFixed(1)+' · Z '+closest.z.toFixed(1) : '';
  });
  canvas.addEventListener('mouseleave',()=>{tooltip.textContent='';});
  user.addEventListener('change',chooseUser);
  session.addEventListener('change',chooseSession);
  map.addEventListener('change',chooseMap);
  zoom.addEventListener('input',draw);
  new ResizeObserver(draw).observe(panel.querySelector('.track-map'));
  Promise.all([json(endpoint()),json('/analytics-maps/'+panel.dataset.game+'/maps.json')]).then(([data,maps])=>{
    metadata=maps;
    const list=panel.querySelector('datalist');
    for(const row of data.users) list.append(option(row.browser_id,date(row.last_seen)+' · '+row.samples+' samples'));
    if(data.users.length){user.value=data.users[0].browser_id;void chooseUser();}
    else status.textContent='No movement recorded yet. New gameplay sessions sample every 10 seconds and upload each minute.';
  }).catch(error=>{status.textContent=error.message;});
}

export const trackViewerScript = '('+installTrackViewer.toString()+')();';
