'use strict';
/* Home Workout — all data stays in this browser (localStorage). No network calls, no tracking. */
const BASE = window.PLAN;
let P;
const KEY = 'homeWorkout.v1';
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const DEFAULTS = () => ({version: 1, sessions: [], bodyweight: [], draft: null,
  sync: {url: '', key: '', lastOk: null, lastErr: null, sig: ''}, tomb: {sessions: [], bw: []}, remotePlan: null, remoteSig: '',
  settings: {restMode: 'exercise', restFixed: 90, sound: true, vibrate: true, steadyMin: 5, intervalRounds: 5, hardSec: 30, easySec: 60, unit: 'lb'}});

let S = load();
function load() {
  try { const d = JSON.parse(localStorage.getItem(KEY)); if (d && d.version) return normalize(d); } catch (e) {}
  return DEFAULTS();
}
function normalize(d) {
  const b = DEFAULTS();
  return {...b, ...d, settings: {...b.settings, ...(d.settings || {})},
    sessions: Array.isArray(d.sessions) ? d.sessions : [], bodyweight: Array.isArray(d.bodyweight) ? d.bodyweight : [],
    sync: {...b.sync, ...(d.sync || {})}, tomb: {sessions: [], bw: [], ...(d.tomb || {})}};
}
function save() { localStorage.setItem(KEY, JSON.stringify(S)); scheduleSync(); }

/* ---------- plan: built-in guide, optionally overridden by the trainer's Plan sheet ---------- */
const truthy = v => v === true || /^(y|yes|true|1|x)$/i.test(String(v).trim());
function buildPlan() {
  const base = JSON.parse(JSON.stringify(BASE)); base.coachNote = '';
  const rp = S.remotePlan; if (!rp) return base;
  base.coachNote = (rp.settings && rp.settings.coach_note) || '';
  if (!Array.isArray(rp.exercises) || !rp.exercises.length) return base;
  base.remotePlanActive = true;
  const lib = {}; Object.values(base.days).forEach(d => d.ex.forEach(e => lib[e.id] = e));
  for (const k of Object.keys(base.days)) {
    const rows = rp.exercises.filter(r => String(r.day).trim().toLowerCase() === k && !(r.active !== '' && r.active != null && !truthy(r.active)))
      .sort((a, b) => (+a.order || 0) - (+b.order || 0));
    if (!rows.length) continue;
    base.days[k].ex = rows.map(r => {
      const id = String(r.exercise_id || r.name || 'ex').trim();
      const e = {...(lib[id] || {id, name: id, caps: ['', ''], cues: [], start: '', end: '', load: 'bw', rest: 60, unit: 'reps', perSide: false, sets: 3, lo: 10, hi: 10})};
      if (r.name) e.name = String(r.name);
      if (+r.sets) e.sets = +r.sets;
      if (+r.rep_low) { e.lo = +r.rep_low; e.hi = +r.rep_high || e.lo; }
      if (r.unit) e.unit = /^s/i.test(r.unit) ? 's' : 'reps';
      if (r.per_side !== '' && r.per_side != null) e.perSide = truthy(r.per_side);
      if (r.load) e.load = /^d/i.test(r.load) ? 'db' : 'bw';
      e.target = +r.target_lb > 0 ? +r.target_lb : null;
      if (+r.rest_s) e.rest = +r.rest_s;
      if (r.cues) e.cues = String(r.cues).split('|').map(x => x.trim()).filter(Boolean);
      e.label = `${e.sets} × ${e.lo}${e.hi !== e.lo ? '–' + e.hi : ''}${e.unit === 's' ? ' s' : ''}${e.perSide ? ' each side' : ''}`;
      return e;
    });
  }
  return base;
}
P = buildPlan();

/* ---------- sync with Evan's Google Sheet via his Apps Script web app ---------- */
let syncTimer = null, syncing = false;
const dataSig = () => JSON.stringify([S.sessions, S.bodyweight, S.tomb]);
function scheduleSync(force) {
  if (!S.sync.url) return;
  if (!force && dataSig() === S.sync.sig) return;
  clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(), force ? 0 : 2500);
}
async function sync(manual) {
  if (!S.sync.url || syncing) return;
  if (!navigator.onLine) { if (manual) toast('Offline — will sync when back online'); return; }
  syncing = true;
  const sig = dataSig();
  try {
    const res = await fetch(S.sync.url, {method: 'POST', headers: {'Content-Type': 'text/plain;charset=utf-8'}, redirect: 'follow',
      body: JSON.stringify({action: 'push', key: S.sync.key, sessions: S.sessions, deletedSessions: S.tomb.sessions, bodyweight: S.bodyweight, deletedBodyweight: S.tomb.bw, client: 'app-v2'})});
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'sync failed');
    let changed = false;
    const sent = new Set(S.tomb.sessions), sentBw = new Set(S.tomb.bw);
    const have = new Set(S.sessions.map(x => x.id));
    (d.sessions || []).forEach(x => { if (x && x.id && !have.has(x.id) && !sent.has(x.id)) { S.sessions.push(x); changed = true; } });
    const bwHave = new Set(S.bodyweight.map(x => x.date));
    (d.bodyweight || []).forEach(x => { if (x && x.date && !bwHave.has(x.date) && !sentBw.has(x.date)) { S.bodyweight.push({date: x.date, lb: +x.lb}); changed = true; } });
    S.tomb.sessions = S.tomb.sessions.filter(id => !sent.has(id)); S.tomb.bw = S.tomb.bw.filter(x => !sentBw.has(x));
    if (d.plan) {
      const rs = JSON.stringify(d.plan);
      if (rs !== S.remoteSig) {
        S.remoteSig = rs; S.remotePlan = d.plan; changed = true;
        const st = d.plan.settings || {}, map = {steady_min: 'steadyMin', interval_rounds: 'intervalRounds', hard_s: 'hardSec', easy_s: 'easySec', rest_fixed_s: 'restFixed'};
        Object.entries(map).forEach(([a, b]) => { if (+st[a] > 0) S.settings[b] = +st[a]; });
        if (st.rest_mode === 'fixed' || st.rest_mode === 'exercise') S.settings.restMode = st.rest_mode;
        P = buildPlan();
      }
    }
    S.sync.lastOk = new Date().toISOString(); S.sync.lastErr = null; S.sync.sig = dataSig();
    localStorage.setItem(KEY, JSON.stringify(S));
    if (changed && !(S.draft && tab === 'workout')) render();
    else if (tab === 'settings') render();
  } catch (e) {
    S.sync.lastErr = (e && e.message) || String(e); localStorage.setItem(KEY, JSON.stringify(S));
    if (manual) toast('Sync failed: ' + S.sync.lastErr);
  } finally { syncing = false; if (dataSig() !== S.sync.sig && !S.sync.lastErr) scheduleSync(); }
}
window.addEventListener('online', () => sync());
setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 10 * 60 * 1000);
(function setupFromHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('sync')) {
    S.sync.url = h.get('sync'); S.sync.key = h.get('key') || ''; S.sync.sig = ''; localStorage.setItem(KEY, JSON.stringify(S));
    history.replaceState(null, '', location.pathname + location.search);
    setTimeout(() => toast('Sync connected to your Google Sheet'), 300);
  }
})();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const fmtDate = iso => new Date(iso + 'T12:00:00').toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric'});
const fmtShort = iso => new Date(iso + 'T12:00:00').toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5);
const mmss = s => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const allEx = () => Object.values(P.days).flatMap(d => d.ex.map(e => ({...e, day: d.key})));
const exById = id => allEx().find(e => e.id === id);
const sorted = () => [...S.sessions].sort((a, b) => (a.date + (a.finishedAt || '')).localeCompare(b.date + (b.finishedAt || '')));

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 2200); }
function setAccent(key) {
  const d = P.days[key] || P.days.a;
  document.documentElement.style.setProperty('--ac', d.accent);
  document.documentElement.style.setProperty('--soft', d.soft);
  $('meta[name=theme-color]').setAttribute('content', d.accent);
}

