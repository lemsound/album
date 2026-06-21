/* =========================================================
   三文抒情 — キャッシュ用サービスワーカー（通信量を抑える設計）

   キャッシュを2つに分けています：
   ・SHELL … HTML/CSS/JS/JSON/TXT（アプリ本体）
             network-first。コード更新のたび作り直す（古い版が混ざらない）。
   ・MEDIA … 音源(mp3/wav…)・画像・フォント
             一度落としたら使い回す。コードを更新しても消えないので、
             音源を何度も再ダウンロードしない（＝通信量を節約）。

   ■ ポイント：<audio> は再生・シークで「部分(Range)リクエスト」を出し、
     サーバは 206 を返しますが、Cache API は 206 を保存できません。
     そこで音源は「全体(200)を1回だけ取得して保存」し、以降の部分要求は
     キャッシュした全体から切り出して 206 を自前で返します。
     これで各曲はワンダウンロードで済み、再生・シーク・再訪問では通信しません。

   ・音源を差し替えたときは MEDIA_VERSION を上げてください（音源だけ作り直し）。
   ・コードだけ更新したときは VERSION を上げてください（音源は保持されます）。
   ========================================================= */
const VERSION       = 'sanmon-jojou-v14';   // アプリ本体（コード）の版
const MEDIA_VERSION = 'sj-media-v1';        // 音源・画像の版（音源を差し替えた時だけ上げる）
const SHELL = 'shell-' + VERSION;
const MEDIA = MEDIA_VERSION;

const isAudio = (u) => /\.(mp3|wav|m4a|aac|ogg|oga|flac)$/i.test(u.pathname);
const isImage = (u) => /\.(jpg|jpeg|png|webp|gif|svg|ico)$/i.test(u.pathname);
const isFont  = (u) => /fonts\.(googleapis|gstatic)\.com$/i.test(u.hostname);

// オフライン起動に必要な“本体一式”（音源以外）。10分のHTTPキャッシュに頼らず保存する。
const SHELL_FILES = ['./','index.html','app.js','style.css',
                     'manifest.json','曲順.txt','design.txt','timing.txt'];

self.addEventListener('install', (e)=>{
  e.waitUntil((async ()=>{
    self.skipWaiting();
    // 本体一式を先に保存（失敗しても起動は妨げない）
    try{
      const shell = await caches.open(SHELL);
      await shell.addAll(SHELL_FILES.map(f=> new Request(f, {cache:'reload'})));
    }catch(_){}
    // 歌詞は本体扱い(SHELL)、ジャケット等の画像はMEDIAへ（manifest から取得）
    try{
      const m = await (await fetch('manifest.json', {cache:'reload'})).json();
      const shell = await caches.open(SHELL);
      const media = await caches.open(MEDIA);
      const lyrics = (m.tracks||[]).map(t=> t.lyrics).filter(Boolean);
      const images = [];
      if(m.jacket) images.push(m.jacket);
      (m.tracks||[]).forEach(t=>{ if(t.image) images.push(t.image); });
      await Promise.all([
        ...lyrics.map(u=> shell.add(new Request(u, {cache:'reload'})).catch(()=>{})),
        ...images.map(u=> media.add(new Request(u, {cache:'reload'})).catch(()=>{}))
      ]);
    }catch(_){}
  })());
});

