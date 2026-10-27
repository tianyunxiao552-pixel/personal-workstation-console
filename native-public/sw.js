const SHELL='workstation-shell-v1';
self.addEventListener('install',event=>event.waitUntil(caches.open(SHELL).then(cache=>cache.add('/app/')).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||!url.pathname.startsWith('/app/'))return;
  event.respondWith(fetch(event.request).then(response=>{
    if(response.ok){const copy=response.clone();event.waitUntil(caches.open(SHELL).then(cache=>cache.put(event.request,copy)));}
    return response;
  }).catch(async()=>await caches.match(event.request)||(event.request.mode==='navigate'?await caches.match('/app/'):undefined)||new Response('暂时无法连接电脑',{status:503,headers:{'Content-Type':'text/plain;charset=utf-8'}})));
});