/* ---------- logic ---------- */
function nextDay() {
  const s = sorted(); if (!s.length) return 'a';
  return s[s.length - 1].day === 'a' ? 'b' : 'a';
}
function lastPerf(exId) {
  const s = sorted().reverse();
  for (const ses of s) { const e = ses.ex.find(x => x.id === exId); if (e && e.sets.some(x => x.done)) return {ses, e}; }
  return null;
}
function progression(ex) {
  const lp = lastPerf(ex.id); if (!lp) return null;
  const done = lp.e.sets.filter(x => x.done);
  const allDone = done.length >= ex.sets;
  const topHit = allDone && done.every(x => Number(x.reps) >= ex.hi);
  const lastW = Math.max(0, ...done.map(x => Number(x.w) || 0));
  const unit = ex.unit === 's' ? ' s' : ' reps';
  const when = fmtShort(lp.ses.date);
  if (topHit) {
    if (ex.load === 'db' || lastW > 0) return {up: true, w: lastW + 5, text: `Last time (${when}) every set hit ${ex.hi}${unit}${lastW ? ' at ' + lastW + ' lb' : ''}. Try ${lastW + 5} lb today.`};
    if (ex.unit === 's') return {up: true, w: 0, text: `Last time (${when}) you held ${ex.hi} s every set. Try ${ex.hi + 5} s, or make it a bit harder.`};
    return {up: true, w: 0, text: `Last time (${when}) every set hit ${ex.hi} reps. Make it harder: harder band or a tougher angle.`};
  }
  const best = done.map(x => `${x.w ? x.w + '×' : ''}${x.reps || '–'}`).join(', ');
  return {up: false, w: lastW, text: `Last time (${when}): ${best || 'no sets logged'}. Same weight — aim for ${ex.hi}${unit} on every set.`};
}
function restFor(ex) { return S.settings.restMode === 'fixed' ? Number(S.settings.restFixed) || 90 : ex.rest; }
function weekInfo() {
  const s = sorted(); if (!s.length) return {week: 1, first: null};
  const d = daysBetween(s[0].date, today()); return {week: Math.floor(d / 7) + 1, first: s[0].date, fortnights: Math.floor(d / 14)};
}
function newDraft(day) {
  const d = P.days[day];
  return {id: 's' + Date.now(), day, date: today(), startedAt: new Date().toISOString(), warm: P.warm.map(() => false), cool: P.cool.map(() => false),
    finisher: false, notes: '', ex: d.ex.map(e => {
      const pr = progression(e);
      const w = e.target ? String(e.target) : (pr && pr.w ? String(pr.w) : '');
      return {id: e.id, sets: Array.from({length: e.sets}, () => ({w, reps: '', done: false}))};
    })};
}

/* ---------- audio / vibration ---------- */
let AC = null;
function unlockAudio() { try { AC = AC || new (window.AudioContext || window.webkitAudioContext)(); if (AC.state === 'suspended') AC.resume(); } catch (e) {} }
document.addEventListener('pointerdown', unlockAudio, {passive: true});
function beep(times = 3, freq = 880, dur = 0.18) {
  if (S.settings.sound && AC) {
    for (let i = 0; i < times; i++) {
      const o = AC.createOscillator(), g = AC.createGain(), t = AC.currentTime + i * (dur + 0.12);
      o.type = 'sine'; o.frequency.value = freq; o.connect(g); g.connect(AC.destination);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.6, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.start(t); o.stop(t + dur + 0.02);
    }
  }
  if (S.settings.vibrate && navigator.vibrate) navigator.vibrate(Array.from({length: times * 2 - 1}, (_, i) => i % 2 ? 120 : 250));
}

/* ---------- wake lock (keep screen on during a session) ---------- */
let wake = null;
async function keepAwake(on) {
  try {
    if (on && !wake && 'wakeLock' in navigator) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => wake = null); }
    if (!on && wake) { await wake.release(); wake = null; }
  } catch (e) {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.draft) keepAwake(true); tick(); });

