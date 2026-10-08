(() => {
'use strict';
const CFG = window.APP_CONFIG || {}, SEED = window.APP_SEED || { players: [], competitions: [] };
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};
const uid = () => crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16));
const int = v => (v === '' || v == null) ? null : parseInt(v, 10);
const DEMO = !(CFG.supabaseUrl && CFG.supabaseKey);

/* ---------- Datos: Supabase o modo demostración ---------- */
function remoteBackend() {
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  const all = async t => { const { data, error } = await sb.from(t).select('*'); if (error) throw new Error(error.message); return data; };
  return {
    async load() {
      const [players, comps, matches, stats, results, voters, att] = await Promise.all(['players', 'competitions', 'matches', 'player_stats', 'match_results', 'match_voters', 'attendance'].map(all));
      return { players, comps, matches, stats, results, voters, att };
    },
    async photos() { return Object.fromEntries((await all('player_photos')).map(r => [r.player_id, r.data])); },
    async rpc(fn, args) { const { data, error } = await sb.rpc(fn, args); if (error) throw new Error(error.message); return data; }
  };
}
function localBackend() {
  const d = ls.get('odp-demo2') || { players: [], competitions: [], matches: [], player_stats: [], photos: {}, pins: {}, ratings: [], mvp: [], admin: 'admin' };
  d.fees ||= []; d.fee_payments ||= []; d.attendance ||= [];
  const adm = pw => { if (pw !== d.admin) throw new Error('Contraseña incorrecta'); };
  const fns = {
    admin_check: ({ pw }) => pw === d.admin,
    admin_upsert({ pw, tbl, rows }) { adm(pw); for (const r of rows) { const i = d[tbl].findIndex(x => x.id === r.id); i < 0 ? d[tbl].push(r) : d[tbl][i] = r; } },
    admin_delete({ pw, tbl, rid }) {
      adm(pw); d[tbl] = d[tbl].filter(x => x.id !== rid);
      if (tbl === 'competitions') d.matches = d.matches.filter(m => m.competition_id !== rid);
      const ms = new Set(d.matches.map(m => m.id)), ps = new Set(d.players.map(p => p.id));
      d.player_stats = d.player_stats.filter(s => ms.has(s.match_id) && ps.has(s.player_id));
      d.ratings = d.ratings.filter(s => ms.has(s.match_id) && ps.has(s.player_id) && ps.has(s.voter_id));
      d.mvp = d.mvp.filter(s => ms.has(s.match_id) && ps.has(s.player_id) && ps.has(s.voter_id));
      d.attendance = d.attendance.filter(s => ms.has(s.match_id) && ps.has(s.player_id));
      const fs = new Set(d.fees.map(f => f.id)); d.fee_payments = d.fee_payments.filter(x => fs.has(x.fee_id) && ps.has(x.player_id));
    },
    admin_set_stats({ pw, mid, rows }) { adm(pw); d.player_stats = d.player_stats.filter(s => s.match_id !== mid).concat(rows.map(r => ({ ...r, match_id: mid }))); },
    admin_reset_pin({ pw, pid }) { adm(pw); delete d.pins[pid]; },
    admin_set_password({ pw, newpw }) { adm(pw); if (newpw.length < 6) throw new Error('La contraseña debe tener al menos 6 caracteres'); d.admin = newpw; },
    set_attendance({ pid, secret, mid, st }) { if (secret !== d.admin && d.pins[pid] !== secret) throw new Error('PIN incorrecto'); d.attendance = d.attendance.filter(x => !(x.match_id === mid && x.player_id === pid)); if (st) d.attendance.push({ match_id: mid, player_id: pid, status: st }); },
    get_fees({ pid, secret }) { if (secret !== d.admin && !(pid && d.pins[pid] === secret)) throw new Error('PIN incorrecto'); return JSON.parse(JSON.stringify({ fees: d.fees, payments: d.fee_payments })); },
    admin_set_payment({ pw, fid, pid, amount }) { adm(pw); d.fee_payments = d.fee_payments.filter(x => !(x.fee_id === fid && x.player_id === pid)); if (amount > 0) d.fee_payments.push({ fee_id: fid, player_id: pid, paid: amount }); },
    pin_login({ pid, pin }) { if (pin.length < 4) throw new Error('El PIN debe tener al menos 4 cifras'); if (!d.pins[pid]) { d.pins[pid] = pin; return true; } return d.pins[pid] === pin; },
    set_photo({ pid, secret, data }) { if (secret !== d.admin && d.pins[pid] !== secret) throw new Error('PIN incorrecto'); if (data) d.photos[pid] = data; else delete d.photos[pid]; },
    cast_vote({ pid, pin, mid, mvp, scores }) {
      if (d.pins[pid] !== pin) throw new Error('PIN incorrecto');
      if (!d.matches.find(m => m.id === mid && m.voting_open)) throw new Error('La votación está cerrada');
      if (mvp === pid) throw new Error('No puedes votarte a ti mismo');
      d.ratings = d.ratings.filter(r => !(r.match_id === mid && r.voter_id === pid));
      for (const [k, v] of Object.entries(scores)) if (k !== pid) d.ratings.push({ match_id: mid, voter_id: pid, player_id: k, score: +v });
      d.mvp = d.mvp.filter(r => !(r.match_id === mid && r.voter_id === pid)); d.mvp.push({ match_id: mid, voter_id: pid, player_id: mvp });
    }
  };
  return {
    async load() {
      const closed = new Set(d.matches.filter(m => !m.voting_open).map(m => m.id));
      const results = d.player_stats.filter(s => closed.has(s.match_id)).map(s => {
        const rs = d.ratings.filter(r => r.match_id === s.match_id && r.player_id === s.player_id);
        return { match_id: s.match_id, player_id: s.player_id, avg_score: rs.length ? rs.reduce((a, r) => a + r.score, 0) / rs.length : null, mvp_votes: d.mvp.filter(v => v.match_id === s.match_id && v.player_id === s.player_id).length };
      });
      return JSON.parse(JSON.stringify({ players: d.players, comps: d.competitions, matches: d.matches, stats: d.player_stats, results, voters: d.mvp.map(v => ({ match_id: v.match_id, voter_id: v.voter_id })), att: d.attendance }));
    },
    async photos() { return { ...d.photos }; },
    async rpc(fn, args) { const r = fns[fn](args); ls.set('odp-demo2', d); return r; }
  };
}
const api = DEMO ? localBackend() : remoteBackend();

