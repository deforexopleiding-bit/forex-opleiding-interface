// modules/klanten-v2/views/commissies-v2.js
//
// Mentoren → Commissies (eerste tab). Eén rustig overzicht van ALLE sales en
// commissies: wie wat verdiend heeft, op welk event, hoe het verdeeld is, wat
// al vrijgegeven is en wat nog binnen moet komen. Plus "+ Sale toewijzen":
// een getekende offerte (vooral een VERLENGING) aan mentor(en) hangen met
// dezelfde regel — de mentor verdient pas wanneer de factuur effectief
// betaald is.
//
// Data: één call GET /api/commissie-overzicht (zelfde bron als het
// mentorzicht en het payout-rapport). Toewijzen: commissie-offertes-zoek →
// commissie-toewijzing-preview → commissie-toewijzing-opslaan. Annuleren:
// commissie-toewijzing-annuleren (typed ANNULEER).
//
// Vensters sluiten alleen via het kruisje of Annuleren (geen klik ernaast).
// Invoervelden zijn uncontrolled (state-only oninput); zoekresultaten worden
// partieel bijgewerkt zodat de cursor blijft staan.

(function () {
  if (!window.DFO) { console.error('[commissies-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[commissies-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, S, render } = window.DFO;
  const H = window.KV_V2.helpers;

  /* ── Helpers ─────────────────────────────────────────────────────────── */
  const asArr = (v) => (Array.isArray(v) ? v : []);
  const eur = (n) => (n == null ? '—' : new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(Number(n) || 0));
  const eur0 = (n) => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0));
  const esc = (v) => (H.esc ? H.esc(v) : String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
  const MAAND_KORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  const MAAND_LANG = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(String(iso).length <= 10 ? iso + 'T00:00:00' : iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return `${d.getDate()} ${MAAND_KORT[d.getMonth()]} ${d.getFullYear()}`;
  }
  function fmtYm(ym, lang) {
    const [y, m] = String(ym || '').split('-');
    const i = Number(m) - 1;
    if (!(i >= 0)) return String(ym || '');
    return lang ? `${MAAND_LANG[i]} ${y}` : `${MAAND_KORT[i]} '${String(y).slice(-2)}`;
  }
  function nuYm() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  const MENTOR_KLEUREN = ['violet', 'blue', 'teal', 'amber', 'emerald', 'rose'];
  const ADMIN_ROLES = new Set(['super_admin', 'admin', 'manager']);
  const isAdmin = () => { try { return ADMIN_ROLES.has(String(S.role || '').toLowerCase()); } catch (_) { return false; } };

  async function api(url, opts, timeoutMs) {
    try {
      if (!window.KV || typeof window.KV.authedJson !== 'function') throw new Error('KV.authedJson nog niet geladen');
      return await Promise.race([
        window.KV.authedJson(url, opts),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs || 20000)),
      ]);
    } catch (e) {
      console.warn('[commissies-v2]', url, '→', e?.message || e);
      return { __error: e?.body?.error || e?.message || 'onbekende fout', __code: e?.body?.code || null, __status: e?.status || null, __body: e?.body || null };
    }
  }
  const post = (url, body, t) => api(url, { method: 'POST', body: JSON.stringify(body || {}) }, t);
  function toast(msg) { try { window.KV?.toast ? window.KV.toast(msg) : console.info(msg); } catch (_) { console.info(msg); } }

  /* ── State ───────────────────────────────────────────────────────────── */
  const _st = {
    data: null, loading: false, error: null, periode: 'alles',
    weergave: 'mentor',            // mentor | event | sale
    f: { mentor: '', event: '', bron: '', status: '' },
    verborgen: new Set(),          // mentoren uit de grafiek
    openEvents: new Set(),
    openSale: null,
    paneel: null,                  // user_id van het zijpaneel
    wiz: null,
    annuleer: null,
    inhaal: null,
    incasso: null,      // venster: { customer_id, deal_id, klant, sinds, reden, scope, bron, bezig, fout }
    opheffen: null,     // venster: { id, klant, reden, bezig, fout }
    koppelKeuze: {},    // invoice_id → gekozen deal_id ('' = geen sale)
  };
  const STATUS = {
    wacht:         { c: 'neutral', l: 'Wacht op betaling' },
    deels:         { c: 'accent',  l: 'Deels vrijgegeven' },
    volledig:      { c: 'ok',      l: 'Volledig vrijgegeven' },
    achterstallig: { c: 'danger',  l: 'Achterstallig' },
    geannuleerd:   { c: 'neutral', l: 'Geannuleerd' },
    incasso:       { c: 'danger',  l: 'Incasso' },
  };
  const statusPill = (s) => { const m = STATUS[s] || STATUS.wacht; return H.pill(m.c, m.l); };

  async function laad() {
    if (_st.loading) return;
    _st.loading = true; _st.error = null;
    const j = await api(`/api/commissie-overzicht?periode=${encodeURIComponent(_st.periode)}`, undefined, 45000);
    _st.loading = false;
    if (!j || j.__error) { _st.error = j?.__error || 'Kon commissies niet laden'; render(); return; }
    _st.data = j; render();
  }

  const kleurVan = (uid) => {
    const ms = asArr(_st.data?.mentoren);
    const i = Math.max(0, ms.findIndex((m) => m.user_id === uid));
    return MENTOR_KLEUREN[i % MENTOR_KLEUREN.length];
  };
  const naamVan = (uid) => asArr(_st.data?.mentoren).find((m) => m.user_id === uid)?.naam || '(mentor)';

  /* ── Globale handlers ────────────────────────────────────────────────── */
  window.__commRetry = () => { _st.data = null; _st.error = null; queueMicrotask(laad); render(); };
  window.__commPeriode = (v) => { _st.periode = v; _st.data = null; queueMicrotask(laad); render(); };
  window.__commWeergave = (v) => { _st.weergave = v; _st.openSale = null; render(); };
  window.__commFilter = (k, v) => { _st.f[k] = v; render(); };
  window.__commToggleMentor = (uid) => { if (_st.verborgen.has(uid)) _st.verborgen.delete(uid); else _st.verborgen.add(uid); render(); };
  window.__commToggleEvent = (k) => { if (_st.openEvents.has(k)) _st.openEvents.delete(k); else _st.openEvents.add(k); render(); };
  window.__commToggleSale = (k) => { _st.openSale = _st.openSale === k ? null : k; render(); };
  window.__commPaneel = (uid) => { _st.paneel = uid || null; render(); };
  window.__commNaarDrilldown = (uid) => {
    _st.paneel = null;
    try { if (typeof window.__mentPickMentor === 'function') window.__mentPickMentor(uid); } catch (_) { /* fail-soft */ }
    window.DFO.goTab('Overzicht');
  };
  if (H.onSearch) H.onSearch('comm-q', () => render(), { debounceMs: 200 });

  /* ── UI-bouwstenen ───────────────────────────────────────────────────── */
  function skel() {
    return `<div class="pad" style="padding-top:16px">
      <div style="height:90px;border-radius:var(--r);background:linear-gradient(90deg,var(--surface-2),var(--surface) 50%,var(--surface-2));background-size:200% 100%;animation:kv-shim 1.4s linear infinite;margin-bottom:14px"></div>
      <div style="height:220px;border-radius:var(--r);background:linear-gradient(90deg,var(--surface-2),var(--surface) 50%,var(--surface-2));background-size:200% 100%;animation:kv-shim 1.4s linear infinite"></div>
    </div>`;
  }
  function errBlk(msg) {
    return `<div class="pad" style="padding-top:16px"><div style="padding:14px 16px;background:var(--rose-soft);border:1px solid var(--rose-line);color:var(--rose);border-radius:var(--r);font-size:13px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <span>⚠ ${esc(msg)}</span><button class="btn btn-ghost btn-sm" onclick="window.__commRetry()">Opnieuw</button></div></div>`;
  }
  const card = (title, dot, body, extra) => `<div class="card" style="margin-bottom:14px">
    <div class="card-head" style="border-bottom:none;padding-bottom:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span class="title-dot" style="background:var(--${dot});box-shadow:0 0 0 3px var(--${dot}-soft)"></span>
      <div class="card-title">${title}</div><div style="margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap">${extra || ''}</div></div>
    <div class="card-body" style="padding:8px 17px 17px">${body}</div></div>`;
  const selectStijl = 'padding:6px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;max-width:100%';
  const inputStijl = 'display:block;width:100%;box-sizing:border-box;min-height:40px;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:16px';
  const lbl = (t) => `<span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">${t}</span>`;

  function voortgang(fractie, kleur) {
    const p = Math.max(0, Math.min(1, Number(fractie) || 0));
    return `<div style="height:6px;border-radius:3px;background:var(--surface-2);overflow:hidden;min-width:60px"><div style="height:100%;width:${(p * 100).toFixed(1)}%;background:var(--${kleur || 'emerald'})"></div></div>`;
  }
  const mentorChip = (uid, naam, bedrag, extra) => `<span style="display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;background:var(--${kleurVan(uid)}-soft);color:var(--${kleurVan(uid)});font-size:11.5px;white-space:nowrap">
    <span style="width:6px;height:6px;border-radius:50%;background:var(--${kleurVan(uid)})"></span>${esc(naam)}${bedrag != null ? ` · <b class="mono">${eur(bedrag)}</b>` : ''}${extra || ''}</span>`;

  function modal(title, body, closeFn, width) {
    // Geen onclick op de achtergrond: sluiten kan alleen via ✕ of Annuleren.
    return `<div style="position:fixed;inset:0;background:rgba(17,23,33,.48);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px">
      <div style="background:var(--surface);color:var(--text);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.32);max-width:${width || 640}px;width:100%;max-height:92vh;overflow:hidden;display:flex;flex-direction:column">
        <div style="padding:14px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div style="font-size:15px;font-weight:600">${title}</div>
          <button class="icon-btn" aria-label="Sluiten" onclick="${closeFn}" style="width:28px;height:28px">✕</button>
        </div>
        <div style="padding:16px 20px;overflow-y:auto;flex:1;min-height:0">${body}</div>
      </div></div>`;
  }

  /* ── Projectiegrafiek: gestapeld per mentor ──────────────────────────── */
  // Achterstallig (schuift mee naar deze maand): schuine arcering in de
  // mentorkleur, zodat het niet verward wordt met gewoon "verwacht".
  const arcering = (k) => `background:repeating-linear-gradient(135deg,var(--${k}) 0 3px,transparent 3px 6px);box-shadow:inset 0 0 0 1px var(--${k})`;
  function grafiek() {
    const proj = asArr(_st.data?.projectie);
    const mentoren = asArr(_st.data?.mentoren);
    if (!proj.length || !mentoren.length) return `<div style="padding:12px;color:var(--text-3);font-size:12.5px">Nog geen commissie om te tonen.</div>`;
    const nu = nuYm();
    let nuIdx = proj.findIndex((p) => p.month === nu);
    if (nuIdx < 0) nuIdx = 0;
    // 6 maanden terug (wat effectief vrijgegeven werd) + 12 vooruit.
    const slice = proj.slice(Math.max(0, nuIdx - 6), Math.min(proj.length, nuIdx + 13));
    const zichtbaar = mentoren.filter((m) => !_st.verborgen.has(m.user_id));
    const tot = (p) => zichtbaar.reduce((s, m) => { const v = p.per_mentor?.[m.user_id]; return s + (v ? (Number(v.betaald) || 0) + (Number(v.verwacht) || 0) : 0); }, 0);
    const mx = slice.reduce((m, p) => Math.max(m, tot(p)), 0);
    const hoogte = 150;
    const bars = slice.map((p) => {
      const t = tot(p);
      const isNu = p.month === nu;
      const segs = zichtbaar.map((m) => {
        const v = p.per_mentor?.[m.user_id];
        if (!v) return '';
        const k = kleurVan(m.user_id);
        const out = [];
        const b = Number(v.betaald) || 0;
        const a = Math.min(Number(v.achterstallig) || 0, Number(v.verwacht) || 0);
        const e = (Number(v.verwacht) || 0) - a;
        if (b > 0 && mx > 0) out.push(`<div title="${esc(m.naam)} · vrijgegeven ${eur(b)}" style="width:100%;height:${Math.max(2, Math.round(b / mx * hoogte))}px;background:var(--${k})"></div>`);
        if (e > 0 && mx > 0) out.push(`<div title="${esc(m.naam)} · verwacht ${eur(e)}" style="width:100%;height:${Math.max(2, Math.round(e / mx * hoogte))}px;background:var(--${k});opacity:.42"></div>`);
        if (a > 0 && mx > 0) out.push(`<div title="${esc(m.naam)} · achterstallig, schuift mee ${eur(a)}" style="width:100%;height:${Math.max(2, Math.round(a / mx * hoogte))}px;${arcering(k)}"></div>`);
        return out.reverse().join('');
      }).reverse().join('');
      return `<div class="comm-bar" style="flex:1;min-width:14px;display:flex;flex-direction:column;align-items:center;height:100%" title="${esc(fmtYm(p.month, true))}: ${eur(t)}">
        <div class="comm-bar-amt" style="font-size:9.5px;color:var(--text-3);white-space:nowrap;margin-bottom:3px;min-height:12px">${t > 0 ? esc(eur0(t)) : ''}</div>
        <div style="flex:1;width:100%;display:flex;flex-direction:column;justify-content:flex-end">
          ${t > 0 ? `<div style="width:100%;display:flex;flex-direction:column;justify-content:flex-end;border-radius:3px 3px 0 0;overflow:hidden">${segs}</div>` : '<div style="width:100%;height:2px;background:var(--surface-2);border-radius:2px"></div>'}
        </div>
        <div class="comm-bar-lbl" style="font-size:10px;margin-top:5px;color:${isNu ? 'var(--text)' : 'var(--text-3)'};font-weight:${isNu ? 600 : 400};white-space:nowrap">${esc(fmtYm(p.month))}</div>
      </div>`;
    }).join('');
    const legende = mentoren.map((m) => {
      const uit = _st.verborgen.has(m.user_id);
      return `<button type="button" onclick="window.__commToggleMentor('${esc(m.user_id)}')" title="${uit ? 'Tonen' : 'Verbergen'}"
        style="display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border:1px solid var(--border);border-radius:999px;background:var(--surface);color:var(--text${uit ? '-3' : ''});font-size:11.5px;cursor:pointer;${uit ? 'text-decoration:line-through;opacity:.6' : ''}">
        <span style="width:9px;height:9px;border-radius:2px;background:var(--${kleurVan(m.user_id)})"></span>${esc(m.naam)}</button>`;
    }).join('');
    // Smal scherm: geen bedragen boven de balken en om de maand een label.
    const smal = `<style>@media (max-width:640px){.comm-bar-amt{visibility:hidden}.comm-bar:nth-child(even) .comm-bar-lbl{visibility:hidden}}</style>`;
    return `${smal}<div style="display:flex;align-items:stretch;gap:${slice.length > 10 ? 4 : 6}px;height:${hoogte + 42}px;padding:4px 0 6px">${bars}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:6px">${legende}
        <span style="font-size:11px;color:var(--text-3);margin-left:auto;display:inline-flex;align-items:center;gap:6px">Vol = vrijgegeven · licht = verwacht ·
          <span style="display:inline-block;width:10px;height:10px;${arcering('text-3')}"></span> achterstallig, schuift mee</span></div>`;
  }

  /* ── Filters op sales ────────────────────────────────────────────────── */
  function gefilterdeSales() {
    const q = String((H.getSearchValue && H.getSearchValue('comm-q')) || '').trim().toLowerCase();
    return asArr(_st.data?.sales).filter((s) => {
      if (_st.f.mentor && !s.mentoren.some((m) => m.user_id === _st.f.mentor)) return false;
      if (_st.f.event && (s.bron === 'handmatig' ? 'handmatig' : (s.event_id || '')) !== _st.f.event) return false;
      if (_st.f.bron && s.bron !== _st.f.bron) return false;
      if (_st.f.status && s.status !== _st.f.status) return false;
      if (q && !(`${s.klant} ${s.bron_label} ${s.event_title || ''}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }

  function filterBalk() {
    const d = _st.data || {};
    const events = asArr(d.per_event).filter((e) => !e.is_handmatig);
    const heeftHandmatig = asArr(d.sales).some((s) => s.bron === 'handmatig');
    return `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
      ${H.stableSearch ? H.stableSearch('comm-q', 'Zoek klant of event…') : ''}
      <select style="${selectStijl}" onchange="window.__commFilter('mentor', this.value)">
        <option value="">Alle mentoren</option>
        ${asArr(d.mentoren).map((m) => `<option value="${esc(m.user_id)}" ${_st.f.mentor === m.user_id ? 'selected' : ''}>${esc(m.naam)}</option>`).join('')}
      </select>
      <select style="${selectStijl}" onchange="window.__commFilter('event', this.value)">
        <option value="">Alle events</option>
        ${heeftHandmatig ? `<option value="handmatig" ${_st.f.event === 'handmatig' ? 'selected' : ''}>Handmatig toegewezen</option>` : ''}
        ${events.map((e) => `<option value="${esc(e.event_id || '')}" ${_st.f.event === e.event_id ? 'selected' : ''}>${esc(e.titel)}${e.datum ? ' · ' + esc(fmtDate(e.datum)) : ''}</option>`).join('')}
      </select>
      <select style="${selectStijl}" onchange="window.__commFilter('bron', this.value)">
        <option value="">Alle bronnen</option>
        <option value="event" ${_st.f.bron === 'event' ? 'selected' : ''}>Event</option>
        <option value="handmatig" ${_st.f.bron === 'handmatig' ? 'selected' : ''}>Handmatig / verlenging</option>
        <option value="traject" ${_st.f.bron === 'traject' ? 'selected' : ''}>Contant traject</option>
      </select>
      <select style="${selectStijl}" onchange="window.__commFilter('status', this.value)">
        <option value="">Alle statussen</option>
        ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${_st.f.status === k ? 'selected' : ''}>${v.l}</option>`).join('')}
      </select>
    </div>`;
  }

  /* ── Weergave: per mentor ────────────────────────────────────────────── */
  function perMentorView() {
    const rows = asArr(_st.data?.per_mentor);
    if (!rows.length) return leeg('Nog geen mentoren met commissie.');
    return `<div class="tbl-wrap"><table><thead><tr>
      <th>Mentor</th><th class="num">Closes</th><th class="num">Geboekt</th><th class="num">Vrijgegeven</th><th class="num">Open</th><th class="num">Volgende maand</th><th class="num">Risico</th><th></th>
      </tr></thead><tbody>
      ${rows.map((m) => `<tr style="cursor:pointer" onclick="window.__commPaneel('${esc(m.user_id)}')">
        <td><span style="display:inline-flex;align-items:center;gap:8px"><span style="width:10px;height:10px;border-radius:3px;background:var(--${kleurVan(m.user_id)})"></span><b>${esc(m.naam)}</b></span></td>
        <td class="num mono">${m.closes}</td>
        <td class="num mono">${eur(m.geboekt)}</td>
        <td class="num mono" style="color:var(--emerald)">${eur(m.vrijgegeven)}</td>
        <td class="num mono">${eur(m.open)}</td>
        <td class="num mono" style="color:var(--blue)">${eur(m.verwacht_volgende_maand)}</td>
        <td class="num mono" style="color:${m.risico > 0 ? 'var(--rose)' : 'var(--text-3)'}">${m.risico > 0 ? eur(m.risico) : '—'}</td>
        <td style="text-align:right;color:var(--text-3)">›</td>
      </tr>`).join('')}
      </tbody></table></div>`;
  }

  /* ── Weergave: per event ─────────────────────────────────────────────── */
  function perEventView() {
    const sales = gefilterdeSales();
    const keys = new Set(sales.map((s) => s.key));
    const events = asArr(_st.data?.per_event).filter((e) => e.sale_keys.some((k) => keys.has(k)));
    if (!events.length) return leeg('Geen events voor deze filters.');
    return events.map((e) => {
      const open = _st.openEvents.has(e.key);
      const mijn = sales.filter((s) => e.sale_keys.includes(s.key));
      const pct = e.pot > 0 ? e.vrijgegeven / e.pot : 0;
      return `<div class="card" style="margin-bottom:10px">
        <div style="padding:12px 16px;cursor:pointer;display:grid;grid-template-columns:minmax(180px,2fr) repeat(3,minmax(90px,1fr)) minmax(140px,1.4fr);gap:12px;align-items:center" onclick="window.__commToggleEvent('${esc(e.key)}')">
          <div><div style="font-weight:600;font-size:13.5px">${open ? '▾' : '▸'} ${esc(e.titel)}</div>
            <div style="font-size:11.5px;color:var(--text-3)">${e.datum ? esc(fmtDate(e.datum)) + ' · ' : ''}${e.sales} sale${e.sales === 1 ? '' : 's'}</div></div>
          <div><div style="font-size:10.5px;color:var(--text-3);text-transform:uppercase">Omzet getekend</div><div class="mono" style="font-size:13px">${eur(e.omzet)}</div></div>
          <div><div style="font-size:10.5px;color:var(--text-3);text-transform:uppercase">Commissiepot</div><div class="mono" style="font-size:13px">${eur(e.pot)}</div></div>
          <div><div style="font-size:10.5px;color:var(--text-3);text-transform:uppercase">Vrijgegeven</div><div class="mono" style="font-size:13px;color:var(--emerald)">${eur(e.vrijgegeven)}</div></div>
          <div>${voortgang(pct)}<div style="font-size:11px;color:var(--text-3);margin-top:3px">${Math.round(pct * 100)}% vrijgegeven</div></div>
          <div style="grid-column:1/-1;display:flex;gap:6px;flex-wrap:wrap">${e.verdeling.map((v) => mentorChip(v.user_id, v.naam, v.bedrag)).join('')}</div>
        </div>
        ${open ? `<div style="border-top:1px solid var(--border)">${salesTabel(mijn, { compact: true })}</div>` : ''}
      </div>`;
    }).join('');
  }

  /* ── Incasso / regeling ─────────────────────────────────────────────── */
  const incassoPill = (inc) => inc
    ? `<span title="Wat vanaf deze datum betaald wordt, telt niet meer voor de mentor">${H.pill('danger', `Incasso — geen commissie meer sinds ${esc(fmtDate(inc.sinds))}`)}</span>` : '';
  // Actieve markering voor deze sale (specifiek) of de hele klant.
  const markeringVoor = (customerId, dealId) => {
    const lijst = asArr(_st.data?.incasso_markeringen).filter((m) => m.customer_id === customerId);
    return lijst.find((m) => dealId && m.deal_id === dealId) || lijst.find((m) => !m.deal_id) || null;
  };

  /* ── Weergave: per sale ──────────────────────────────────────────────── */
  function salesTabel(sales, opts) {
    const o = opts || {};
    if (!sales.length) return leeg('Geen sales voor deze filters.');
    const kolommen = o.compact ? 7 : 9;
    return `<div class="tbl-wrap"><table><thead><tr>
      <th>Klant</th>${o.compact ? '' : '<th>Bron</th>'}<th class="num">Dealwaarde</th><th>Mentoren</th><th style="min-width:140px">Betaalvoortgang</th><th>Status</th><th>Volgende termijn</th>${o.compact ? '' : '<th class="num">Commissie</th>'}<th></th>
      </tr></thead><tbody>
      ${sales.map((s) => {
        const open = _st.openSale === s.key;
        const tc = Number(s.term_count) || 0;
        const fr = tc > 0 ? s.betaalde_termijnen / tc : 0;
        const bron = s.bron === 'handmatig'
          ? H.pill('violet', esc(s.bron_label || 'Handmatig'), true)
          : s.bron === 'traject' ? H.pill('teal', 'Contant traject', true) : `<span style="font-size:12px">${esc(s.bron_label)}</span>`;
        return `<tr style="cursor:pointer;${s.geannuleerd ? 'opacity:.55' : ''}" onclick="window.__commToggleSale('${esc(s.key)}')">
          <td><b>${esc(s.klant)}</b>${s.risico ? ` <span title="${esc(s.risico_redenen.join(', '))}" style="color:var(--rose)">●</span>` : ''}</td>
          ${o.compact ? '' : `<td>${bron}</td>`}
          <td class="num mono">${eur(s.dealwaarde)}${s.pct != null ? `<div style="font-size:10.5px;color:var(--text-3)">${esc(s.pct)}%</div>` : ''}</td>
          <td><div style="display:flex;gap:4px;flex-wrap:wrap">${s.mentoren.map((m) => mentorChip(m.user_id, m.naam, m.aandeel, m.geannuleerd ? ' (geannuleerd)' : '')).join('')}</div></td>
          <td>${tc ? voortgang(fr) + `<div style="font-size:11px;color:var(--text-3);margin-top:3px">${s.betaalde_termijnen}/${tc} termijnen${s.schema_onbekend ? ' · geen abonnement' : ''}</div>` : '<span style="font-size:11.5px;color:var(--text-3)">—</span>'}</td>
          <td>${s.incasso ? incassoPill(s.incasso) : statusPill(s.status)}</td>
          <td style="font-size:12px">${s.volgende_termijn ? `${esc(fmtDate(s.volgende_termijn.due_date))}<div class="mono" style="font-size:11px;color:var(--text-3)">${eur(s.volgende_termijn.aandeel)}</div>` : '—'}</td>
          ${o.compact ? '' : `<td class="num mono">${eur(s.share)}<div style="font-size:10.5px;color:var(--emerald)">${eur(s.vrijgegeven)} vrij</div></td>`}
          <td style="color:var(--text-3)">${open ? '▾' : '▸'}</td>
        </tr>
        ${open ? `<tr><td colspan="${kolommen}" style="background:var(--surface-2);padding:12px 16px">${saleDetail(s)}</td></tr>` : ''}`;
      }).join('')}
      </tbody></table></div>`;
  }

  function saleDetail(s) {
    const termijnen = asArr(s.termijnen);
    const TS = { betaald: ['ok', 'Betaald'], open: ['neutral', 'Open'], achterstallig: ['danger', 'Achterstallig'], gecrediteerd: ['neutral', 'Gecrediteerd'], incasso: ['danger', 'Incasso — vervalt'] };
    const tabel = termijnen.length ? `<div class="tbl-wrap"><table><thead><tr><th>#</th><th>Vervaldatum</th><th>Status</th><th class="num">Commissie (alle mentoren)</th></tr></thead><tbody>
      ${termijnen.map((t) => { const m = TS[t.status] || TS.open; return `<tr><td class="mono">${t.index}</td><td>${esc(fmtDate(t.due_date))}</td><td>${H.pill(m[0], m[1])}${t.vervangen ? ' <span style="font-size:11px;color:var(--text-3)">→ vervangen door regeling</span>' : ''}</td><td class="num mono">${eur(t.aandeel)}</td></tr>`; }).join('')}
      </tbody></table></div>` : '<div style="font-size:12.5px;color:var(--text-3)">Geen termijnschema bekend.</div>';
    const annuleer = s.bron === 'handmatig' && s.attribution_id && !s.geannuleerd && isAdmin()
      ? `<button class="btn btn-ghost btn-sm" style="color:var(--rose)" onclick="event.stopPropagation();window.__commAnnuleerOpen('${esc(s.attribution_id)}')">Toewijzing annuleren</button>` : '';
    const mark = s.customer_id ? markeringVoor(s.customer_id, s.deal_id) : null;
    const incassoKnop = !isAdmin() || !s.customer_id || s.bron === 'traject' ? ''
      : mark
        ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();window.__commOpheffenOpen('${esc(mark.id)}')">Incasso opheffen</button>`
        : `<button class="btn btn-ghost btn-sm" style="color:var(--rose)" onclick="event.stopPropagation();window.__commIncassoOpen('${esc(s.customer_id)}','${esc(s.deal_id || '')}')">Incasso…</button>`;
    return `<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">
      <div style="flex:2;min-width:260px">${tabel}</div>
      <div style="flex:1;min-width:200px;font-size:12.5px;line-height:1.7">
        <div><span style="color:var(--text-3)">Bron:</span> ${esc(s.bron === 'handmatig' ? 'Handmatig toegewezen · ' + s.bron_label : s.bron_label)}</div>
        ${s.datum ? `<div><span style="color:var(--text-3)">Datum:</span> ${esc(fmtDate(s.datum))}</div>` : ''}
        <div><span style="color:var(--text-3)">Commissie:</span> <span class="mono">${eur(s.share)}</span> · vrij <span class="mono" style="color:var(--emerald)">${eur(s.vrijgegeven)}</span> · open <span class="mono">${eur(s.open)}</span></div>
        ${s.achterstallig ? `<div style="color:var(--rose)">Achterstand klant: <span class="mono">${eur(s.achterstand_bedrag)}</span></div>` : ''}
        ${s.risico_redenen.length ? `<div style="color:var(--rose)">Risico: ${esc(s.risico_redenen.join(', '))}</div>` : ''}
        ${s.incasso ? `<div style="color:var(--rose)">Incasso sinds ${esc(fmtDate(s.incasso.sinds))} · vervalt <span class="mono">${eur(s.incasso.vervallen)}</span>${mark ? ` · ${esc(mark.reden)}` : ''}</div>` : ''}
        ${s.niet_gedekt > 0 ? `<div style="color:var(--text-3)">Regeling dekt <span class="mono">${eur(s.niet_gedekt)}</span> niet (gecrediteerd zonder vervangende factuur)</div>` : ''}
        <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${annuleer}${incassoKnop}</div>
      </div></div>`;
  }

  function leeg(t) {
    return `<div style="padding:28px 16px;text-align:center;color:var(--text-3);font-size:13px">${esc(t)}</div>`;
  }

  /* ── Zijpaneel: wat die mentor zelf ziet ─────────────────────────────── */
  function zijpaneel() {
    const uid = _st.paneel;
    if (!uid || !_st.data) return '';
    const m = asArr(_st.data.per_mentor).find((x) => x.user_id === uid) || { naam: naamVan(uid) };
    const mijn = asArr(_st.data.sales).filter((s) => s.mentoren.some((x) => x.user_id === uid));
    const proj = asArr(_st.data.projectie);
    const nu = nuYm();
    const toekomst = proj.filter((p) => p.month >= nu).slice(0, 6);
    const rij = (s) => {
      const me = s.mentoren.find((x) => x.user_id === uid);
      const tc = Number(s.term_count) || 0;
      const n = s.mentoren.filter((x) => !x.geannuleerd).length;
      return `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
          <div><b style="font-size:13px">${esc(s.klant)}</b><div style="font-size:11.5px;color:var(--text-3)">${esc(s.bron === 'handmatig' ? s.bron_label : s.bron_label)}${n > 1 ? ` · gedeeld met ${n - 1} mentor${n - 1 === 1 ? '' : 'en'}` : ''}</div></div>
          <div style="text-align:right"><div class="mono" style="font-size:13px">${eur(me?.aandeel)}</div><div class="mono" style="font-size:11px;color:var(--emerald)">${eur(me?.vrijgegeven)} vrij</div></div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
          <div style="flex:1">${tc ? voortgang(s.betaalde_termijnen / tc) : ''}</div>
          <span style="font-size:11px;color:var(--text-3)">${tc ? `${s.betaalde_termijnen}/${tc}` : ''}</span>${s.incasso ? incassoPill(s.incasso) : statusPill(s.status)}
        </div>
        ${isAdmin() && s.customer_id && s.bron !== 'traject' && !s.incasso ? `<div style="margin-top:4px;text-align:right"><button class="btn btn-ghost btn-sm" style="color:var(--rose);font-size:11.5px" onclick="window.__commIncassoOpen('${esc(s.customer_id)}','${esc(s.deal_id || '')}')">Incasso…</button></div>` : ''}
        </div>`;
    };
    return `<div style="position:fixed;top:0;right:0;bottom:0;width:min(520px,100%);background:var(--surface);color:var(--text);box-shadow:-12px 0 40px rgba(0,0,0,.22);z-index:1900;display:flex;flex-direction:column">
      <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
        <span style="width:12px;height:12px;border-radius:3px;background:var(--${kleurVan(uid)})"></span>
        <div style="font-size:15px;font-weight:600;flex:1">${esc(m.naam)}</div>
        <button class="icon-btn" aria-label="Sluiten" onclick="window.__commPaneel(null)" style="width:28px;height:28px">✕</button>
      </div>
      <div style="padding:14px 18px;overflow-y:auto;flex:1">
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:14px">
          ${[['Geboekt', m.geboekt, 'text'], ['Vrijgegeven', m.vrijgegeven, 'emerald'], ['Open', m.open, 'text'], ['Volgende maand', m.verwacht_volgende_maand, 'blue']]
            .map(([l, v, c]) => `<div style="padding:10px 12px;border:1px solid var(--border);border-radius:10px"><div style="font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">${l}</div><div class="mono" style="font-size:16px;font-weight:600;color:var(--${c})">${eur(v)}</div></div>`).join('')}
        </div>
        <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Verwacht de komende maanden</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">${toekomst.map((p) => {
          const v = p.per_mentor?.[uid];
          const t = v ? (Number(v.betaald) || 0) + (Number(v.verwacht) || 0) : 0;
          return `<div style="padding:6px 9px;border:1px solid var(--border);border-radius:8px;font-size:11.5px;min-width:70px"><div style="color:var(--text-3)">${esc(fmtYm(p.month))}</div><div class="mono">${eur(t)}</div></div>`;
        }).join('')}</div>
        <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Sales (${mijn.length})</div>
        ${mijn.length ? mijn.map(rij).join('') : leeg('Nog geen sales.')}
      </div>
      <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end">
        <button class="btn btn-ghost btn-sm" onclick="window.__commNaarDrilldown('${esc(uid)}')">Volledige drilldown (uitbetalingen, grootboek) ›</button>
      </div>
    </div>`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     + SALE TOEWIJZEN — 3 stappen: offerte → mentoren → preview
     ═══════════════════════════════════════════════════════════════════════ */
  let _zoekTimer = null;
  let _zoekVolgnr = 0;
  window.__commWizOpen = async () => {
    _st.wiz = { stap: 1, q: '', res: null, zoekt: false, deal: null, mentoren: new Set(), reden: 'verlenging', pct: '3', inclBtw: true, note: '', toch: false, tochReden: '', preview: null, bezig: false, fout: null, mentorLijst: null };
    if (H.registreerVuilCheck) { try { H.registreerVuilCheck(() => !!(_st.wiz && (_st.wiz.deal || _st.wiz.q))); } catch (_) { /* optioneel */ } }
    render();
    setTimeout(() => document.getElementById('comm-wiz-q')?.focus(), 30);
    const j = await api('/api/mentor-admin-list');
    if (_st.wiz) { _st.wiz.mentorLijst = j?.__error ? [] : asArr(j?.mentors); if (_st.wiz.stap === 2) render(); }
  };
  window.__commWizSluit = () => { _st.wiz = null; render(); };
  window.__commWizQ = (v) => {
    if (!_st.wiz) return;
    _st.wiz.q = v;
    clearTimeout(_zoekTimer);
    _zoekTimer = setTimeout(zoek, 300);
  };
  async function zoek() {
    const w = _st.wiz;
    if (!w) return;
    const q = String(w.q || '').trim();
    if (q.length < 2) { w.res = null; tekenResultaten(); return; }
    const nr = ++_zoekVolgnr;
    w.zoekt = true; tekenResultaten();
    const j = await api(`/api/commissie-offertes-zoek?q=${encodeURIComponent(q)}`);
    if (!_st.wiz || nr !== _zoekVolgnr) return;
    w.zoekt = false;
    w.res = j?.__error ? { fout: j.__error } : asArr(j?.resultaten);
    tekenResultaten();
  }
  function tekenResultaten() {
    const el = document.getElementById('comm-wiz-res');
    if (el) el.innerHTML = resultatenHtml();
  }
  function resultatenHtml() {
    const w = _st.wiz;
    if (!w) return '';
    if (w.zoekt) return `<div style="padding:12px;color:var(--text-3);font-size:12.5px">Zoeken…</div>`;
    if (!w.res) return `<div style="padding:12px;color:var(--text-3);font-size:12.5px">Typ minstens 2 tekens: klantnaam, e-mail of offertenummer.</div>`;
    if (w.res.fout) return `<div style="padding:12px;color:var(--rose);font-size:12.5px">${esc(w.res.fout)}</div>`;
    if (!w.res.length) return `<div style="padding:12px;color:var(--text-3);font-size:12.5px">Geen getekende offertes gevonden.</div>`;
    return w.res.map((d, i) => {
      const sub = asArr(d.abonnementen)[asArr(d.abonnementen).length - 1];
      const abo = asArr(d.abonnementen).map((a) => `${a.term_count || '?'} × ${eur(a.per_termijn_incl)}${a.start_date ? ' vanaf ' + fmtDate(a.start_date) : ''}`).join(' + ');
      return `<button type="button" onclick="window.__commWizKies(${i})" style="display:block;width:100%;text-align:left;padding:11px 12px;margin-bottom:8px;border:1px solid ${d.waarschuwingen.length ? 'var(--amber-line)' : 'var(--border)'};border-radius:10px;background:var(--surface);color:var(--text);cursor:pointer">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div><b style="font-size:13.5px">${esc(d.klant.naam)}</b> <span style="font-size:11.5px;color:var(--text-3)">${esc(d.offertenummer || '')}${d.getekend_op ? ' · getekend ' + esc(fmtDate(d.getekend_op)) : ''}</span>
            <div style="font-size:11.5px;color:var(--text-3)">${esc(d.klant.email || '')}${d.andere_getekende_deals ? ` · ${d.andere_getekende_deals} andere getekende offerte(s) — mogelijk verlenging` : ''}</div></div>
          <div style="text-align:right"><div class="mono" style="font-size:13.5px">${eur(d.basis_incl)}</div><div style="font-size:11px;color:var(--text-3)">betaald ${eur(d.betaald)}</div></div>
        </div>
        <div style="font-size:11.5px;color:var(--text-2);margin-top:4px">${abo ? 'Abonnement: ' + esc(abo) : (sub ? '' : 'Geen abonnement gekoppeld')}</div>
        ${d.waarschuwingen.length ? `<div style="font-size:11.5px;color:var(--amber);margin-top:4px">⚠ ${esc(d.waarschuwingen.join(' '))}</div>` : ''}
      </button>`;
    }).join('');
  }
  window.__commWizKies = (i) => {
    const w = _st.wiz;
    if (!w || !Array.isArray(w.res)) return;
    w.deal = w.res[i] || null;
    if (!w.deal) return;
    w.stap = 2; w.fout = null; w.preview = null; w.toch = false; w.tochReden = '';
    render();
  };
  window.__commWizTerug = (stap) => { if (_st.wiz) { _st.wiz.stap = stap; _st.wiz.fout = null; render(); } };
  window.__commWizMentor = (uid, aan) => { if (!_st.wiz) return; if (aan) _st.wiz.mentoren.add(uid); else _st.wiz.mentoren.delete(uid); };
  window.__commWizVeld = (k, v) => { if (_st.wiz) _st.wiz[k] = v; };
  window.__commWizToch = (aan) => { if (_st.wiz) { _st.wiz.toch = !!aan; render(); } };

  function payload() {
    const w = _st.wiz;
    return {
      deal_id: w.deal.deal_id,
      mentor_user_ids: [...w.mentoren],
      pct: Number(String(w.pct).replace(',', '.')),
      reden: w.reden,
      basis_incl_btw: !!w.inclBtw,
      note: w.note || null,
      toch_toevoegen: !!w.toch,
      toch_reden: w.tochReden || null,
    };
  }
  window.__commWizPreview = async () => {
    const w = _st.wiz;
    if (!w || w.bezig) return;
    if (!w.mentoren.size) { w.fout = 'Kies minstens één mentor.'; render(); return; }
    const pct = Number(String(w.pct).replace(',', '.'));
    if (!(pct > 0 && pct <= 100)) { w.fout = 'Percentage moet tussen 0 en 100 liggen.'; render(); return; }
    if (w.deal.waarschuwingen.length && !w.toch) { w.fout = 'Op deze offerte staat al commissie. Vink "toch toevoegen" aan met een reden, of kies een andere offerte.'; render(); return; }
    if (w.toch && String(w.tochReden || '').trim().length < 5) { w.fout = 'Geef een reden (minstens 5 tekens) waarom je toch toevoegt.'; render(); return; }
    w.bezig = true; w.fout = null; render();
    const j = await post('/api/commissie-toewijzing-preview', payload());
    if (!_st.wiz) return;
    w.bezig = false;
    if (j?.__error) { w.fout = j.__error; render(); return; }
    w.preview = j; w.stap = 3; render();
  };
  window.__commWizOpslaan = async () => {
    const w = _st.wiz;
    if (!w || w.bezig || !w.preview) return;
    w.bezig = true; w.fout = null; render();
    const j = await post('/api/commissie-toewijzing-opslaan', payload(), 30000);
    if (!_st.wiz) return;
    w.bezig = false;
    if (j?.__error) {
      w.fout = j.__code === 'MIGRATIE_ONTBREEKT'
        ? 'Toewijzen kan nog niet: de database-migratie (2026-10-22-mentor-sale-attributions.sql) is nog niet gedraaid.'
        : j.__error;
      render(); return;
    }
    const vrij = Number(j?.vrijgave?.vrijgegeven) || 0;
    _st.wiz = null;
    toast(`Sale toegewezen${vrij > 0 ? ` — ${eur(vrij)} meteen vrijgegeven (al betaald)` : ''}.`);
    _st.data = null; queueMicrotask(laad); render();
  };

  function wizard() {
    const w = _st.wiz;
    if (!w) return '';
    const stappen = ['Offerte', 'Mentoren', 'Bevestigen'].map((t, i) => {
      const n = i + 1;
      const act = w.stap === n;
      const klaar = w.stap > n;
      return `<div style="display:flex;align-items:center;gap:6px;font-size:12px;color:${act ? 'var(--text)' : 'var(--text-3)'};font-weight:${act ? 600 : 400}">
        <span style="width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:11px;background:${act || klaar ? 'var(--violet)' : 'var(--surface-2)'};color:${act || klaar ? '#fff' : 'var(--text-3)'}">${klaar ? '✓' : n}</span>${t}</div>`;
    }).join('<span style="flex:1;height:1px;background:var(--border);min-width:12px"></span>');
    const fout = w.fout ? `<div style="padding:9px 12px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin:10px 0">${esc(w.fout)}</div>` : '';
    let body = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">${stappen}</div>`;

    if (w.stap === 1) {
      body += `<label style="display:block;margin-bottom:10px">${lbl('Zoek offerte')}
          <input id="comm-wiz-q" type="search" autocomplete="off" value="${esc(w.q)}" oninput="window.__commWizQ(this.value)" placeholder="Klantnaam, e-mail of offertenummer" style="${inputStijl}" /></label>
        <div id="comm-wiz-res">${resultatenHtml()}</div>
        <div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="btn btn-ghost" onclick="window.__commWizSluit()">Annuleren</button></div>`;
    } else if (w.stap === 2) {
      const d = w.deal;
      const lijst = w.mentorLijst;
      body += `<div style="padding:10px 12px;background:var(--surface-2);border-radius:10px;font-size:12.5px;margin-bottom:12px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div><b>${esc(d.klant.naam)}</b> · ${esc(d.offertenummer || 'offerte')}</div><div class="mono">${eur(d.basis_incl)} incl. btw</div></div>
        <div style="margin-bottom:12px">${lbl('Mentor(en)')}
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
            ${lijst == null ? '<span style="font-size:12.5px;color:var(--text-3)">Mentoren laden…</span>'
              : lijst.length ? lijst.map((m) => `<label style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--border);border-radius:999px;font-size:12.5px;cursor:pointer">
                  <input type="checkbox" ${w.mentoren.has(m.user_id) ? 'checked' : ''} onchange="window.__commWizMentor('${esc(m.user_id)}', this.checked)"> ${esc(m.name || m.email || m.user_id)}</label>`).join('')
                : '<span style="font-size:12.5px;color:var(--rose)">Kon mentoren niet laden.</span>'}
          </div><div style="font-size:11.5px;color:var(--text-3);margin-top:4px">Bij meerdere mentoren wordt de commissie gelijk verdeeld.</div></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:12px">
          <label>${lbl('Reden')}<select onchange="window.__commWizVeld('reden', this.value)" style="${inputStijl}">
            ${[['verlenging', 'Verlenging'], ['upsell', 'Upsell'], ['handmatig', 'Handmatig']].map(([v, l]) => `<option value="${v}" ${w.reden === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>${lbl('Commissie %')}<input type="number" min="0.1" max="100" step="0.1" value="${esc(w.pct)}" oninput="window.__commWizVeld('pct', this.value)" style="${inputStijl}" /></label>
          <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;padding-top:18px"><input type="checkbox" ${w.inclBtw ? 'checked' : ''} onchange="window.__commWizVeld('inclBtw', this.checked)"> Basis incl. btw</label>
        </div>
        <label style="display:block;margin-bottom:12px">${lbl('Notitie (optioneel)')}
          <textarea oninput="window.__commWizVeld('note', this.value)" style="${inputStijl};min-height:54px;resize:vertical;font-family:inherit">${esc(w.note)}</textarea></label>
        ${d.waarschuwingen.length ? `<div style="padding:10px 12px;border:1px solid var(--amber-line);background:var(--amber-soft);border-radius:10px;font-size:12.5px;color:var(--amber);margin-bottom:12px">
            ⚠ ${esc(d.waarschuwingen.join(' '))} Dubbele commissie is standaard uitgesloten.
            <label style="display:flex;align-items:center;gap:8px;margin-top:8px;color:var(--text)"><input type="checkbox" ${w.toch ? 'checked' : ''} onchange="window.__commWizToch(this.checked)"> Toch toevoegen</label>
            ${w.toch ? `<input type="text" value="${esc(w.tochReden)}" oninput="window.__commWizVeld('tochReden', this.value)" placeholder="Waarom? (verplicht)" style="${inputStijl}" />` : ''}
          </div>` : ''}
        ${fout}
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <button class="btn btn-ghost" onclick="window.__commWizTerug(1)">‹ Andere offerte</button>
          <div style="display:flex;gap:8px"><button class="btn btn-ghost" onclick="window.__commWizSluit()">Annuleren</button>
          <button class="btn btn-primary" ${w.bezig ? 'disabled' : ''} onclick="window.__commWizPreview()">${w.bezig ? 'Rekenen…' : 'Bekijk preview ›'}</button></div>
        </div>`;
    } else {
      const p = w.preview;
      const maanden = asArr(p.per_maand);
      body += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px">
          ${[['Dealwaarde', eur(p.basis) + (p.basis_incl_btw ? ' incl.' : ' excl.')], ['Commissie', `${esc(p.pct)}% = ${eur(p.totaal_commissie)}`], ['Al betaald op deze offerte', eur(p.betaald_op_deal)]]
            .map(([l, v]) => `<div style="padding:10px 12px;border:1px solid var(--border);border-radius:10px"><div style="font-size:10.5px;color:var(--text-3);text-transform:uppercase">${l}</div><div class="mono" style="font-size:14px;font-weight:600">${v}</div></div>`).join('')}
        </div>
        <div style="margin-bottom:12px">${lbl('Per mentor')}
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${asArr(p.mentoren).map((m) => `<span style="padding:5px 10px;border-radius:999px;background:var(--violet-soft);color:var(--violet);font-size:12.5px">${esc(m.naam)} · <b class="mono">${eur(m.aandeel)}</b></span>`).join('')}</div>
          ${p.valt_meteen_vrij_per_mentor > 0 ? `<div style="font-size:12px;color:var(--emerald);margin-top:6px">Valt meteen vrij (al betaald): ${eur(p.valt_meteen_vrij_per_mentor)} per mentor.</div>` : `<div style="font-size:12px;color:var(--text-3);margin-top:6px">Nog niets betaald op deze offerte — commissie valt vrij per betaalde termijn.</div>`}
        </div>
        <div style="margin-bottom:10px">${lbl('Projectie per maand (per mentor)')}
          <div class="tbl-wrap" style="margin-top:6px;max-height:240px;overflow-y:auto"><table><thead><tr><th>Maand</th><th class="num">Vrijgegeven</th><th class="num">Verwacht</th></tr></thead><tbody>
            ${maanden.length ? maanden.map((m) => `<tr><td>${esc(fmtYm(m.month, true))}</td><td class="num mono" style="color:var(--emerald)">${m.betaald ? eur(m.betaald) : '—'}</td><td class="num mono" style="color:var(--blue)">${m.verwacht ? eur(m.verwacht) : '—'}</td></tr>`).join('')
              : '<tr><td colspan="3" style="color:var(--text-3)">Geen termijnschema bekend — commissie valt vrij zodra de facturen van deze offerte betaald zijn.</td></tr>'}
          </tbody></table></div></div>
        <div style="font-size:11.5px;color:var(--text-3);margin-bottom:10px">Commissie valt pas vrij wanneer de klant de factuur van déze offerte effectief betaalt. Achteraf annuleerbaar vanuit de sale.</div>
        ${fout}
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <button class="btn btn-ghost" onclick="window.__commWizTerug(2)">‹ Aanpassen</button>
          <div style="display:flex;gap:8px"><button class="btn btn-ghost" onclick="window.__commWizSluit()">Annuleren</button>
          <button class="btn btn-primary" ${w.bezig ? 'disabled' : ''} onclick="window.__commWizOpslaan()">${w.bezig ? 'Opslaan…' : 'Bevestigen'}</button></div>
        </div>`;
    }
    return modal('Sale toewijzen aan mentor', body, 'window.__commWizSluit()', 680);
  }

  /* ── Toewijzing annuleren (typed ANNULEER) ───────────────────────────── */
  window.__commAnnuleerOpen = (id) => {
    const s = asArr(_st.data?.sales).find((x) => x.attribution_id === id);
    _st.annuleer = { id, klant: s?.klant || '', vrij: s?.vrijgegeven || 0, typed: '', reden: '', bezig: false, fout: null };
    render();
  };
  window.__commAnnuleerSluit = () => { _st.annuleer = null; render(); };
  window.__commAnnuleerVeld = (k, v) => {
    if (!_st.annuleer) return;
    _st.annuleer[k] = v;
    const btn = document.querySelector('[data-comm-annuleer-btn]');
    if (btn) btn.disabled = String(_st.annuleer.typed || '').trim() !== 'ANNULEER';
  };
  window.__commAnnuleerOk = async () => {
    const a = _st.annuleer;
    if (!a || a.bezig || String(a.typed).trim() !== 'ANNULEER') return;
    a.bezig = true; a.fout = null; render();
    const j = await post('/api/commissie-toewijzing-annuleren', { attribution_id: a.id, bevestiging: 'ANNULEER', reden: a.reden || null });
    if (!_st.annuleer) return;
    if (j?.__error) { a.bezig = false; a.fout = j.__error; render(); return; }
    _st.annuleer = null;
    toast(j.clawback_melding ? `Toewijzing geannuleerd — let op: ${eur(j.al_uitbetaald)} was al uitbetaald (melding naar finance).` : 'Toewijzing geannuleerd.');
    _st.data = null; queueMicrotask(laad); render();
  };
  function annuleerModal() {
    const a = _st.annuleer;
    if (!a) return '';
    const body = `<div style="font-size:13.5px;line-height:1.6;margin-bottom:10px">Toewijzing voor <b>${esc(a.klant)}</b> annuleren? Openstaande commissie vervalt.
        ${a.vrij > 0 ? `Al vrijgegeven commissie (${eur(a.vrij)}) blijft staan.` : ''}</div>
      <label style="display:block;margin-bottom:10px">${lbl('Reden (optioneel)')}<input type="text" value="${esc(a.reden)}" oninput="window.__commAnnuleerVeld('reden', this.value)" style="${inputStijl}" /></label>
      <div style="padding:10px 12px;background:var(--rose-soft);border:1px solid var(--rose-line);border-radius:8px;font-size:12.5px;color:var(--rose);margin-bottom:10px">Typ <code style="font-weight:600">ANNULEER</code> om te bevestigen.</div>
      <input type="text" value="${esc(a.typed)}" oninput="window.__commAnnuleerVeld('typed', this.value)" placeholder="ANNULEER" style="${inputStijl};font-family:'IBM Plex Mono',monospace" />
      ${a.fout ? `<div style="padding:9px 12px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-top:10px">${esc(a.fout)}</div>` : ''}
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px">
        <button class="btn btn-ghost" onclick="window.__commAnnuleerSluit()">Annuleren</button>
        <button class="btn btn-danger" data-comm-annuleer-btn ${String(a.typed).trim() === 'ANNULEER' && !a.bezig ? '' : 'disabled'} onclick="window.__commAnnuleerOk()">${a.bezig ? 'Bezig…' : 'Toewijzing annuleren'}</button>
      </div>`;
    return modal('Toewijzing annuleren', body, 'window.__commAnnuleerSluit()', 480);
  }

  /* ── Verschoven commissie + inhaal ───────────────────────────────────── */
  // Commissie telt in de maand waarin de klant effectief betaalt. Hier staat
  // wat niet in zijn vervalmaand telt: achterstallig (schuift mee), later
  // betaald (telt in de betaalmaand) en inhaal (betaald in een maand waarvan
  // het rapport al definitief is → correctie op het volgende rapport).
  function verschovenTekst(v) {
    if (v.inhaal) {
      return v.inhaal_voorgesteld
        ? `Betaald op ${esc(fmtDate(v.betaald_op))} · correctie voorgesteld voor rapport ${esc(fmtYm(String(v.inhaal_voorgesteld.period_month).slice(0, 7), true))}`
        : `Betaald op ${esc(fmtDate(v.betaald_op))} — rapport van die maand is al definitief`;
    }
    if (v.status === 'achterstallig') return `Nog niet betaald · schuift mee (achterstallig sinds ${esc(fmtDate(v.achterstallig_sinds))})`;
    if (v.uitbetaald_in) return `Betaald op ${esc(fmtDate(v.betaald_op))} → uitbetaald in rapport ${esc(fmtYm(v.uitbetaald_in, true))}`;
    const rap = v.rapport_periode ? fmtYm(v.rapport_periode, true) : '';
    return `Betaald op ${esc(fmtDate(v.betaald_op))} → ${v.rapport_status ? 'rapport' : 'komt in rapport'} ${esc(rap)}${v.rapport_status ? ` (${esc(v.rapport_status)})` : ''}`;
  }
  function verschovenBlok() {
    const lijst = asArr(_st.data?.verschoven);
    if (!lijst.length) return '';
    const inhaal = lijst.filter((v) => v.inhaal);
    const rijen = lijst.slice().sort((a, b) => (Number(b.inhaal) - Number(a.inhaal)) || String(a.mentor).localeCompare(String(b.mentor)) || String(a.due_date).localeCompare(String(b.due_date)));
    const tabel = `<div class="tbl-wrap"><table><thead><tr><th>Mentor</th><th>Klant</th><th>Termijn</th><th>Oorspr. vervaldag</th><th>Status</th><th class="num">Bedrag</th><th></th></tr></thead><tbody>
      ${rijen.map((v, i) => `<tr>
        <td>${mentorChip(v.mentor_user_id, v.mentor)}</td>
        <td><b>${esc(v.klant)}</b></td>
        <td class="mono">${v.index}/${v.term_count}</td>
        <td>${esc(fmtDate(v.due_date))}</td>
        <td style="font-size:12px">${v.inhaal ? H.pill('violet', 'Inhaal', true) + ' ' : v.status === 'achterstallig' ? H.pill('warn', 'Achterstallig', true) + ' ' : H.pill('ok', 'Later betaald', true) + ' '}${verschovenTekst(v)}</td>
        <td class="num mono">${eur(v.amount)}</td>
        <td>${v.inhaal && !v.inhaal_voorgesteld && isAdmin() ? `<button class="btn btn-ghost btn-sm" onclick="window.__commInhaalOpen(${rijen.indexOf(v)})">Correctie voorstellen</button>` : ''}</td>
      </tr>`).join('')}
      </tbody></table></div>`;
    _st._verschovenRijen = rijen;
    const kop = inhaal.length
      ? `<div style="padding:9px 12px;border:1px solid var(--violet-line);background:var(--violet-soft);color:var(--violet);border-radius:8px;font-size:12.5px;margin-bottom:10px">
          <b>Inhaalcommissie:</b> ${inhaal.length} termijn${inhaal.length === 1 ? '' : 'en'} werd${inhaal.length === 1 ? '' : 'en'} betaald in een maand waarvan het rapport al definitief was. Niets wordt automatisch uitbetaald — stel per termijn een correctie voor op het volgende rapport en keur dat rapport zoals altijd goed.</div>`
      : '';
    return card('Verschoven commissie', 'amber', `<div style="font-size:12px;color:var(--text-3);margin-bottom:10px">Commissie telt in de maand waarin de klant effectief betaalt. Een onbetaalde termijn schuift mee naar de huidige maand tot hij betaald is.</div>${kop}${tabel}`);
  }

  window.__commInhaalOpen = (i) => {
    const v = asArr(_st._verschovenRijen)[i];
    if (!v) return;
    const periode = v.inhaal_voorstel_periode;
    _st.inhaal = {
      v, periode, bezig: false, fout: null,
      label: `Inhaalcommissie ${v.klant} termijn ${v.index}/${v.term_count} (vervaldag ${v.due_date}, betaald ${v.betaald_op}) [inhaal:${v.inhaal_token}]`.slice(0, 200),
    };
    render();
  };
  window.__commInhaalSluit = () => { _st.inhaal = null; render(); };
  window.__commInhaalOk = async () => {
    const x = _st.inhaal;
    if (!x || x.bezig) return;
    if (!x.periode) { x.fout = 'Geen volgend rapport bekend.'; render(); return; }
    x.bezig = true; x.fout = null; render();
    const j = await post('/api/mentor-payout-adjustment-save', {
      mentor_user_id: x.v.mentor_user_id, period_month: x.periode, label: x.label, amount_incl: x.v.amount,
    });
    if (!_st.inhaal) return;
    if (j?.__error) { x.bezig = false; x.fout = j.__error; render(); return; }
    _st.inhaal = null;
    toast(`Correctie van ${eur(x.v.amount)} voorgesteld op het rapport van ${fmtYm(x.periode, true)} — keur dat rapport goed om uit te betalen.`);
    _st.data = null; queueMicrotask(laad); render();
  };
  function inhaalModal() {
    const x = _st.inhaal;
    if (!x) return '';
    const body = `<div style="font-size:13.5px;line-height:1.6;margin-bottom:12px">
        Correctie voorstellen voor <b>${esc(x.v.mentor)}</b>: <b class="mono">${eur(x.v.amount)}</b> op het rapport van <b>${esc(x.periode ? fmtYm(x.periode, true) : '—')}</b>.</div>
      <div style="font-size:12.5px;color:var(--text-2);line-height:1.6;margin-bottom:12px">
        ${esc(x.v.klant)} · termijn ${x.v.index}/${x.v.term_count} · vervaldag ${esc(fmtDate(x.v.due_date))} · betaald op ${esc(fmtDate(x.v.betaald_op))}.<br>
        Dit voegt een handmatige post toe aan het concept-rapport (bestaat het nog niet, dan wordt het concept aangemaakt). Er wordt niets uitbetaald tot je dat rapport goedkeurt.</div>
      ${x.fout ? `<div style="padding:9px 12px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-bottom:10px">${esc(x.fout)}</div>` : ''}
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__commInhaalSluit()">Annuleren</button>
        <button class="btn btn-primary" ${x.bezig ? 'disabled' : ''} onclick="window.__commInhaalOk()">${x.bezig ? 'Bezig…' : 'Correctie voorstellen'}</button>
      </div>`;
    return modal('Inhaalcommissie', body, 'window.__commInhaalSluit()', 520);
  }

  /* ── Wanbetaling: mogelijk incasso, markeringen, niet-gekoppelde betalingen ─ */
  function wanbetalingBlok() {
    const d = _st.data || {};
    const mog = asArr(d.mogelijk_incasso);
    const mark = asArr(d.incasso_markeringen);
    const los = asArr(d.niet_gekoppeld);
    const gek = asArr(d.koppelingen);
    if (!mog.length && !mark.length && !los.length && !gek.length) return '';
    const sectie = (titel, uitleg, inhoud) => `<div style="margin-bottom:14px"><div style="font-size:12.5px;font-weight:600;margin-bottom:2px">${titel}</div>
      <div style="font-size:11.5px;color:var(--text-3);margin-bottom:6px">${uitleg}</div>${inhoud}</div>`;
    const tbl = (koppen, rijen) => `<div class="tbl-wrap"><table><thead><tr>${koppen.map((k) => `<th>${k}</th>`).join('')}</tr></thead><tbody>${rijen.join('')}</tbody></table></div>`;
    let html = '';
    if (!d.incasso_ok || !d.koppel_ok) {
      html += `<div style="padding:9px 12px;border:1px solid var(--amber-line);background:var(--amber-soft);color:var(--amber);border-radius:8px;font-size:12.5px;margin-bottom:12px">
        Incasso markeren en betalingen koppelen kan zodra de database-migratie (2026-10-22-commissie-incasso-en-koppeling.sql) gedraaid is.</div>`;
    }
    if (mog.length) {
      html += sectie('Mogelijk incasso', 'Signaal uit het incassodossier, de wanbetalers-pipeline of de onboarding. Niets is automatisch gezet — jij beslist.',
        tbl(['Klant', 'Signaal', 'Voorstel sinds', ''], mog.map((m, i) => `<tr><td><b>${esc(m.klant)}</b></td>
          <td style="font-size:12px">${m.signalen.map((x) => esc(x.bron) + (x.sinds ? ' · ' + esc(fmtDate(x.sinds)) : '')).join('<br>')}</td>
          <td>${esc(fmtDate(m.voorstel_sinds))}</td>
          <td>${isAdmin() ? `<button class="btn btn-ghost btn-sm" style="color:var(--rose)" onclick="window.__commIncassoVoorstel(${i})">Markeer als incasso</button>` : ''}</td></tr>`)));
    }
    if (mark.length) {
      html += sectie('Incasso — geen commissie meer', 'Betalingen vanaf de datum tellen niet meer. Al vrijgegeven commissie blijft van de mentor.',
        tbl(['Klant', 'Geldt voor', 'Sinds', 'Reden', ''], mark.map((m) => `<tr><td><b>${esc(m.klant)}</b></td><td style="font-size:12px">${esc(m.sale)}</td>
          <td>${esc(fmtDate(m.sinds))}</td><td style="font-size:12px">${esc(m.reden)}</td>
          <td>${isAdmin() ? `<button class="btn btn-ghost btn-sm" onclick="window.__commOpheffenOpen('${esc(m.id)}')">Opheffen</button>` : ''}</td></tr>`)));
    }
    if (los.length) {
      html += sectie('Niet gekoppelde betaling', 'Factuur na creditering zonder offerte/abonnement bij een klant met meerdere sales. Kies bij welke sale ze hoort — anders telt ze niet voor een toegewezen sale.',
        tbl(['Klant', 'Factuur', 'Bedrag', 'Vervaldag', 'Hoort bij', ''], los.map((f) => {
          const gekozen = _st.koppelKeuze[f.invoice_id] ?? '';
          return `<tr><td><b>${esc(f.klant)}</b></td><td class="mono">${esc(f.invoice_number || '—')}</td><td class="num mono">${eur(f.bedrag)}</td>
          <td>${esc(fmtDate(f.due_date))}</td>
          <td><select style="${selectStijl}" onchange="window.__commKoppelKies('${esc(f.invoice_id)}', this.value)">
            <option value="">— kies sale —</option>
            ${f.opties.map((o) => `<option value="${esc(o.deal_id)}" ${gekozen === o.deal_id ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
            <option value="geen" ${gekozen === 'geen' ? 'selected' : ''}>Hoort bij geen sale</option>
          </select></td>
          <td>${isAdmin() ? `<button class="btn btn-ghost btn-sm" onclick="window.__commKoppel('${esc(f.invoice_id)}')">Koppel</button>` : ''}</td></tr>`;
        })));
    }
    if (gek.length) {
      html += sectie('Gekoppelde regelingsfacturen', 'Automatisch (klant met één sale) of door jou gekozen.',
        tbl(['Klant', 'Factuur', 'Bedrag', 'Hoort bij', 'Hoe', ''], gek.map((f) => `<tr><td><b>${esc(f.klant)}</b></td><td class="mono">${esc(f.invoice_number || '—')}</td>
          <td class="num mono">${eur(f.bedrag)}</td><td style="font-size:12px">${esc(f.sale)}</td><td>${f.bron === 'auto' ? H.pill('neutral', 'Automatisch', true) : H.pill('violet', 'Handmatig', true)}</td>
          <td>${isAdmin() && f.bron === 'handmatig' ? `<button class="btn btn-ghost btn-sm" onclick="window.__commKoppelWis('${esc(f.invoice_id)}')">Keuze wissen</button>` : ''}</td></tr>`)));
    }
    return card('Wanbetaling: incasso & regelingen', 'rose', html);
  }

  window.__commKoppelKies = (inv, v) => { _st.koppelKeuze[inv] = v; };
  window.__commKoppel = async (inv) => {
    const v = _st.koppelKeuze[inv];
    if (!v) { toast('Kies eerst bij welke sale de factuur hoort.'); return; }
    const j = await post('/api/commissie-factuur-koppelen', { invoice_id: inv, deal_id: v === 'geen' ? null : v });
    if (j?.__error) { toast(j.__error); return; }
    toast('Factuur gekoppeld.');
    _st.data = null; queueMicrotask(laad); render();
  };
  window.__commKoppelWis = async (inv) => {
    const j = await post('/api/commissie-factuur-koppelen', { invoice_id: inv, actie: 'wissen' });
    if (j?.__error) { toast(j.__error); return; }
    toast('Keuze gewist.');
    _st.data = null; queueMicrotask(laad); render();
  };

  const vandaagIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  window.__commIncassoOpen = (customerId, dealId) => {
    const sale = asArr(_st.data?.sales).find((x) => x.customer_id === customerId && (!dealId || x.deal_id === dealId));
    _st.incasso = { customer_id: customerId, deal_id: dealId || null, klant: sale?.klant || '', sinds: vandaagIso(), reden: '', scope: 'klant', bron: 'handmatig', bezig: false, fout: null };
    render();
  };
  window.__commIncassoVoorstel = (i) => {
    const m = asArr(_st.data?.mogelijk_incasso)[i];
    if (!m) return;
    _st.incasso = { customer_id: m.customer_id, deal_id: null, klant: m.klant, sinds: m.voorstel_sinds || vandaagIso(),
      reden: m.signalen.map((x) => x.bron).join(', '), scope: 'klant', bron: 'voorstel', bezig: false, fout: null };
    render();
  };
  window.__commIncassoVeld = (k, v) => { if (_st.incasso) _st.incasso[k] = v; };
  window.__commIncassoScope = (v) => { if (_st.incasso) { _st.incasso.scope = v; render(); } };
  window.__commIncassoSluit = () => { _st.incasso = null; render(); };
  window.__commIncassoOk = async () => {
    const x = _st.incasso;
    if (!x || x.bezig) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x.sinds))) { x.fout = 'Kies een datum.'; render(); return; }
    if (String(x.reden || '').trim().length < 3) { x.fout = 'Geef een korte reden.'; render(); return; }
    x.bezig = true; x.fout = null; render();
    const j = await post('/api/commissie-incasso', {
      actie: 'markeren', customer_id: x.customer_id, deal_id: x.scope === 'sale' ? x.deal_id : null,
      sinds: x.sinds, reden: x.reden, bron: x.bron,
    });
    if (!_st.incasso) return;
    if (j?.__error) { x.bezig = false; x.fout = j.__error; render(); return; }
    _st.incasso = null;
    toast(`Incasso gemarkeerd — vanaf ${fmtDate(x.sinds)} geen commissie meer.`);
    _st.data = null; queueMicrotask(laad); render();
  };
  function incassoModal() {
    const x = _st.incasso;
    if (!x) return '';
    const body = `<div style="font-size:13.5px;line-height:1.6;margin-bottom:12px">Klant <b>${esc(x.klant)}</b> naar incasso: vanaf de datum telt geen enkele betaling nog voor de mentor — ook niet als het bureau later geld binnenhaalt. Wat al vrijgegeven of uitbetaald is, blijft van de mentor.</div>
      ${x.deal_id ? `<div style="display:flex;gap:14px;margin-bottom:12px;font-size:13px">
        <label style="display:flex;gap:6px;align-items:center"><input type="radio" name="comm-inc-scope" ${x.scope === 'klant' ? 'checked' : ''} onchange="window.__commIncassoScope('klant')"> Alle sales van deze klant</label>
        <label style="display:flex;gap:6px;align-items:center"><input type="radio" name="comm-inc-scope" ${x.scope === 'sale' ? 'checked' : ''} onchange="window.__commIncassoScope('sale')"> Alleen deze sale</label></div>` : ''}
      <label style="display:block;margin-bottom:10px">${lbl('Sinds')}<input type="date" value="${esc(x.sinds)}" oninput="window.__commIncassoVeld('sinds', this.value)" style="${inputStijl}" /></label>
      <label style="display:block;margin-bottom:10px">${lbl('Reden (alleen intern zichtbaar)')}<input type="text" value="${esc(x.reden)}" oninput="window.__commIncassoVeld('reden', this.value)" placeholder="bv. dossier naar incassobureau" style="${inputStijl}" /></label>
      ${x.fout ? `<div style="padding:9px 12px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-bottom:10px">${esc(x.fout)}</div>` : ''}
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__commIncassoSluit()">Annuleren</button>
        <button class="btn btn-danger" ${x.bezig ? 'disabled' : ''} onclick="window.__commIncassoOk()">${x.bezig ? 'Bezig…' : 'Markeer als incasso'}</button>
      </div>`;
    return modal('Incasso — geen commissie meer', body, 'window.__commIncassoSluit()', 520);
  }

  window.__commOpheffenOpen = (id) => {
    const m = asArr(_st.data?.incasso_markeringen).find((x) => x.id === id);
    if (!m) return;
    _st.opheffen = { id, klant: m.klant, sinds: m.sinds, reden: '', bezig: false, fout: null };
    render();
  };
  window.__commOpheffenVeld = (v) => { if (_st.opheffen) _st.opheffen.reden = v; };
  window.__commOpheffenSluit = () => { _st.opheffen = null; render(); };
  window.__commOpheffenOk = async () => {
    const x = _st.opheffen;
    if (!x || x.bezig) return;
    x.bezig = true; x.fout = null; render();
    const j = await post('/api/commissie-incasso', { actie: 'opheffen', id: x.id, reden: x.reden || null });
    if (!_st.opheffen) return;
    if (j?.__error) { x.bezig = false; x.fout = j.__error; render(); return; }
    _st.opheffen = null;
    toast('Incasso opgeheven — betalingen tellen weer mee.');
    _st.data = null; queueMicrotask(laad); render();
  };
  function opheffenModal() {
    const x = _st.opheffen;
    if (!x) return '';
    const body = `<div style="font-size:13.5px;line-height:1.6;margin-bottom:12px">Incasso voor <b>${esc(x.klant)}</b> (sinds ${esc(fmtDate(x.sinds))}) opheffen? Vanaf nu tellen alle betalingen weer mee voor de mentor; wat sindsdien betaald werd, valt bij de volgende vrijgave alsnog vrij.</div>
      <label style="display:block;margin-bottom:10px">${lbl('Reden (optioneel)')}<input type="text" value="${esc(x.reden)}" oninput="window.__commOpheffenVeld(this.value)" placeholder="bv. vergissing" style="${inputStijl}" /></label>
      ${x.fout ? `<div style="padding:9px 12px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-bottom:10px">${esc(x.fout)}</div>` : ''}
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__commOpheffenSluit()">Annuleren</button>
        <button class="btn btn-primary" ${x.bezig ? 'disabled' : ''} onclick="window.__commOpheffenOk()">${x.bezig ? 'Bezig…' : 'Opheffen'}</button>
      </div>`;
    return modal('Incasso opheffen', body, 'window.__commOpheffenSluit()', 480);
  }

  /* ── Hoofdview ───────────────────────────────────────────────────────── */
  function commissiesView() {
    if (!isAdmin()) {
      return `<div class="empty" style="padding:72px 20px"><div class="empty-ico">${svg(I.grad)}</div><div class="empty-t">Geen toegang</div>
        <div class="empty-s">Commissies zijn alleen zichtbaar voor manager / admin / super_admin.</div></div>`;
    }
    if (!_st.data && !_st.loading && !_st.error) queueMicrotask(laad);
    const kop = `<div class="pad" style="padding-top:14px;padding-bottom:0;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <div style="font-size:12.5px;color:var(--text-2);flex:1;min-width:220px">Commissie valt pas vrij wanneer de klant de factuur effectief betaalt.</div>
      <select style="${selectStijl}" onchange="window.__commPeriode(this.value)" aria-label="Periode">
        ${[['alles', 'Alle sales'], ['dit_jaar', 'Dit jaar'], ['12m', 'Laatste 12 maanden'], ['90d', 'Laatste 90 dagen']].map(([v, l]) => `<option value="${v}" ${_st.periode === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <button class="btn btn-primary btn-sm" onclick="window.__commWizOpen()">${svg(I.plus, 'width:14px;height:14px')} Sale toewijzen</button>
    </div>`;
    const modals = `${wizard()}${annuleerModal()}${inhaalModal()}${incassoModal()}${opheffenModal()}${zijpaneel()}`;
    if (_st.error && !_st.data) return kop + errBlk(_st.error) + modals;
    if (!_st.data) return kop + skel() + modals;

    const d = _st.data;
    const k = d.kpis || {};
    const migratie = d.migratie_ok === false ? `<div class="pad" style="padding-top:10px;padding-bottom:0"><div style="padding:9px 12px;border:1px solid var(--amber-line);background:var(--amber-soft);color:var(--amber);border-radius:8px;font-size:12.5px">
      Handmatig toewijzen kan zodra de database-migratie gedraaid is. Het overzicht hieronder werkt al.</div></div>` : '';
    const fouten = asArr(d.fouten).length ? `<div class="pad" style="padding-top:10px;padding-bottom:0"><div style="padding:9px 12px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px">
      Niet alles kon geladen worden: ${esc(asArr(d.fouten).map((f) => f.naam).join(', '))}.</div></div>` : '';
    const kpiStrip = H.kpis([
      { c: 'violet', icon: I.euro, label: 'Commissie geboekt', val: eur(k.geboekt), sub: `${k.aantal_sales || 0} sales` },
      { c: 'emerald', icon: I.tick, label: 'Vrijgegeven', val: eur(k.vrijgegeven), sub: 'klant heeft betaald', hi: true },
      { c: 'blue', icon: I.clock, label: 'Nog binnen te komen', val: eur(k.open), sub: 'wacht op betaling' },
      { c: 'teal', icon: I.cal, label: 'Verwacht deze maand', val: eur(k.deze_maand_verwacht), sub: `volgende maand ${eur(k.volgende_maand_verwacht)}` },
      { c: 'amber', icon: I.clock, label: 'Achterstallig', val: eur(k.achterstallig), sub: `schuift mee · ${k.achterstallig_aantal || 0} termijn${k.achterstallig_aantal === 1 ? '' : 'en'}`, hi: (k.achterstallig || 0) > 0 },
      { c: 'rose', icon: I.alert, label: 'Risico', val: eur(k.risico), sub: `${k.risico_aantal || 0} sale${k.risico_aantal === 1 ? '' : 's'} · vervallen / wanbetaler / geannuleerd`, hi: (k.risico || 0) > 0 },
      ...((k.vervallen_incasso || 0) > 0 ? [{ c: 'rose', icon: I.alert, label: 'Vervallen door incasso', val: eur(k.vervallen_incasso), sub: `${k.vervallen_incasso_aantal || 0} sale${k.vervallen_incasso_aantal === 1 ? '' : 's'} · niet meer voor de mentor` }] : []),
    ]);
    const seg = [['mentor', 'Per mentor'], ['event', 'Per event'], ['sale', 'Per sale']].map(([v, l]) =>
      `<button class="chip ${_st.weergave === v ? 'on' : ''}" onclick="window.__commWeergave('${v}')">${l}</button>`).join('');
    const inhoud = _st.weergave === 'mentor' ? perMentorView()
      : _st.weergave === 'event' ? filterBalk() + perEventView()
        : filterBalk() + salesTabel(gefilterdeSales());
    // 6 tegels: iets smaller dan de standaard (200px) zodat ze op één rij passen.
    const kpiStijl = '<style>.comm-kpis .kpi-grid{grid-template-columns:repeat(auto-fit,minmax(165px,1fr))}</style>';
    return `${kop}${migratie}${fouten}${kpiStijl}<div class="comm-kpis">${kpiStrip}</div>
      <div class="pad" style="padding-top:0">
        <div style="height:14px"></div>
        ${card('Commissie per maand', 'violet', grafiek(), '<span style="font-size:11.5px;color:var(--text-3)">verleden = vrijgegeven · toekomst = verwacht</span>')}
        ${card('Overzicht', 'blue', inhoud, `<div style="display:flex;gap:6px">${seg}</div>`)}
        ${verschovenBlok()}
        ${wanbetalingBlok()}
      </div>
      ${modals}`;
  }

  window.DFO.VIEWS['mentoren/Commissies'] = commissiesView;
  console.debug('[commissies-v2] v1 — Mentoren/Commissies geregistreerd.');
})();