/* ---------- timer engine (phases; based on wall clock so it survives the screen locking) ---------- */
let T = null; // {phases:[{label,sec,cls}], i, end, paused, left, onDone}
function startTimer(phases, onDone) {
  unlockAudio();
  T = {phases, i: 0, end: Date.now() + phases[0].sec * 1000, paused: false, left: 0, onDone};
  $('#timer').classList.remove('hidden'); document.body.classList.add('timing'); $('#tPause').textContent = 'Pause';
  tick();
}
function stopTimer() { T = null; $('#timer').classList.add('hidden'); $('#timer').className = 'timer hidden'; document.body.classList.remove('timing'); }
function tick() {
  if (!T) return;
  const ph = T.phases[T.i];
  let left = T.paused ? T.left : (T.end - Date.now()) / 1000;
  if (!T.paused && left <= 0) {
    if (T.i < T.phases.length - 1) {
      const over = -left; T.i++; const np = T.phases[T.i]; T.end = Date.now() + (np.sec - over) * 1000;
      beep(np.cls === 'hard' ? 2 : 1, np.cls === 'hard' ? 990 : 660, 0.25); return tick();
    }
    beep(3); const cb = T.onDone; const el = $('#timer'); el.classList.add('doneflash');
    $('#tTime').textContent = '0:00'; $('#tLabel').textContent = 'Time! ' + (ph.doneText || 'Go');
    T = null; setTimeout(() => { if (!T) stopTimer(); }, 2500); if (cb) cb(); return;
  }
  const el = $('#timer'); el.className = 'timer' + (ph.cls ? ' ' + ph.cls : '');
  $('#tLabel').textContent = ph.label;
  $('#tTime').textContent = mmss(left);
  $('#tFill').style.width = (100 * (1 - left / ph.sec)) + '%';
}
setInterval(tick, 250);
$('#timer').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || !T) { if (b && b.dataset.t === 'stop') stopTimer(); return; }
  const a = b.dataset.t;
  if (a === 'stop') return stopTimer();
  if (a === 'pause') { if (T.paused) { T.end = Date.now() + T.left * 1000; T.paused = false; b.textContent = 'Pause'; } else { T.left = (T.end - Date.now()) / 1000; T.paused = true; b.textContent = 'Resume'; } return tick(); }
  const d = parseInt(a, 10);
  if (T.paused) T.left = Math.max(1, T.left + d); else T.end = Math.max(Date.now() + 1000, T.end + d * 1000);
  T.phases[T.i].sec = Math.max(T.phases[T.i].sec + d, 1); tick();
});
function restTimer(ex, next) { const s = restFor(ex); startTimer([{label: next ? `Rest · then set ${next} of ${ex.sets}` : 'Rest · ' + ex.name, sec: s, doneText: next ? `Set ${next}` : 'Next set'}]); }
function holdTimer(ex, sec) { startTimer([{label: 'Get set', sec: 5, cls: 'easy'}, {label: 'Hold — ' + ex.name, sec, cls: 'hard', doneText: 'Done, step down'}]); }
function finisherTimer(day) {
  const st = S.settings;
  if (day === 'a') return startTimer([{label: 'Steady row', sec: st.steadyMin * 60, doneText: 'Finisher done'}], () => markFin());
  const ph = []; for (let r = 1; r <= st.intervalRounds; r++) { ph.push({label: `HARD · round ${r} of ${st.intervalRounds}`, sec: st.hardSec, cls: 'hard'}); ph.push({label: `Easy · round ${r} of ${st.intervalRounds}`, sec: st.easySec, cls: 'easy', doneText: 'Finisher done'}); }
  startTimer([{label: 'Get ready', sec: 5}].concat(ph), () => markFin());
}
function markFin() { if (S.draft) { S.draft.finisher = true; save(); const c = $('#finChk'); if (c) c.checked = true; } }

/* ---------- views ---------- */
let tab = 'workout', previewDay = null;
function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const v = $('#view');
  setAccent(S.draft ? S.draft.day : (previewDay || nextDay()));
  ({workout: viewWorkout, history: viewHistory, progress: viewProgress, body: viewBody, settings: viewSettings}[tab])(v);
}
function figs(e) {
  if (!e.start) return '<div style="height:6px"></div>';
  return `<div class="figs"><div class="fig">${e.start}<div class="cap"><b>Start</b>${esc(e.caps[0])}</div></div><div class="arrow">➜</div><div class="fig">${e.end}<div class="cap"><b>End</b>${esc(e.caps[1])}</div></div></div>`;
}
/* ---------- How-to sheet & full-day guide ---------- */
let sheetOpen = false;
function openSheet(title, html) {
  $('#shTitle').textContent = title; $('#shBody').innerHTML = html; $('#shBody').scrollTop = 0;
  $('#sheet').classList.remove('hidden'); document.body.classList.add('noscroll');
  if (!sheetOpen) { history.pushState({sheet: 1}, ''); sheetOpen = true; }
  $('#shClose').focus({preventScroll: true});
}
function closeSheet(fromPop) {
  if (!sheetOpen) return; sheetOpen = false;
  $('#sheet').classList.add('hidden'); document.body.classList.remove('noscroll');
  if (!fromPop) history.back();
}
window.addEventListener('popstate', () => closeSheet(true));
$('#shClose').onclick = () => closeSheet();
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
function findEx(id) { for (const D of Object.values(P.days)) { const e = D.ex.find(x => x.id === id); if (e) return {e, D}; } return null; }
function howTo(id) {
  const f = findEx(id); if (!f) return; const {e, D} = f, st = S.settings;
  const pr = progression(e);
  let h = `<div class="ex-meta" style="margin:0 0 10px"><span class="badge">${esc(e.label)}</span><span class="pill">Rest ${restFor(e)} s</span><span class="pill">${e.load === 'db' ? 'Dumbbell' : 'Bodyweight / band'}</span>${e.target ? `<span class="pill">Target ${e.target} lb</span>` : ''}</div>`;
  if (e.start) h += `<div class="bigfig">${e.start}<div class="cap"><b>1 · Start</b>${esc(e.caps[0])}</div></div><div class="bigfig">${e.end}<div class="cap"><b>2 · End</b>${esc(e.caps[1])}</div></div>`;
  if (e.cues.length) h += `<h3 style="margin:4px 2px 8px">How to do it</h3><ol class="steps2">${e.cues.map(c => `<li>${esc(c)}</li>`).join('')}</ol>`;
  if (pr) h += `<div class="hint${pr.up ? ' ok' : ''}" style="margin-top:10px">${esc(pr.text)}</div>`;
  h += `<p class="mut" style="margin:10px 2px">${e.unit === 's' ? 'Hold steady and keep breathing.' : 'Move slowly on the way down (about 2 s), then up with control.'} Weeks 1–2: stop with 3 reps left in the tank.</p>`;
  h += `<button class="btn alt" data-guide="${D.key}" style="margin-bottom:6px">📄 See the full ${esc(D.title)} guide</button>`;
  openSheet(e.name, h);
}
function fullGuide(key) {
  const D = P.days[key];
  openSheet(`${D.title} guide`, `<p class="mut" style="margin:0 2px 8px">Pinch to zoom, or open the image on its own. Saved for offline use.</p>
    <img class="guideimg" src="guides/day_${key}.png" alt="${esc(D.title)} printable guide with illustrations for every exercise">
    <div class="grid2" style="margin-top:10px"><a class="btn ghost" style="text-align:center;text-decoration:none" href="guides/day_${key}.png" target="_blank" rel="noopener">Open image</a><a class="btn ghost" style="text-align:center;text-decoration:none" href="guides/day_${key}.pdf" target="_blank" rel="noopener">Open PDF</a></div>
    ${P.remotePlanActive ? '<p class="mut" style="margin:10px 2px">Note: your coach has adjusted the plan since this guide was drawn — the app screens show the current version.</p>' : ''}`);
}
document.addEventListener('click', e => {
  const h = e.target.closest('[data-how]'); if (h) { e.preventDefault(); return howTo(h.dataset.how); }
  const g = e.target.closest('[data-guide]'); if (g) { e.preventDefault(); return fullGuide(g.dataset.guide); }
});

