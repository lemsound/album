/* =========================================================
   三文抒情 — キャッシュ用サービスワーカー
   ・音源/画像  … cache-first（一度落としたら再通信しない＝通信料節約）
   ・設定/本体  … network-first（更新が混ざらず、常に最新一式がそろう）
   ・Webフォント … cache-first
   キャッシュを作り直したいときは下の VERSION を変えてください。
   ========================================================= */
const VERSION = 'sanmon-jojou-v4';

const isMedia  = (u) => /\.(mp3|wav|m4a|ogg|jpg|jpeg|png|webp|gif|svg)$/i.test(u.pathname);
const isFont   = (u) => /fonts\.(googleapis|gstatic)\.com$/i.test(u.hostname);

self.addEventListener('install', (e)=>{
  // 旧版のシェルを引きずらないよう、何も precache せず即時有効化
  self.skipWaiting();
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
    e.respondWith(cacheFirst(req));      // 音源・画像・フォントは使い回し
  }else{
    e.respondWith(networkFirst(req));    // html/css/js/json/txt は常に最新を取りに行く
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
