// modules/klanten-v2/views/trial-opvolging-v2.js
//
// Leadsonderhoud › Templates › Trial-opvolging (26 okt 2026).
//
// De warme opvolgmotor van ELKE trial-lead (minicursus, 7-daagse, webinar,
// website, The Lab) in één scherm: de schakelaar aan/uit, en per stap de
// mailtekst (standaard of eigen) en het WhatsApp-template met zijn
// Meta-status. Bron: GET/POST /api/lab-opvolging-instellingen. Bewaren via
// de bestaande /api/leadsonderhoud-sjabloon-opslaan (traject 'the-lab').
//
// window.DFOTrialOpvolging.render() → HTML-string (de Templates-view roept dit
// aan in de subtab "Trial-opvolging").
(function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const rerender = () => { if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render(); };
  const toast = (t, soort) => { try { (window.KV && window.KV.toast) ? window.KV.toast(t, soort) : console.log(t); } catch (_) { /* geen toast */ } };

  const st = { laden: false, data: null, fout: null, bewerk: null, bezig: false };

  async function json(url, init) {
    if (!window.KV || typeof window.KV.authedJson !== 'function') throw new Error('KV.authedJson niet beschikbaar');
    return window.KV.authedJson(url, init);
  }

  async function laad(force) {
    if (st.laden || (st.data && !force)) return;
    st.laden = true; st.fout = null;
    try { st.data = await json('/api/lab-opvolging-instellingen'); } catch (e) { st.fout = e.message || 'Kon de instellingen niet ophalen'; }
    st.laden = false;
    rerender();
  }

  window.__trialOpvLive = async (aan) => {
    if (aan && !window.confirm('De opvolgmotor AAN zetten? Vanaf de volgende run (elk kwartier) krijgen trial-leads echte mails en WhatsApps.')) return;
    try {
      const j = await json('/api/lab-opvolging-instellingen', { method: 'POST', body: JSON.stringify({ live: !!aan }) });
      if (st.data) st.data.live = j.live;
      toast(j.live ? 'Opvolgmotor staat AAN' : 'Opvolgmotor staat UIT (droogloop)', 'ok');
    } catch (e) { toast('Opslaan mislukt: ' + e.message, 'err'); }
    rerender();
  };

  const tekstUitHtml = (h) => String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();

  window.__trialOpvBewerk = (stap, kanaal) => {
    const s = (st.data?.stappen || []).find((x) => x.stap === stap);
    if (!s) return;
    if (kanaal === 'mail') {
      const e = s.mail?.eigen;
      st.bewerk = { stap, kanaal, id: e?.id || null, onderwerp: e?.onderwerp ?? s.mail?.standaard?.onderwerp ?? '', html: e?.html ?? s.mail?.standaard?.html ?? '', actief: e ? e.actief !== false : true };
    } else {
      const e = s.whatsapp?.eigen;
      st.bewerk = { stap, kanaal, id: e?.id || null, meta_template: e?.meta_template || s.whatsapp?.voorgesteld_template || '', variabele_volgorde: (e?.variabele_volgorde || ['voornaam', 'loginlink']).join(', '), tekst: e?.tekst || '', actief: e ? e.actief !== false : true };
    }
    rerender();
  };
  window.__trialOpvVeld = (k, v) => { if (st.bewerk) st.bewerk[k] = v; };
  window.__trialOpvSluit = () => { st.bewerk = null; rerender(); };
  window.__trialOpvBewaar = async (actief) => {
    const b = st.bewerk;
    if (!b || st.bezig) return;
    const body = { id: b.id || undefined, traject_slug: 'the-lab', soort: b.stap, kanaal: b.kanaal, actief: actief !== false };
    if (b.kanaal === 'mail') {
      body.onderwerp = b.onderwerp; body.html = b.html; body.tekst = tekstUitHtml(b.html) || b.onderwerp || b.stap;
    } else {
      body.meta_template = b.meta_template; body.variabele_volgorde = b.variabele_volgorde; body.tekst = b.tekst || b.meta_template || b.stap;
    }
    st.bezig = true; rerender();
    try {
      await json('/api/leadsonderhoud-sjabloon-opslaan', { method: 'POST', body: JSON.stringify(body) });
      toast(actief === false ? 'Terug naar de standaardtekst' : 'Bewaard', 'ok');
      st.bewerk = null;
      await laad(true);
    } catch (e) { toast('Bewaren mislukt: ' + e.message, 'err'); }
    st.bezig = false; rerender();
  };

  const chip = (tekst, kleur) => `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;border:1px solid ${kleur};color:${kleur};margin-right:6px">${esc(tekst)}</span>`;

  function waStatus(w) {
    if (!w) return '';
    if (w.eigen && w.eigen.actief === false) return chip('WhatsApp uit', 'var(--text-3)');
    const naam = w.eigen?.meta_template || w.voorgesteld_template;
    if (!w.eigen) return chip('WhatsApp: nog geen template gekoppeld', 'var(--amber,#B7791F)');
    if (w.goedgekeurd === true) return chip('WhatsApp · ' + naam + ' · goedgekeurd', 'var(--emerald,#1F9D6B)');
    if (w.goedgekeurd === false) return chip('WhatsApp · ' + naam + ' · wacht op Meta (wordt overgeslagen)', 'var(--amber,#B7791F)');
    return chip('WhatsApp · ' + naam + ' · status onbekend', 'var(--text-3)');
  }

  function bewerkModal() {
    const b = st.bewerk;
    if (!b) return '';
    const vars = (st.data?.variabelen || []).map((v) => '{' + v + '}').join(' ');
    const veld = (label, k, v, rijen) => rijen
      ? `<label style="display:block;margin-top:12px;font-size:12px;font-weight:600">${esc(label)}<textarea oninput="window.__trialOpvVeld('${k}', this.value)" rows="${rijen}" style="display:block;width:100%;margin-top:4px;font:12.5px/1.5 var(--mono,monospace);padding:8px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface)">${esc(v)}</textarea></label>`
      : `<label style="display:block;margin-top:12px;font-size:12px;font-weight:600">${esc(label)}<input oninput="window.__trialOpvVeld('${k}', this.value)" value="${esc(v)}" style="display:block;width:100%;margin-top:4px;padding:8px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface)"></label>`;
    const inhoud = b.kanaal === 'mail'
      ? veld('Onderwerp', 'onderwerp', b.onderwerp) + veld('Tekst (HTML; de knop staat als <table>-blok, laat {loginlink} in de href staan)', 'html', b.html, 16)
      : veld('Naam van het Meta-template (exact zoals in WhatsApp Manager)', 'meta_template', b.meta_template)
        + veld('Variabelen in volgorde ({{1}}, {{2}}, …) — komma-gescheiden', 'variabele_volgorde', b.variabele_volgorde)
        + veld('Tekst van het template (ter info, zoals ingediend bij Meta)', 'tekst', b.tekst, 6);
    return `<div style="position:fixed;inset:0;background:rgba(10,20,30,.45);z-index:9000;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow:auto" onclick="if(event.target===this)window.__trialOpvSluit()">
      <div style="background:var(--surface,#fff);border-radius:var(--r-md,12px);max-width:760px;width:100%;padding:20px 22px;box-shadow:0 20px 60px rgba(0,0,0,.25)">
        <div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0;font-size:16px">${esc(b.kanaal === 'mail' ? 'Mail' : 'WhatsApp')} · ${esc(b.stap)}</h3><button onclick="window.__trialOpvSluit()" style="border:0;background:transparent;font-size:18px;cursor:pointer">✕</button></div>
        <p style="margin:8px 0 0;font-size:12px;color:var(--text-3)">Variabelen: <code>${esc(vars)}</code></p>
        ${inhoud}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap">
          ${b.id ? `<button onclick="window.__trialOpvBewaar(false)" ${st.bezig ? 'disabled' : ''} style="padding:8px 14px;border:1px solid var(--border);border-radius:var(--r-sm);background:transparent;cursor:pointer">${b.kanaal === 'mail' ? 'Terug naar standaardtekst' : 'WhatsApp uitzetten'}</button>` : ''}
          <button onclick="window.__trialOpvSluit()" style="padding:8px 14px;border:1px solid var(--border);border-radius:var(--r-sm);background:transparent;cursor:pointer">Annuleren</button>
          <button onclick="window.__trialOpvBewaar(true)" ${st.bezig ? 'disabled' : ''} style="padding:8px 14px;border:0;border-radius:var(--r-sm);background:var(--brand,#0A7490);color:#fff;font-weight:600;cursor:pointer">${st.bezig ? 'Bewaren…' : 'Bewaar'}</button>
        </div>
      </div>
    </div>`;
  }

  function render() {
    if (!st.data && !st.laden && !st.fout) queueMicrotask(() => laad(false));
    if (st.fout) return `<div style="padding:16px;background:var(--rose-soft);color:var(--rose);border-radius:var(--r-sm);font-size:13px">Kon de trial-opvolging niet ophalen: ${esc(st.fout)} <button onclick="window.__trialOpvHerlaad()" style="margin-left:8px">Opnieuw</button></div>`;
    if (!st.data) return '<div style="padding:24px;color:var(--text-3);font-size:13px">Trial-opvolging laden…</div>';
    const d = st.data;
    const schakelaar = `<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:14px 16px;border:1px solid var(--border);border-radius:var(--r-md,12px);background:var(--surface-2,var(--surface));margin-bottom:16px">
      <div style="flex:1;min-width:240px"><div style="font-weight:700;font-size:14px">Opvolgmotor trial-leads</div>
        <div style="font-size:12px;color:var(--text-3);margin-top:2px">Elke trial (minicursus, 7-daagse, webinar, website, The Lab). Elk kwartier, nooit tussen 21u en 8u, max. 1 bericht per 20 uur, stopt bij sessie geboekt, afmelding of klant.</div></div>
      ${d.noodstop ? chip('NOODSTOP actief (env LEADSONDERHOUD_UIT) — er gaat niets weg', 'var(--rose,#C22B3E)') : ''}
      <button onclick="window.__trialOpvLive(${d.live ? 'false' : 'true'})" style="padding:8px 16px;border-radius:999px;border:0;font-weight:700;cursor:pointer;background:${d.live ? 'var(--emerald,#1F9D6B)' : 'var(--text-3,#7a8794)'};color:#fff">${d.live ? 'AAN — klik om uit te zetten' : 'UIT (droogloop) — klik om aan te zetten'}</button>
    </div>`;
    const kaarten = (d.stappen || []).map((s) => {
      const mailChip = s.mail ? (s.mail.eigen && s.mail.eigen.actief !== false ? chip('Mail · eigen tekst', 'var(--brand,#0A7490)') : chip('Mail · standaardtekst', 'var(--text-2,#4a5a68)')) : chip('Mail · welkomst per belofte (code)', 'var(--text-2,#4a5a68)');
      const onderwerp = s.mail ? (s.mail.eigen && s.mail.eigen.actief !== false ? s.mail.eigen.onderwerp : s.mail.standaard?.onderwerp) : '';
      return `<div style="border:1px solid var(--border);border-radius:var(--r-md,12px);padding:12px 14px;margin-bottom:10px;background:var(--surface)">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline">
          <div><span style="font-weight:700">${esc(s.label)}</span> <code style="font-size:11px;color:var(--text-3)">${esc(s.stap)}</code></div>
          <div style="display:flex;gap:6px">
            ${s.mail ? `<button onclick="window.__trialOpvBewerk('${esc(s.stap)}','mail')" style="padding:5px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:transparent;cursor:pointer;font-size:12px">Mail bewerken</button>` : ''}
            ${s.whatsapp ? `<button onclick="window.__trialOpvBewerk('${esc(s.stap)}','whatsapp')" style="padding:5px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:transparent;cursor:pointer;font-size:12px">WhatsApp-template</button>` : ''}
          </div>
        </div>
        <div style="font-size:12px;color:var(--text-3);margin:4px 0 8px">${esc(s.wanneer)}</div>
        <div>${mailChip}${waStatus(s.whatsapp)}</div>
        ${onderwerp ? `<div style="font-size:12.5px;margin-top:8px"><span style="color:var(--text-3)">Onderwerp:</span> ${esc(onderwerp)}</div>` : ''}
      </div>`;
    }).join('');
    return `${schakelaar}${!d.wa_lijn_ok ? '<div style="font-size:12px;color:var(--amber,#B7791F);margin-bottom:10px">Geen leadsonderhoud-WhatsApp-lijn gevonden: WhatsApp wordt overgeslagen, de mails gaan wel.</div>' : ''}${kaarten}
      <div style="font-size:11.5px;color:var(--text-3);margin-top:6px">WhatsApp gaat enkel via een door Meta goedgekeurd template. Zolang dat er niet is, slaat de motor WhatsApp over (gelogd in lab_opvolging) en gaat de mail wel. Voorgestelde templateteksten: docs/trial-opvolging-whatsapp.md.</div>
      ${bewerkModal()}`;
  }

  window.__trialOpvHerlaad = () => { st.fout = null; laad(true); };
  window.DFOTrialOpvolging = { render, herlaad: () => laad(true) };
})();