function cues(e, open) { return `<details class="cues"${open ? ' open' : ''}><summary>Form cues ▾</summary><ul class="cl">${e.cues.map(c => `<li>${esc(c)}</li>`).join('')}</ul></details>`; }

function viewWorkout(v) {
  if (S.draft) return viewSession(v);
  const nd = nextDay(), day = previewDay || nd, D = P.days[day], s = sorted(), last = s[s.length - 1], wi = weekInfo();
  $('#title').textContent = 'Workout'; $('#sub').textContent = '';
  let h = `<div class="card hero"><div class="k">${day === nd ? 'Up next' : 'Preview'}${last ? ' · last workout ' + (daysBetween(last.date, today()) === 0 ? 'today' : daysBetween(last.date, today()) + ' days ago') : ''}</div>
    <h2>${D.title}</h2><p>~30 min · warm-up, ${D.ex.length} exercises, rower finisher, cool-down.${s.length ? ` Week ${wi.week} · ${s.length} session${s.length > 1 ? 's' : ''} done.` : ' First session — welcome!'}</p>
    <button class="btn" id="start">Start ${D.title}</button><button class="btn alt" data-guide="${day}" style="margin-top:8px">📄 Full ${D.title} guide</button></div>
    <div class="seg"><button data-pd="a" class="${day === 'a' ? 'on' : ''}">Day A</button><button data-pd="b" class="${day === 'b' ? 'on' : ''}">Day B</button></div>`;
  if (P.coachNote) h += `<div class="hint">📋 Coach: ${esc(P.coachNote)}</div>`;
  if (!s.length || wi.week <= 2) h += `<div class="hint ok">Weeks 1–2: learn the movements. Stop every set while you could still do 3 more reps.</div>`;
  h += `<div class="card"><div class="row sp"><span class="tag">Warm-up</span><span class="pill">5 min</span></div><ul class="cl" style="margin-top:8px">${P.warm.map(w => `<li><b>${esc(w[0])}</b> — ${esc(w[1])}</li>`).join('')}</ul></div>`;
  D.ex.forEach((e, i) => {
    const pr = progression(e);
    h += `<div class="card"><div class="ex-top"><div class="num">${i + 1}</div><h3>${esc(e.name)}</h3><div class="badge">${esc(e.label)}</div></div><div class="ex-meta"><button class="howbtn" data-how="${esc(e.id)}">ⓘ How to</button></div>${figs(e)}${pr ? `<div class="hint${pr.up ? ' ok' : ''}">${esc(pr.text)}</div>` : ''}${e.target ? `<div class="hint ok">Coach target: ${e.target} lb</div>` : ''}${cues(e, false)}</div>`;
  });
  h += finCard(D, false) + coolCard(false) + rulesCard();
  v.innerHTML = h;
  $('#start').onclick = () => { S.draft = newDraft(day); previewDay = null; save(); keepAwake(true); unlockAudio(); render(); scrollTo(0, 0); };
  v.querySelectorAll('[data-pd]').forEach(b => b.onclick = () => { previewDay = b.dataset.pd; render(); });
}
function finCard(D, live) {
  const st = S.settings, wi = weekInfo();
  const sug = wi.fortnights ? (D.key === 'a' ? `Plan: +1 min every 2 weeks — try ${5 + wi.fortnights} min.` : `Plan: +1 min every 2 weeks — try ${5 + wi.fortnights} rounds (each round is 1.5 min).`) : '';
  const t = D.key === 'a' ? `${st.steadyMin} min steady` : `${st.intervalRounds} × (${st.hardSec}s hard / ${st.easySec}s easy)`;
  return `<div class="card"><div class="row sp"><span class="tag">Finisher</span><span class="pill">rower · ${t}</span></div><h3 style="margin-top:6px">${esc(D.finisher.title)}</h3><p class="mut" style="margin:2px 0 8px">${esc(D.finisher.note)}</p>${sug ? `<div class="hint">${sug} (change it under More)</div>` : ''}
    ${live ? `<button class="btn" id="finGo">▶ Start finisher timer</button><label class="ck" style="margin-top:8px"><input type="checkbox" id="finChk" ${S.draft.finisher ? 'checked' : ''}>Finisher done</label>` : ''}</div>`;
}
function coolCard(live) {
  return `<div class="card"><div class="row sp"><span class="tag">Cool-down</span><span class="pill">3 min · foam roll</span></div><div class="list" style="margin-top:8px">${P.cool.map((c, i) => live
    ? `<label class="ck"><input type="checkbox" data-cool="${i}" ${S.draft.cool[i] ? 'checked' : ''}><span>${esc(c[0])}<small>${esc(c[1])}</small></span></label>`
    : `<div class="ck"><span>${esc(c[0])}<small>${esc(c[1])}</small></span></div>`).join('')}</div></div>`;
}
function rulesCard() { return `<div class="card"><span class="tag">How to progress</span><ul class="cl" style="margin-top:8px">${P.rules.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>`; }

