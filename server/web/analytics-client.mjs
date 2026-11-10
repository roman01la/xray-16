const browserKey = 'xray-analytics-browser-v1';
const installKey = 'xray-analytics-pending-install-v1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

async function getBrowserId() {
  const readOrCreate = () => {
    const saved = localStorage.getItem(browserKey);
    if (uuid.test(saved)) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem(browserKey,id);
    return id;
  };
  return navigator.locks
    ? navigator.locks.request(browserKey,readOrCreate)
    : readOrCreate();
}

export function startCampaignAnalytics() {
  const params = new URLSearchParams(location.search);
  if (!/^\/releases\/[a-f0-9]{64}\/index\.html$/.test(location.pathname) ||
      !params.has('stream') || params.get('play') === 'multiplayer' ||
      params.get('storage') === 'manage' || params.get('saves') === 'import' || params.has('save')) return;

  const browser = getBrowserId().catch(() => null);
  async function send(event,eventId) {
    try {
      const browserId = await browser;
      if (!browserId) return false;
      const response = await fetch('/analytics/event',{
        method:'POST', mode:'same-origin', credentials:'omit', referrerPolicy:'no-referrer',
        keepalive:true, headers:{'Content-Type':'application/json'},
        body:JSON.stringify({event,browserId,eventId:eventId ?? crypto.randomUUID()}),
      });
      return response.status === 204;
    } catch {return false;}
  }

  let sendingInstall = false;
  async function sendInstall(firstInstall = false) {
    if (sendingInstall) return;
    sendingInstall = true;
    try {
      let eventId = localStorage.getItem(installKey);
      if (!uuid.test(eventId)) {
        if (!firstInstall) return;
        eventId = crypto.randomUUID();
        localStorage.setItem(installKey,eventId);
      }
      // Keep a completed first install until the server acknowledges it.
      if (await send('install',eventId) && localStorage.getItem(installKey) === eventId)
        localStorage.removeItem(installKey);
    } catch {} finally {sendingInstall = false;}
  }

  void send('visit');
  void sendInstall();
  window.addEventListener('xray-stream-progress',({detail}) => {
    if (detail.phase === 'install' && detail.ready && detail.firstInstall) void sendInstall(true);
  });
  window.addEventListener('xray-game-start-pressed',() => {void send('start_game');});
  window.addEventListener('xray-engine-log',({detail}) => {
    if (detail === 'XRAY_ANALYTICS new_campaign') void send('new_campaign');
    if (detail === 'XRAY_ANALYTICS load_save') void send('load_save');
  });
}
