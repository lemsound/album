/* =========================================================
   三文抒情 — キャッシュ用サービスワーカー
   ・音源/画像  … cache-first（一度落としたら再通信しない＝通信料節約）
   ・設定ファイル … network-first（編集が再読み込みで反映される）
   ・本体(html/css/js) … stale-while-revalidate
   ・Webフォント … cache-first
   キャッシュを作り直したいときは下の VERSION を変えてください。
   ========================================================= */
const VERSION = 'sanmon-jojou-v1';
const SHELL = ['./', './index.html', './style.css', './app.js'];

const isMedia  = (u) => /\.(mp3|wav|m4a|ogg|jpg|jpeg|png|webp|gif)$/i.test(u.pathname);
const isConfig = (u) => /(manifest\.json|design\.txt|timing\.txt|曲順\.txt|%E6%9B%B2%E9%A0%86\.txt)$/i.test(u.pathname);
const isFont   = (u) => /fonts\.(googleapis|gstatic)\.com$/i.test(u.hostname);

self.addEventListener('install', (e)=>{
  e.waitUntil(caches.open(VERSION).then(c=> c.addAll(SHELL)).then(()=> self.skipWaiting()));
});

self.addEventListener('activate', (e)=>{
  e.waitUntil(
    caches.keys().then(keys=> Promise.all(keys.filter(k=> k!==VERSION).map(k=> caches.delete(k))))
      .then(()=> self.clients.claim())
  );
});

self.addEventListener('fetch', (e)=>{
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);

  // 別オリジンはフォントだけ扱う
  if(url.origin !== location.origin && !isFont(url)) return;

  if(isMedia(url) || isFont(url)){
    e.respondWith(cacheFirst(req));
  }else if(isConfig(url)){
    e.respondWith(networkFirst(req));
  }else{
    e.respondWith(staleWhileRevalidate(req));
  }
});

async function cacheFirst(req){
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if(hit) return hit;
  try{
    const res = await fetch(req);
    if(res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  }catch(err){
    return hit || Response.error();
  }
}

async function networkFirst(req){
  const cache = await caches.open(VERSION);
  try{
    const res = await fetch(req, {cache:'no-cache'});
    if(res && res.ok) cache.put(req, res.clone());
    return res;
  }catch(err){
    const hit = await cache.match(req);
    return hit || Response.error();
  }
}

async function staleWhileRevalidate(req){
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  const net = fetch(req).then(res=>{
    if(res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(()=> hit);
  return hit || net;
}