function viewSession(v) {
  const dr = S.draft, D = P.days[dr.day];
  $('#title').textContent = D.title; $('#sub').textContent = 'in progress · ' + fmtDate(dr.date);
  const doneSets = dr.ex.reduce((n, e) => n + e.sets.filter(s => s.done).length, 0), totalSets = dr.ex.reduce((n, e) => n + e.sets.length, 0);
  let h = `<div class="card"><div class="row sp"><h3>${doneSets} / ${totalSets} sets done</h3><button class="btn sm ghost" id="cancel">Discard</button></div>
    <p class="mut" style="margin-top:4px">Tick ✓ after each set — the rest timer starts automatically. Tap <b>ⓘ How to</b> on any exercise for the illustrated steps.</p>
    <button class="btn ghost sm" data-guide="${dr.day}" style="margin-top:8px">📄 Full ${D.title} guide</button></div>`;
  h += `<div class="card"><div class="row sp"><span class="tag">Warm-up</span><span class="pill">5 min</span></div><div class="list" style="margin-top:8px">${P.warm.map((w, i) => `<label class="ck"><input type="checkbox" data-warm="${i}" ${dr.warm[i] ? 'checked' : ''}><span>${esc(w[0])}<small>${esc(w[1])}</small></span></label>`).join('')}</div>
    <button class="btn ghost sm" id="warmRow" style="margin-top:8px">▶ 3-min easy row timer</button></div>`;
  D.ex.forEach((e, i) => {
    const le = dr.ex[i], pr = progression(e), isS = e.unit === 's';
    const target = isS ? `${e.lo}${e.hi !== e.lo ? '–' + e.hi : ''} s` : `${e.lo}${e.hi !== e.lo ? '–' + e.hi : ''}${e.perSide ? '/side' : ''}`;
    h += `<div class="card" id="ex-${e.id}"><div class="ex-top"><div class="num">${i + 1}</div><h3>${esc(e.name)}</h3><button class="howbtn" data-how="${esc(e.id)}" aria-label="How to do ${esc(e.name)}">ⓘ How to</button></div><div class="ex-meta"><span class="badge">${esc(e.label)}</span><span class="pill">rest ${restFor(e)} s</span></div>${figs(e)}
      ${pr ? `<div class="hint${pr.up ? ' ok' : ''}">${esc(pr.text)}</div>` : ''}${e.target ? `<div class="hint ok">Coach target: ${e.target} lb</div>` : ''}${cues(e, i === 0 && !sorted().length)}
      <div class="sets"><div class="sethead"><span>Set</span><span>${e.load === 'db' ? 'lb (each)' : 'lb / band'}</span><span>${isS ? 'seconds' : 'reps' + (e.perSide ? '/side' : '')}</span><span></span></div>
      ${le.sets.map((s, j) => `<div class="set${s.done ? ' done' : ''}" data-ex="${i}" data-set="${j}"><span class="n">${j + 1}</span>
        <input inputmode="decimal" data-f="w" value="${esc(s.w)}" placeholder="${e.load === 'db' ? 'lb' : 'BW'}" aria-label="weight set ${j + 1}">
        <input inputmode="numeric" data-f="reps" value="${esc(s.reps)}" placeholder="${target}" aria-label="${isS ? 'seconds' : 'reps'} set ${j + 1}">
        <button class="chk" data-f="done" aria-label="set ${j + 1} done">✓</button></div>`).join('')}</div>
      <div class="row sp" style="margin-top:8px"><span class="mut">Rest ${restFor(e)} s between sets</span>${isS ? `<button class="holdbtn" data-hold="${i}">▶ ${e.hi} s hold timer</button>` : `<button class="holdbtn" data-rest="${i}">▶ Rest timer</button>`}</div></div>`;
  });
  h += finCard(D, true) + coolCard(true);
  h += `<div class="card"><label class="f" for="notes" style="margin-top:0">Notes (how it felt, pain, band colour…)</label><textarea id="notes">${esc(dr.notes)}</textarea>
    <label class="f" for="sdate">Date</label><input type="date" id="sdate" value="${esc(dr.date)}"></div>
    <button class="btn" id="finish" style="margin-bottom:16px">Finish & save session</button>`;
  v.innerHTML = h;

  v.querySelectorAll('[data-warm]').forEach(c => c.onchange = () => { dr.warm[c.dataset.warm] = c.checked; save(); });
  v.querySelectorAll('[data-cool]').forEach(c => c.onchange = () => { dr.cool[c.dataset.cool] = c.checked; save(); });
  $('#finChk').onchange = e => { dr.finisher = e.target.checked; save(); };
  $('#finGo').onclick = () => finisherTimer(dr.day);
  $('#warmRow').onclick = () => startTimer([{label: 'Easy row warm-up', sec: 180, doneText: 'Warm-up row done'}]);
  $('#notes').oninput = e => { dr.notes = e.target.value; save(); };
  $('#sdate').onchange = e => { if (e.target.value) { dr.date = e.target.value; save(); } };
  v.querySelectorAll('[data-hold]').forEach(b => b.onclick = () => holdTimer(D.ex[b.dataset.hold], D.ex[b.dataset.hold].hi));
  v.querySelectorAll('[data-rest]').forEach(b => b.onclick = () => restTimer(D.ex[b.dataset.rest]));
  v.querySelectorAll('.set').forEach(row => {
    const i = +row.dataset.ex, j = +row.dataset.set, s = dr.ex[i].sets[j], e = D.ex[i];
    row.querySelectorAll('input').forEach(inp => inp.oninput = () => { s[inp.dataset.f] = inp.value.trim(); save(); });
    row.querySelector('.chk').onclick = () => {
      s.done = !s.done;
      if (s.done && !s.reps) { s.reps = String(e.unit === 's' ? e.hi : e.lo); row.querySelector('[data-f=reps]').value = s.reps; }
      if (s.done && j < dr.ex[i].sets.length - 1) { const nx = dr.ex[i].sets[j + 1]; if (!nx.w && s.w) { nx.w = s.w; row.nextElementSibling.querySelector('[data-f=w]').value = s.w; } }
      row.classList.toggle('done', s.done); save();
      const n = dr.ex.reduce((a, x) => a + x.sets.filter(y => y.done).length, 0); v.querySelector('.card h3').textContent = `${n} / ${totalSets} sets done`;
      if (s.done) {
        const lastOfEx = j === dr.ex[i].sets.length - 1;
        if (!lastOfEx) restTimer(e, j + 2);
        else if (i < D.ex.length - 1) { startTimer([{label: 'Rest · next: ' + D.ex[i + 1].name, sec: restFor(e), doneText: 'Next exercise'}]); }
        else toast('Last set done — time for the finisher!');
      }
    };
  });
  $('#cancel').onclick = () => { if (confirm('Discard this session? Nothing will be saved.')) { S.draft = null; save(); stopTimer(); keepAwake(false); render(); } };
  $('#finish').onclick = () => {
    const n = dr.ex.reduce((a, x) => a + x.sets.filter(y => y.done).length, 0);
    if (!n && !confirm('No sets are ticked. Save anyway?')) return;
    dr.finishedAt = new Date().toISOString(); S.sessions.push(dr); S.draft = null; save(); stopTimer(); keepAwake(false);
    toast('Session saved 💪'); tab = 'history'; render(); scrollTo(0, 0);
  };
}