/* ---------- Estado ---------- */
let S = { players: [], comps: [], matches: [], stats: [], results: [], voters: [], att: [] }, PH = {};
let adminPw = null; try { adminPw = sessionStorage.getItem('odp-admin'); } catch {}
let me = ls.get('odp-me'), FEES = null, feesErr = '';
const eur = n => (+n || 0).toLocaleString('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
async function loadFees() { try { FEES = await api.rpc('get_fees', { pid: me?.id || null, secret: adminPw || me?.pin || '' }); feesErr = ''; } catch (e) { FEES = null; feesErr = e.message; if (!adminPw) { me = null; ls.del('odp-me'); } } render(); }
const ui = { comp: null, onlyUs: true, metric: 'goals', statComp: '' };
const isCoach = p => p.position === 'Entrenador';
const player = id => S.players.find(p => p.id === id);
const comp = id => S.comps.find(c => c.id === id);
const isUs = t => (t || '').trim().toUpperCase() === (CFG.team || '').toUpperCase();
const ours = m => isUs(m.home) || isUs(m.away);
const played = m => m.home_goals != null && m.away_goals != null;
const byDate = (a, b) => (a.date || '9').localeCompare(b.date || '9') || (a.round || 0) - (b.round || 0);
const byName = (a, b) => a.name.localeCompare(b.name, 'es');
const comps = () => [...S.comps].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name));
function fmtDate(s, long) {
  if (!s) return 'Fecha por confirmar';
  const d = new Date(s); if (isNaN(d)) return s;
  const txt = d.toLocaleDateString('es-ES', long ? { weekday: 'long', day: 'numeric', month: 'long' } : { weekday: 'short', day: 'numeric', month: 'short' });
  return s.length > 10 ? `${txt} · ${s.slice(11, 16)}` : txt;
}
function avatar(p, size = 44) {
  const ini = (p?.name || '?').split(' ').map(w => w[0]).slice(0, 2).join('');
  return `<span class="av" style="--s:${size}px">${p && PH[p.id] ? `<img src="${PH[p.id]}" alt="">` : esc(ini)}</span>`;
}
function standings(c) {
  const T = {}, row = t => T[t] ||= { team: t, pj: 0, pg: 0, pe: 0, pp: 0, gf: 0, gc: 0, pts: 0 };
  (c.teams || []).forEach(row);
  for (const m of S.matches) if (m.competition_id === c.id && played(m)) {
    const h = row(m.home), a = row(m.away); h.pj++; a.pj++; h.gf += m.home_goals; h.gc += m.away_goals; a.gf += m.away_goals; a.gc += m.home_goals;
    if (m.home_goals > m.away_goals) { h.pg++; h.pts += 3; a.pp++; } else if (m.home_goals < m.away_goals) { a.pg++; a.pts += 3; h.pp++; } else { h.pe++; a.pe++; h.pts++; a.pts++; }
  }
  return Object.values(T).sort((a, b) => b.pts - a.pts || (b.gf - b.gc) - (a.gf - a.gc) || b.gf - a.gf || a.team.localeCompare(b.team));
}
function mvpOf(mid) {
  const rs = S.results.filter(r => r.match_id === mid && r.mvp_votes > 0).sort((a, b) => b.mvp_votes - a.mvp_votes || (b.avg_score || 0) - (a.avg_score || 0));
  return rs[0]?.player_id;
}
function totals(compId) {
  const mids = new Set(S.matches.filter(m => !compId || m.competition_id === compId).map(m => m.id)), T = {};
  for (const p of S.players) T[p.id] = { p, pj: 0, goals: 0, assists: 0, yellow: 0, red: 0, own_goals: 0, mvp: 0, sum: 0, n: 0 };
  for (const s of S.stats) if (mids.has(s.match_id) && T[s.player_id]) { const t = T[s.player_id]; t.pj++; for (const k of ['goals', 'assists', 'yellow', 'red', 'own_goals']) t[k] += s[k] || 0; }
  for (const mid of mids) { const w = mvpOf(mid); if (w && T[w]) T[w].mvp++; }
  for (const r of S.results) if (mids.has(r.match_id) && r.avg_score != null && T[r.player_id]) { T[r.player_id].sum += +r.avg_score; T[r.player_id].n++; }
  return Object.values(T).map(t => ({ ...t, avg: t.n ? t.sum / t.n : null })).filter(t => (t.p.active && !isCoach(t.p)) || t.pj);
}
const resultOf = m => { if (!played(m)) return ''; const d = (m.home_goals - m.away_goals) * (isUs(m.home) ? 1 : -1); return d > 0 ? 'W' : d < 0 ? 'L' : 'D'; };
const RES = { W: 'Victoria', D: 'Empate', L: 'Derrota' };

