const $ = id => document.getElementById(id);
const api = 'https://www.googleapis.com/drive/v3/files', folderType = 'application/vnd.google-apps.folder', root = {id:'root',name:'Meu Drive'};
const CLIENT = '284735647572-fjbiid4k7abis5nlieg9nv8jq0jus6rf.apps.googleusercontent.com', DONE = ['Pronto no Drive','Falhou','Cancelado'];
let token = '', queue = '', trail = [root], selected, previewUrl, session = 0, busy = false, tc, pend, toastTimer;
const cache = new Map(), imgs = new Map();
const img = id => (imgs.has(id) || imgs.set(id, req(api+'/'+id+'?alt=media').then(r => r.blob()).then(URL.createObjectURL)), imgs.get(id));
const fmt = v => Math.floor(v/60)+':'+String(Math.floor(v%60)).padStart(2, '0');
const say = m => { $('message').textContent = m; const t = $('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 4000); };
const tab = n => { document.querySelector('main').dataset.tab = n; document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-pressed', b.dataset.tab === n)); };
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => tab(b.dataset.tab));
function action(id, fn) { $(id).onclick = async () => { $(id).disabled = true; try { await fn(); } catch (e) { say(e.message); } finally { $(id).disabled = false; } }; }
const grant = prompt => new Promise((resolve, reject) => {
  if (!window.google?.accounts) return reject(Error('O login do Google ainda está carregando. Tente novamente.'));
  pend = {resolve, reject};
  tc ||= google.accounts.oauth2.initTokenClient({client_id:CLIENT, scope:'https://www.googleapis.com/auth/drive', callback:r => pend.resolve(r), error_callback:() => pend.reject(Error('Login interrompido.'))});
  tc.requestAccessToken(prompt === undefined ? {} : {prompt});
});
async function req(url, options = {}, retry = true) {
  if (!token) throw Error('Conecte sua conta Google.');
  const res = await fetch(url, {...options, headers:{...options.headers, Authorization:'Bearer '+token}});
  if (res.status === 401 && retry) {
    try { const r = await grant(''); if (!r.access_token) throw 0; token = r.access_token; } catch { throw Error('Sessão expirada. Toque em Conectar Google.'); }
    return req(url, options, false);
  }
  if (!res.ok) throw Error(res.status === 401 ? 'Sessão expirada. Toque em Conectar Google.' : 'Google Drive retornou erro '+res.status+'. Tente novamente.');
  return res;
}
async function list(q, fields = 'nextPageToken,files(id,name,modifiedTime,createdTime,appProperties)') {
  const files = []; let page = '';
  do {
    const p = new URLSearchParams({q:'trashed = false and '+q, fields, pageSize:1000}); if (page) p.set('pageToken', page);
    const data = await (await req(api+'?'+p)).json(); files.push(...data.files); page = data.nextPageToken;
  } while (page);
  return files;
}
const trash = id => req(api+'/'+id, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({trashed:true})});
async function connect() {
  const result = await grant();
  if (!result.access_token) throw Error('O Google não autorizou o acesso.');
  session++; token = result.access_token; queue = ''; trail = [root]; selected = null; cache.clear();
  $('jobs').replaceChildren(); $('video').removeAttribute('src'); $('video').load(); if (previewUrl) URL.revokeObjectURL(previewUrl);
  const existing = await list("'root' in parents and mimeType = '"+folderType+"' and appProperties has { key='samukaQueue' and value='v1' }");
  queue = existing[0]?.id || (await (await req(api, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:'Samuka - Fila do Estúdio', mimeType:folderType, parents:['root'], appProperties:{samukaQueue:'v1'}})})).json()).id;
  $('pair').value = queue; $('connect').textContent = 'Reconectar'; await folders(); await refresh(); say('Drive conectado. Escolha a pasta que receberá os vídeos.');
}
async function folders() {
  const items = (await list("'"+trail.at(-1).id+"' in parents and mimeType = '"+folderType+"'")).filter(f => f.id !== queue).sort((a, b) => a.name.localeCompare(b.name));
  $('crumbs').replaceChildren(...trail.map((f, i) => { const b = document.createElement('button'); b.textContent = f.name; b.onclick = async () => { const old = trail; trail = trail.slice(0, i+1); try { await folders(); } catch (e) { trail = old; say(e.message); } }; return b; }));
  $('folders').replaceChildren(...(items.length ? items.map(f => { const b = document.createElement('button'); b.textContent = '📁 '+f.name; b.onclick = async () => { trail.push({id:f.id, name:f.name}); try { await folders(); } catch (e) { trail.pop(); say(e.message); } }; return b; }) : [Object.assign(document.createElement('small'), {textContent:'Sem subpastas aqui. Os vídeos serão salvos nesta pasta.'})]));
}
function youtube(raw) {
  let u; try { u = new URL(raw); } catch { throw Error('Confira este link do YouTube: '+raw); }
  const id = u.hostname === 'youtu.be' ? u.pathname.slice(1) : ['youtube.com','www.youtube.com','m.youtube.com'].includes(u.hostname) ? (u.pathname === '/watch' ? u.searchParams.get('v') : u.pathname.match(/^\/(?:shorts|live)\/([\w-]+)$/)?.[1]) : '';
  if (!/^[\w-]{11}$/.test(id || '')) throw Error('Confira este link do YouTube: '+raw);
  return id;
}
function secs(v) {
  v = v.trim(); if (!v) return null;
  const p = v.split(':').map(Number); if (p.length > 3 || p.some(n => !Number.isFinite(n) || n < 0)) throw Error('Tempo inválido: '+v);
  return p.reduce((a, n) => a*60+n, 0);
}
async function submit(payload, label) {
  if (!queue) throw Error('Conecte o Drive primeiro.');
  const id = crypto.randomUUID(), boundary = 'samuka_'+id, meta = {name:'job-'+id+'.json', parents:[queue], appProperties:{label:label.slice(0, 80)}};
  const body = [meta, payload].map(part => '--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(part)+'\r\n').join('')+'--'+boundary+'--';
  await req('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {method:'POST', headers:{'Content-Type':'multipart/related; boundary='+boundary}, body});
}
action('send', async () => {
  const lines = $('links').value.trim().split(/\s+/).filter(Boolean);
  if (!lines.length) throw Error('Cole pelo menos um link.');
  const ids = lines.map(youtube), dest = trail.at(-1).id, q = $('quality').value, ss = secs($('ss').value), to = secs($('to').value);
  if ((ss === null) !== (to === null) || (ss !== null && to <= ss)) throw Error('Informe início e fim do trecho, com o fim depois do início.');
  for (let i = 0; i < ids.length; i++) { await submit({type:'download', video:ids[i], dest, q, ...(ss !== null && {ss, to})}, ids[i]); $('links').value = lines.slice(i+1).join('\n'); }
  say('Adicionado à fila.'); tab('queue'); await refresh();
});
function button(text, fn) { const b = document.createElement('button'); b.textContent = text; b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { say(e.message); } finally { b.disabled = false; } }; return b; }
async function preview(s) {
  const current = session; say('Carregando a prévia…');
  const blob = await (await req(api+'/'+encodeURIComponent(s.proxy || s.file)+'?alt=media')).blob();
  if (current !== session) return;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob); selected = s; $('video').src = previewUrl; $('title').textContent = s.name; $('start').value = 0;
  $('video').onloadedmetadata = () => { $('end').value = Math.floor($('video').duration*100)/100; paint(); };
  tl.style.backgroundImage = ''; if (s.strip) img(s.strip).then(u => tl.style.backgroundImage = 'url('+u+')').catch(() => {});
  tab('editor'); say('Prévia carregada.');
}
function row(job, s) {
  const r = document.createElement('div'), l = document.createElement('strong'), i = document.createElement('p'); r.className = 'job';
  l.textContent = s.name || job.appProperties?.label || 'Vídeo';
  i.textContent = s.state + (s.state === 'Baixando' && s.pct != null ? ` · ${Math.round(s.pct)}%${s.speed && !/Unknown/.test(s.speed) ? ' · '+s.speed : ''}${s.eta && !/Unknown/.test(s.eta) ? ' · falta '+s.eta : ''}` : '') + (s.error ? ' · '+s.error : '');
  if (s.dur) i.textContent += ' · '+fmt(s.dur);
  if (s.thumb) { const t = document.createElement('img'); t.className = 'thumb'; t.alt = ''; img(s.thumb).then(u => t.src = u).catch(() => t.remove()); r.append(t); }
  r.append(l, i);
  let x0 = null;
  r.onpointerdown = e => { if (!e.target.closest('button')) x0 = e.clientX; };
  r.onpointermove = e => { if (x0 !== null && Math.abs(e.clientX-x0) > 8) r.style.transform = `translateX(${Math.max(-90, Math.min(90, e.clientX-x0))}px)`; };
  r.onpointerup = r.onpointercancel = e => {
    if (x0 === null) return; const d = e.clientX-x0; x0 = null; r.style.transform = '';
    if (d > 80 && s.file && !s.audio) preview(s).catch(x => say(x.message));
    else if (d < -80 && !DONE.includes(s.state) && confirm('Cancelar este pedido?')) submitCancel(job.name).then(() => say('Cancelamento pedido.')).catch(x => say(x.message));
  };
  if (s.pct != null && s.state === 'Baixando') { const bar = document.createElement('div'), f = document.createElement('b'); bar.className = 'bar'; f.style.width = Math.min(100, s.pct)+'%'; bar.append(f); r.append(bar); }
  if (!DONE.includes(s.state)) r.append(button('Cancelar', async () => { await submitCancel(job.name); say('Cancelamento pedido.'); }));
  if (s.file && !s.audio) r.append(button('Abrir vídeo', () => preview(s)));
  if (s.state === 'Falhou') r.append(button('Tentar novamente', async () => {
    const data = await (await req(api+'/'+job.id+'?alt=media')).json(); await submit(data, l.textContent); await trash(job.id); if (job.status) await trash(job.status); await refresh();
  }));
  return r;
}
const submitCancel = async name => req('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {method:'POST', headers:{'Content-Type':'multipart/related; boundary=c'}, body:'--c\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify({name:name.replace('job-', 'cancel-'), parents:[queue]})+'\r\n--c\r\nContent-Type: application/json\r\n\r\n{}\r\n--c--'});
async function refresh() {
  if (!queue || busy) return; busy = true; const current = session;
  try {
    const files = await list("'"+queue+"' in parents"), byName = new Map(files.map(f => [f.name, f])), rows = []; let active = 0, ready = 0;
    const hb = byName.get('heartbeat.json'), on = hb && Date.now() - Date.parse(hb.modifiedTime) < 90000;
    $('chip').textContent = on ? 'PC online' : 'PC offline'; $('chip').className = 'chip '+(on ? 'on' : 'off'); $('s1').className = 'ok'; $('s3').className = on ? 'ok' : '';
    for (const job of files.filter(f => /^job-[a-f0-9-]+\.json$/.test(f.name)).sort((a, b) => b.createdTime.localeCompare(a.createdTime))) {
      const status = byName.get(job.name.replace('job-', 'status-')); let s = {state:'Na fila'};
      if (status) {
        const old = cache.get(status.id);
        if (old?.time === status.modifiedTime) s = old.data; else { s = await (await req(api+'/'+status.id+'?alt=media')).json(); cache.set(status.id, {time:status.modifiedTime, data:s}); }
        job.status = status.id;
      }
      if (!DONE.includes(s.state)) active++;
      if (s.state === 'Pronto no Drive') ready++;
      rows.push(row(job, s));
    }
    $('summary').textContent = rows.length ? active+' em andamento · '+ready+' prontos' : ''; $('badge').textContent = active; $('badge').hidden = !active;
    if (current === session) $('jobs').replaceChildren(...(rows.length ? rows : ['Nenhum pedido ainda.']));
  } finally { busy = false; }
}
action('connect', connect); action('refresh', refresh);
action('clean', async () => {
  if (!queue) throw Error('Conecte o Drive primeiro.');
  const files = await list("'"+queue+"' in parents"), names = new Set(files.map(f => f.name)); let n = 0;
  for (const job of files.filter(f => /^job-[a-f0-9-]+\.json$/.test(f.name))) {
    const st = files.find(f => f.name === job.name.replace('job-', 'status-')); if (!st) continue;
    const s = cache.get(st.id)?.data || await (await req(api+'/'+st.id+'?alt=media')).json();
    if (!DONE.includes(s.state)) continue;
    const id = job.name.slice(4, -5);
    for (const f of files.filter(f => [job.name, st.name, 'preview-'+id+'.mp4', 'strip-'+id+'.jpg', 'thumb-'+id+'.jpg', 'cancel-'+id+'.json'].includes(f.name))) await trash(f.id);
    n++;
  }
  cache.clear(); say(n ? n+' concluído(s) removido(s) da fila. Os vídeos no Drive não foram alterados.' : 'Nada para limpar.'); await refresh();
});
for (const [id, target] of [['markStart', 'start'], ['markEnd', 'end']]) action(id, () => { $(target).value = $('video').currentTime.toFixed(2); paint(); });
const tl = $('tl'), dur = () => $('video').duration || 0;
function paint() {
  const d = dur(); if (!d) return; const s = +$('start').value/d*100, e = (+$('end').value || d)/d*100;
  $('hS').style.left = s+'%'; $('hE').style.left = e+'%'; $('tlSel').style.left = s+'%'; $('tlSel').style.width = Math.max(0, e-s)+'%';
}
const at = ev => { const b = tl.getBoundingClientRect(); return Math.max(0, Math.min(1, (ev.clientX-b.left)/b.width))*dur(); };
for (const [h, t] of [['hS', 'start'], ['hE', 'end']]) $(h).onpointerdown = ev => {
  ev.preventDefault(); ev.stopPropagation(); $(h).setPointerCapture(ev.pointerId);
  $(h).onpointermove = m => { const v = at(m); $(t).value = (t === 'start' ? Math.min(v, +$('end').value-.1) : Math.max(v, +$('start').value+.1)).toFixed(2); $('video').currentTime = +$(t).value; paint(); };
  $(h).onpointerup = () => { $(h).onpointermove = null; };
};
tl.onpointerdown = ev => { if (ev.target.tagName !== 'I') $('video').currentTime = at(ev); };
$('video').ontimeupdate = () => { $('tlHead').style.left = ($('video').currentTime/(dur() || 1)*100)+'%'; };
$('start').oninput = $('end').oninput = paint;
action('cut', async () => {
  const start = +$('start').value, end = +$('end').value;
  if (!selected || !Number.isFinite($('video').duration) || !$('end').value || start < 0 || end <= start || end > $('video').duration) throw Error('Selecione um vídeo e marque um intervalo válido.');
  await submit({type:'cut', source:selected.job, start, end, dest:trail.at(-1).id}, 'Corte '+start+'–'+end+' s'); say('Corte enviado à fila.'); tab('queue'); await refresh();
});
setInterval(() => { if (!document.hidden) refresh().catch(e => say(e.message)); }, 15000);