function sessionSummary(ses) {
  const D = P.days[ses.day];
  return ses.ex.map(le => {
    const e = D.ex.find(x => x.id === le.id) || exById(le.id); if (!e) return '';
    const sets = le.sets.filter(s => s.done);
    return `<div class="row sp" style="font-size:14px;padding:2px 0"><span>${esc(e.name)}</span><span class="mut">${sets.length ? sets.map(s => (s.w ? s.w + '×' : '') + (s.reps || '?') + (e.unit === 's' ? 's' : '')).join(', ') : 'skipped'}</span></div>`;
  }).join('');
}
function viewHistory(v) {
  $('#title').textContent = 'History'; $('#sub').textContent = `${S.sessions.length} session${S.sessions.length === 1 ? '' : 's'}`;
  const s = sorted().reverse();
  if (!s.length) { v.innerHTML = `<div class="card empty">No sessions yet.<br>Finish a workout and it will show up here.</div>`; return; }
  const last30 = s.filter(x => daysBetween(x.date, today()) < 30).length;
  const thisWeek = s.filter(x => daysBetween(x.date, today()) < 7).length;
  let h = `<div class="grid2" style="margin-bottom:12px"><div class="stat"><b>${thisWeek}</b><span>last 7 days (goal 2)</span></div><div class="stat"><b>${last30}</b><span>last 30 days</span></div></div><div class="card">`;
  s.forEach(ses => {
    const D = P.days[ses.day], n = ses.ex.reduce((a, x) => a + x.sets.filter(y => y.done).length, 0);
    const mins = ses.finishedAt && ses.startedAt ? Math.round((new Date(ses.finishedAt) - new Date(ses.startedAt)) / 6e4) : null;
    h += `<details class="hist"><summary class="row sp" style="list-style:none;cursor:pointer"><span><b style="color:${D.accent}">${D.title}</b> · ${fmtDate(ses.date)}</span><span class="mut">${n} sets${mins && mins < 240 ? ' · ' + mins + ' min' : ''}${ses.finisher ? ' · ✓ row' : ''}</span></summary>
      <div style="margin-top:6px">${sessionSummary(ses)}${ses.notes ? `<p style="font-size:14px;margin-top:6px;white-space:pre-wrap">📝 ${esc(ses.notes)}</p>` : ''}
      <button class="btn sm danger" data-del="${esc(ses.id)}" style="margin-top:8px">Delete session</button></div></details>`;
  });
  v.innerHTML = h + '</div>';
  v.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { if (confirm('Delete this session?')) { S.sessions = S.sessions.filter(x => x.id !== b.dataset.del); S.tomb.sessions.push(b.dataset.del); save(); render(); } });
}