/* ---------- Diálogos ---------- */
const dlg = $('#dlg');
function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 2600); }
function formDlg(title, body, onSubmit, label = 'Guardar') {
  dlg.innerHTML = `<form id="dlgform"><h2>${esc(title)}</h2><div class="fields">${body}</div><p class="err" id="dlgerr" hidden></p>
    <div class="row end"><button type="button" class="btn ghost" data-act="close">Cancelar</button><button class="btn" id="dlgok">${esc(label)}</button></div></form>`;
  dlg.showModal();
  $('#dlgform').onsubmit = async e => {
    e.preventDefault(); const ok = $('#dlgok'); ok.disabled = true; $('#dlgerr').hidden = true;
    try { await onSubmit(Object.fromEntries(new FormData(e.target)), e.target); dlg.close(); }
    catch (err) { const el = $('#dlgerr'); if (el) { el.textContent = err.message || String(err); el.hidden = false; } ok.disabled = false; }
  };
}
const fld = (label, name, val = '', attrs = '') => `<label class="f">${esc(label)}<input id="f_${name}" name="${name}" value="${esc(val)}" ${attrs}></label>`;
const sel = (label, name, opts, val) => `<label class="f">${esc(label)}<select id="f_${name}" name="${name}">${opts.map(([v, t]) => `<option value="${esc(v)}"${v == val ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
const arpc = (fn, args = {}) => api.rpc(fn, { pw: adminPw, ...args });
async function refresh(photos) { S = await api.load(); if (photos) PH = await api.photos(); render(); }

/* ---------- Vistas ---------- */
const view = $('#view');
const V = {};
const fixture = m => `<a href="#partido.${m.id}"><span class="fx"><span>${isUs(m.home) ? `<b>${esc(m.home)}</b>` : esc(m.home)}</span>
  ${played(m) ? `<span class="sc num">${m.home_goals} - ${m.away_goals}</span>` : `<span class="sc t">${m.date ? esc(m.date.slice(8, 10) + '/' + m.date.slice(5, 7)) : 'vs'}</span>`}
  <span>${isUs(m.away) ? `<b>${esc(m.away)}</b>` : esc(m.away)}</span></span></a>`;
const meta = m => `${esc(comp(m.competition_id)?.friendly ? 'Amistoso' : comp(m.competition_id)?.name || '')}${m.round ? ` · Jornada ${m.round}` : ''}`;

V.inicio = () => {
  const today = new Date().toISOString().slice(0, 10);
  const mine = S.matches.filter(ours).sort(byDate);
  const next = mine.find(m => !played(m) && (!m.date || m.date.slice(0, 10) >= today));
  const last = mine.filter(played).pop();
  const voting = mine.filter(m => m.voting_open);
  let h = '';
  if (next) {
    const days = next.date ? Math.round((new Date(next.date.slice(0, 10)) - new Date(today)) / 864e5) : null;
    h += `<a class="hero" href="#partido.${next.id}"><span class="eyebrow">Próximo partido · ${meta(next)}</span>
      <div class="versus"><span>${esc(next.home)}</span><span class="mid">VS</span><span>${esc(next.away)}</span></div>
      <div class="heromet"><span>${esc(fmtDate(next.date, true))}</span>${next.venue ? `<span>${esc(next.venue)}</span>` : ''}${days != null ? `<span><b>${days === 0 ? 'Hoy' : days === 1 ? 'Mañana' : `Faltan ${days} días`}</b></span>` : ''}</div></a>`;
    const rest = S.matches.filter(m => m.competition_id === next.competition_id && !played(m) && m.date && next.date && m.date.slice(0, 10) >= today && m.date < next.date).sort(byDate)[0];
    if (rest) h += `<p class="small muted" style="margin:0">Jornada ${rest.round} (${esc(fmtDate(rest.date))}): ${esc(CFG.team)} descansa.</p>`;
  } else h += `<div class="hero"><span class="eyebrow">Próximo partido</span><h2>Sin partidos programados</h2><span class="heromet">Añade el calendario desde Administración (icono de arriba a la derecha).</span></div>`;
  if (adminPw) for (const m of mine.filter(m => !played(m) && m.date && m.date.slice(0, 10) <= today)) h += `<div class="card"><div class="row between"><div class="grow"><span class="eyebrow">Falta el resultado</span><h3>${esc(m.home)} - ${esc(m.away)}</h3></div><button class="btn" data-act="editmatch" data-id="${m.id}">Poner resultado</button></div></div>`;
  if (next) { const n = S.att.filter(x => x.match_id === next.id && x.status === 'si').length, mine2 = me && attOf(next.id, me.id);
    h += `<div class="card"><div class="row between"><div class="grow"><span class="eyebrow">Convocatoria</span><div><b>${n}</b> ${n === 1 ? 'confirmado' : 'confirmados'}${mine2 ? ` · Tú: ${ATT[mine2]}` : ''}</div></div><a class="btn ${mine2 ? 'ghost' : ''}" href="#partido.${next.id}">${mine2 ? 'Ver' : '¿Vas al partido?'}</a></div></div>`; }
  for (const m of voting) h += `<div class="card"><div class="row between"><div class="grow"><span class="eyebrow">Votación abierta</span><h3>${esc(m.home)} ${m.home_goals ?? ''} - ${m.away_goals ?? ''} ${esc(m.away)}</h3></div><button class="btn neon" data-act="vote" data-id="${m.id}">Puntuar y votar MVP</button></div></div>`;
  if (last) {
    const w = player(mvpOf(last.id)), r = resultOf(last);
    h += `<a class="card" href="#partido.${last.id}"><div class="row between"><span class="eyebrow">Último resultado · ${meta(last)}</span><span class="pill ${r}">${RES[r]}</span></div>
      <div class="versus"><span>${esc(last.home)}</span><span class="mid score num">${last.home_goals} - ${last.away_goals}</span><span>${esc(last.away)}</span></div>
      ${w ? `<div class="row">${avatar(w, 32)}<span><span class="pill neon">MVP</span> <b>${esc(w.name)}</b></span></div>` : ''}</a>`;
  }
  const c = [comp(next?.competition_id), comp(last?.competition_id), ...comps()].find(x => x && !x.friendly);
  if (c) {
    const st = standings(c), i = st.findIndex(r => isUs(r.team));
    if (i >= 0) { const r = st[i]; h += `<a href="#clasificacion" data-act="setcomp" data-id="${c.id}"><div class="eyebrow" style="margin-bottom:8px">${esc(c.name)}</div><div class="tiles">
      <div class="tile"><b class="num">${i + 1}º</b><span>Posición</span></div><div class="tile"><b class="num">${r.pts}</b><span>Puntos</span></div>
      <div class="tile"><b class="num">${r.pj}</b><span>Jugados</span></div><div class="tile"><b class="num">${r.gf}-${r.gc}</b><span>Goles</span></div></div></a>`; }
  }
  const top = totals().filter(t => t.goals).sort((a, b) => b.goals - a.goals).slice(0, 3);
  if (top.length) h += `<div class="card"><div class="row between"><h2>Goleadores</h2><a class="small muted" href="#estadisticas">Ver todo</a></div><div class="list rank">${top.map((t, i) => rankRow(t, i, t.goals, top[0].goals)).join('')}</div></div>`;
  return h;
};
const rankRow = (t, i, val, max) => `<a href="#jugador.${t.p.id}"><span class="pos">${i + 1}</span>${avatar(t.p, 40)}<span class="grow"><b>${esc(t.p.name)}</b><div class="bar"><i style="width:${max ? Math.max(4, (parseFloat(val) || 0) / max * 100) : 0}%"></i></div></span><span class="val num">${val}</span></a>`;
const compChips = (cur, act, all, noFr) => `<div class="chips">${all ? `<button class="chip${!cur ? ' on' : ''}" data-act="${act}" data-id="">Todas</button>` : ''}${comps().filter(c => !(noFr && c.friendly)).map(c => `<button class="chip${c.id === cur ? ' on' : ''}" data-act="${act}" data-id="${c.id}">${esc(c.name)}</button>`).join('')}</div>`;
const curComp = () => comp(ui.comp) || comps()[0];
const ATT = { si: 'Voy', duda: 'En duda', no: 'No puedo' };
const attOf = (mid, pid) => S.att.find(x => x.match_id === mid && x.player_id === pid)?.status;

V.clasificacion = () => {
  let c = curComp(); if (c?.friendly) c = comps().find(x => !x.friendly); if (!c) return empty('Todavía no hay competiciones.');
  if (!standings(c).length) return `<h1>Clasificación</h1>${compChips(c.id, 'setcomp', false, true)}${empty('Esta competición todavía no tiene equipos ni partidos.')}`;
  return `<h1>Clasificación</h1>${compChips(c.id, 'setcomp', false, true)}<div class="card scroll"><table><thead><tr><th>#</th><th class="l">Equipo</th><th>Pts</th><th>PJ</th><th>PG</th><th>PE</th><th>PP</th><th>GF</th><th>GC</th><th>DG</th></tr></thead><tbody>
    ${standings(c).map((r, i) => `<tr class="${isUs(r.team) ? 'us' : ''}"><td>${i + 1}</td><td class="l">${esc(r.team)}</td><td class="pts">${r.pts}</td><td>${r.pj}</td><td>${r.pg}</td><td>${r.pe}</td><td>${r.pp}</td><td>${r.gf}</td><td>${r.gc}</td><td>${r.gf - r.gc > 0 ? '+' : ''}${r.gf - r.gc}</td></tr>`).join('')}
    </tbody></table></div><p class="small muted">La tabla se calcula sola con los resultados del calendario.</p>`;
};
const empty = t => `<div class="card"><p class="muted" style="margin:0">${t}</p></div>`;

V.partidos = () => {
  const c = curComp(); if (!c) return empty('Todavía no hay competiciones.');
  const ms = S.matches.filter(m => m.competition_id === c.id && (!ui.onlyUs || ours(m))).sort((a, b) => (a.round || 0) - (b.round || 0) || byDate(a, b));
  const groups = new Map(); for (const m of ms) { const k = m.round || 0; (groups.get(k) || groups.set(k, []).get(k)).push(m); }
  return `<h1>Calendario</h1>${compChips(c.id, 'setcomp')}
    <label class="row small"><input type="checkbox" id="onlyus" data-chg="onlyus" ${ui.onlyUs ? 'checked' : ''}> Solo partidos de ${esc(CFG.team)}</label>
    ${ms.length ? [...groups].map(([k, g]) => `<div class="card"><div class="row between"><h3>${k ? 'Jornada ' + k : 'Sin jornada'}</h3><span class="small muted">${esc(fmtDate(g[0].date))}</span></div><div class="list">${g.map(fixture).join('')}</div></div>`).join('') : empty('No hay partidos en esta competición.')}`;
};

V.partido = id => {
  const m = S.matches.find(x => x.id === id); if (!m) return empty('Partido no encontrado.');
  const st = S.stats.filter(s => s.match_id === id).map(s => ({ s, p: player(s.player_id), r: S.results.find(r => r.match_id === id && r.player_id === s.player_id) })).filter(x => x.p).sort((a, b) => byName(a.p, b.p));
  const w = mvpOf(id), voters = S.voters.filter(v => v.match_id === id), r = ours(m) ? resultOf(m) : '';
  let h = `<a class="small muted" href="#partidos">‹ Calendario</a><div class="hero"><div class="row between"><span class="eyebrow">${meta(m)}</span>${r ? `<span class="pill ${r}">${RES[r]}</span>` : ''}</div>
    <div class="versus"><span>${esc(m.home)}</span><span class="mid ${played(m) ? 'score num' : ''}">${played(m) ? `${m.home_goals} - ${m.away_goals}` : 'VS'}</span><span>${esc(m.away)}</span></div>
    <div class="heromet"><span>${esc(fmtDate(m.date, true))}</span>${m.venue ? `<span>${esc(m.venue)}</span>` : ''}</div></div>`;
  if (adminPw) h += `<div class="row"><button class="btn sm" data-act="editmatch" data-id="${id}">${played(m) ? 'Editar partido y resultado' : 'Poner resultado'}</button>
    ${ours(m) ? `<button class="btn sm" data-act="editstats" data-id="${id}">Estadísticas de jugadores</button><button class="btn sm ${m.voting_open ? 'ghost' : 'neon'}" data-act="togglevote" data-id="${id}">${m.voting_open ? 'Cerrar votación' : 'Abrir votación'}</button>` : ''}
    <button class="btn sm danger" data-act="delmatch" data-id="${id}">Eliminar</button></div>`;
  if (m.voting_open) h += `<div class="card"><div class="row between"><div class="grow"><span class="eyebrow">Votación abierta</span><div>${voters.length ? `Han votado ${voters.length}: ${voters.map(v => esc(player(v.voter_id)?.name || '')).join(', ')}` : 'Todavía no ha votado nadie.'}</div></div><button class="btn neon" data-act="vote" data-id="${id}">Puntuar y votar MVP</button></div><p class="small muted" style="margin:0">Las notas y el MVP se publican cuando se cierre la votación.</p></div>`;
  else if (w) h += `<a class="card" href="#jugador.${w}"><div class="row">${avatar(player(w), 56)}<div><span class="pill neon">MVP del partido</span><h2 style="margin-top:4px">${esc(player(w).name)}</h2></div></div></a>`;
  if (ours(m) && !st.length) {
    const ps = S.players.filter(p => p.active && !isCoach(p)).sort(byName), by = k => ps.filter(p => (attOf(id, p.id) || '') === k), my = me && attOf(id, me.id);
    const line = (k, label) => by(k).length ? `<div><b>${label} (${by(k).length}):</b> ${by(k).map(p => esc(p.name)).join(', ')}</div>` : '';
    h += `<div class="card"><div class="row between"><h2>Convocatoria</h2>${adminPw ? `<button class="btn sm ghost" data-act="editatt" data-id="${id}">Editar</button>` : ''}</div>
      <div class="row">${Object.entries(ATT).map(([k, l]) => `<button class="chip${my === k ? ' on' : ''}" data-act="attend" data-id="${id}" data-st="${k}">${l}</button>`).join('')}</div>
      ${me && player(me.id) ? `<span class="small muted">Respondes como ${esc(player(me.id).name)}.</span>` : ''}
      ${line('si', 'Van')}${line('duda', 'En duda')}${line('no', 'No pueden')}${line('', 'Sin responder')}</div>`;
  }
  if (st.length) h += `<div class="card scroll"><table><thead><tr><th class="l">Jugador</th><th>Goles</th><th>Asist.</th><th>Tarj.</th><th>Nota</th><th>MVP</th></tr></thead><tbody>
    ${st.map(({ s, p, r }) => `<tr><td class="l"><a href="#jugador.${p.id}">${esc(p.name)}</a></td><td>${s.goals || '·'}</td><td>${s.assists || '·'}</td><td>${'<i class="cardy"></i> '.repeat(s.yellow)}${'<i class="cardr"></i> '.repeat(s.red)}${s.yellow + s.red ? '' : '·'}</td><td>${r?.avg_score != null ? (+r.avg_score).toFixed(1) : '·'}</td><td>${r?.mvp_votes || '·'}</td></tr>`).join('')}</tbody></table></div>`;
  else if (ours(m) && played(m)) h += empty('Aún no se han cargado las estadísticas de este partido.');
  return h;
};

V.plantilla = () => {
  const all = S.players.filter(p => p.active).sort(byName), ps = all.filter(p => !isCoach(p)), cs = all.filter(isCoach);
  const grid = l => `<div class="squad">${l.map(p => `<a href="#jugador.${p.id}">${avatar(p, 76)}<span>${esc(p.name)}${p.number != null ? ` <span class="muted num">${p.number}</span>` : ''}</span></a>`).join('')}</div>`;
  return `<h1>Plantilla</h1>${ps.length ? grid(ps) : empty('Todavía no hay jugadores.')}${cs.length ? `<h2>Cuerpo técnico</h2>${grid(cs)}` : ''}`;
};

V.jugador = id => {
  const p = player(id); if (!p) return empty('Jugador no encontrado.');
  const t = totals().find(x => x.p.id === id) || { pj: 0, goals: 0, assists: 0, yellow: 0, red: 0, mvp: 0, avg: null };
  const log = S.stats.filter(s => s.player_id === id).map(s => ({ s, m: S.matches.find(m => m.id === s.match_id) })).filter(x => x.m).sort((a, b) => byDate(b.m, a.m));
  return `<a class="small muted" href="#plantilla">‹ Plantilla</a><div class="row">${avatar(p, 104)}<div class="grow"><h1>${esc(p.name)}</h1>
    <div class="muted">${[p.number != null ? 'Dorsal ' + p.number : '', p.position].filter(Boolean).map(esc).join(' · ') || 'Jugador'}</div>
    <button class="btn sm ghost" style="margin-top:8px" data-act="photo" data-id="${id}">${PH[id] ? 'Cambiar foto' : 'Poner foto'}</button></div></div>
    ${isCoach(p) && !t.pj ? '' : `<div class="tiles">${[['Partidos', t.pj], ['Goles', t.goals], ['Asist.', t.assists], ['MVP', t.mvp], ['Nota', t.avg != null ? t.avg.toFixed(1) : '–'], ['Amarillas', t.yellow], ['Rojas', t.red]].map(([l, v]) => `<div class="tile"><b class="num">${v}</b><span>${l}</span></div>`).join('')}</div>
    <div class="card"><h2>Partidos jugados</h2>${log.length ? `<div class="list">${log.map(({ s, m }) => { const r = S.results.find(r => r.match_id === m.id && r.player_id === id);
      return `<a href="#partido.${m.id}"><span class="grow"><b>${esc(isUs(m.home) ? m.away : m.home)}</b> <span class="muted num">${played(m) ? `${m.home_goals}-${m.away_goals}` : ''}</span><div class="small muted">${esc(fmtDate(m.date))}</div></span>
      <span class="small num">${[s.goals ? s.goals + ' gol' + (s.goals > 1 ? 'es' : '') : '', s.assists ? s.assists + ' asist.' : ''].filter(Boolean).join(' · ')}</span>${mvpOf(m.id) === id ? '<span class="pill neon">MVP</span>' : ''}${r?.avg_score != null ? `<span class="pill num">${(+r.avg_score).toFixed(1)}</span>` : ''}</a>`; }).join('')}</div>` : '<p class="muted" style="margin:0">Todavía no ha jugado ningún partido.</p>'}</div>`}`;
};

const METRICS = { goals: ['Goleadores', t => t.goals], assists: ['Asistentes', t => t.assists], most: ['Más partidos', t => t.pj], least: ['Menos partidos', t => t.pj], mvp: ['MVP', t => t.mvp], avg: ['Nota media', t => t.avg], cards: ['Tarjetas', t => t.yellow + t.red * 2] };
V.estadisticas = () => {
  const T = totals(ui.statComp), [, fn] = METRICS[ui.metric];
  let rows = T.filter(t => ui.metric === 'least' ? t.p.active : fn(t) > 0).sort((a, b) => (ui.metric === 'least' ? fn(a) - fn(b) : fn(b) - fn(a)) || byName(a.p, b.p));
  const max = Math.max(1, ...rows.map(t => fn(t) || 0));
  const show = t => ui.metric === 'avg' ? t.avg.toFixed(2) : ui.metric === 'cards' ? `${t.yellow}<i class="cardy"></i> ${t.red}<i class="cardr"></i>` : fn(t);
  return `<h1>Estadísticas</h1>${compChips(ui.statComp, 'statcomp', true)}
    <div class="chips">${Object.entries(METRICS).map(([k, [l]]) => `<button class="chip${k === ui.metric ? ' on' : ''}" data-act="metric" data-id="${k}">${l}</button>`).join('')}</div>
    <div class="card">${rows.length ? `<div class="list rank">${rows.map((t, i) => rankRow(t, i, show(t), ui.metric === 'cards' ? 0 : max)).join('')}</div>` : '<p class="muted" style="margin:0">Aún no hay datos para esta tabla.</p>'}</div>
    <h2>Tabla completa</h2><div class="card scroll"><table><thead><tr><th class="l">Jugador</th><th>PJ</th><th>G</th><th>A</th><th>TA</th><th>TR</th><th>PP</th><th>MVP</th><th>Nota</th></tr></thead><tbody>
    ${T.sort((a, b) => b.goals - a.goals || b.assists - a.assists || byName(a.p, b.p)).map(t => `<tr><td class="l"><a href="#jugador.${t.p.id}">${esc(t.p.name)}</a></td><td>${t.pj}</td><td>${t.goals}</td><td>${t.assists}</td><td>${t.yellow}</td><td>${t.red}</td><td>${t.own_goals}</td><td>${t.mvp}</td><td>${t.avg != null ? t.avg.toFixed(1) : '–'}</td></tr>`).join('')}</tbody></table></div>
    <p class="small muted">PJ partidos jugados · G goles · A asistencias · TA/TR tarjetas · PP goles en propia puerta</p>`;
};

V.cuotas = () => {
  if (!adminPw && !me) return `<h1>Cuotas</h1><div class="card"><p style="margin:0">Las cuotas solo las ven los jugadores del equipo. Identifícate con tu nombre y tu PIN.</p><div><button class="btn" data-act="identify" data-then="cuotas">Identificarme</button></div></div>`;
  if (!FEES) { if (!feesErr) loadFees(); return `<h1>Cuotas</h1>${empty(feesErr ? esc(feesErr) : 'Cargando…')}`; }
  const fees = [...FEES.fees].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)), paid = (f, p) => +(FEES.payments.find(x => x.fee_id === f.id && x.player_id === p)?.paid || 0);
  let h = `<div class="row between"><h1>Cuotas</h1>${adminPw ? '<button class="btn sm" data-act="editfee">Añadir cuota</button>' : ''}</div>`;
  if (me && player(me.id)) { const owe = fees.reduce((s, f) => s + Math.max(0, f.amount - paid(f, me.id)), 0);
    h += `<div class="hero"><span class="eyebrow">${esc(player(me.id).name)}</span><h2>${owe > 0 ? 'Te quedan ' + eur(owe) + ' por pagar' : fees.length ? 'Estás al día' : 'No hay cuotas'}</h2></div>`; }
  if (!fees.length) h += empty(adminPw ? 'Todavía no hay cuotas. Crea la primera con "Añadir cuota".' : 'Todavía no hay cuotas.');
  for (const f of fees) {
    const ps = S.players.filter(p => p.active || paid(f, p.id)).sort(byName), tot = ps.reduce((s, p) => s + Math.min(paid(f, p.id), f.amount), 0), done = ps.filter(p => paid(f, p.id) >= f.amount).length;
    h += `<div class="card"><div class="row between"><div class="grow"><h2>${esc(f.name)}</h2><div class="muted small">${eur(f.amount)} por jugador${f.due ? ' · hasta el ' + esc(fmtDate(f.due)) : ''}</div></div>
      ${adminPw ? `<button class="btn sm ghost" data-act="editfee" data-id="${f.id}">Editar</button>` : ''}</div>
      <div><b>${done} de ${ps.length}</b> han pagado · ${eur(tot)} de ${eur(f.amount * ps.length)}<div class="bar"><i style="width:${ps.length && f.amount ? tot / (f.amount * ps.length) * 100 : 0}%"></i></div></div>
      <div class="list wrap">${ps.map(p => { const v = paid(f, p.id), ok = v >= f.amount;
        return `<div>${avatar(p, 32)}<span class="grow"><b>${esc(p.name)}</b></span><span class="pill ${ok ? 'W' : v > 0 ? 'D' : 'L'}">${ok ? 'Pagado' : v > 0 ? 'Faltan ' + eur(f.amount - v) : 'Pendiente'}</span>
        ${adminPw ? `<button class="btn sm ghost" data-act="pay" data-fee="${f.id}" data-id="${p.id}" data-amount="${ok ? 0 : f.amount}">${ok ? 'Quitar' : 'Pagado'}</button><button class="btn sm ghost" data-act="paypart" data-fee="${f.id}" data-id="${p.id}" aria-label="Importe parcial de ${esc(p.name)}">€</button>` : ''}</div>`; }).join('')}</div></div>`;
  }
  return h;
};

