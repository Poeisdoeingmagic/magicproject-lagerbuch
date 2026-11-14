/* Lagerbuch – Offline-App
 * Daten liegen lokal im Gerät (IndexedDB). Jede Änderung wird als Vorgang gespeichert
 * und beim nächsten Netzkontakt an das Google-Apps-Script geschickt, das sie ins Sheet schreibt. */
(() => {
"use strict";
const APP_VERSION = "1.0.0";
const TRANSIT = "_unterwegs";
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = s => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss");
const newId = () => { const a = "abcdefghijkmnpqrstuvwxyz23456789"; let s = ""; for (const b of crypto.getRandomValues(new Uint8Array(16))) s += a[b % a.length]; return s; };
const ls = { get(k, d) { try { const v = localStorage.getItem("lb:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
             set(k, v) { try { localStorage.setItem("lb:" + k, JSON.stringify(v)); } catch {} } };
const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const ICON_IMG = '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-8 8"/></svg>';
const KAT_DEFAULT = ["Werkzeug", "Elektronik", "Küche", "Kleidung", "Dokumente", "Sport & Freizeit", "Möbel", "Deko", "Garten", "Haushalt", "Spielzeug", "Sonstiges"];

/* ================================================================ IndexedDB */
const IDB = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open("lagerbuch", 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("kv"); d.createObjectStore("ops", { keyPath: "opId" }); d.createObjectStore("photos"); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => { const d = await open(); return new Promise((res, rej) => {
    const t = d.transaction(store, mode); const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req ? req.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); };
  return {
    get: (st, k) => tx(st, "readonly", s => s.get(k)),
    put: (st, v, k) => tx(st, "readwrite", s => k === undefined ? s.put(v) : s.put(v, k)),
    del: (st, k) => tx(st, "readwrite", s => s.delete(k)),
    all: st => tx(st, "readonly", s => s.getAll()),
    keys: st => tx(st, "readonly", s => s.getAllKeys())
  };
})();

/* ================================================================ Zustand */
const S = {
  cfg: null,                                   // {url, key, name, device}
  server: { orte: [], dinge: [], journal: [], lastNr: 0, syncedAt: 0 },
  ops: [],                                     // noch nicht synchronisierte Vorgänge
  orte: new Map(), dinge: new Map(), journal: [],
  view: "dinge", q: "", fOrt: "", fKat: "", fTag: "", sort: ls.get("sort", "name"), jq: "", jType: "",
  sync: "idle", syncErr: "", updateReady: false, booted: false
};

function recompute() {
  S.orte = new Map(S.server.orte.map(o => [o.id, { ...o }]));
  S.dinge = new Map(S.server.dinge.map(d => [d.id, { ...d, tags: [...(d.tags || [])], fotos: [...(d.fotos || [])] }]));
  const pend = [];
  for (const op of [...S.ops].sort((a, b) => a.seq - b.seq)) { const j = localApply(op); if (j) pend.push(j); }
  S.journal = [...pend.reverse(), ...S.server.journal];
}
function localApply(op) {
  const J = (typ, d, von, nach, notiz) => ({ pending: true, at: op.at, typ, dingId: d ? d.id : "", dingName: d ? d.name : "", von: von || "", nach: nach || "", by: op.by, notiz: notiz || "" });
  let d;
  switch (op.typ) {
    case "ort.create":
      if (S.orte.has(op.id)) return null;
      S.orte.set(op.id, { id: op.id, standort: op.standort, bereich: op.bereich, order: 50 });
      return J("ort", null, "", op.id, "Neuer Lagerort");
    case "ding.create":
      if (S.dinge.has(op.id)) return null;
      d = { id: op.id, ...op.fields, ortId: op.ortId, ortSeit: op.at, ortBy: op.by, unterwegsBei: "", createdAt: op.at, createdBy: op.by, updatedAt: op.at, updatedBy: op.by, _pending: true };
      S.dinge.set(op.id, d);
      return J("new", d, "", op.ortId);
    case "ding.update":
      d = S.dinge.get(op.id); if (!d) return null;
      Object.assign(d, op.fields, { updatedAt: op.at, updatedBy: op.by, _pending: true });
      return J("edit", d, "", "", "Änderung");
    case "ding.move": case "ding.take": {
      d = S.dinge.get(op.id); if (!d) return null;
      const von = d.ortId, nach = op.typ === "ding.take" ? TRANSIT : op.nach;
      if (von === nach) return null;
      Object.assign(d, { ortId: nach, ortSeit: op.at, ortBy: op.by, unterwegsBei: nach === TRANSIT ? op.by : "", updatedAt: op.at, updatedBy: op.by, _pending: true });
      return J(op.typ === "ding.take" ? "out" : von === TRANSIT ? "in" : "move", d, von, nach, op.notiz);
    }
    case "ding.delete":
      d = S.dinge.get(op.id); if (!d) return null;
      S.dinge.delete(op.id);
      return J("del", d, d.ortId, "");
  }
  return null;
}
let seqCounter = 0;
async function queueOp(op) {
  op.opId = newId(); op.at = Date.now(); op.seq = op.at * 1000 + (seqCounter++ % 1000); op.by = S.cfg ? S.cfg.name : "";
  await IDB.put("ops", op);
  S.ops.push(op);
  recompute(); render();
  scheduleSync(600);
}

/* ================================================================ Server */
const b64FromBuf = buf => { const b = new Uint8Array(buf); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
const bufFromB64 = b64 => { const s = atob(b64); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b.buffer; };

async function call(body, timeout = 60000, cfg = S.cfg) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(cfg.url, { method: "POST", body: JSON.stringify({ ...body, key: cfg.key }), headers: { "Content-Type": "text/plain;charset=utf-8" }, signal: ctl.signal, redirect: "follow", cache: "no-store" });
    if (!r.ok) throw Object.assign(new Error("http"), { code: "http_" + r.status });
    let j; try { j = await r.json(); } catch { throw Object.assign(new Error("not json"), { code: "not_json" }); }
    if (!j.ok) throw Object.assign(new Error(j.message || j.error), { code: j.error || "error", detail: j.message });
    return j;
  } catch (e) {
    if (e.name === "AbortError") throw Object.assign(new Error("timeout"), { code: "timeout" });
    if (!e.code) throw Object.assign(new Error(String(e.message || e)), { code: "network" });
    throw e;
  } finally { clearTimeout(t); }
}
function errText(e) {
  const c = e && e.code;
  if (c === "unauthorized") return "Zugangsschlüssel ist falsch.";
  if (c === "timeout") return "Der Server hat zu lange gebraucht.";
  if (c === "network") return "Server nicht erreichbar.";
  if (c === "not_json") return "Die Adresse ist keine Lagerbuch-Web-App. Bitte die URL der Bereitstellung prüfen.";
  if (c === "server_error") return "Fehler im Sheet: " + (e.detail || "unbekannt");
  if (c && c.startsWith("http_")) return "Server antwortet mit Fehler " + c.slice(5) + ".";
  return "Unbekannter Fehler.";
}

let syncing = false, syncAgain = false, syncTimer = null;
function scheduleSync(ms = 800) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }
async function sync() {
  if (!S.cfg) return;
  if (syncing) { syncAgain = true; return; }
  if (!navigator.onLine) { S.sync = "off"; renderSync(); return; }
  syncing = true; S.sync = "busy"; renderSync();
  try {
    const photoKeys = await IDB.keys("photos");
    for (const k of photoKeys) {
      const p = await IDB.get("photos", k);
      if (!p || p.up) continue;
      await call({ action: "upload", id: p.id, size: p.size, data: b64FromBuf(p.buf) }, 90000);
      p.up = true; await IDB.put("photos", p, k);
    }
    const ops = [...S.ops].sort((a, b) => a.seq - b.seq).map(({ seq, ...o }) => o);
    let res = await call({ action: "sync", ops, sinceNr: S.server.lastNr, device: S.cfg.device }, 120000);
    let journal = S.server.journal;
    if (res.lastNr < S.server.lastNr) { // Sheet wurde neu aufgesetzt oder Journal gekürzt: alles neu laden
      res = await call({ action: "sync", ops: [], sinceNr: 0, device: S.cfg.device }, 120000); journal = [];
    }
    const applied = new Set(res.applied || []);
    for (const id of applied) await IDB.del("ops", id);
    S.ops = S.ops.filter(o => !applied.has(o.opId));
    const jm = new Map(journal.map(j => [j.nr, j])); for (const j of res.journal || []) jm.set(j.nr, j);
    S.server = { orte: res.orte || [], dinge: res.dinge || [], journal: [...jm.values()].sort((a, b) => b.nr - a.nr), lastNr: res.lastNr || 0, syncedAt: Date.now() };
    await IDB.put("kv", S.server, "server");
    S.syncErr = ""; S.sync = "idle";
    recompute(); render();
    prefetchThumbs();
  } catch (e) {
    console.warn(e);
    S.syncErr = errText(e); S.sync = navigator.onLine ? "err" : "off";
    if (e.code === "unauthorized") renderNotices();
  } finally {
    syncing = false; renderSync();
    if (syncAgain) { syncAgain = false; scheduleSync(300); }
  }
}
window.addEventListener("online", () => scheduleSync(300));
window.addEventListener("offline", () => { S.sync = "off"; renderSync(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") scheduleSync(300); });
setInterval(() => { if (document.visibilityState === "visible") sync(); }, 60000);

/* ================================================================ Fotos */
const urlCache = new Map(), inflight = new Map(), missing = new Set();
let active = 0; const waiters = [];
async function limited(fn) { if (active >= 3) await new Promise(r => waiters.push(r)); active++; try { return await fn(); } finally { active--; waiters.length && waiters.shift()(); } }
function photoURL(id, size) {
  const k = id + "_" + size;
  if (urlCache.has(k)) return Promise.resolve(urlCache.get(k));
  if (inflight.has(k)) return inflight.get(k);
  const p = (async () => {
    let rec = await IDB.get("photos", k).catch(() => null);
    if (!rec) {
      if (!navigator.onLine || !S.cfg || missing.has(k)) return null;
      try { const r = await limited(() => call({ action: "photo", id, size }, 60000)); rec = { k, id, size, buf: bufFromB64(r.data), up: true }; await IDB.put("photos", rec, k); }
      catch (e) { if (e.code === "not_found") missing.add(k); return null; }
    }
    const u = URL.createObjectURL(new Blob([rec.buf], { type: "image/jpeg" })); urlCache.set(k, u); return u;
  })();
  inflight.set(k, p); p.finally(() => inflight.delete(k));
  return p;
}
function hydrate(root = document) {
  root.querySelectorAll("img[data-ph]").forEach(async img => {
    const [id, size] = img.dataset.ph.split("|");
    let u = await photoURL(id, size);
    if (!u && size === "b") u = await photoURL(id, "t");
    if (u && img.isConnected && img.dataset.ph === id + "|" + size) img.src = u;
  });
}
async function prefetchThumbs() {
  const have = new Set(await IDB.keys("photos").catch(() => []));
  for (const d of S.dinge.values()) for (const id of d.fotos || []) if (!have.has(id + "_t")) photoURL(id, "t");
}
function loadImg(file) { return new Promise((res, rej) => { const u = URL.createObjectURL(file); const i = new Image(); i.onload = () => res({ i, u }); i.onerror = () => { URL.revokeObjectURL(u); rej(new Error("decode")); }; i.src = u; }); }
async function shrink(img, max, q) {
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
  const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(img, 0, 0, w, h);
  return await new Promise((r, j) => c.toBlob(b => b ? r(b) : j(new Error("encode")), "image/jpeg", q));
}
async function storePhoto(file) {
  const { i, u } = await loadImg(file);
  try {
    const [big, small] = await Promise.all([shrink(i, 1600, 0.82), shrink(i, 320, 0.75)]);
    const id = newId();
    await IDB.put("photos", { k: id + "_b", id, size: "b", buf: await big.arrayBuffer(), up: false }, id + "_b");
    await IDB.put("photos", { k: id + "_t", id, size: "t", buf: await small.arrayBuffer(), up: false }, id + "_t");
    urlCache.set(id + "_t", URL.createObjectURL(small)); urlCache.set(id + "_b", URL.createObjectURL(big));
    return id;
  } finally { URL.revokeObjectURL(u); }
}
async function dropLocalPhoto(id) { for (const s of ["b", "t"]) { const r = await IDB.get("photos", id + "_" + s).catch(() => null); if (r && !r.up) await IDB.del("photos", id + "_" + s).catch(() => {}); } }

/* ================================================================ Hilfen */
const standortHue = (() => { const cache = {}; const fixed = { KLU: 1, PG16: 3, FG19: 2, HG19: 4 };
  return st => { if (cache[st]) return cache[st]; let n = fixed[st]; if (!n) { let h = 0; for (const c of st) h = (h * 31 + c.charCodeAt(0)) >>> 0; n = (h % 6) + 1; } return cache[st] = n; }; })();
function ortChip(ortId, big, opts = {}) {
  const cls = big ? " big" : "";
  if (ortId === TRANSIT) return `<span class="chip transit${cls}"><span class="st">UNTERWEGS</span><span class="ber">${esc(opts.bei ? "bei " + opts.bei : "entnommen")}</span></span>`;
  const o = S.orte.get(ortId);
  if (!o) return `<span class="chip${cls}" style="--sb:var(--surface-2);--sf:var(--muted)"><span class="st">?</span><span class="ber">${esc(opts.name || "Ort unbekannt")}</span></span>`;
  const n = standortHue(o.standort);
  return `<span class="chip${cls}" style="--sb:var(--s${n});--sf:var(--s${n}f)"><span class="st">${esc(o.standort)}</span><span class="ber">${esc(o.bereich)}</span></span>`;
}
const ortName = id => id === TRANSIT ? "Unterwegs" : (S.orte.get(id) ? S.orte.get(id).standort + " " + S.orte.get(id).bereich : "");
const fmtDay = ms => new Date(ms).toLocaleDateString("de-AT", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
const fmtTime = ms => new Date(ms).toLocaleTimeString("de-AT", { hour: "2-digit", minute: "2-digit" });
const fmtFull = ms => ms ? new Date(ms).toLocaleString("de-AT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "–";
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2600); }
function sortedOrte() { return [...S.orte.values()].sort((a, b) => a.standort.localeCompare(b.standort, "de") || (a.order ?? 50) - (b.order ?? 50) || a.bereich.localeCompare(b.bereich, "de")); }
function standorte() { const m = new Map(); for (const o of sortedOrte()) { if (!m.has(o.standort)) m.set(o.standort, []); m.get(o.standort).push(o); } return m; }
function ortOptions(sel) {
  let h = ""; for (const [st, list] of standorte()) { h += `<optgroup label="${esc(st)}">`; for (const o of list) h += `<option value="${esc(o.id)}"${o.id === sel ? " selected" : ""}>${esc(o.standort + " " + o.bereich)}</option>`; h += "</optgroup>"; }
  return h;
}
function allKategorien() { const s = new Set(KAT_DEFAULT); for (const d of S.dinge.values()) if (d.kategorie) s.add(d.kategorie); return [...s].sort((a, b) => a.localeCompare(b, "de")); }
function allTags() { const m = new Map(); for (const d of S.dinge.values()) for (const t of d.tags || []) m.set(t, (m.get(t) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]); }
function knownNames() { const s = new Set(); for (const j of S.journal) if (j.by) s.add(j.by); return [...s]; }

/* ================================================================ Darstellung */
function route() { const h = location.hash.replace("#", ""); S.view = ["dinge", "orte", "journal"].includes(h) ? h : "dinge"; render(); }
window.addEventListener("hashchange", route);

function render() {
  for (const v of ["dinge", "orte", "journal"]) {
    $("#view-" + v).hidden = v !== S.view;
    const a = $(`.tabs a[data-view="${v}"]`); v === S.view ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current");
  }
  $("#fab").hidden = !S.cfg;
  renderSync(); renderNotices();
  if (S.view === "dinge") renderDinge(); else if (S.view === "orte") renderOrte(); else renderJournal();
  if (detailId && dlg.open && openDetail.redraw && !$("#delZone .confirm")) openDetail.redraw();
}
function renderSync() {
  const dot = $("#syncDot"), txt = $("#syncText"), n = S.ops.length;
  if (!S.cfg) { dot.className = "dot off"; txt.textContent = "Nicht eingerichtet"; return; }
  if (S.sync === "busy") { dot.className = "dot busy"; txt.textContent = "Synchronisiere …"; return; }
  if (!navigator.onLine || S.sync === "off") { dot.className = "dot " + (n ? "wait" : "off"); txt.textContent = "Offline" + (n ? ` · ${n} wartend` : ""); return; }
  if (S.sync === "err") { dot.className = "dot err"; txt.textContent = "Sync-Fehler" + (n ? ` · ${n} wartend` : ""); return; }
  if (n) { dot.className = "dot wait"; txt.textContent = `${n} wartend`; return; }
  dot.className = "dot ok"; txt.textContent = S.server.syncedAt ? "Sync " + fmtTime(S.server.syncedAt) : "Bereit";
}
function renderNotices() {
  const n = [];
  if (S.updateReady) n.push(`<div class="notice"><p>Eine neue Version des Lagerbuchs ist da.</p><button class="btn primary" type="button" data-act="reload">Neu laden</button></div>`);
  if (S.cfg && S.syncErr && S.sync === "err") n.push(`<div class="notice warn"><p>Synchronisieren hat nicht geklappt: ${esc(S.syncErr)} Deine Änderungen bleiben im Gerät gespeichert.</p><button class="btn" type="button" data-act="settings">Einstellungen</button></div>`);
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  if (ios && navigator.standalone === false && !ls.get("hideA2HS", false))
    n.push(`<div class="notice"><p>Für Offline-Betrieb am iPhone: in Safari auf <b>Teilen</b> tippen und <b>Zum Home-Bildschirm</b> wählen. Dann das Lagerbuch immer über das neue Symbol öffnen.</p><button class="btn ghost" type="button" data-act="hideA2HS">Ausblenden</button></div>`);
  $("#notices").innerHTML = n.join("");
}
function filteredDinge() {
  const words = norm(S.q).split(/\s+/).filter(Boolean);
  const list = [...S.dinge.values()].filter(d => {
    if (S.fOrt && (S.fOrt.startsWith("st:") ? (S.orte.get(d.ortId) || {}).standort !== S.fOrt.slice(3) : d.ortId !== S.fOrt)) return false;
    if (S.fKat && d.kategorie !== S.fKat) return false;
    if (S.fTag && !(d.tags || []).includes(S.fTag)) return false;
    if (!words.length) return true;
    const hay = norm([d.name, d.notiz, d.kategorie, (d.tags || []).join(" "), ortName(d.ortId)].join(" "));
    return words.every(w => hay.includes(w.replace(/^#/, "")));
  });
  const s = S.sort;
  list.sort((a, b) => s === "recent" ? (b.updatedAt || 0) - (a.updatedAt || 0)
    : s === "ort" ? (ortName(a.ortId).localeCompare(ortName(b.ortId), "de") || a.name.localeCompare(b.name, "de"))
    : a.name.localeCompare(b.name, "de"));
  return list;
}
function renderDinge() {
  let oh = `<option value="">Alle Orte</option>`;
  for (const [st, list] of standorte()) {
    oh += `<optgroup label="${esc(st)}"><option value="st:${esc(st)}"${S.fOrt === "st:" + st ? " selected" : ""}>${esc(st)} – alle</option>`;
    for (const o of list) oh += `<option value="${esc(o.id)}"${o.id === S.fOrt ? " selected" : ""}>${esc(o.standort + " " + o.bereich)}</option>`;
    oh += "</optgroup>";
  }
  oh += `<option value="${TRANSIT}"${S.fOrt === TRANSIT ? " selected" : ""}>Unterwegs</option>`;
  $("#fOrt").innerHTML = oh;
  const kats = [...new Set([...S.dinge.values()].map(d => d.kategorie).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
  $("#fKat").innerHTML = `<option value="">Alle Kategorien</option>` + kats.map(k => `<option${k === S.fKat ? " selected" : ""}>${esc(k)}</option>`).join("");
  $("#sort").value = S.sort;
  $("#activeFilter").innerHTML = S.fTag ? `<button type="button" data-act="clearTag">#${esc(S.fTag)} ✕</button>` : "";

  const list = filteredDinge(), total = S.dinge.size, box = $("#dingList");
  $("#countInfo").textContent = total ? (list.length === total ? `${total} Dinge` : `${list.length} von ${total} Dingen`) : "";
  if (!S.cfg) { box.innerHTML = `<div class="empty"><strong>Noch nicht eingerichtet</strong>Verbinde die App mit deinem Google Sheet.<br><br><button class="btn primary" type="button" data-act="settings">Einrichten</button></div>`; return; }
  if (!total && !S.server.syncedAt) { box.innerHTML = `<div class="empty"><strong>Noch keine Daten im Gerät</strong>Sobald eine Verbindung besteht, lädt das Lagerbuch die Daten aus dem Sheet.</div>`; return; }
  if (!total) { box.innerHTML = `<div class="empty"><strong>Noch keine Dinge erfasst</strong>Tippe auf „Ding erfassen“, mach ein Foto und wähle den Lagerort.</div>`; return; }
  if (!list.length) { box.innerHTML = `<div class="empty"><strong>Nichts gefunden</strong>Andere Suchbegriffe versuchen oder Filter zurücksetzen.</div>`; return; }
  box.innerHTML = `<div class="list">` + list.map(d => {
    const f = (d.fotos || [])[0];
    const img = f ? `<img class="thumb" alt="" src="${BLANK}" data-ph="${esc(f)}|t">` : `<div class="thumb ph">${ICON_IMG}</div>`;
    const sub = [d.kategorie, d.menge > 1 ? d.menge + " Stück" : ""].filter(Boolean).join(" · ");
    const tags = (d.tags || []).slice(0, 4).map(t => "#" + t).join(" ");
    return `<button class="row" type="button" data-open="${esc(d.id)}">${img}<div style="min-width:0"><div class="rname">${esc(d.name)}${d._pending ? '<span class="pend">wartet auf Sync</span>' : ""}</div>
      <div class="rsub">${esc(sub)}${sub && tags ? " · " : ""}${esc(tags)}</div></div><div class="chipcol">${ortChip(d.ortId, false, { bei: d.unterwegsBei })}</div></button>`;
  }).join("") + `</div>`;
  hydrate(box);
}
function renderOrte() {
  const counts = new Map(); for (const d of S.dinge.values()) counts.set(d.ortId, (counts.get(d.ortId) || 0) + 1);
  const groups = standorte(), box = $("#ortGroups");
  if (!groups.size) box.innerHTML = `<div class="empty"><strong>Noch keine Lagerorte</strong>${S.cfg ? "Nach der ersten Synchronisierung erscheinen hier die Orte aus dem Sheet." : "Zuerst die Verbindung einrichten."}</div>`;
  else {
    let h = `<div class="groups">`;
    for (const [st, list] of groups) {
      const n = standortHue(st), sum = list.reduce((a, o) => a + (counts.get(o.id) || 0), 0);
      h += `<div class="group" style="--sb:var(--s${n});--sf:var(--s${n}f)"><h3>${esc(st)}<small>${sum} Dinge</small></h3>`;
      for (const o of list) h += `<button class="ortrow" type="button" data-ort="${esc(o.id)}"><span>${esc(o.bereich)}</span><span class="count">${counts.get(o.id) || 0}</span></button>`;
      h += `<button class="ortrow" type="button" data-ort="st:${esc(st)}" style="color:var(--muted);font-size:13px"><span>Alle in ${esc(st)} anzeigen</span><span class="count">→</span></button></div>`;
    }
    const tr = counts.get(TRANSIT) || 0;
    if (tr) h += `<div class="group" style="--sb:var(--label);--sf:var(--label-fg)"><h3>Unterwegs<small>${tr} Dinge</small></h3><button class="ortrow" type="button" data-ort="${TRANSIT}"><span>Entnommen, noch nicht abgelegt</span><span class="count">${tr}</span></button></div>`;
    box.innerHTML = h + `</div>`;
  }
  $("#standortList").innerHTML = [...groups.keys()].map(s => `<option value="${esc(s)}">`).join("");
  $("#addOrtForm").hidden = !S.cfg;
  $("#settingsInfo").textContent = S.cfg ? `Angemeldet als ${S.cfg.name}. Version ${APP_VERSION}.` : "Noch nicht eingerichtet.";
}
function journalParts(j) {
  const verb = { new: ["Neu angelegt", "new"], move: ["Umgebucht", "move"], out: ["Entnommen", "out"], in: ["Abgelegt", "move"], edit: ["Geändert", ""], del: ["Gelöscht", "del"], ort: ["Ort angelegt", "new"] }[j.typ] || [j.typ, ""];
  const chip = (id, name) => id ? ortChip(id, false, { bei: j.by, name }) : "";
  let where = "";
  if (["move", "in", "out"].includes(j.typ)) where = `${chip(j.von, j.vonName)}<span class="arrow">→</span>${chip(j.nach, j.nachName)}`;
  else if (j.nach) where = chip(j.nach, j.nachName);
  else if (j.von) where = chip(j.von, j.vonName);
  return { verb, where };
}
function renderJournal() {
  const box = $("#journalList"), words = norm(S.jq).split(/\s+/).filter(Boolean);
  const list = S.journal.filter(j => {
    if (S.jType) { const g = { move: ["move", "in", "out"], new: ["new", "ort"] }[S.jType] || [S.jType]; if (!g.includes(j.typ)) return false; }
    if (!words.length) return true;
    const hay = norm([j.dingName, ortName(j.von) || j.vonName, ortName(j.nach) || j.nachName, j.by, j.notiz].join(" "));
    return words.every(w => hay.includes(w));
  });
  if (!list.length) { box.innerHTML = `<div class="empty"><strong>Keine Einträge</strong>Jede Neuanlage, Umbuchung und Änderung erscheint hier mit Datum, Uhrzeit und Person.</div>`; return; }
  let h = "", day = "";
  for (const j of list.slice(0, 600)) {
    const d = fmtDay(j.at);
    if (d !== day) { if (day) h += "</div>"; h += `<div class="jday">${esc(d)}</div><div class="jlist">`; day = d; }
    const { verb, where } = journalParts(j);
    const name = j.dingName ? (S.dinge.has(j.dingId) ? `<button class="lnk" type="button" data-open="${esc(j.dingId)}">${esc(j.dingName)}</button>` : `<b>${esc(j.dingName)}</b>`) : "";
    h += `<div class="jrow"><div class="jtime">${fmtTime(j.at)}</div><div style="min-width:0"><div class="jwhat"><span class="verb ${verb[1]}">${verb[0]}</span>${name}${where}${j.pending ? '<span class="verb wait">wartet auf Sync</span>' : ""}</div>
      <div class="jby">von ${esc(j.by || "Unbekannt")}${j.notiz ? " · " + esc(j.notiz) : ""}</div></div></div>`;
  }
  box.innerHTML = h + "</div>" + (list.length > 600 ? `<p class="meta">Es werden die letzten 600 Vorgänge gezeigt. Den ganzen Verlauf eines Dings siehst du in seiner Detailansicht, alles weitere im Google Sheet.</p>` : "");
}

/* ================================================================ Dialoge */
const dlg = $("#dlg"), sheet = $("#sheet");
let dlgCleanup = null, detailId = null;
function openSheet(html, onClose) { if (dlgCleanup) { const c = dlgCleanup; dlgCleanup = null; c(); } detailId = null; sheet.innerHTML = html; sheet.onclick = null; dlgCleanup = onClose || null; if (!dlg.open) dlg.showModal(); const b = sheet.querySelector(".sh-body"); if (b) b.scrollTop = 0; }
function closeSheet() { if (dlgCleanup) { const c = dlgCleanup; dlgCleanup = null; c(); } detailId = null; if (dlg.open) dlg.close(); }
dlg.addEventListener("cancel", e => { e.preventDefault(); if (S.cfg) closeSheet(); });

function openDetail(id) {
  if (!S.dinge.get(id)) return;
  let sel = 0;
  const draw = () => {
    const d = S.dinge.get(id); if (!d) { closeSheet(); return; }
    const fotos = d.fotos || [];
    const cur = fotos[Math.min(sel, fotos.length - 1)];
    const photo = fotos.length ? `<img class="hero-photo" alt="Foto von ${esc(d.name)}" src="${BLANK}" data-ph="${esc(cur)}|b">` + (fotos.length > 1 ? `<div class="strip">${fotos.map((f, i) => `<img src="${BLANK}" data-ph="${esc(f)}|t" alt="Foto ${i + 1}" data-sel="${i}" class="${i === sel ? "sel" : ""}">`).join("")}</div>` : "") : "";
    const hist = S.journal.filter(j => j.dingId === id);
    const histHtml = hist.length ? `<div class="hist">${hist.map(j => { const { verb, where } = journalParts(j);
      return `<div><time>${fmtFull(j.at)} · ${esc(j.by || "Unbekannt")}</time><div class="jwhat"><span class="verb ${verb[1]}">${verb[0]}</span>${where}${j.pending ? '<span class="verb wait">wartet</span>' : ""}</div>${j.notiz ? `<span class="jby">${esc(j.notiz)}</span>` : ""}</div>`; }).join("")}</div>` : `<p class="hint">Noch kein Verlauf.</p>`;
    const isTransit = d.ortId === TRANSIT;
    sheet.innerHTML = `<div class="sh-head"><h2>${esc(d.name)}</h2><button class="btn ghost" type="button" data-act="close">Schließen</button></div>
      <div class="sh-body">${photo}
        <div class="where"><span class="lbl">Wo ist es jetzt?</span><div>${ortChip(d.ortId, true, { bei: d.unterwegsBei })}</div>
          <span class="jby">seit ${fmtFull(d.ortSeit || d.createdAt)}${d.ortBy ? " · verbracht von " + esc(d.ortBy) : ""}</span></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${isTransit ? `<button class="btn primary" type="button" data-act="move">Ablegen in …</button>` : `<button class="btn primary" type="button" data-act="move">Umbuchen</button><button class="btn" type="button" data-act="take">Entnehmen</button>`}<button class="btn" type="button" data-act="edit">Bearbeiten</button></div>
        <dl class="kv">
          ${d.kategorie ? `<dt>Kategorie</dt><dd>${esc(d.kategorie)}</dd>` : ""}
          <dt>Menge</dt><dd>${esc(d.menge || 1)}</dd>
          ${(d.tags || []).length ? `<dt>Schlagworte</dt><dd style="display:flex;gap:6px;flex-wrap:wrap">${d.tags.map(t => `<button class="tagbtn" type="button" data-tag="${esc(t)}">#${esc(t)}</button>`).join("")}</dd>` : ""}
          ${d.notiz ? `<dt>Notiz</dt><dd style="white-space:pre-wrap">${esc(d.notiz)}</dd>` : ""}
          <dt>Erfasst</dt><dd>${fmtFull(d.createdAt)} · ${esc(d.createdBy || "Unbekannt")}</dd>
        </dl>
        <div><div class="lbl" style="margin-bottom:8px">Bewegungsjournal</div>${histHtml}</div>
        <div id="delZone"><button class="btn danger" type="button" data-act="askdel">Ding löschen</button></div>
      </div>`;
    hydrate(sheet);
  };
  openSheet("");
  detailId = id; openDetail.redraw = draw; draw();
  sheet.onclick = e => {
    const t = e.target.closest("[data-act],[data-sel],[data-tag]"); if (!t) return;
    if (t.dataset.sel != null) { sel = +t.dataset.sel; draw(); return; }
    if (t.dataset.tag) { S.fTag = t.dataset.tag; closeSheet(); location.hash = "dinge"; render(); return; }
    const a = t.dataset.act;
    if (a === "close") closeSheet();
    else if (a === "move") openMove(id);
    else if (a === "take") { const d = S.dinge.get(id); queueOp({ typ: "ding.take", id, von: d.ortId }).then(() => { toast("Entnommen. Beim Ablegen den neuen Ort wählen."); draw(); }); }
    else if (a === "edit") openEdit(id);
    else if (a === "askdel") $("#delZone").innerHTML = `<div class="confirm"><b>„${esc(S.dinge.get(id).name)}“ wirklich löschen?</b><span class="jby">Im Sheet wird das Ding als gelöscht markiert. Der Verlauf bleibt im Journal.</span><div style="display:flex;gap:8px"><button class="btn danger" type="button" data-act="dodel">Löschen</button><button class="btn" type="button" data-act="nodel">Abbrechen</button></div></div>`;
    else if (a === "nodel") draw();
    else if (a === "dodel") { const n = S.dinge.get(id).name; queueOp({ typ: "ding.delete", id }).then(() => { closeSheet(); toast(`„${n}“ gelöscht`); }); }
  };
}

function openMove(id) {
  const d = S.dinge.get(id); if (!d) return;
  const isTransit = d.ortId === TRANSIT;
  openSheet(`<div class="sh-head"><h2>${isTransit ? "Ablegen" : "Umbuchen"}: ${esc(d.name)}</h2></div>
    <form class="sh-body" id="moveForm">
      <div class="where"><span class="lbl">Jetzt</span><div>${ortChip(d.ortId, true, { bei: d.unterwegsBei })}</div></div>
      <div class="field"><label for="mvTo">Neuer Lagerort</label><select id="mvTo" required><option value="">Bitte wählen …</option>${ortOptions("")}</select></div>
      <div class="field"><label for="mvNote">Notiz (optional)</label><input id="mvNote" maxlength="300" placeholder="z. B. für Umzug, verliehen an …"></div>
    </form>
    <div class="sh-foot"><button class="btn" type="button" data-act="back">Abbrechen</button><button class="btn primary" type="submit" form="moveForm">Buchen</button></div>`);
  sheet.onclick = e => { if (e.target.closest('[data-act="back"]')) openDetail(id); };
  $("#moveForm").onsubmit = async e => {
    e.preventDefault();
    const to = $("#mvTo").value; if (!to) return;
    if (to === d.ortId) { toast("Das Ding ist bereits dort."); return; }
    await queueOp({ typ: "ding.move", id, von: d.ortId, nach: to, notiz: $("#mvNote").value.trim() });
    ls.set("lastOrt", to); toast(`Gebucht nach ${ortName(to)}`); openDetail(id);
  };
}

let pickHandler = null;
for (const fid of ["fileCam", "fileLib"]) $("#" + fid).addEventListener("change", e => { const fs = [...e.target.files]; if (fs.length && pickHandler && dlg.open) pickHandler(fs); });

function openEdit(id) {
  const d = id ? S.dinge.get(id) : null;
  const F = { fotos: d ? [...(d.fotos || [])] : [], tags: d ? [...(d.tags || [])] : [], busy: 0, fresh: [] };
  const last = ls.get("lastOrt", "");
  const defOrt = d ? d.ortId : (S.fOrt && S.orte.has(S.fOrt) ? S.fOrt : (S.orte.has(last) ? last : ""));
  let saved = false;
  openSheet(`<div class="sh-head"><h2>${d ? "Bearbeiten" : "Neues Ding"}</h2></div>
    <form class="sh-body" id="editForm" autocomplete="off">
      <div class="field"><span class="lbl">Fotos</span><div class="photos" id="phBox"></div></div>
      <div class="field"><label for="eName">Name</label><input id="eName" required maxlength="120" placeholder="z. B. Akkuschrauber Bosch grün" value="${esc(d ? d.name : "")}"></div>
      <div class="two">
        <div class="field"><label for="eOrt">Lagerort</label>${d ? `<div>${ortChip(d.ortId, false, { bei: d.unterwegsBei })}</div><span class="jby">Ort ändern über „Umbuchen“, damit es im Journal steht.</span>` : `<select id="eOrt" required><option value="">Bitte wählen …</option>${ortOptions(defOrt)}</select>`}</div>
        <div class="field"><label for="eKat">Kategorie</label><input id="eKat" list="katList" maxlength="60" placeholder="z. B. Werkzeug" value="${esc(d ? d.kategorie || "" : "")}"><datalist id="katList">${allKategorien().map(k => `<option value="${esc(k)}">`).join("")}</datalist></div>
      </div>
      <div class="field"><label for="eTag">Schlagworte</label><div class="tagbox" id="tagBox"><input id="eTag" list="tagList" placeholder="Wort eingeben, Enter"><datalist id="tagList">${allTags().map(t => `<option value="${esc(t)}">`).join("")}</datalist></div></div>
      <div class="two"><div class="field"><label for="eMenge">Menge</label><input id="eMenge" type="number" min="1" step="1" inputmode="numeric" value="${esc(d ? d.menge || 1 : 1)}"></div><div></div></div>
      <div class="field"><label for="eNotiz">Notiz</label><textarea id="eNotiz" rows="3" maxlength="2000" placeholder="Beschreibung, Zustand, Kiste Nr. …">${esc(d ? d.notiz || "" : "")}</textarea></div>
    </form>
    <div class="sh-foot"><button class="btn" type="button" data-act="cancel">Abbrechen</button><button class="btn primary" type="submit" form="editForm" id="saveBtn">Speichern</button></div>`,
    () => { pickHandler = null; if (!saved) for (const p of F.fresh) dropLocalPhoto(p); });
  if (!d) $("#eOrt").value = defOrt || "";
  const drawPhotos = () => {
    $("#phBox").innerHTML = F.fotos.map((f, i) => `<div class="ph-item"><img alt="" src="${BLANK}" data-ph="${esc(f)}|t"><button type="button" data-rm="${i}" aria-label="Foto entfernen">×</button></div>`).join("")
      + (F.busy ? `<div class="ph-item"><div class="busy">verarbeite …</div></div>` : "")
      + `<button class="ph-add" type="button" data-act="cam"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Kamera</button>
         <button class="ph-add" type="button" data-act="lib"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m21 16-5-5-8 8"/></svg>Galerie</button>`;
    $("#saveBtn").disabled = F.busy > 0;
    hydrate($("#phBox"));
  };
  const drawTags = () => {
    const box = $("#tagBox"), inp = $("#eTag"); box.querySelectorAll(".tchip").forEach(n => n.remove());
    F.tags.forEach((t, i) => { const s = document.createElement("span"); s.className = "tchip"; s.innerHTML = `#${esc(t)}<button type="button" data-rmtag="${i}" aria-label="Schlagwort entfernen">×</button>`; box.insertBefore(s, inp); });
  };
  const addTag = v => { for (let t of v.split(/[,;]/)) { t = t.trim().replace(/^#/, "").slice(0, 40); if (t && !F.tags.some(x => norm(x) === norm(t))) F.tags.push(t); } $("#eTag").value = ""; drawTags(); };
  drawPhotos(); drawTags();
  $("#eTag").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(e.target.value); } else if (e.key === "Backspace" && !e.target.value && F.tags.length) { F.tags.pop(); drawTags(); } });
  $("#eTag").addEventListener("change", e => { if (e.target.value) addTag(e.target.value); });
  pickHandler = async files => {
    for (const file of files) {
      F.busy++; drawPhotos();
      try { const pid = await storePhoto(file); F.fotos.push(pid); F.fresh.push(pid); }
      catch (err) { console.warn(err); toast("Foto konnte nicht verarbeitet werden."); }
      F.busy--; if ($("#phBox")) drawPhotos();
    }
  };
  sheet.onclick = e => {
    const rm = e.target.closest("[data-rm]"); if (rm) { const pid = F.fotos.splice(+rm.dataset.rm, 1)[0]; if (F.fresh.includes(pid)) { F.fresh = F.fresh.filter(x => x !== pid); dropLocalPhoto(pid); } drawPhotos(); return; }
    const rt = e.target.closest("[data-rmtag]"); if (rt) { F.tags.splice(+rt.dataset.rmtag, 1); drawTags(); return; }
    const a = e.target.closest("[data-act]")?.dataset.act;
    if (a === "cam") { $("#fileCam").value = ""; $("#fileCam").click(); }
    else if (a === "lib") { $("#fileLib").value = ""; $("#fileLib").click(); }
    else if (a === "cancel") { d ? openDetail(id) : closeSheet(); }
  };
  $("#editForm").onsubmit = async e => {
    e.preventDefault();
    if ($("#eTag").value.trim()) addTag($("#eTag").value);
    const name = $("#eName").value.trim(), ortId = d ? d.ortId : $("#eOrt").value;
    if (!name || !ortId) { toast("Name und Lagerort sind nötig."); return; }
    const fields = { name, kategorie: $("#eKat").value.trim(), tags: F.tags, menge: Math.max(1, parseInt($("#eMenge").value, 10) || 1), notiz: $("#eNotiz").value.trim(), fotos: F.fotos };
    saved = true;
    if (d) { await queueOp({ typ: "ding.update", id, fields }); toast("Gespeichert"); openDetail(id); }
    else { const nid = newId(); await queueOp({ typ: "ding.create", id: nid, ortId, fields }); ls.set("lastOrt", ortId); closeSheet(); toast(`„${name}“ in ${ortName(ortId)} erfasst`); }
  };
}

function openSettings(first) {
  const c = S.cfg || {};
  openSheet(`<div class="sh-head"><h2>${first ? "Lagerbuch einrichten" : "Verbindung & Name"}</h2>${first ? "" : `<button class="btn ghost" type="button" data-act="x">Schließen</button>`}</div>
    <form class="sh-body" id="setForm" autocomplete="off">
      ${first ? `<p class="hint">Einmal pro Gerät. Die Web-App-Adresse und den Zugangsschlüssel bekommst du aus dem Apps Script deines Google Sheets (siehe Anleitung).</p>` : ""}
      <div class="field"><label for="sUrl">Web-App-Adresse</label><input id="sUrl" type="url" required placeholder="https://script.google.com/macros/s/…/exec" value="${esc(c.url || "")}"></div>
      <div class="field"><label for="sKey">Zugangsschlüssel</label><input id="sKey" required autocapitalize="off" spellcheck="false" value="${esc(c.key || "")}"></div>
      <div class="field"><label for="sName">Dein Name</label><input id="sName" required maxlength="40" list="nameList" placeholder="So erscheinst du im Journal" value="${esc(c.name || "")}"><datalist id="nameList">${knownNames().map(n => `<option value="${esc(n)}">`).join("")}</datalist></div>
      <p class="err" id="setErr" hidden></p>
    </form>
    <div class="sh-foot"><button class="btn primary" type="submit" form="setForm" id="setBtn">Verbinden &amp; speichern</button></div>`);
  sheet.onclick = e => { if (e.target.closest('[data-act="x"]')) closeSheet(); };
  $("#setForm").onsubmit = async e => {
    e.preventDefault();
    const cfg = { url: $("#sUrl").value.trim(), key: $("#sKey").value.trim(), name: $("#sName").value.trim(), device: c.device || ("Gerät-" + newId().slice(0, 5)) };
    const err = $("#setErr"); err.hidden = true;
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(cfg.url)) { err.textContent = "Die Adresse muss mit https://script.google.com/ beginnen."; err.hidden = false; return; }
    const btn = $("#setBtn"); btn.disabled = true; btn.textContent = "Prüfe …";
    try { await call({ action: "ping" }, 30000, cfg); }
    catch (ex) {
      btn.disabled = false; btn.textContent = "Verbinden & speichern";
      if (ex.code === "network" && !navigator.onLine && S.cfg) { /* offline: Name trotzdem ändern */ }
      else { err.textContent = errText(ex); err.hidden = false; return; }
    }
    const urlChanged = S.cfg && S.cfg.url !== cfg.url;
    S.cfg = cfg; await IDB.put("kv", cfg, "cfg");
    if (urlChanged) { S.server = { orte: [], dinge: [], journal: [], lastNr: 0, syncedAt: 0 }; await IDB.put("kv", S.server, "server"); recompute(); }
    closeSheet(); render(); toast("Verbunden"); sync();
  };
}

/* ================================================================ Ereignisse */
$("#fab").onclick = () => openEdit(null);
$("#syncBtn").onclick = () => { if (!S.cfg) openSettings(true); else { if (!navigator.onLine) toast("Kein Netz. Änderungen bleiben im Gerät und werden später übertragen."); sync(); } };
$("#openSettings").onclick = () => openSettings(!S.cfg);
$("#q").addEventListener("input", e => { S.q = e.target.value; renderDinge(); });
$("#fOrt").addEventListener("change", e => { S.fOrt = e.target.value; renderDinge(); });
$("#fKat").addEventListener("change", e => { S.fKat = e.target.value; renderDinge(); });
$("#sort").addEventListener("change", e => { S.sort = e.target.value; ls.set("sort", S.sort); renderDinge(); });
$("#jq").addEventListener("input", e => { S.jq = e.target.value; renderJournal(); });
$("#jType").addEventListener("change", e => { S.jType = e.target.value; renderJournal(); });
document.addEventListener("click", e => {
  if (dlg.contains(e.target)) return;
  const o = e.target.closest("[data-open]"); if (o) { openDetail(o.dataset.open); return; }
  const r = e.target.closest("[data-ort]"); if (r) { S.fOrt = r.dataset.ort; S.q = ""; $("#q").value = ""; S.fKat = ""; S.fTag = ""; location.hash = "dinge"; route(); return; }
  const a = e.target.closest("[data-act]")?.dataset.act;
  if (a === "clearTag") { S.fTag = ""; renderDinge(); }
  else if (a === "settings") openSettings(!S.cfg);
  else if (a === "reload") location.reload();
  else if (a === "hideA2HS") { ls.set("hideA2HS", true); renderNotices(); }
});
$("#addOrtForm").addEventListener("submit", async e => {
  e.preventDefault();
  const st = $("#newStandort").value.trim().toUpperCase().replace(/\s+/g, ""), be = $("#newBereich").value.trim();
  if (!st || !be) return;
  if ([...S.orte.values()].some(o => norm(o.standort) === norm(st) && norm(o.bereich) === norm(be))) { toast("Diesen Ort gibt es schon."); return; }
  await queueOp({ typ: "ort.create", id: newId(), standort: st, bereich: be });
  $("#newBereich").value = ""; toast(`${st} ${be} angelegt`);
});

/* ================================================================ Start */
(async () => {
  try {
    S.cfg = (await IDB.get("kv", "cfg")) || null;
    S.server = (await IDB.get("kv", "server")) || S.server;
    S.ops = (await IDB.all("ops")) || [];
  } catch (e) { console.warn(e); toast("Gerätespeicher nicht verfügbar. Privates Surfen beenden?"); }
  recompute(); S.booted = true; route();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if (!S.cfg) openSettings(true); else sync();
})();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW", e));
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController) { S.updateReady = true; renderNotices(); } });
}
})();