function chart(points, {color = '#2f6fdb', unit = '', goal = null} = {}) {
  const W = 340, H = 170, L = 38, R = 10, Tp = 12, B = 26;
  if (!points.length) return '';
  const xs = points.map(p => p.x), ys = points.map(p => p.y).concat(goal != null ? [goal] : []);
  let x0 = Math.min(...xs), x1 = Math.max(...xs); if (x0 === x1) { x0 -= 864e5 * 3; x1 += 864e5 * 3; }
  let y0 = Math.min(...ys), y1 = Math.max(...ys); const pad = Math.max((y1 - y0) * 0.12, 1); y0 -= pad; y1 += pad;
  const raw = (y1 - y0) / 3, mag = Math.pow(10, Math.floor(Math.log10(raw))), step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(v => v >= raw);
  y0 = Math.floor(y0 / step) * step; y1 = Math.ceil(y1 / step) * step; const nT = Math.round((y1 - y0) / step);
  const X = x => L + (x - x0) / (x1 - x0) * (W - L - R), Y = y => Tp + (1 - (y - y0) / (y1 - y0)) * (H - Tp - B);
  let g = '';
  for (let k = 0; k <= nT; k++) { const yv = y0 + step * k, yy = Y(yv); g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="#e3e7ee"/><text x="${L - 5}" y="${yy + 4}" font-size="10" text-anchor="end" fill="#5b6780">${+yv.toFixed(1)}</text>`; }
  const d0 = new Date(x0), d1 = new Date(x1), lab = d => d.toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
  g += `<text x="${L}" y="${H - 6}" font-size="10" fill="#5b6780">${lab(d0)}</text><text x="${W - R}" y="${H - 6}" font-size="10" text-anchor="end" fill="#5b6780">${lab(d1)}</text>`;
  if (goal != null) g += `<line x1="${L}" x2="${W - R}" y1="${Y(goal)}" y2="${Y(goal)}" stroke="#138a72" stroke-dasharray="4 4"/><text x="${W - R}" y="${Y(goal) - 4}" font-size="10" text-anchor="end" fill="#138a72">goal ${goal}</text>`;
  const path = points.map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ' ' + Y(p.y).toFixed(1)).join(' ');
  g += `<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>`;
  g += points.map(p => `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="3.5" fill="#fff" stroke="${color}" stroke-width="2"/>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="chart${unit ? ' in ' + unit : ''}">${g}</svg>`;
}
let progEx = null;
function viewProgress(v) {
  $('#title').textContent = 'Progress'; $('#sub').textContent = 'per exercise';
  const exs = allEx(); progEx = progEx || exs[0].id;
  const e = exById(progEx), s = sorted();
  const pts = [], vol = [];
  s.forEach(ses => { const le = ses.ex.find(x => x.id === e.id); if (!le) return; const d = le.sets.filter(x => x.done); if (!d.length) return;
    const t = new Date(ses.date + 'T12:00:00').getTime(), maxW = Math.max(...d.map(x => Number(x.w) || 0)), best = Math.max(...d.map(x => Number(x.reps) || 0));
    const tot = d.reduce((a, x) => a + (Number(x.reps) || 0) * ((Number(x.w) || 0) || 1), 0);
    pts.push({x: t, y: maxW > 0 ? maxW : best, w: maxW, best, date: ses.date, sets: d}); vol.push({x: t, y: tot}); });
  const useW = pts.some(p => p.w > 0);
  let h = `<div class="card"><label class="f" for="pex" style="margin-top:0">Exercise</label><select id="pex">${Object.values(P.days).map(D => `<optgroup label="${D.title}">${D.ex.map(x => `<option value="${x.id}" ${x.id === progEx ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>`).join('')}</select></div>`;
  if (!pts.length) h += `<div class="card empty">No logged sets for this exercise yet.</div>`;
  else {
    const pr = progression(e);
    h += `<div class="card"><h3>${useW ? 'Heaviest weight (lb)' : (e.unit === 's' ? 'Longest hold (s)' : 'Best reps')}</h3>${chart(pts.map(p => ({x: p.x, y: useW ? p.w : p.best})), {color: P.days[e.day].accent})}
      ${pr ? `<div class="hint${pr.up ? ' ok' : ''}">${esc(pr.text)}</div>` : ''}</div>
      <div class="card"><h3>${useW ? 'Total volume (lb × reps)' : 'Total ' + (e.unit === 's' ? 'seconds' : 'reps')}</h3>${chart(vol, {color: '#8f9bb3'})}</div>
      <div class="card"><h3>Log</h3>${pts.slice().reverse().map(p => `<div class="row sp" style="font-size:14px;padding:3px 0"><span>${fmtDate(p.date)}</span><span class="mut">${p.sets.map(x => (x.w ? x.w + '×' : '') + (x.reps || '?')).join(', ')}</span></div>`).join('')}</div>`;
  }
  v.innerHTML = h;
  $('#pex').onchange = ev => { progEx = ev.target.value; render(); };
}

function viewBody(v) {
  $('#title').textContent = 'Bodyweight'; $('#sub').textContent = '';
  const bw = [...S.bodyweight].sort((a, b) => a.date.localeCompare(b.date));
  const goal = S.settings.goalWeight ? Number(S.settings.goalWeight) : null;
  let h = `<div class="card"><h3>Log weight</h3><div class="grid2" style="margin-top:6px"><input type="number" inputmode="decimal" step="0.1" id="bwv" placeholder="lb" aria-label="weight in lb"><input type="date" id="bwd" value="${today()}"></div>
    <button class="btn" id="bwadd" style="margin-top:8px">Save</button><p class="mut" style="margin-top:6px">Tip: weigh in once a week, same time of day (e.g. Friday morning before breakfast).</p></div>`;
  if (bw.length) {
    const first = bw[0], last = bw[bw.length - 1], ch = (last.lb - first.lb);
    h += `<div class="grid2" style="margin-bottom:12px"><div class="stat"><b>${last.lb}</b><span>latest (${fmtShort(last.date)})</span></div><div class="stat"><b style="color:${ch <= 0 ? '#138a72' : '#c2410c'}">${ch > 0 ? '+' : ''}${ch.toFixed(1)}</b><span>since ${fmtShort(first.date)} (${first.lb})</span></div></div>`;
    if (bw.length > 1) h += `<div class="card"><h3>Trend (lb)</h3>${chart(bw.map(p => ({x: new Date(p.date + 'T12:00:00').getTime(), y: p.lb})), {color: '#2f6fdb', goal})}</div>`;
    h += `<div class="card"><h3>Entries</h3>${bw.slice().reverse().map(p => `<div class="row sp" style="padding:4px 0"><span>${fmtDate(p.date)}</span><span><b>${p.lb}</b> lb <button class="btn sm ghost" data-bwdel="${p.date}" style="margin-left:6px;padding:4px 8px">✕</button></span></div>`).join('')}</div>`;
  } else h += `<div class="card empty">Log your starting weight to begin the chart.</div>`;
  h += `<div class="card"><label class="f" for="goal" style="margin-top:0">Goal weight (optional, shown on chart)</label><input type="number" inputmode="decimal" id="goal" value="${esc(S.settings.goalWeight || '')}" placeholder="lb"></div>`;
  v.innerHTML = h;
  $('#bwadd').onclick = () => {
    const lb = parseFloat($('#bwv').value), date = $('#bwd').value || today();
    if (!(lb > 50 && lb < 800)) return toast('Enter a weight in lb');
    S.tomb.bw = S.tomb.bw.filter(x => x !== date); S.bodyweight = S.bodyweight.filter(x => x.date !== date).concat([{date, lb: Math.round(lb * 10) / 10}]); save(); toast('Saved'); render();
  };
  $('#goal').onchange = e => { S.settings.goalWeight = e.target.value ? parseFloat(e.target.value) : null; save(); render(); };
  v.querySelectorAll('[data-bwdel]').forEach(b => b.onclick = () => { if (confirm('Delete this entry?')) { S.bodyweight = S.bodyweight.filter(x => x.date !== b.dataset.bwdel); S.tomb.bw.push(b.dataset.bwdel); save(); render(); } });
}

function viewSettings(v) {
  $('#title').textContent = 'More'; $('#sub').textContent = 'settings & backup';
  const st = S.settings;
  v.innerHTML = `<div class="card"><h3>Rest timer</h3>
    <label class="f" for="rm">Rest between sets</label><select id="rm"><option value="exercise" ${st.restMode === 'exercise' ? 'selected' : ''}>Per exercise (60–90 s)</option><option value="fixed" ${st.restMode === 'fixed' ? 'selected' : ''}>Same for every exercise</option></select>
    <label class="f" for="rf">Fixed rest (seconds)</label><input type="number" inputmode="numeric" id="rf" value="${st.restFixed}" min="15" max="300">
    <label class="ck" style="margin-top:10px"><input type="checkbox" id="snd" ${st.sound ? 'checked' : ''}>Beep when time is up</label>
    <label class="ck" style="margin-top:6px"><input type="checkbox" id="vib" ${st.vibrate ? 'checked' : ''}>Vibrate (Android; iPhone doesn't allow it)</label>
    <button class="btn ghost sm" id="test" style="margin-top:8px">Test sound (5 s timer)</button></div>
    <div class="card"><h3>Rower finishers</h3>
    <label class="f" for="sm">Day A steady row (minutes)</label><input type="number" inputmode="numeric" id="sm" value="${st.steadyMin}" min="1" max="30">
    <div class="grid2"><div><label class="f" for="hs">Day B hard (s)</label><input type="number" inputmode="numeric" id="hs" value="${st.hardSec}"></div><div><label class="f" for="es">Day B easy (s)</label><input type="number" inputmode="numeric" id="es" value="${st.easySec}"></div></div>
    <label class="f" for="ir">Day B rounds</label><input type="number" inputmode="numeric" id="ir" value="${st.intervalRounds}" min="1" max="20"></div>
    <div class="card"><h3>Sync to Google Sheet</h3>
    <p class="mut" style="margin:4px 0 8px">${S.sync.url ? (S.sync.lastErr ? '⚠️ Last sync failed: ' + esc(S.sync.lastErr) : S.sync.lastOk ? '✅ Synced ' + new Date(S.sync.lastOk).toLocaleString() : 'Connected — not synced yet') : 'Not connected. Open the setup link from your assistant once, or paste the details below.'}</p>
    <details${S.sync.url ? '' : ' open'}><summary class="mut" style="cursor:pointer">Connection details</summary>
    <label class="f" for="surl">Web app URL</label><input type="text" id="surl" value="${esc(S.sync.url)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off">
    <label class="f" for="skey">Sync key</label><input type="text" id="skey" value="${esc(S.sync.key)}" autocomplete="off"></details>
    <button class="btn" id="syncNow" style="margin-top:8px">Sync now</button></div>
    <div class="card"><h3>Backup</h3><p class="mut" style="margin:4px 0 8px">Saved on this phone first (works offline). ${S.sync.url ? 'Also synced automatically to your Google Sheet.' : 'Connect sync above, or export a backup now and then.'}</p>
    <button class="btn" id="exp">Export data (JSON)</button>
    <label class="btn alt" style="display:block;text-align:center;margin-top:8px">Import backup<input type="file" id="imp" accept="application/json,.json" hidden></label>
    <p class="mut" style="margin-top:8px">${S.sessions.length} sessions · ${S.bodyweight.length} weigh-ins stored.</p></div>
    <div class="card"><h3>Install</h3><p class="mut" style="margin-top:4px">iPhone (Safari): Share ▸ <b>Add to Home Screen</b>. Android (Chrome): ⋮ ▸ <b>Install app</b> / Add to Home screen. Works offline once opened.</p></div>
    <div class="card"><h3>Reset</h3><button class="btn danger" id="wipe" style="margin-top:6px">Erase all data on this device</button></div>
    <p class="mut" style="text-align:center;margin:10px 0 20px">No accounts · no tracking · data only goes to your own Google Sheet</p>`;
  const num = (id, k, min, max) => $(id).onchange = e => { const n = parseInt(e.target.value, 10); if (n >= min && n <= max) { st[k] = n; save(); toast('Saved'); } else e.target.value = st[k]; };
  $('#surl').onchange = e => { S.sync.url = e.target.value.trim(); S.sync.sig = ''; save(); };
  $('#skey').onchange = e => { S.sync.key = e.target.value.trim(); S.sync.sig = ''; save(); };
  $('#syncNow').onclick = async () => { if (!S.sync.url) return toast('Add the web app URL first'); S.sync.lastErr = null; await sync(true); render(); if (!S.sync.lastErr) toast('Synced'); };
  $('#rm').onchange = e => { st.restMode = e.target.value; save(); toast('Saved'); };
  num('#rf', 'restFixed', 10, 600); num('#sm', 'steadyMin', 1, 60); num('#hs', 'hardSec', 5, 300); num('#es', 'easySec', 5, 600); num('#ir', 'intervalRounds', 1, 30);
  $('#snd').onchange = e => { st.sound = e.target.checked; save(); };
  $('#vib').onchange = e => { st.vibrate = e.target.checked; save(); };
  $('#test').onclick = () => startTimer([{label: 'Test', sec: 5, doneText: 'That\'s the alert'}]);
  $('#exp').onclick = () => {
    const blob = new Blob([JSON.stringify({app: 'home-workout', exportedAt: new Date().toISOString(), ...S}, null, 2)], {type: 'application/json'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `workout-backup-${today()}.json`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  $('#imp').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text()); if (!d || !Array.isArray(d.sessions)) throw new Error('not a backup');
      const replace = confirm(`Backup has ${d.sessions.length} sessions and ${(d.bodyweight || []).length} weigh-ins.\n\nOK = replace everything on this device\nCancel = merge with what's here`);
      if (replace) { const keep = {sync: S.sync, tomb: S.tomb, remotePlan: S.remotePlan, remoteSig: S.remoteSig}; S = normalize({...d, version: 1, ...keep}); P = buildPlan(); }
      else {
        const ids = new Set(S.sessions.map(x => x.id)); S.sessions = S.sessions.concat(d.sessions.filter(x => !ids.has(x.id)));
        const bd = new Map(S.bodyweight.map(x => [x.date, x])); (d.bodyweight || []).forEach(x => { if (!bd.has(x.date)) bd.set(x.date, x); }); S.bodyweight = [...bd.values()];
      }
      save(); toast('Imported'); render();
    } catch (err) { toast('That file is not a valid backup'); }
    e.target.value = '';
  };
  $('#wipe').onclick = () => { if (confirm('Erase ALL sessions, weigh-ins and settings on this device? Export a backup first if unsure.') && confirm('Really erase everything?')) { S = DEFAULTS(); save(); stopTimer(); render(); } };
}

document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => { tab = b.dataset.tab; render(); scrollTo(0, 0); });
render();
if (S.draft) keepAwake(true);
sync();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