V.admin = () => {
  if (!adminPw) return `<h1>Administración</h1><div class="card"><p style="margin:0">Zona para quien lleva el equipo: resultados, estadísticas, jugadores y votaciones.</p><div><button class="btn" data-act="login">Entrar con contraseña</button></div></div>
    ${me ? `<div class="card"><div class="row between"><span>Identificado como <b>${esc(player(me.id)?.name || '')}</b></span><button class="btn sm ghost" data-act="forgetme">Cambiar de jugador</button></div></div>` : ''}`;
  const ps = [...S.players].sort(byName);
  return `<div class="row between"><h1>Administración</h1><button class="btn sm ghost" data-act="logout">Salir</button></div>
    ${!S.players.length && !S.comps.length ? `<div class="card"><p style="margin:0">La base de datos está vacía.</p><div><button class="btn" data-act="seed">Cargar plantilla y calendario de liga</button></div></div>` : ''}
    <div class="card"><div class="row between"><h2>Partidos</h2><div class="row"><button class="btn sm" data-act="editmatch">Añadir partido</button><button class="btn sm ghost" data-act="bulk">Añadir varios</button></div></div>
      <p class="small muted" style="margin:0">Para poner un resultado, cargar estadísticas o abrir la votación, entra en el partido desde Calendario.</p></div>
    <div class="card"><div class="row between"><h2>Competiciones</h2><button class="btn sm" data-act="editcomp">Añadir</button></div><div class="list">
      ${comps().map(c => `<div><span class="grow"><b>${esc(c.name)}</b> <span class="muted small">${c.teams.length} equipos</span></span><button class="btn sm ghost" data-act="editcomp" data-id="${c.id}">Editar</button><button class="btn sm danger" data-act="delcomp" data-id="${c.id}">Eliminar</button></div>`).join('')}</div></div>
    <div class="card"><div class="row between"><h2>Jugadores (${ps.length})</h2><button class="btn sm" data-act="editplayer">Añadir</button></div><div class="list">
      ${ps.map(p => `<div>${avatar(p, 36)}<span class="grow"><b>${esc(p.name)}</b>${p.active ? '' : ' <span class="pill">Baja</span>'}</span><button class="btn sm ghost" data-act="editplayer" data-id="${p.id}">Editar</button></div>`).join('')}</div></div>
    <div class="card"><h2>Seguridad</h2><div><button class="btn sm ghost" data-act="chpw">Cambiar contraseña de administrador</button></div></div>`;
};

