const CACHE='samuka-v16-shell-1',ASSETS=['samuka-v16.html','samuka-v16.webmanifest','samuka-mono-192.png','samuka-mono-512.png','samuka-v16-engine.html'].map(x=>new URL(x,self.registration.scope).href);
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;const u=new URL(e.request.url);u.search='';u.hash='';if(!ASSETS.includes(u.href))return;e.respondWith(fetch(e.request).then(async r=>{if(r.ok){const c=await caches.open(CACHE);await c.put(u.href,r.clone())}return r}).catch(()=>caches.open(CACHE).then(c=>c.match(u.href)).then(r=>r||Response.error())))});
