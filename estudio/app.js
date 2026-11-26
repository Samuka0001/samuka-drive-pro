const $ = id => document.getElementById(id);
const api = 'https://www.googleapis.com/drive/v3/files';
const folderType = 'application/vnd.google-apps.folder';
const root = {id:'root',name:'Meu Drive'};
let token = '', queue = '', trail = [root], selected, previewUrl, session = 0, busy = false;
const cache = new Map();
const say = message => { $('message').textContent = message; };
function action(id, fn) {
  $(id).onclick = async () => {
    $(id).disabled = true;
    try { await fn(); } catch (e) { say(e.message); }
    finally { $(id).disabled = false; }
  };
}
async function req(url, options = {}) {
  if (!token) throw Error('Conecte sua conta Google.');
  const res = await fetch(url, {...options, headers:{...options.headers, Authorization:'Bearer '+token}});
  if (!res.ok) throw Error(res.status === 401 ? 'Sessão expirada. Toque em Conectar Google.' : 'Google Drive retornou erro '+res.status+'. Tente novamente.');
  return res;
}
async function list(q) {
  const files = [];
  let page = '';
  do {
    const p = new URLSearchParams({q:'trashed = false and '+q,fields:'nextPageToken,files(id,name,modifiedTime,createdTime,appProperties)',pageSize:1000});
    if (page) p.set('pageToken',page);
    const data = await (await req(api+'?'+p)).json();
    files.push(...data.files); page = data.nextPageToken;
  } while (page);
  return files;
}
async function connect() {
  if (!window.google?.accounts) throw Error('O login do Google ainda está carregando. Tente novamente.');
  const result = await new Promise((resolve,reject) => google.accounts.oauth2.initTokenClient({
    client_id:'284735647572-fjbiid4k7abis5nlieg9nv8jq0jus6rf.apps.googleusercontent.com',
    scope:'https://www.googleapis.com/auth/drive',callback:resolve,error_callback:()=>reject(Error('Login interrompido.'))
  }).requestAccessToken());
  if (!result.access_token) throw Error('O Google não autorizou o acesso.');
  session++; token=result.access_token; queue=''; trail=[root]; selected=null; cache.clear();
  $('jobs').replaceChildren(); $('video').removeAttribute('src'); $('video').load();
  if(previewUrl) URL.revokeObjectURL(previewUrl);
  const existing = await list("'root' in parents and mimeType = '"+folderType+"' and appProperties has { key='samukaQueue' and value='v1' }");
  queue = existing[0]?.id || (await (await req(api,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    name:'Samuka - Fila do Estúdio', mimeType:folderType, parents:['root'],appProperties:{samukaQueue:'v1'}
  })})).json()).id;
  $('pair').value=queue; await folders(); await refresh(); say('Drive conectado. Escolha a pasta que receberá os vídeos.');
}
async function folders() {
  const items=await list("'"+trail.at(-1).id+"' in parents and mimeType = '"+folderType+"'");
  $('folder').replaceChildren(new Option('Usar esta pasta',''),...items.filter(f=>f.id!==queue).sort((a,b)=>a.name.localeCompare(b.name)).map(f=>new Option(f.name,f.id)));
  $('path').textContent=trail.map(f=>f.name).join(' / ');
}
$('folder').onchange=async e=>{
  const o=e.target.selectedOptions[0]; if(!o.value)return;
  trail.push({id:o.value,name:o.text}); try{await folders();}catch(err){trail.pop();say(err.message);}
};
action('back',async()=>{if(trail.length>1)trail.pop();await folders();});
function youtube(raw) {
  const u=new URL(raw);
  if(!['http:','https:'].includes(u.protocol))throw Error('Use um link do YouTube.');
  const id=u.hostname==='youtu.be'?u.pathname.slice(1):['youtube.com','www.youtube.com','m.youtube.com'].includes(u.hostname)?
    (u.pathname==='/watch'?u.searchParams.get('v'):u.pathname.match(/^\/(?:shorts|live)\/([\w-]+)$/)?.[1]):'';
  if(!/^[\w-]{11}$/.test(id||'')) throw Error('Confira este link do YouTube: '+raw);
  return id;
}
async function submit(payload,label) {
  if (!queue) throw Error('Conecte o Drive primeiro.');
  const id=crypto.randomUUID();
  const boundary='samuka_'+id;
  const meta={name:'job-'+id+'.json',parents:[queue],appProperties:{label:label.slice(0,80)}};
  const body=[meta,payload].map(part=>'--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(part)+'\r\n').join('')+'--'+boundary+'--';
  await req('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',{method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body});
}
action('send',async()=>{
  const lines=$('links').value.trim().split(/\s+/).filter(Boolean);
  if(!lines.length) throw Error('Cole pelo menos um link.');
  const ids=lines.map(youtube), dest=trail.at(-1).id;
  for(let i=0;i<ids.length;i++){await submit({type:'download',video:ids[i],dest},ids[i]);$('links').value=lines.slice(i+1).join('\n');}
  say('Links enviados. O Windows vai processar a fila.');await refresh();
});
function button(text,fn){
  const b=document.createElement('button'); b.textContent=text;b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){say(e.message);}finally{b.disabled=false;}};return b;
}
async function preview(s){
  const current=session;
  say('Carregando o vídeo do Drive…');
  const blob=await (await req(api+'/'+encodeURIComponent(s.file)+'?alt=media')).blob();
  if(current!==session)return;
  if(previewUrl)URL.revokeObjectURL(previewUrl);
  previewUrl=URL.createObjectURL(blob); selected=s;
  $('video').src=previewUrl; $('title').textContent=s.name; $('start').value=0;
  $('video').onloadedmetadata=()=>{$('end').value=Math.floor($('video').duration*100)/100;};
  $('editor').scrollIntoView(); say('Prévia carregada.');
}
async function refresh(){
  if(!queue||busy)return;busy=true;const current=session;
  try{
    const files=await list("'"+queue+"' in parents");
    const byName=new Map(files.map(f=>[f.name,f])), rows=[];
    for(const job of files.filter(f=>/^job-[a-f0-9-]+\.json$/.test(f.name)).sort((a,b)=>b.createdTime.localeCompare(a.createdTime))){
      const status=byName.get(job.name.replace('job-','status-'));let s={state:'Na fila'};
      if(status){
        const old=cache.get(status.id);
        if(old?.time===status.modifiedTime)s=old.data;
        else{s=await (await req(api+'/'+status.id+'?alt=media')).json();cache.set(status.id,{time:status.modifiedTime,data:s});}
      }
      const row=document.createElement('div');row.className='job';const label=document.createElement('strong'), info=document.createElement('p');
      label.textContent=s.name||job.appProperties?.label||'Vídeo';info.textContent=s.state+(s.error?' · '+s.error:'');row.append(label,info);
      if(s.file)row.append(button('Abrir vídeo',()=>preview(s)));
      if(s.state==='Falhou')row.append(button('Tentar novamente',async()=>{const data=await(await req(api+'/'+job.id+'?alt=media')).json();await submit(data,label.textContent);await refresh();}));
      rows.push(row);
    }
    if(current===session)$('jobs').replaceChildren(...(rows.length?rows:['Nenhum pedido ainda.']));
  }finally{busy=false;}
}
action('connect',connect);action('refresh',refresh);
for(const [id,target] of [['markStart','start'],['markEnd','end']]) action(id,()=>{$(target).value=$('video').currentTime.toFixed(2);});
action('cut',async()=>{
  const start=+$('start').value,end=+$('end').value;
  if(!selected||!Number.isFinite($('video').duration)||!$('end').value||start<0||end<=start||end>$('video').duration)throw Error('Selecione um vídeo e marque um intervalo válido.');
  await submit({type:'cut',source:selected.job,start,end,dest:trail.at(-1).id},'Corte '+start+'–'+end+' s');say('Corte enviado à fila.');await refresh();
});
setInterval(()=>{if(!document.hidden)refresh().catch(e=>say(e.message));},15000);