/* ---------- Acciones ---------- */
const POS = [['', 'Sin posición'], ['Portero', 'Portero'], ['Defensa', 'Defensa'], ['Centrocampista', 'Centrocampista'], ['Delantero', 'Delantero'], ['Entrenador', 'Entrenador (cuerpo técnico)']];
const A = {
  close: () => dlg.close(),
  setcomp: d => { ui.comp = d.id; render(); },
  statcomp: d => { ui.statComp = d.id; render(); },
  metric: d => { ui.metric = d.id; render(); },
  login: () => formDlg('Administración', fld('Contraseña', 'pw', '', 'type="password" required autocomplete="current-password"'), async f => {
    if (!await api.rpc('admin_check', { pw: f.pw })) throw new Error('Contraseña incorrecta');
    adminPw = f.pw; try { sessionStorage.setItem('odp-admin', f.pw); } catch {} FEES = null; feesErr = ''; render();
  }, 'Entrar'),
  logout: () => { if (dlg.open) dlg.close(); toast('Sesión de administrador cerrada'); FEES = null; feesErr = ''; adminPw = null; try { sessionStorage.removeItem('odp-admin'); } catch {} render(); },
  forgetme: () => { if (dlg.open) dlg.close(); toast('Sesión cerrada'); FEES = null; feesErr = ''; me = null; ls.del('odp-me'); render(); },
  chpw: () => formDlg('Cambiar contraseña', fld('Nueva contraseña (mínimo 6 caracteres)', 'n', '', 'type="password" required minlength="6"'), async f => {
    await arpc('admin_set_password', { newpw: f.n }); adminPw = f.n; try { sessionStorage.setItem('odp-admin', f.n); } catch {} toast('Contraseña cambiada');
  }),
  seed: async () => {
    await arpc('admin_upsert', { tbl: 'players', rows: SEED.players.map(name => ({ id: uid(), name, number: null, position: null, active: true })) });
    const L = SEED.league, lid = uid(), ms = [], mk = (round, date, home, away) => ms.push({ id: uid(), competition_id: lid, round, date, venue: null, home, away, home_goals: null, away_goals: null, voting_open: false });
    for (const [r1, r2, d1, d2, pairs] of L.rounds) for (const [h, a] of pairs) { mk(r1, d1, h, a); mk(r2, d2, a, h); }
    await arpc('admin_upsert', { tbl: 'competitions', rows: [{ id: lid, name: L.name, teams: [...new Set(ms.flatMap(m => [m.home, m.away]))].sort(), sort: 0, friendly: false }, ...SEED.competitions.map((c, i) => ({ id: uid(), name: c.name, teams: c.teams, sort: i + 1, friendly: false }))] });
    await arpc('admin_upsert', { tbl: 'matches', rows: ms });
    await refresh(); toast('Datos iniciales cargados');
  },
  editplayer: d => {
    const p = player(d.id) || { id: uid(), name: '', number: null, position: '', active: true }, isNew = !d.id;
    formDlg(isNew ? 'Nuevo jugador' : p.name, `${fld('Nombre', 'name', p.name, 'required')}<div class="two">${fld('Dorsal', 'number', p.number ?? '', 'type="number" min="0" max="99"')}${sel('Posición', 'position', POS, p.position || '')}</div>
      <label class="row"><input type="checkbox" id="f_active" name="active" ${p.active ? 'checked' : ''}> En la plantilla actual</label>
      ${isNew ? '' : `<div class="row"><button type="button" class="btn sm ghost" data-act="photo" data-id="${p.id}">Foto</button><button type="button" class="btn sm ghost" data-act="resetpin" data-id="${p.id}">Borrar su PIN</button><button type="button" class="btn sm danger" data-act="delplayer" data-id="${p.id}">Eliminar</button></div>
      <p class="small muted" style="margin:0">Si deja el equipo, desmarca la casilla en vez de eliminarlo: así se conservan sus estadísticas.</p>`}`, async f => {
      await arpc('admin_upsert', { tbl: 'players', rows: [{ id: p.id, name: f.name.trim().toUpperCase(), number: int(f.number), position: f.position || null, active: !!f.active }] }); await refresh();
    });
  },
  resetpin: async d => { await arpc('admin_reset_pin', { pid: d.id }); toast('PIN borrado: elegirá uno nuevo al entrar'); },
  delplayer: d => formDlg('¿Eliminar a ' + player(d.id).name + '?', '<p style="margin:0">Se borran también sus estadísticas y votos. No se puede deshacer.</p>', async () => { await arpc('admin_delete', { tbl: 'players', rid: d.id }); await refresh(); }, 'Eliminar'),
  editcomp: d => {
    const c = comp(d.id) || { id: uid(), name: '', teams: [CFG.team], sort: S.comps.length };
    formDlg(d.id ? 'Editar competición' : 'Nueva competición', `${fld('Nombre', 'name', c.name, 'required placeholder="Liga 2026/27"')}<label class="f">Equipos (uno por línea)<textarea id="f_teams" name="teams" rows="10">${esc(c.teams.join('\n'))}</textarea></label>`, async f => {
      await arpc('admin_upsert', { tbl: 'competitions', rows: [{ id: c.id, name: f.name.trim(), teams: [...new Set(f.teams.split('\n').map(t => t.trim().toUpperCase()).filter(Boolean))], sort: c.sort ?? 0, friendly: !!c.friendly }] }); await refresh();
    });
  },
  delcomp: d => formDlg('¿Eliminar ' + comp(d.id).name + '?', '<p style="margin:0">Se borran también todos sus partidos, estadísticas y votos. No se puede deshacer.</p>', async () => { await arpc('admin_delete', { tbl: 'competitions', rid: d.id }); await refresh(); }, 'Eliminar'),
  editmatch: d => {
    const fr = S.comps.find(c => c.friendly);
    const m = S.matches.find(x => x.id === d.id) || { id: uid(), competition_id: curComp()?.id || '__f', round: null, date: '', venue: '', home: '', away: '', home_goals: null, away_goals: null, voting_open: false };
    const teams = [...new Set(S.comps.flatMap(c => c.teams))].sort();
    formDlg(d.id ? 'Editar partido' : 'Nuevo partido', `${sel('Competición', 'competition_id', [...comps().map(c => [c.id, c.name]), ...(fr ? [] : [['__f', 'Amistoso']])], m.competition_id)}
      <div class="two">${fld('Jornada', 'round', m.round ?? '', 'type="number" min="1"')}${fld('Fecha y hora', 'date', m.date || '', 'type="datetime-local"')}</div>${fld('Campo', 'venue', m.venue || '')}
      <datalist id="teams">${teams.map(t => `<option value="${esc(t)}">`).join('')}</datalist>
      <div class="two">${fld('Local', 'home', m.home, 'required list="teams"')}${fld('Visitante', 'away', m.away, 'required list="teams"')}</div>
      <div class="two">${fld('Goles local', 'hg', m.home_goals ?? '', 'type="number" min="0"')}${fld('Goles visitante', 'ag', m.away_goals ?? '', 'type="number" min="0"')}</div>
      <p class="small muted" style="margin:0">Deja los goles vacíos si aún no se ha jugado.</p>`, async f => {
      if (f.competition_id === '__f') { f.competition_id = uid(); await arpc('admin_upsert', { tbl: 'competitions', rows: [{ id: f.competition_id, name: 'Amistosos', teams: [], sort: 99, friendly: true }] }); }
      await arpc('admin_upsert', { tbl: 'matches', rows: [{ id: m.id, competition_id: f.competition_id, round: int(f.round), date: f.date || null, venue: f.venue.trim() || null, home: f.home.trim().toUpperCase(), away: f.away.trim().toUpperCase(), home_goals: int(f.hg), away_goals: int(f.ag), voting_open: m.voting_open }] });
      await refresh();
    });
  },
  bulk: () => {
    if (!S.comps.length) return toast('Primero crea una competición');
    formDlg('Añadir varios partidos', `${sel('Competición', 'competition_id', comps().map(c => [c.id, c.name]), curComp().id)}
      <label class="f">Un partido por línea: jornada; fecha hora; local; visitante<textarea id="f_lines" name="lines" rows="9" required placeholder="1; 2026-10-18 10:30; OS DO PUNTO; COUSO&#10;1; 2026-10-18 12:00; CHAIN; ALOIA"></textarea></label>`, async f => {
      const rows = f.lines.split('\n').map(l => l.trim()).filter(Boolean).map((l, i) => {
        const [r, dt, home, away] = l.split(';').map(x => x.trim());
        if (!home || !away) throw new Error(`Línea ${i + 1}: faltan datos (jornada; fecha hora; local; visitante)`);
        if (dt && !/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?$/.test(dt)) throw new Error(`Línea ${i + 1}: la fecha debe ser AAAA-MM-DD HH:MM`);
        return { id: uid(), competition_id: f.competition_id, round: int(r), date: dt ? dt.replace(' ', 'T') : null, venue: null, home: home.toUpperCase(), away: away.toUpperCase(), home_goals: null, away_goals: null, voting_open: false };
      });
      await arpc('admin_upsert', { tbl: 'matches', rows });
      const c = comp(f.competition_id), teams = [...new Set([...c.teams, ...rows.flatMap(r => [r.home, r.away])])];
      if (teams.length > c.teams.length) await arpc('admin_upsert', { tbl: 'competitions', rows: [{ ...c, teams }] });
      ui.comp = c.id; await refresh(); toast(rows.length + ' partidos añadidos');
    }, 'Añadir');
  },
  delmatch: d => formDlg('¿Eliminar este partido?', '<p style="margin:0">Se borran también sus estadísticas y votos. No se puede deshacer.</p>', async () => { await arpc('admin_delete', { tbl: 'matches', rid: d.id }); location.hash = '#partidos'; await refresh(); }, 'Eliminar'),
  togglevote: async d => {
    const m = S.matches.find(x => x.id === d.id);
    if (!m.voting_open && !S.stats.some(s => s.match_id === m.id)) return toast('Antes marca quién jugó en "Estadísticas de jugadores"');
    await arpc('admin_upsert', { tbl: 'matches', rows: [{ ...m, voting_open: !m.voting_open }] }); await refresh(); toast(m.voting_open ? 'Votación cerrada: resultados publicados' : 'Votación abierta');
  },
  editstats: d => {
    const cur = Object.fromEntries(S.stats.filter(s => s.match_id === d.id).map(s => [s.player_id, s]));
    const hasStats = Object.keys(cur).length > 0, ps = S.players.filter(p => (p.active && !isCoach(p)) || cur[p.id]).sort(byName), n = (k, p) => `<input type="number" min="0" max="20" inputmode="numeric" id="${k}_${p.id}" name="${k}_${p.id}" value="${cur[p.id]?.[{ g: 'goals', a: 'assists', y: 'yellow', r: 'red', o: 'own_goals' }[k]] || ''}" aria-label="${k}">`;
    formDlg('Estadísticas del partido', `<p class="small muted" style="margin:0">Marca quién jugó. G goles · A asistencias · TA/TR tarjetas · PP propia puerta</p>
      <div class="sg"><span></span><span></span>${['G', 'A', 'TA', 'TR', 'PP'].map(x => `<span class="h">${x}</span>`).join('')}
      ${ps.map(p => `<label for="pl_${p.id}">${esc(p.name)}</label><input type="checkbox" id="pl_${p.id}" name="pl_${p.id}" ${cur[p.id] || (!hasStats && attOf(d.id, p.id) === 'si') ? 'checked' : ''}>${['g', 'a', 'y', 'r', 'o'].map(k => n(k, p)).join('')}`).join('')}</div>`, async f => {
      const rows = ps.map(p => ({ match_id: d.id, player_id: p.id, goals: +f['g_' + p.id] || 0, assists: +f['a_' + p.id] || 0, yellow: +f['y_' + p.id] || 0, red: +f['r_' + p.id] || 0, own_goals: +f['o_' + p.id] || 0, on: !!f['pl_' + p.id] }))
        .filter(r => r.on || r.goals || r.assists || r.yellow || r.red || r.own_goals).map(({ on, ...r }) => r);
      await arpc('admin_set_stats', { mid: d.id, rows }); await refresh(); toast('Estadísticas guardadas');
    });
  },
  photo: d => {
    const p = player(d.id), needPin = !adminPw && !(me && me.id === p.id);
    formDlg('Foto de ' + p.name, `<label class="f">Elige una foto<input type="file" id="f_file" name="file" accept="image/*" required></label>
      ${needPin ? fld('PIN de ' + p.name, 'pin', '', 'type="password" inputmode="numeric" required minlength="4" autocomplete="off"') + '<p class="small muted" style="margin:0">Solo cada jugador puede cambiar su foto. Si es tu primera vez, el PIN que escribas quedará como tuyo.</p>' : ''}`, async (f, form) => {
      let secret = adminPw || me?.pin;
      if (needPin) { if (!await api.rpc('pin_login', { pid: p.id, pin: f.pin })) throw new Error('PIN incorrecto'); me = { id: p.id, pin: f.pin }; ls.set('odp-me', me); secret = f.pin; }
      const data = await fileToPhoto($('#f_file', form).files[0]);
      await api.rpc('set_photo', { pid: p.id, secret, data }); await refresh(true); toast('Foto guardada');
    });
  },
  identify: d => A.vote({ ...d, only: 1 }),
  session: () => {
    const p = me && player(me.id);
    formDlg('Sesión', `<div class="row between"><span class="grow">${p ? `Jugador: <b>${esc(p.name)}</b>` : 'No te has identificado como jugador.'}</span><button type="button" class="btn sm ${p ? 'danger' : ''}" data-act="${p ? 'forgetme' : 'identify'}">${p ? 'Cerrar sesión' : 'Identificarme'}</button></div>
      <div class="row between"><span class="grow">${adminPw ? '<b>Administrador</b>: sesión abierta.' : 'Administrador: sin sesión.'}</span><button type="button" class="btn sm ${adminPw ? 'danger' : 'ghost'}" data-act="${adminPw ? 'logout' : 'login'}">${adminPw ? 'Salir de administrador' : 'Entrar'}</button></div>
      <p class="small muted" style="margin:0">Si te has identificado con el nombre equivocado, cierra sesión y vuelve a entrar con el tuyo.</p>`, async () => {}, 'Listo');
  },
  attend: async d => {
    if (!me || !player(me.id)) return A.vote({ only: 1, after: () => A.attend(d) });
    try { await api.rpc('set_attendance', { pid: me.id, secret: me.pin, mid: d.id, st: attOf(d.id, me.id) === d.st ? null : d.st }); }
    catch (e) { if (/PIN/.test(e.message)) { me = null; ls.del('odp-me'); } throw e; }
    await refresh();
  },
  editatt: d => {
    const ps = S.players.filter(p => p.active && !isCoach(p)).sort(byName);
    formDlg('Convocatoria', ps.map(p => `<div class="row between"><label for="f_at_${p.id}">${esc(p.name)}</label><select id="f_at_${p.id}" name="at_${p.id}" style="width:auto">${[['', 'Sin responder'], ...Object.entries(ATT)].map(([v, t]) => `<option value="${v}"${(attOf(d.id, p.id) || '') === v ? ' selected' : ''}>${t}</option>`).join('')}</select></div>`).join(''), async f => {
      for (const p of ps) if ((attOf(d.id, p.id) || '') !== f['at_' + p.id]) await api.rpc('set_attendance', { pid: p.id, secret: adminPw, mid: d.id, st: f['at_' + p.id] || null });
      await refresh();
    });
  },
  editfee: d => {
    const f = FEES?.fees.find(x => x.id === d.id) || { id: uid(), name: '', amount: '', due: '', sort: FEES?.fees.length || 0 };
    formDlg(d.id ? 'Editar cuota' : 'Nueva cuota', `${fld('Concepto', 'name', f.name, 'required placeholder="Cuota temporada 2026/27"')}<div class="two">${fld('Importe por jugador (€)', 'amount', f.amount, 'type="number" min="0" step="0.01" required')}${fld('Fecha límite', 'due', f.due || '', 'type="date"')}</div>
      ${d.id ? `<div><button type="button" class="btn sm danger" data-act="delfee" data-id="${f.id}">Eliminar cuota</button></div>` : ''}`, async x => {
      await arpc('admin_upsert', { tbl: 'fees', rows: [{ id: f.id, name: x.name.trim(), amount: +x.amount, due: x.due || null, sort: f.sort ?? 0 }] }); await loadFees();
    });
  },
  delfee: d => formDlg('¿Eliminar esta cuota?', '<p style="margin:0">Se borran también los pagos apuntados. No se puede deshacer.</p>', async () => { await arpc('admin_delete', { tbl: 'fees', rid: d.id }); await loadFees(); }, 'Eliminar'),
  pay: async d => { await arpc('admin_set_payment', { fid: d.fee, pid: d.id, amount: +d.amount }); await loadFees(); },
  paypart: d => formDlg('Pago de ' + player(d.id).name, fld('Importe pagado hasta ahora (€)', 'amount', FEES.payments.find(x => x.fee_id === d.fee && x.player_id === d.id)?.paid ?? '', 'type="number" min="0" step="0.01" required'), async f => { await arpc('admin_set_payment', { fid: d.fee, pid: d.id, amount: +f.amount }); await loadFees(); }),
  vote: d => {
    if (d.only || !me || !player(me.id)) {
      return formDlg('¿Quién eres?', `${sel('Jugador', 'pid', S.players.filter(p => p.active).sort(byName).map(p => [p.id, p.name]))}${fld('Tu PIN (4 cifras o más)', 'pin', '', 'type="password" inputmode="numeric" required minlength="4" autocomplete="off"')}
        <p class="small muted" style="margin:0">Si es tu primera vez, el PIN que escribas quedará como tuyo. Si lo olvidas, pídele al administrador que lo borre.</p>`, async f => {
        if (!await api.rpc('pin_login', { pid: f.pid, pin: f.pin })) throw new Error('PIN incorrecto');
        me = { id: f.pid, pin: f.pin }; ls.set('odp-me', me); FEES = null; feesErr = ''; if (d.after) setTimeout(d.after); else if (d.only) render(); else setTimeout(() => A.vote(d));
      }, 'Continuar');
    }
    const ps = S.stats.filter(s => s.match_id === d.id).map(s => player(s.player_id)).filter(p => p && p.id !== me.id).sort(byName);
    formDlg('Puntúa a tus compañeros', `<p class="small muted" style="margin:0">Votas como <b>${esc(player(me.id).name)}</b>. Nota del 1 al 10 para cada uno y un MVP. Puedes cambiar tu voto mientras la votación siga abierta.</p>
      ${ps.map(p => `<div class="vote"><div class="row between"><span class="row">${avatar(p, 32)}<b>${esc(p.name)}</b></span><label class="mvpl"><input type="radio" id="mvp_${p.id}" name="mvp" value="${p.id}" required> MVP</label></div>
      <div class="scores">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `<label><input type="radio" id="s_${p.id}_${n}" name="s_${p.id}" value="${n}" required aria-label="${n}"><span>${n}</span></label>`).join('')}</div></div>`).join('')}`, async f => {
      const scores = Object.fromEntries(ps.map(p => [p.id, +f['s_' + p.id]]));
      try { await api.rpc('cast_vote', { pid: me.id, pin: me.pin, mid: d.id, mvp: f.mvp, scores }); }
      catch (e) { if (/PIN/.test(e.message)) { me = null; ls.del('odp-me'); } throw e; }
      await refresh(); toast('Voto guardado. ¡Gracias!');
    }, 'Enviar voto');
  }
};
function fileToPhoto(file) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => { const n = 320, c = document.createElement('canvas'); c.width = c.height = n; const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, n, n); URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', .82)); };
    img.onerror = () => rej(new Error('No se pudo leer la imagen')); img.src = url;
  });
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b || !A[b.dataset.act]) return;
  if (b.tagName !== 'A') e.preventDefault();
  try { await A[b.dataset.act](b.dataset); } catch (err) { toast(err.message || 'Algo ha fallado'); }
});
document.addEventListener('change', e => { if (e.target.dataset.chg === 'onlyus') { ui.onlyUs = e.target.checked; render(); } });

