// modules/klanten-v2/views/trustpilot-v2.js
//
// TRUSTPILOT-REVIEWS (Maxim, 16 nov 2026) — de campagne "Kerst 2026" in het
// LMS: wie zag de pop-up, wie koos Later of Niet meer tonen, en wie bevestigde
// dat zijn review online staat (met de naam waaronder die op Trustpilot staat).
// Per 10 bevestigde reviews verloot Maxim een 25k funded account — de loting
// doet hij ZELF; hier enkel de namen (kopiëren) en een CSV.
//
// Alleen lezen. De enige knop die iets wijzigt: een TESTrij wissen (checkin.run).
// Data: GET /api/trustpilot-reviews (recht checkin.view), rekenkern
// api/_lib/trustpilot-overzicht.js. Testaccounts tellen nergens mee.

(function () {
  'use strict';
  if (!window.DFO) return;
  window.DFO.VIEWS = window.DFO.VIEWS || {};
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const API = '/api/trustpilot-reviews';
  const st = window.__tpState = window.__tpState || { laden: false, data: null, fout: null, filter: '', zoek: '', test: false, sort: 'bevestigd' };
  const rerender = () => { if (typeof window.DFO.render === 'function') window.DFO.render(); };
  const toast = (m) => { if (window.KV && typeof window.KV.toast === 'function') window.KV.toast(m); else alert(m); };
  const moment = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('nl-BE', { timeZone: 'Europe/Brussels', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (_) { return '—'; }
  };
  const dag = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleDateString('nl-BE', { timeZone: 'Europe/Brussels', day: 'numeric', month: 'long', year: 'numeric' }); } catch (_) { return '—'; }
  };
  const KLEUR = { nog_niet_gezien: 'var(--text-3)', later: 'var(--amber,#B7791F)', niet_meer_tonen: 'var(--rose,#b42318)', geplaatst: 'var(--emerald,#059669)' };

  async function laad() {
    st.laden = true; st.fout = null; rerender();
    try {
      st.data = await window.KV.authedJson(API);
    } catch (e) {
      st.fout = e && e.status === 403 ? 'Geen toegang (recht checkin.view).' : ((e && e.body && e.body.error) || (e && e.message) || 'Het overzicht kon niet geladen worden.');
    } finally {
      st.laden = false; rerender();
    }
  }

  window.__tp = {
    laad,
    filter: (f) => { st.filter = st.filter === f ? '' : f; rerender(); },
    zoek: (v) => { st.zoek = v; rerender(); setTimeout(() => { const el = document.getElementById('tpZoek'); if (el) { el.focus(); el.setSelectionRange(v.length, v.length); } }, 0); },
    test: (v) => { st.test = !!v; rerender(); },
    sort: (v) => { st.sort = v; rerender(); },
    csv: async () => {
      try {
        const r = await window.KV.authedFetch(API + '?csv=1');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const url = URL.createObjectURL(await r.blob());
        const a = document.createElement('a');
        a.href = url; a.download = 'trustpilot-reviews.csv';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (e) { toast('Export mislukt: ' + (e.message || e)); }
    },
    kopieer: async () => {
      const namen = (st.data && st.data.loting) || [];
      if (!namen.length) return toast('Nog geen bevestigde reviews.');
      try { await navigator.clipboard.writeText(namen.join('\n')); toast(namen.length + ' namen gekopieerd.'); }
      catch (_) { window.prompt('Kopieer de namen:', namen.join('\n')); }
    },
    reset: async (i) => {
      const r = (st.zichtbaar || [])[i];
      if (!r) return;
      const id = r.student_id;
      const naam = r.naam;
      if (!confirm('De testrij van ' + naam + ' wissen? De pop-up komt dan opnieuw voor dit testaccount.')) return;
      try {
        await window.KV.authedJson(API, { method: 'POST', body: JSON.stringify({ actie: 'reset_test', student_id: id }) });
        toast('Testrij gewist.'); laad();
      } catch (e) { toast((e && e.body && e.body.error) || 'Wissen mislukt.'); }
    },
  };

  function tegel(sleutel, label, waarde, sub) {
    const actief = st.filter === sleutel;
    return `<button type="button" class="card" onclick="window.__tp.filter('${sleutel}')" data-testid="tp-tegel-${sleutel}" style="text-align:left;cursor:pointer;border:${actief ? '2px solid var(--brand,#0ea5e9)' : '1px solid var(--border)'}"><div class="card-body" style="padding:10px 12px">
      <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em">${esc(label)}</div>
      <div style="font-size:22px;font-weight:700">${esc(waarde)}</div>${sub ? `<div style="font-size:11.5px;color:var(--text-3)">${esc(sub)}</div>` : ''}</div></button>`;
  }

  function view() {
    if (!st.data && !st.laden && !st.fout) laad();
    if (st.fout) return `<div class="card"><div class="card-body" style="color:var(--rose)">${esc(st.fout)} <button class="btn btn-ghost btn-sm" onclick="window.__tp.laad()">Opnieuw</button></div></div>`;
    if (!st.data) return `<div class="card"><div class="card-body" style="color:var(--text-3)">Laden…</div></div>`;
    const d = st.data;
    const c = d.campagne;
    const t = d.tegels;
    const L = d.status_label || {};
    const statusPill = { concept: ['Concept — enkel testaccounts', 'var(--amber,#B7791F)'], live: ['Live', 'var(--emerald,#059669)'], afgelopen: ['Afgelopen', 'var(--text-3)'] }[c.status] || [c.status, 'var(--text-3)'];

    let h = `<div data-testid="trustpilot-reviews">`;
    h += `<div class="card" style="margin-bottom:12px"><div class="card-body" style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start">
      <div style="flex:1;min-width:240px"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b style="font-size:15px">${esc(c.naam)}</b>
        <span data-testid="tp-campagne-status" style="padding:2px 8px;border-radius:999px;border:1px solid ${statusPill[1]};color:${statusPill[1]};font-size:11.5px;font-weight:600">${esc(statusPill[0])}</span></div>
        <div style="font-size:12.5px;color:var(--text-2);margin-top:6px;line-height:1.5">Van ${esc(dag(c.start_op))} tot en met ${esc(dag(c.einde_op))}. Per ${esc(c.per_aantal)} bevestigde reviews: één ${esc(c.prijs)} (de loting doe je zelf). Testaccounts tellen nergens mee.</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" onclick="window.__tp.kopieer()" data-testid="tp-kopieer">Kopieer namen voor de loting (${esc((d.loting || []).length)})</button>
        <button class="btn btn-ghost btn-sm" onclick="window.__tp.csv()" data-testid="tp-csv">Export CSV</button>
      </div></div></div>`;

    h += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:10px">
      ${tegel('doelgroep', 'Doelgroep', t.doelgroep, 'actieve studenten')}
      ${tegel('nog_niet_gezien', 'Nog niet gezien', t.nog_niet_gezien)}
      ${tegel('later', 'Later', t.later)}
      ${tegel('niet_meer_tonen', 'Niet meer tonen', t.niet_meer_tonen)}
      ${tegel('geplaatst', 'Geplaatst', t.geplaatst, t.link_geklikt + ' klikten op de link')}
    </div>`;
    h += `<div class="card" style="margin-bottom:12px" data-testid="tp-verloten"><div class="card-body" style="font-size:13.5px"><b>Accounts te verloten: ${esc(t.te_verloten)} × ${esc(c.prijs)}</b> <span style="color:var(--text-3)">(nog ${esc(t.nog_tot_volgende)} review${t.nog_tot_volgende === 1 ? '' : 's'} tot het volgende)</span></div></div>`;

    //  Tabel
    const q = st.zoek.trim().toLowerCase();
    let rijen = (d.rijen || []).filter((r) => (st.test ? true : !r.is_test));
    if (st.filter === 'doelgroep') rijen = rijen.filter((r) => r.in_doelgroep);
    else if (st.filter) rijen = rijen.filter((r) => r.status === st.filter);
    if (q) rijen = rijen.filter((r) => [r.naam, r.email, r.trustpilot_naam].some((x) => String(x || '').toLowerCase().includes(q)));
    rijen = rijen.slice().sort(st.sort === 'naam'
      ? (a, b) => a.naam.localeCompare(b.naam, 'nl')
      : (a, b) => String(b.bevestigd_op || '').localeCompare(String(a.bevestigd_op || '')) || a.naam.localeCompare(b.naam, 'nl'));

    h += `<div class="card"><div class="card-body">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
        <input id="tpZoek" type="search" placeholder="Zoek op naam, e-mail of Trustpilot-naam" value="${esc(st.zoek)}" oninput="window.__tp.zoek(this.value)" data-testid="tp-zoek" style="flex:1;min-width:200px;padding:7px 9px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:inherit">
        <label style="font-size:12px">Status <select onchange="window.__tp.filter(this.value || '')" data-testid="tp-filter">
          <option value="">Alle</option>${['nog_niet_gezien', 'later', 'niet_meer_tonen', 'geplaatst'].map((s) => `<option value="${s}" ${st.filter === s ? 'selected' : ''}>${esc(L[s] || s)}</option>`).join('')}</select></label>
        <label style="font-size:12px">Sorteer <select onchange="window.__tp.sort(this.value)" data-testid="tp-sort">
          <option value="bevestigd" ${st.sort === 'bevestigd' ? 'selected' : ''}>Bevestigd op (nieuwste eerst)</option>
          <option value="naam" ${st.sort === 'naam' ? 'selected' : ''}>Naam</option></select></label>
        <label style="font-size:12px"><input type="checkbox" ${st.test ? 'checked' : ''} onchange="window.__tp.test(this.checked)" data-testid="tp-toon-test"> Toon testaccounts</label>
      </div>
      <div style="overflow-x:auto"><table class="table" style="width:100%;font-size:12.5px" data-testid="tp-tabel"><thead><tr>
        <th>Naam</th><th>E-mail</th><th>Traject</th><th>Mentor</th><th>Status</th><th>Trustpilot-naam</th><th>Bevestigd op</th><th>Keer getoond</th><th>Laatst getoond</th><th>Laatst later</th>${d.rechten && d.rechten.reset ? '<th></th>' : ''}
      </tr></thead><tbody>`;
    st.zichtbaar = rijen;
    h += rijen.length ? rijen.map((r, i) => `<tr data-testid="tp-rij" data-status="${esc(r.status)}">
        <td>${esc(r.naam)}${r.is_test ? ' <span style="font-size:10.5px;color:var(--amber,#B7791F);font-weight:600">TEST</span>' : ''}</td>
        <td>${esc(r.email || '—')}</td><td>${esc(r.traject)}</td><td>${esc(r.mentor || '—')}</td>
        <td><span style="color:${KLEUR[r.status] || 'inherit'};font-weight:600">${esc(L[r.status] || r.status)}</span></td>
        <td>${esc(r.trustpilot_naam || '—')}</td><td>${esc(moment(r.bevestigd_op))}</td><td>${esc(r.keer_getoond)}</td>
        <td>${esc(moment(r.laatst_getoond_op))}</td><td>${esc(moment(r.laatst_later_op))}</td>
        ${d.rechten && d.rechten.reset ? `<td>${r.is_test && r.heeft_rij ? `<button class="btn btn-ghost btn-sm" onclick="window.__tp.reset(${i})" data-testid="tp-reset">Reset test</button>` : ''}</td>` : ''}
      </tr>`).join('') : `<tr><td colspan="11" style="color:var(--text-3);padding:14px">Niemand binnen deze filter.</td></tr>`;
    h += `</tbody></table></div></div></div></div>`;
    return h;
  }

  window.DFO.VIEWS['trustpilot/'] = view;
})();
