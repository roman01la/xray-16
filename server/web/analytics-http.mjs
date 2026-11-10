import {analyticsEvents} from './analytics-store.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function validateAnalyticsEvent(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 3 ||
      !analyticsEvents.has(value.event) || typeof value.browserId !== 'string' ||
      typeof value.eventId !== 'string' || !uuid.test(value.browserId) || !uuid.test(value.eventId))
    return null;
  const {event,browserId,eventId} = value;
  return {event,browserId,eventId};
}

const labels = {
  visit: 'Visits',
  install: 'First completed game installs',
  start_game: 'Start Game presses',
  new_campaign: 'New campaigns started',
  load_save: 'Successful save loads',
};

export function analyticsDashboard({browsers,events}) {
  const counts = new Map(events.map(row => [row.event,row]));
  const number = value => Number(value).toLocaleString('en');
  const rows = Object.entries(labels).map(([event,label]) => {
    const row = counts.get(event);
    return `<tr><th scope="row">${label}</th><td>${number(row?.browsers ?? 0)}</td><td>${number(row?.total ?? 0)}</td></tr>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>S.T.A.L.K.E.R. Analytics</title>
<style>
html{color-scheme:dark;background:#161812;color:#eee;font:16px/1.5 system-ui,sans-serif}
main{max-width:42rem;margin:3rem auto;padding:0 1rem}table{width:100%;border-collapse:collapse}
th,td{padding:.65rem .4rem;border-bottom:1px solid #46483c;text-align:right}
th:first-child{text-align:left}p{color:#bbb}
</style>
<main>
  <h1>Game analytics</h1>
  <p>All time since analytics was enabled.</p>
  <p>Unique browsers <strong>${number(browsers)}</strong></p>
  <table aria-label="Game activity totals">
    <thead><tr><th scope="col">Activity</th><th scope="col">Unique browsers</th><th scope="col">Total</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p>A visit begins when a browser opens the game after 30 minutes without recorded activity.
     Successful save loads are a signal that players continued a campaign.</p>
</main>
</html>`;
}