/* ---------- Navegación ---------- */
const TABS = [['inicio', 'Inicio', 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z'], ['clasificacion', 'Clasificación', 'M4 20V10h4v10zM10 20V4h4v16zM16 20v-7h4v7z'], ['partidos', 'Calendario', 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4'], ['plantilla', 'Plantilla', 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20c0-3.5 3-6 7-6s7 2.5 7 6M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14.5c2.5.8 4 2.800 4 5.500'], ['estadisticas', 'Estadísticas', 'M4 20h16M7 16v-5M12 16V6M17 16v-8']];
function render() {
  const [name, arg] = (location.hash.slice(1) || 'inicio').split('.');
  const fn = V[name] || V.inicio, tab = { partido: 'partidos', jugador: 'plantilla' }[name] || (V[name] ? name : 'inicio');
  view.innerHTML = fn(arg);
  const p = me && player(me.id); $('#who').textContent = [p?.name, adminPw ? 'Admin' : ''].filter(Boolean).join(' · ') || 'Entrar'; $('#who').classList.toggle('on', !!(p || adminPw));
  $('#tabs').innerHTML = TABS.map(([k, l, p]) => `<a href="#${k}" class="${k === tab ? 'on' : ''}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${p}"/></svg>${l}</a>`).join('');
}
addEventListener('hashchange', () => { render(); scrollTo(0, 0); });

(async () => {
  $('#demo').hidden = !DEMO;
  try {
    S = await api.load();
    if (DEMO && !S.players.length && !S.comps.length) { adminPw = 'admin'; await A.seed(); adminPw = null; }
    render();
    PH = await api.photos(); render();
  } catch (e) { view.innerHTML = empty('No se han podido cargar los datos: ' + esc(e.message) + '. Revisa config.js y que hayas ejecutado supabase.sql.'); }
})();
})();
