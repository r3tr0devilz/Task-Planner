const CACHE='tp-v2';
const PRECACHE=['/index.html','/icon-192.png','/icon-512.png','/manifest.json'];

self.addEventListener('install',function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(PRECACHE);}));
  self.skipWaiting();
});

self.addEventListener('activate',function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));
  }));
  self.clients.claim();
});

self.addEventListener('notificationclick',function(e){
  e.notification.close();
  var action=e.action;
  e.waitUntil(
    clients.matchAll({type:'window',includeUncontrolled:true}).then(function(cs){
      var msg=action==='restart'?'pomo-restart':'pomo-stop';
      cs.forEach(function(c){c.postMessage({type:msg});});
      for(var i=0;i<cs.length;i++){if('focus' in cs[i])return cs[i].focus();}
      return clients.openWindow('/');
    })
  );
});

self.addEventListener('fetch',function(e){
  if(e.request.method!=='GET')return;
  if(e.request.url.indexOf('/.netlify/')>-1)return;
  // Network-first for HTML so changes always reach the browser
  var isHTML=e.request.mode==='navigate'||(e.request.headers.get('accept')||'').indexOf('text/html')>-1;
  if(isHTML){
    e.respondWith(fetch(e.request).then(function(res){
      if(res&&res.status===200){
        var clone=res.clone();
        caches.open(CACHE).then(function(c){c.put(e.request,clone);});
      }
      return res;
    }).catch(function(){return caches.match(e.request);}));
    return;
  }
  // Cache-first for static assets (icons, manifest)
  e.respondWith(
    caches.match(e.request).then(function(cached){
      if(cached)return cached;
      return fetch(e.request).then(function(res){
        if(res&&res.status===200&&res.type==='basic'){
          var clone=res.clone();
          caches.open(CACHE).then(function(c){c.put(e.request,clone);});
        }
        return res;
      });
    })
  );
});