self.addEventListener('activate', (e)=>{
  e.waitUntil((async ()=>{
    const keep = new Set([SHELL, MEDIA]);
    const keys = await caches.keys();
    await Promise.all(keys.filter(k=> !keep.has(k)).map(k=> caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e)=>{
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);

  // 別オリジンはフォントだけ扱う
  if(url.origin !== location.origin && !isFont(url)) return;

  if(isAudio(url)){
    e.respondWith(audioHandler(req, url));          // Range対応・全体を1回だけ保存
  }else if(isImage(url) || isFont(url)){
    e.respondWith(cacheFirst(req, MEDIA));          // 画像・フォントは普通に使い回し
  }else{
    e.respondWith(networkFirst(req, SHELL));        // 本体は常に最新を取りに行く
  }
});

/* ---------- 音源：Range対応キャッシュ ---------- */
const inflight = new Set();   // 同じ曲の全体取得が二重に走らないように

async function audioHandler(req, url){
  const cache = await caches.open(MEDIA);
  const full = await cache.match(url.href, {ignoreVary:true});
  const range = req.headers.get('range');

  if(full){
    // 2回目以降：通信せず、キャッシュした全体から返す（シークも自前で206）
    return range ? sliceFromCache(full, range) : full.clone();
  }

  // 未キャッシュ（＝初回再生）：ネットの応答を「再生用」と「保存用」に分ける。
  // これで初回は“1回ぶん”のダウンロードだけで、全体がキャッシュに入る。
  try{
    const res = await fetch(req);                 // 再生のための取得（通常は206/全体）
    if(res && (res.status === 200 || res.status === 206)){
      cacheFullFromResponse(url.href, res.clone(), cache, req);  // 同じ取得を保存にも回す
    }
    return res;                                   // 再生はそのまま即開始（iOSも206でOK）
  }catch(err){
    const got = await cache.match(url.href, {ignoreVary:true});
    if(got) return range ? sliceFromCache(got, range) : got.clone();
    return Response.error();
  }
}

/* 再生のために取得した応答が「全体」なら、それを 200 として保存（teeした複製を読む）。
   万一“部分”しか来なかった初回だけ、別途1回だけ全体を取りにいく。 */
async function cacheFullFromResponse(href, res, cache, req){
  try{
    const status = res.status;
    const cr = res.headers.get('Content-Range');   // 例: "bytes 0-5242879/5242880"
    let isFull = (status === 200);
    if(status === 206 && cr){
      const m = /bytes\s+(\d+)-(\d+)\/(\d+)/.exec(cr);
      if(m && m[1] === '0' && (parseInt(m[2],10) + 1) === parseInt(m[3],10)) isFull = true;
    }
    if(!isFull){
      // 先頭以外からの再生など、部分しか来なかった → 全体を1回だけ確保（フォールバック）
      ensureFullCached(href, cache);
      return;
    }
    const buf = await res.arrayBuffer();
    const synth = new Response(buf, {
      status: 200,
      headers: {
        'Content-Type':   res.headers.get('Content-Type') || 'audio/mpeg',
        'Content-Length': String(buf.byteLength),
        'Accept-Ranges':  'bytes'
      }
    });
    await cache.put(href, synth);
  }catch(_){
    ensureFullCached(href, cache);
  }
}

function ensureFullCached(href, cache){
  if(inflight.has(href)) return;
  inflight.add(href);
  // Rangeヘッダを付けない＝サーバは 200（全体）を返す
  fetch(href, {headers:{}, credentials:'same-origin'})
    .then(res=>{ if(res && res.status === 200) return cache.put(href, res.clone()); })
    .catch(()=>{})
    .finally(()=> inflight.delete(href));
}

async function sliceFromCache(fullRes, rangeHeader){
  const buf = await fullRes.clone().arrayBuffer();
  const total = buf.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader || '');
  let start = m && m[1] !== '' ? parseInt(m[1], 10) : 0;
  let end   = m && m[2] !== '' ? parseInt(m[2], 10) : total - 1;
  if(isNaN(start)) start = 0;
  if(isNaN(end) || end >= total) end = total - 1;
  if(start > end || start >= total){ start = 0; end = total - 1; }
  const body = buf.slice(start, end + 1);
  return new Response(body, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type':  fullRes.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Length': String(end - start + 1),
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
      'Accept-Ranges': 'bytes'
    }
  });
}

/* ---------- 画像・フォント：cache-first ---------- */
async function cacheFirst(req, cacheName){
  const cache = await caches.open(cacheName);
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

/* ---------- 本体：network-first ---------- */
async function networkFirst(req, cacheName){
  const cache = await caches.open(cacheName);
  try{
    const res = await fetch(req, {cache:'no-cache'});
    if(res && res.ok) cache.put(req, res.clone());
    return res;
  }catch(err){
    const hit = await cache.match(req);
    return hit || Response.error();
  }
}
