/* =========================================================
   三文抒情 — アルバムプレイヤー  app.js
   ========================================================= */
'use strict';

/* ---------- フォント定義 ---------- */
const FONT_STACK = {
  '明朝'   : `"游明朝","Yu Mincho","YuMincho","Hiragino Mincho ProN","Noto Serif JP",serif`,
  'ゴシック': `"游ゴシック","Yu Gothic","YuGothic","Hiragino Kaku Gothic ProN","Noto Sans JP","Meiryo",sans-serif`,
  'セリフ' : `"EB Garamond",Georgia,"Times New Roman",serif`,
  'サンセリフ': `"Inter",system-ui,-apple-system,sans-serif`,
};
const GOOGLE_FONT = {
  '明朝'   : 'Noto+Serif+JP:wght@400;500;700',   // 游明朝が無い端末向けフォールバック
  'ゴシック': 'Noto+Sans+JP:wght@400;500;700',    // 游ゴシックが無い端末向けフォールバック
  'セリフ' : 'EB+Garamond:ital,wght@0,400;0,600;1,400',
  'サンセリフ': 'Inter:wght@400;500;700',
};
// アルバムタイトル専用（このフォントは気に入っているので維持）
const ALBUM_TITLE_FONT = `"Shippori Mincho","Hiragino Mincho ProN","游明朝","Yu Mincho",serif`;
const _loadedFonts = new Set();
function ensureFont(name){
  if(!GOOGLE_FONT[name] || _loadedFonts.has(name)) return;
  _loadedFonts.add(name);
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = `https://fonts.googleapis.com/css2?family=${GOOGLE_FONT[name]}&display=swap`;
  document.head.appendChild(l);
}
function ensureShippori(){
  if(_loadedFonts.has('__shippori')) return;
  _loadedFonts.add('__shippori');
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@500;700&display=swap';
  document.head.appendChild(l);
}

/* ---------- 小物 ---------- */
const $ = (id) => document.getElementById(id);
const fmt = (s) => {
  if(s == null || !isFinite(s)) return '--:--';
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
};
const fmtJP = (s) => {
  s = Math.max(0, Math.round(s || 0));
  return `${Math.floor(s/60)}分${s%60}秒`;
};
async function fetchText(url){
  const r = await fetch(url, {cache:'no-cache'});
  if(!r.ok) throw new Error(url+' '+r.status);
  return await r.text();
}

/* ---------- 設定ファイル解析 ---------- */
function parseDesign(text){
  const cfg = {colors:{}, year:null, albumFont:'明朝', lyricsFont:'明朝', albumTitleSize:null, perSong:{}};
  text.replace(/\r\n?/g,'\n').split('\n').forEach(raw=>{
    const line = raw.trim();
    if(!line || line.startsWith('#')) return;
    const i = line.indexOf('=');
    if(i < 0) return;
    const key = line.slice(0,i).trim();
    let val = line.slice(i+1).trim();
    val = val.replace(/[\s　]*[（(].*$/,'').trim();   // 末尾の (注釈) を除去
    switch(key){
      case '背景色': cfg.colors['--bg'] = val; break;
      case 'サブ色': cfg.colors['--surface'] = val; break;
      case '差し色': cfg.colors['--accent'] = val; break;
      case '文字色': cfg.colors['--text'] = val; break;
      case '淡色':   cfg.colors['--muted'] = val; break;
      case 'リリース年': cfg.year = val; break;
      case 'アルバム名': if(FONT_STACK[val]) cfg.albumFont = val; break;
      case 'アルバム名サイズ': cfg.albumTitleSize = val; break;
      case '歌詞':       if(FONT_STACK[val]) cfg.lyricsFont = val; break;
      default:
        if(key.startsWith('歌詞@') && FONT_STACK[val]){
          cfg.perSong[key.slice(3).trim()] = val;
        }
    }
  });
  return cfg;
}

function parseTiming(text){
  const map = {};
  text.replace(/\r\n?/g,'\n').split('\n').forEach(raw=>{
    const line = raw.trim();
    if(!line || line.startsWith('#')) return;
    const mh = line.match(/頭\s*=\s*([+-]?[0-9.]+)/);
    const mt = line.match(/尻\s*=\s*([+-]?[0-9.]+)/);
    // 曲名 = 「頭=」より前の部分（無ければ行頭トークン）
    let name = line;
    const cut = line.search(/頭\s*=/);
    if(cut > 0) name = line.slice(0, cut).trim();
    else name = line.split(/[\s　\t]+/)[0];
    name = name.replace(/[\s　\t]+$/,'');
    map[name] = {
      head: mh ? parseFloat(mh[1]) : 0,
      tail: mt ? parseFloat(mt[1]) : 0,
    };
  });
  return map;
}

/* ---------- 状態 ---------- */
const audio = $('audio');
let manifest = null;
let design = null;
let timing = {};
let tracks = [];              // {…manifest, head, tail, base, eff}
let order = [];               // 再生順（index の配列）
let cur = -1;                 // 現在トラックの index（tracks内）
let isPlaying = false;
let loopMode = 0;            // 0:off 1:all 2:one
let shuffleOn = false;
const lyricsCache = {};

/* ---------- 効果時間モデル（曲頭/曲尻の無音・カット） ---------- */
function shape(tr){
  const base = (tr.base != null) ? tr.base : 0;
  const h = tr.head || 0, t = tr.tail || 0;
  const startOffset = Math.max(0, -h);              // 頭カット → 音声をこの秒数から
  const leadSilence = Math.max(0, h);               // 頭に足す無音
  const endAt       = (t < 0) ? Math.max(startOffset, base + t) : base;  // 尻カット
  const trailSilence= Math.max(0, t);               // 尻に足す無音
  const span        = Math.max(0, endAt - startOffset);
  return {startOffset, leadSilence, endAt, trailSilence, span,
          eff: leadSilence + span + trailSilence};
}

/* ---------- 初期化 ---------- */
init();
async function init(){
  try{
    const [mfTxt, dsTxt, tmTxt] = await Promise.all([
      fetchText('manifest.json'),
      fetchText('design.txt').catch(()=> ''),
      fetchText('timing.txt').catch(()=> ''),
    ]);
    manifest = JSON.parse(mfTxt);
    design = parseDesign(dsTxt);
    timing = parseTiming(tmTxt);
  }catch(e){
    $('loading').textContent = '読み込みに失敗しました（manifest.json を確認してください）';
    console.error(e);
    return;
  }

  // 描画もまとめて保護：途中でつまずいても「読み込み中」で固まらせない
  try{
    applyDesign();
    buildTracks();
    renderHeader();
    renderList();
    bindUI();

    // 共有リンクで ?t=曲名 が指定されていたら、その曲を選んで表示
    const want = new URLSearchParams(location.search).get('t');
    if(want){
      const idx = tracks.findIndex(t=> t.name === want);
      if(idx >= 0){ select(idx, false); document.querySelectorAll('.track')[idx]?.scrollIntoView({block:'center'}); }
    }
  }catch(e){
    console.error(e);
    // 古いキャッシュ等で画面構成が食い違ったとき、ここに来ることがある。
    // selfHeal（index.html 側）が一度だけ掃除して再読み込みする。
    $('loading').textContent = '表示の準備でつまずきました。数秒お待ちください…';
    return;
  }

  $('loading').hidden = true;
  $('screen').hidden = false;
  registerSW();   // 画面を出してから登録（初回描画を妨げない）
}

function applyDesign(){
  const root = document.documentElement.style;
  for(const [k,v] of Object.entries(design.colors)){
    if(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) root.setProperty(k, v);
  }
  // surface-2 を surface から少し持ち上げる
  if(design.colors['--surface']) root.setProperty('--surface-2',
    `color-mix(in srgb, ${design.colors['--surface']} 80%, #fff 8%)`);

  ensureFont('ゴシック');            // UI（游ゴシック）のフォールバック Noto を読む
  ensureFont(design.albumFont);
  ensureFont(design.lyricsFont);

  // アルバムタイトルは Shippori Mincho を維持（明朝指定のとき）
  if(design.albumFont === '明朝'){
    ensureShippori();
    root.setProperty('--font-album', ALBUM_TITLE_FONT);
  }else{
    root.setProperty('--font-album', FONT_STACK[design.albumFont]);
  }
  root.setProperty('--font-lyrics', FONT_STACK[design.lyricsFont]);

  // アルバム名サイズ（数字だけなら rem 扱い。スマホは画面幅で頭打ち）
  if(design.albumTitleSize){
    let v = String(design.albumTitleSize).trim();
    if(/^[\d.]+$/.test(v)) v = v + 'rem';
    root.setProperty('--album-title-size', v);
    root.setProperty('--album-title-size-m', `min(${v}, 11vw)`);
  }

  // ファビコン（♪）を差し色で塗る
  const accent = (design.colors['--accent'] && /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(design.colors['--accent']))
                 ? design.colors['--accent'] : '#e8c45a';
  setFavicon(accent);
}

function setFavicon(color){
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><g fill="${color}"><ellipse cx="12" cy="22" rx="7" ry="6"/><rect x="17.3" y="6" width="2.7" height="16.4" rx="1.2"/><path d="M19 5.6c2.7.7 5 2.5 5 5.5 0 1-.25 1.9-.7 2.7.25-2.7-1.8-4.5-4.3-5.2z"/></g></svg>`;
  const href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  let link = document.getElementById('favicon');
  if(!link){ link = document.createElement('link'); link.rel = 'icon'; link.id = 'favicon'; document.head.appendChild(link); }
  link.href = href;
}

function buildTracks(){
  tracks = manifest.tracks.map(t=>{
    const tm = timing[t.name] || {head:0, tail:0};
    const tr = {...t, head:tm.head, tail:tm.tail, base:t.duration, playable: t.duration != null};
    tr.shape = shape(tr);
    return tr;
  });
  rebuildOrder();
}

function rebuildOrder(){
  const idx = tracks.map((_,i)=> i);
  if(shuffleOn){
    for(let i=idx.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [idx[i],idx[j]]=[idx[j],idx[i]]; }
    if(cur >= 0){ // 現在曲を先頭へ
      const p = idx.indexOf(cur);
      if(p > 0){ idx.splice(p,1); idx.unshift(cur); }
    }
  }
  order = idx;
}

/* ---------- 描画 ---------- */
function renderHeader(){
  $('albumTitle').textContent = manifest.album || '';
  document.title = manifest.album || '三文抒情';
  $('app').querySelectorAll('meta');

  if(manifest.artist){
    $('albumArtist').textContent = manifest.artist;
    $('albumArtist').hidden = false;
  }
  if(design.year){
    $('statYear').textContent = design.year;
    $('statYear').hidden = false;
  }
  $('statCount').textContent = `${tracks.length}曲`;
  const total = tracks.reduce((s,t)=> s + (t.base != null ? t.shape.eff : 0), 0);
  $('statTotal').textContent = fmtJP(total);

  const art = $('art');
  if(manifest.jacket){
    const img = new Image();
    img.alt = manifest.album || '';
    img.src = encodeURI(manifest.jacket);
    art.innerHTML = ''; art.appendChild(img);
    // OGP / 共有サムネ用にも反映
    document.querySelector('meta[property="og:image"]')?.remove();
    const og = document.createElement('meta');
    og.setAttribute('property','og:image');
    og.setAttribute('content', new URL(encodeURI(manifest.jacket), location.href).href);
    document.head.appendChild(og);
  }else{
    art.classList.add('album__art--empty');
    art.textContent = '♪';
  }
  // og:url（共有カード用）
  document.querySelector('meta[property="og:url"]')?.remove();
  const ogu = document.createElement('meta');
  ogu.setAttribute('property','og:url');
  ogu.setAttribute('content', location.origin + location.pathname);
  document.head.appendChild(ogu);
}

function renderList(){
  const ol = $('tracklist');
  ol.innerHTML = '';
  tracks.forEach((t,i)=>{
    const li = document.createElement('li');
    li.className = 'track' + (t.playable ? '' : ' is-empty');
    li.dataset.i = i;

    const num = document.createElement('span');
    num.className = 'track__index'; num.textContent = i+1;

    let art;
    if(t.image){
      art = new Image(); art.className='track__art'; art.alt=''; art.loading='lazy';
      art.src = encodeURI(t.image);
    }else{
      art = document.createElement('span'); art.className='track__art--spacer';
    }

    const title = document.createElement('span');
    title.className = 'track__title'; title.textContent = t.name;

    const dur = document.createElement('span');
    dur.className = 'track__dur';
    dur.textContent = t.playable ? fmt(t.shape.eff) : '--:--';

    li.append(num, art, title, dur);
    li.addEventListener('click', ()=> onTrackClick(i));
    ol.appendChild(li);
  });
  markCurrent();
}

function markCurrent(){
  document.querySelectorAll('.track').forEach((el,i)=>{
    const isCur = (i === cur);
    el.classList.toggle('is-current', isCur);
    const num = el.querySelector('.track__index');
    if(isCur && isPlaying){
      if(!num.querySelector('.track__bars'))
        num.innerHTML = '<span class="track__bars"><span></span><span></span><span></span></span>';
    }else if(isCur){
      // 選択中だが停止 → 番号でなく一時停止マーク
      if(!num.querySelector('.track__pause'))
        num.innerHTML = '<span class="track__pause"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-pause"></use></svg></span>';
    }else{
      num.textContent = i+1;
    }
  });
}

/* ---------- 再生エンジン ---------- */
let phase = 'idle';            // 'lead' | 'audio' | 'trail' | 'idle'
let phaseStart = 0;            // performance.now() 起点（無音フェーズ用）
let phaseConsumed = 0;         // 一時停止時に消費済みの無音秒数
let rafId = 0;
let seeking = false;           // ユーザーがシークバーを操作中か

function onTrackClick(i){
  if(i === cur){ togglePlay(); return; }
  select(i, true);
}

function select(i, autoplay){
  cur = i;
  const t = tracks[i];
  stopRAF();
  audio.pause();
  isPlaying = false;

  // プレイヤー表示
  $('player').hidden = false;
  $('npTitle').textContent = t.name;
  const npArt = $('npArt');
  if(t.image || manifest.jacket){
    npArt.src = encodeURI(t.image || manifest.jacket); npArt.hidden = false;
  }else npArt.hidden = true;

  $('dur').textContent = t.playable ? fmt(t.shape.eff) : '--:--';
  $('cur').textContent = '0:00';
  setSeek(0);
  syncLyricsIfOpen();
  markCurrent();
  // ※ 再生中もURLは書き換えない（リロードしたら初期画面に戻すため）。
  //   共有は share() のときだけ ?t=曲名 付きリンクを作る。

  if(!t.playable){
    showToast('この曲はまだ音源が入っていません');
    return;
  }
  // 音源をセット
  audio.src = encodeURI(t.audio);
  audio.load();
  audio.onloadedmetadata = ()=>{
    if(isFinite(audio.duration) && audio.duration > 0){
      t.base = audio.duration;            // 実測で上書き
      t.shape = shape(t);
      $('dur').textContent = fmt(t.shape.eff);
      const el = document.querySelectorAll('.track__dur')[i];
      if(el) el.textContent = fmt(t.shape.eff);
    }
  };
  audio.onerror = ()=>{ t.playable = false; showToast('音源を読み込めませんでした'); };

  if(autoplay) play();
}

function play(){
  const t = tracks[cur];
  if(!t || !t.playable){ next(); return; }
  // 現在位置 P を維持して再生再開
  const P = currentP();
  seekToP(P, true);
  isPlaying = true;
  setPlayIcon(true);
  markCurrent();
  startRAF();
}

function pause(){
  phaseConsumed = currentP();      // 位置を覚えておく
  audio.pause();
  isPlaying = false;
  setPlayIcon(false);
  stopRAF();
  markCurrent();
}

function togglePlay(){
  if(cur < 0){ playAll(); return; }
  isPlaying ? pause() : play();
}

/* P = 効果時間上の現在位置（秒） */
function currentP(){
  const sh = tracks[cur].shape;
  if(phase === 'audio') return sh.leadSilence + Math.max(0, audio.currentTime - sh.startOffset);
  if(phase === 'lead')  return Math.min(sh.leadSilence, (performance.now()-phaseStart)/1000 + phaseConsumed);
  if(phase === 'trail') return sh.leadSilence + sh.span + Math.min(sh.trailSilence,(performance.now()-phaseStart)/1000 + phaseConsumed);
  return phaseConsumed;
}

/* 効果時間 P へ移動。play=true なら再生継続 */
function seekToP(P, playNow){
  const t = tracks[cur], sh = t.shape;
  P = Math.max(0, Math.min(P, sh.eff));
  phaseConsumed = 0;
  if(P < sh.leadSilence){                       // 頭の無音
    phase = 'lead';
    phaseConsumed = P;
    phaseStart = performance.now();
    audio.pause();
    try{ audio.currentTime = sh.startOffset; }catch(_){}
  }else if(P < sh.leadSilence + sh.span){        // 本体
    phase = 'audio';
    const at = sh.startOffset + (P - sh.leadSilence);
    try{ audio.currentTime = at; }catch(_){}
    if(playNow) audio.play().catch(()=>{});
    else audio.pause();
  }else{                                         // 尻の無音
    phase = 'trail';
    phaseConsumed = P - (sh.leadSilence + sh.span);
    phaseStart = performance.now();
    audio.pause();
    try{ audio.currentTime = sh.endAt; }catch(_){}
  }
}

function startRAF(){ stopRAF(); rafId = requestAnimationFrame(tick); }
function stopRAF(){ if(rafId){ cancelAnimationFrame(rafId); rafId = 0; } }

function tick(){
  if(!isPlaying){ return; }
  const t = tracks[cur], sh = t.shape;

  if(phase === 'lead'){
    const p = (performance.now()-phaseStart)/1000 + phaseConsumed;
    if(p >= sh.leadSilence){                      // 無音おわり → 本体へ
      phase = 'audio'; phaseConsumed = 0;
      try{ audio.currentTime = sh.startOffset; }catch(_){}
      audio.play().catch(()=>{});
    }
  }else if(phase === 'audio'){
    if(audio.currentTime >= sh.endAt - 0.02 || audio.ended){
      audio.pause();
      if(sh.trailSilence > 0){ phase='trail'; phaseConsumed=0; phaseStart=performance.now(); }
      else { trackEnded(); return; }
    }
  }else if(phase === 'trail'){
    const p = (performance.now()-phaseStart)/1000 + phaseConsumed;
    if(p >= sh.trailSilence){ trackEnded(); return; }
  }

  const P = currentP();
  if(!seeking){                       // 操作中はユーザーの指に任せる
    $('cur').textContent = fmt(P);
    setSeek(sh.eff ? P/sh.eff*1000 : 0);
  }
  rafId = requestAnimationFrame(tick);
}

function trackEnded(){
  if(loopMode === 2){ seekToP(0, true); startRAF(); return; }   // 単曲ループ
  next(true);
}

/* ---------- 曲送り ---------- */
function posInOrder(){ return order.indexOf(cur); }

function next(auto){
  let p = posInOrder();
  for(let step=1; step<=order.length; step++){
    let np = p + step;
    if(np >= order.length){
      if(loopMode === 1 || (auto && loopMode === 1)) np = np % order.length;
      else if(!auto) np = np % order.length;       // 手動は末尾→先頭で巡回
      else { stopPlayback(); return; }             // 自動でループoffなら終了
    }
    const cand = order[np];
    if(tracks[cand].playable){ select(cand, true); return; }
  }
  stopPlayback();
}

function prev(){
  if(cur >= 0 && currentP() > 3){ seekToP(0, isPlaying); if(isPlaying) startRAF(); return; }
  let p = posInOrder();
  for(let step=1; step<=order.length; step++){
    let np = (p - step + order.length) % order.length;
    const cand = order[np];
    if(tracks[cand].playable){ select(cand, isPlaying || true); return; }
  }
}

function playAll(){
  rebuildOrder();
  const first = order.find(i=> tracks[i].playable);
  if(first != null) select(first, true);
}

function stopPlayback(){
  isPlaying = false; setPlayIcon(false); stopRAF(); audio.pause();
  phase='idle'; phaseConsumed=0; setSeek(0); $('cur').textContent='0:00';
  markCurrent();
}

/* ---------- UI 反映 ---------- */
function setPlayIcon(on){
  const use = $('play').querySelector('use');
  use.setAttribute('href', on ? '#i-pause' : '#i-play');
  $('play').setAttribute('aria-label', on ? '一時停止' : '再生');
  // 上部のアルバム再生ボタンも同期
  const pa = $('playAll');
  if(pa){
    pa.querySelector('use').setAttribute('href', on ? '#i-pause' : '#i-play');
    pa.setAttribute('aria-label', on ? '一時停止' : '再生');
  }
}
function setSeek(v){
  const s = $('seek'); s.value = v;
  s.style.setProperty('--p', (v/1000*100)+'%');
}

/* ---------- 歌詞 ---------- */
async function loadLyrics(t){
  if(!t.lyrics) return null;
  if(lyricsCache[t.name] !== undefined) return lyricsCache[t.name];
  try{ lyricsCache[t.name] = await fetchText(encodeURI(t.lyrics)); }
  catch(_){ lyricsCache[t.name] = null; }
  return lyricsCache[t.name];
}
function lyricFontFor(t){
  return design.perSong[t.name] || design.lyricsFont;
}
async function openLyrics(){
  if(cur < 0){
    const first = tracks.findIndex(t=> t.playable);
    if(first >= 0) select(first, false);   // 再生はせず、曲だけ選んで歌詞を出す
  }
  const t = tracks[cur]; if(!t) return;
  $('lyricsTitle').textContent = t.name;
  const body = $('lyricsBody');
  body.innerHTML = '<div class="lyrics__inner">読み込み中…</div>';
  $('lyrics').hidden = false;
  $('lyricsToggle').classList.add('is-active');

  const fontName = lyricFontFor(t);
  ensureFont(fontName);
  document.documentElement.style.setProperty('--font-lyrics', FONT_STACK[fontName]);

  const text = await loadLyrics(t);
  if(text == null){ body.innerHTML = '<p class="lyrics__empty">歌詞ファイルがありません。</p>'; return; }
  const inner = document.createElement('div');
  inner.className = 'lyrics__inner';
  text.replace(/\r\n?/g,'\n').split('\n').forEach(line=>{
    const p = document.createElement('p');
    if(line.trim()===''){ p.className='blank'; p.innerHTML='&nbsp;'; }
    else p.textContent = line;
    inner.appendChild(p);
  });
  body.innerHTML=''; body.appendChild(inner);
  body.scrollTop = 0;
}
function closeLyrics(){
  $('lyrics').hidden = true;
  $('lyricsToggle').classList.remove('is-active');
}
function syncLyricsIfOpen(){ if(!$('lyrics').hidden) openLyrics(); }

/* ---------- 共有 ---------- */
function linkFor(t){
  const base = location.origin + location.pathname;
  return t ? base + '?t=' + encodeURIComponent(t.name) : base;
}
async function share(){
  const t = (cur >= 0) ? tracks[cur] : null;
  const url = linkFor(t);
  const title = manifest.album + (t ? ' / ' + t.name : '');
  if(navigator.share){
    try{ await navigator.share({title, url}); return; }catch(_){ /* キャンセル時は下へ */ }
  }
  try{
    await navigator.clipboard.writeText(url);
    showToast(t ? 'この曲のリンクをコピーしました' : 'アルバムのリンクをコピーしました');
  }catch(_){
    showToast(url);
  }
}

let toastTimer = 0;
function showToast(msg){
  const el = $('toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> el.hidden = true, 2600);
}

/* ---------- ループ／シャッフル ---------- */
function cycleLoop(){
  loopMode = (loopMode + 1) % 3;
  const b = $('loop'), use = b.querySelector('use');
  const labels = ['ループ：オフ','アルバムをループ','この曲をループ'];
  use.setAttribute('href', loopMode===2 ? '#i-loop1' : '#i-loop');
  b.classList.toggle('is-active', loopMode!==0);
  b.setAttribute('aria-label', labels[loopMode]);
  b.title = labels[loopMode];
}
function toggleShuffle(){
  shuffleOn = !shuffleOn;
  const b = $('shuffle');
  b.setAttribute('aria-pressed', String(shuffleOn));
  b.classList.toggle('is-active', shuffleOn);
  rebuildOrder();
  showToast(shuffleOn ? 'シャッフル：オン' : 'シャッフル：オフ');
}

/* ---------- イベント結線 ---------- */
function bindUI(){
  const on = (id, ev, fn)=>{ const el = $(id); if(el) el.addEventListener(ev, fn); };

  on('playAll','click', ()=>{
    if(cur >= 0 && isPlaying){ pause(); } else if(cur >= 0){ play(); } else { playAll(); }
  });
  on('shuffle','click', toggleShuffle);
  on('loop','click', cycleLoop);
  on('share','click', share);

  on('play','click', togglePlay);
  on('next','click', ()=> next(false));
  on('prev','click', prev);
  on('lyricsToggle','click', ()=> $('lyrics').hidden ? openLyrics() : closeLyrics());
  on('lyricsClose','click', closeLyrics);

  // シーク（操作中は seeking=true にして、tick の上書きを止める）
  const seek = $('seek');
  if(seek){
    const previewSeek = ()=>{
      if(cur < 0) return;
      const sh = tracks[cur].shape;
      $('cur').textContent = fmt(seek.value/1000 * sh.eff);
      setSeek(seek.value);
    };
    const commitSeek = ()=>{
      if(cur < 0){ seeking = false; return; }
      const sh = tracks[cur].shape;
      const P = seek.value/1000 * sh.eff;
      setSeek(seek.value);
      seekToP(P, isPlaying);
      if(isPlaying) startRAF();
      seeking = false;
      seek.classList.remove('is-seeking');
    };
    const startSeek = ()=>{ seeking = true; seek.classList.add('is-seeking'); };
    seek.addEventListener('pointerdown', startSeek);
    seek.addEventListener('keydown', e=>{ if(/Arrow|Home|End|Page/.test(e.key)) startSeek(); });
    seek.addEventListener('input', ()=>{ seeking = true; seek.classList.add('is-seeking'); previewSeek(); });
    seek.addEventListener('change', commitSeek);
    seek.addEventListener('pointerup', ()=>{ if(seeking) commitSeek(); });
    seek.addEventListener('pointercancel', ()=>{ if(seeking) commitSeek(); });
  }

  // 音量（色のfillも更新）
  const vol = $('vol');
  if(vol){
    const applyVol = ()=>{
      audio.volume = parseFloat(vol.value);
      vol.style.setProperty('--vp', (vol.value*100)+'%');
    };
    vol.addEventListener('input', applyVol);
    applyVol();   // 初期fill
  }

  // キーボード
  document.addEventListener('keydown', e=>{
    if(/INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if(e.code === 'Space'){ e.preventDefault(); togglePlay(); }
    else if(e.code === 'ArrowRight' && cur>=0){ const sh=tracks[cur].shape; seekToP(Math.min(sh.eff, currentP()+5), isPlaying); if(isPlaying) startRAF(); }
    else if(e.code === 'ArrowLeft' && cur>=0){ seekToP(Math.max(0, currentP()-5), isPlaying); if(isPlaying) startRAF(); }
    else if(e.key === 'Escape' && !$('lyrics').hidden){ closeLyrics(); }
  });
}

/* ---------- サービスワーカー（キャッシュ）---------- */
function registerSW(){
  if('serviceWorker' in navigator){
    window.addEventListener('load', ()=>{
      navigator.serviceWorker.register('sw.js').catch(err=> console.warn('SW登録失敗', err));
    });
  }
}
