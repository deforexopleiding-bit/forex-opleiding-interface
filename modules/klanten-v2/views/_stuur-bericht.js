// modules/klanten-v2/views/_stuur-bericht.js
//
// "Stuur bericht" (fase 1, 2026-10-09) — ÉÉN popup, gedeeld door:
//   - Leads → detail → Meer acties            (leads-v2.js)
//   - Leadsonderhoud → Contacten → rij-actie   (leadsonderhoud-v2.js)
// Tabs:
//   WhatsApp        — ECHT goedgekeurde templates van de lead-WABA (live via
//                     /api/lead-bericht), variabelen (voornaam automatisch),
//                     live voorbeeld, versturen → staat in de gesprekkendraad.
//   E-mail          — onderwerp + editor (vet/cursief/onderstreept/kop/lijsten/
//                     link), variabelen {{voornaam}} e.d., optioneel een sjabloon
//                     laden; verzonden in de huisstijl-shell, staat in de draad.
//   E-mailsjablonen — bibliotheek: nieuw / bewerken / verwijderen / gebruiken.
// Geen massaverzending (fase 2).
//
// Hangt aan document.body (niet aan DFO.render): leadsonderhoud rendert elke
// 20 s opnieuw en zou anders de editor onder je vingers vervangen. De editor
// wordt alleen opnieuw opgebouwd bij een tab-wissel of het laden van een
// sjabloon — nooit tijdens typen.
//
// Zet niets op window.KV — alleen window.StuurBericht.

(function () {
  'use strict';
  const ROOT_ID = 'stuurBerichtRoot';
  const VARS = ['voornaam', 'achternaam', 'naam', 'email', 'boekingslink'];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  let st = null;

  // ── Helpers (puur; getest) ────────────────────────────────────────────────
  function renderWaTekst(body, waarden) {
    return String(body || '').replace(/\{\{(\d+)\}\}/g, (m, n) => {
      const v = (waarden || [])[Number(n) - 1];
      return v == null || String(v).trim() === '' ? m : String(v);
    });
  }
  function vulVars(tekst, vars) {
    return String(tekst || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (vars && k in vars && vars[k] !== '' ? esc(vars[k]) : m));
  }
  function onbekendeVars(tekst) {
    const namen = [...String(tekst || '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
    return [...new Set(namen.filter((n) => VARS.indexOf(n) < 0))];
  }
  function tekstVan(html) {
    const d = document.createElement('div');
    d.innerHTML = String(html || '');
    return (d.textContent || '').trim();
  }
  function waKnopStatus(s) {
    if (!s || !s.data) return { uit: true, reden: '' };
    if (!s.data.lead.geldig_telefoon) return { uit: true, reden: 'Deze lead heeft geen geldig telefoonnummer.' };
    const t = gekozenTemplate(s);
    if (!t) return { uit: true, reden: 'Kies een template.' };
    if (!t.verstuurbaar || !t.verstuurbaar.ok) return { uit: true, reden: (t.verstuurbaar && t.verstuurbaar.reden) || 'Niet verstuurbaar.' };
    const leeg = (s.wa.waarden || []).findIndex((v) => !String(v || '').trim());
    if (leeg >= 0) return { uit: true, reden: `Vul variabele {{${leeg + 1}}} in.` };
    return { uit: false, reden: '' };
  }
  function mailKnopStatus(s, html) {
    if (!s || !s.data) return { uit: true, reden: '' };
    if (!s.data.lead.geldig_email) return { uit: true, reden: 'Deze lead heeft geen geldig e-mailadres.' };
    if (!String(s.mail.onderwerp || '').trim()) return { uit: true, reden: 'Vul een onderwerp in.' };
    if (!tekstVan(html)) return { uit: true, reden: 'Het bericht is leeg.' };
    const onb = onbekendeVars(s.mail.onderwerp + ' ' + html);
    if (onb.length) return { uit: true, reden: 'Onbekende variabele: ' + onb.map((x) => '{{' + x + '}}').join(', ') };
    return { uit: false, reden: '' };
  }
  function gekozenTemplate(s) {
    if (!s || !s.data || !s.wa.gekozen) return null;
    return (s.data.wa.templates || []).find((t) => t.name + '|' + t.language === s.wa.gekozen) || null;
  }

  function toast(msg, ok) {
    try { if (window.KV && typeof window.KV.toast === 'function') window.KV.toast(msg, { duration: ok ? 4500 : 9000 }); } catch (_) { /* noop */ }
  }
  async function api(url, init) {
    if (!window.KV || typeof window.KV.authedFetch !== 'function') throw new Error('KV.authedFetch niet beschikbaar');
    const resp = await window.KV.authedFetch(url, init);
    let j = null;
    try { j = await resp.json(); } catch (_) { j = null; }
    if (!resp.ok) { const e = new Error((j && j.error) || ('HTTP ' + resp.status)); e.status = resp.status; e.body = j; throw e; }
    return j;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function root() { return document.getElementById(ROOT_ID); }
  function editor(id) { const r = root(); return r ? r.querySelector('[data-sb-editor="' + id + '"]') : null; }

  function toolbarHtml(id) {
    const knop = (cmd, label, title, arg) => `<button type="button" class="btn btn-ghost btn-sm" data-sb-cmd="${cmd}" data-sb-arg="${esc(arg || '')}" data-sb-ed="${id}" title="${esc(title)}" style="min-width:30px;padding:4px 8px">${label}</button>`;
    return `<div style="display:flex;flex-wrap:wrap;gap:2px;align-items:center;padding:4px;border:1px solid var(--border);border-bottom:0;border-radius:var(--r-sm,8px) var(--r-sm,8px) 0 0;background:var(--surface-2,#f6f8fa)">
      ${knop('bold', '<b>B</b>', 'Vet')}${knop('italic', '<i>I</i>', 'Cursief')}${knop('underline', '<u>U</u>', 'Onderstreept')}
      <span style="width:1px;height:18px;background:var(--border);margin:0 4px"></span>
      ${knop('formatBlock', 'Kop', 'Tussenkop', 'h3')}${knop('formatBlock', '¶', 'Gewone tekst', 'p')}
      ${knop('insertUnorderedList', '• Lijst', 'Opsomming')}${knop('insertOrderedList', '1. Lijst', 'Genummerde lijst')}
      ${knop('createLink', '🔗 Link', 'Link toevoegen')}${knop('removeFormat', '⌫ Opmaak', 'Opmaak weghalen')}
      <span style="width:1px;height:18px;background:var(--border);margin:0 4px"></span>
      <span style="font-size:11px;color:var(--text-3);margin-right:2px">Invoegen:</span>
      ${VARS.map((v) => `<button type="button" class="btn btn-ghost btn-sm" data-sb-var="${v}" data-sb-ed="${id}" style="padding:2px 6px;font-size:11px" title="Wordt bij versturen ingevuld">{{${v}}}</button>`).join('')}
    </div>
    <div data-sb-editor="${id}" contenteditable="true" spellcheck="true" style="min-height:190px;max-height:340px;overflow:auto;padding:12px 14px;border:1px solid var(--border);border-radius:0 0 var(--r-sm,8px) var(--r-sm,8px);background:var(--surface,#fff);font-size:14px;line-height:1.6;outline:none"></div>`;
  }

  function waTabHtml() {
    const d = st.data;
    const wa = d.wa || {};
    if (!d.lead.geldig_telefoon) {
      return `<div style="padding:12px;border-radius:8px;background:var(--amber-soft);color:var(--amber);border:1px solid var(--amber-line)">Deze lead heeft geen geldig telefoonnummer${d.lead.telefoon ? ' (' + esc(d.lead.telefoon) + ')' : ''}. WhatsApp kan niet verstuurd worden.</div>`;
    }
    if (!wa.ok) {
      const r = { GEEN_LIJN: 'Er is geen WhatsApp-lijn ingesteld voor leads.', GEEN_360_LIJN: 'De lead-lijn is (nog) geen 360dialog-lijn met API-key.', LIJST_NIET_OP_TE_HALEN: 'De goedgekeurde templates konden niet worden opgehaald. Probeer het zo opnieuw.' }[wa.reden] || 'Templates konden niet worden geladen.';
      return `<div style="padding:12px;border-radius:8px;background:var(--rose-soft);color:var(--rose);border:1px solid var(--rose-line)">${esc(r)}</div>`;
    }
    const t = gekozenTemplate(st);
    const opties = (wa.templates || []).map((x) => {
      const k = x.name + '|' + x.language;
      const ok = x.verstuurbaar && x.verstuurbaar.ok;
      return `<option value="${esc(k)}" ${st.wa.gekozen === k ? 'selected' : ''} ${ok ? '' : 'disabled'}>${esc(x.name)}${x.category ? ' · ' + esc(x.category.toLowerCase()) : ''}${ok ? '' : ' — ' + esc(x.verstuurbaar.reden)}</option>`;
    }).join('');
    const velden = t ? (t.variabelen || []).map((v, i) => `
      <label style="display:block;font-size:12px;color:var(--text-3);margin-top:8px">${esc(v.label)} <span class="mono" style="opacity:.7">{{${v.pos}}}</span>${v.auto ? ' <span style="font-size:10.5px;color:var(--emerald)">· automatisch uit de lead</span>' : ''}
        <input class="ib-input" data-sb-wavar="${i}" value="${esc(st.wa.waarden[i] || '')}" maxlength="500" style="width:100%;margin-top:3px">
      </label>`).join('') : '';
    return `
      <div style="font-size:11.5px;color:var(--text-3);margin-bottom:8px">Naar <b>${esc(d.lead.telefoon)}</b> · ${(wa.templates || []).length} goedgekeurde template(s) live van de lead-WABA${wa.waba_id ? ' <span class="mono">' + esc(wa.waba_id) + '</span>' : ''}${wa.phone_number_id ? ' (lijn <span class="mono">' + esc(wa.phone_number_id) + '</span>)' : ''}.</div>
      ${(wa.templates || []).length ? `<select class="ib-input" data-sb-veld="template" style="width:100%"><option value="">— Kies een template —</option>${opties}</select>` : '<div style="color:var(--text-3)">Er staan nog geen goedgekeurde templates op de lead-WABA.</div>'}
      <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;margin-top:10px">
        <div>${t ? (velden || '<div style="font-size:12px;color:var(--text-3);margin-top:8px">Dit template heeft geen variabelen.</div>') : ''}</div>
        <div>${t ? `<div style="font-size:12px;color:var(--text-3);margin:8px 0 4px">Voorbeeld</div>
          <div data-sb-wapreview style="white-space:pre-wrap;background:#dcf8c6;color:#111;border-radius:10px 10px 2px 10px;padding:10px 12px;font-size:13.5px;line-height:1.45;box-shadow:0 1px 1px rgba(0,0,0,.08)">${esc(renderWaTekst(t.body, st.wa.waarden))}</div>
          ${t.footer ? `<div style="font-size:11px;color:var(--text-3);margin-top:4px">${esc(t.footer)}</div>` : ''}
          ${(t.knoppen || []).length ? `<div style="font-size:11px;color:var(--text-3);margin-top:4px">Knoppen: ${t.knoppen.map((k) => esc(k.text)).join(' · ')}</div>` : ''}` : ''}</div>
      </div>`;
  }

  function mailTabHtml() {
    const d = st.data;
    if (!d.lead.geldig_email) {
      return `<div style="padding:12px;border-radius:8px;background:var(--amber-soft);color:var(--amber);border:1px solid var(--amber-line)">Deze lead heeft geen geldig e-mailadres${d.lead.email ? ' (' + esc(d.lead.email) + ')' : ''}.</div>`;
    }
    const sj = st.sj.lijst || [];
    return `
      <div style="font-size:11.5px;color:var(--text-3);margin-bottom:8px">Naar <b>${esc(d.lead.email)}</b> · van welkom@ · in de huisstijl (kop, logo, groet) · verschijnt in de gesprekkendraad.</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <select class="ib-input" data-sb-veld="sjabloon" style="flex:1"><option value="">${st.sj.laden ? 'Sjablonen laden…' : (st.sj.fout ? 'Sjablonen niet beschikbaar' : '— Optioneel: sjabloon laden —')}</option>
          ${sj.map((x) => `<option value="${esc(x.id)}">${esc(x.naam)}</option>`).join('')}</select>
      </div>
      <input class="ib-input" data-sb-veld="onderwerp" value="${esc(st.mail.onderwerp)}" placeholder="Onderwerp" maxlength="200" style="width:100%;margin-bottom:8px">
      ${toolbarHtml('mail')}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
        <span style="font-size:11px;color:var(--text-3)">{{voornaam}} wordt "${esc(d.variabelen.voornaam || '—')}", {{boekingslink}} wordt ${esc(d.variabelen.boekingslink)}</span>
        <button type="button" class="btn btn-ghost btn-sm" data-sb-actie="voorbeeld">${st.mail.voorbeeld ? 'Verberg voorbeeld' : 'Voorbeeld'}</button>
      </div>
      <div data-sb-mailpreview style="${st.mail.voorbeeld ? '' : 'display:none;'}margin-top:8px;border:1px solid var(--border);border-radius:10px;overflow:hidden"></div>`;
  }

  function sjTabHtml() {
    if (st.sj.laden) return '<div style="color:var(--text-3)">Sjablonen laden…</div>';
    if (st.sj.fout) return `<div style="padding:12px;border-radius:8px;background:var(--amber-soft);color:var(--amber);border:1px solid var(--amber-line)">${esc(st.sj.fout)}</div>`;
    if (st.sj.bewerk) {
      const b = st.sj.bewerk;
      return `<div style="font-weight:600;margin-bottom:8px">${b.id ? 'Sjabloon bewerken' : 'Nieuw sjabloon'}</div>
        <input class="ib-input" data-sb-veld="sjnaam" value="${esc(b.naam)}" placeholder="Naam (alleen intern)" maxlength="120" style="width:100%;margin-bottom:8px">
        <input class="ib-input" data-sb-veld="sjonderwerp" value="${esc(b.onderwerp)}" placeholder="Onderwerp" maxlength="200" style="width:100%;margin-bottom:8px">
        ${toolbarHtml('sj')}`;
    }
    const lijst = st.sj.lijst || [];
    return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="font-size:12px;color:var(--text-3)">${lijst.length} sjabloon/sjablonen · variabelen: ${VARS.map((v) => '{{' + v + '}}').join(' ')}</span>
        <button type="button" class="btn btn-primary btn-sm" data-sb-actie="sj-nieuw">+ Nieuw sjabloon</button></div>
      ${lijst.length ? `<div style="border:1px solid var(--border);border-radius:10px;overflow:hidden">${lijst.map((x) => `
        <div style="display:flex;gap:10px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--border)">
          <div style="flex:1;min-width:0"><div style="font-weight:600">${esc(x.naam)}</div><div style="font-size:12px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(x.onderwerp)}</div></div>
          <button type="button" class="btn btn-ghost btn-sm" data-sb-actie="sj-gebruik" data-sb-id="${esc(x.id)}">Gebruik in mail</button>
          <button type="button" class="btn btn-ghost btn-sm" data-sb-actie="sj-bewerk" data-sb-id="${esc(x.id)}">Bewerken</button>
          <button type="button" class="btn btn-ghost btn-sm" data-sb-actie="sj-verwijder" data-sb-id="${esc(x.id)}" style="color:var(--rose)">Verwijderen</button>
        </div>`).join('')}</div>` : '<div style="color:var(--text-3);font-size:13px">Nog geen sjablonen. Maak er een met "+ Nieuw sjabloon".</div>'}`;
  }

  function voetHtml() {
    if (!st.data) return '<button class="btn btn-ghost btn-sm" data-sb-actie="sluit">Sluiten</button>';
    let knop = '';
    let reden = '';
    if (st.tab === 'whatsapp') {
      const k = waKnopStatus(st); reden = k.reden;
      knop = `<button class="btn btn-primary btn-sm" data-sb-actie="verstuur-wa" ${k.uit || st.bezig ? 'disabled style="opacity:.5;cursor:not-allowed"' : ''}>${st.bezig ? 'Versturen…' : 'Verstuur WhatsApp'}</button>`;
    } else if (st.tab === 'mail') {
      const ed = editor('mail');
      const k = mailKnopStatus(st, ed ? ed.innerHTML : st.mail.html); reden = k.reden;
      knop = `<button class="btn btn-primary btn-sm" data-sb-actie="verstuur-mail" ${k.uit || st.bezig ? 'disabled style="opacity:.5;cursor:not-allowed"' : ''}>${st.bezig ? 'Versturen…' : 'Verstuur e-mail'}</button>`;
    } else if (st.sj.bewerk) {
      knop = `<button class="btn btn-ghost btn-sm" data-sb-actie="sj-annuleer" ${st.bezig ? 'disabled' : ''}>Annuleren</button>
        <button class="btn btn-primary btn-sm" data-sb-actie="sj-opslaan" ${st.bezig ? 'disabled' : ''}>${st.bezig ? 'Opslaan…' : 'Opslaan'}</button>`;
    }
    return `<span data-sb-reden style="flex:1;font-size:12px;color:${st.fout ? 'var(--rose)' : 'var(--text-3)'}">${esc(st.fout || reden)}</span>
      <button class="btn btn-ghost btn-sm" data-sb-actie="sluit" ${st.bezig ? 'disabled' : ''}>Sluiten</button>${knop}`;
  }

  function render() {
    const r = root();
    if (!r || !st) return;
    const box = r.querySelector('[data-sb-box]');
    const tab = (id, label) => `<button type="button" data-sb-tab="${id}" style="border:0;background:none;padding:10px 4px;margin-right:14px;font-size:13.5px;cursor:pointer;border-bottom:2px solid ${st.tab === id ? 'var(--accent,#10284A)' : 'transparent'};font-weight:${st.tab === id ? 600 : 400};color:${st.tab === id ? 'inherit' : 'var(--text-3)'}">${label}</button>`;
    let body;
    if (st.laden) body = '<div style="color:var(--text-3)">Laden…</div>';
    else if (st.laadFout) body = `<div style="color:var(--rose)">${esc(st.laadFout)}</div>`;
    else body = st.tab === 'whatsapp' ? waTabHtml() : st.tab === 'mail' ? mailTabHtml() : sjTabHtml();
    box.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:14px 18px 0">
        <div style="flex:1;min-width:0"><div style="font-weight:600;font-size:15px">Stuur bericht</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">${esc(st.naam || (st.data && st.data.lead.naam) || 'Lead')}${st.data && st.data.lead.gearchiveerd ? ' · <span style="color:var(--amber)">gearchiveerd</span>' : ''}</div></div>
        <button class="btn btn-ghost btn-sm" data-sb-actie="sluit" aria-label="Sluiten" ${st.bezig ? 'disabled' : ''}>✕</button>
      </div>
      <div style="padding:0 18px;border-bottom:1px solid var(--border)">${tab('whatsapp', 'WhatsApp')}${tab('mail', 'E-mail')}${tab('sjablonen', 'E-mailsjablonen')}</div>
      <div style="padding:16px 18px;font-size:13px;line-height:1.5;overflow:auto;flex:1">${body}</div>
      <div data-sb-voet style="display:flex;gap:8px;align-items:center;justify-content:flex-end;padding:12px 18px;border-top:1px solid var(--border)">${voetHtml()}</div>`;
    // Editor-inhoud zetten ná de opbouw (nooit tijdens typen).
    const em = editor('mail'); if (em) em.innerHTML = st.mail.html || '';
    const es = editor('sj'); if (es && st.sj.bewerk) es.innerHTML = st.sj.bewerk.html || '';
    if (st.mail.voorbeeld) repaintMailPreview();
  }

  function repaintVoet() { const v = root() && root().querySelector('[data-sb-voet]'); if (v) v.innerHTML = voetHtml(); }
  function repaintWaPreview() {
    const p = root() && root().querySelector('[data-sb-wapreview]');
    const t = gekozenTemplate(st);
    if (p && t) p.textContent = renderWaTekst(t.body, st.wa.waarden);
  }
  function repaintMailPreview() {
    const p = root() && root().querySelector('[data-sb-mailpreview]');
    if (!p) return;
    const ed = editor('mail');
    const html = ed ? ed.innerHTML : st.mail.html;
    p.innerHTML = `<div style="background:#10284A;color:#fff;font-weight:700;padding:12px 18px;font-family:Arial,Helvetica,sans-serif">De Forex Opleiding</div>
      <div style="padding:16px 18px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;background:#fff;color:#2b3a4a">
        <div style="font-weight:600;margin-bottom:10px">${vulVars(esc(st.mail.onderwerp), st.data.variabelen)}</div>
        ${vulVars(html, st.data.variabelen)}
        <p style="margin-top:14px">Met vriendelijke groet,<br><br>Team - De Forex Opleiding</p></div>`;
  }

  // ── Data ──────────────────────────────────────────────────────────────────
  async function laadLead() {
    try {
      const j = await api('/api/lead-bericht?lead_id=' + encodeURIComponent(st.leadId));
      if (!st) return;
      st.data = j;
      if (!st.naam) st.naam = j.lead.naam;
      if (!j.lead.geldig_telefoon && j.lead.geldig_email) st.tab = 'mail';
    } catch (e) {
      if (!st) return;
      console.error('[stuur-bericht] laden mislukt:', e && e.status, e && (e.body || e.message));
      st.laadFout = 'Kon de lead niet laden: ' + ((e && e.message) || 'onbekende fout');
    }
    st.laden = false;
    render();
  }
  async function laadSjablonen(force) {
    if (st.sj.geladen && !force) return;
    st.sj.laden = true; st.sj.fout = null;
    if (st.tab !== 'whatsapp') render();
    try {
      const j = await api('/api/lead-mail-sjablonen');
      if (!st) return;
      st.sj.lijst = j.sjablonen || [];
      st.sj.geladen = true;
    } catch (e) {
      if (!st) return;
      console.error('[stuur-bericht] sjablonen laden mislukt:', e && e.status, e && (e.body || e.message));
      st.sj.fout = (e && e.body && e.body.code === 'MIGRATIE_NODIG') ? 'De sjablonen-tabel bestaat nog niet (migratie 2026-10-09-lead-mail-sjablonen.sql). Losse e-mails versturen werkt wel.' : 'Kon de sjablonen niet laden.';
    }
    st.sj.laden = false;
    bewaarEditor();
    render();
  }

  function bewaarEditor() {
    const em = editor('mail'); if (em) st.mail.html = em.innerHTML;
    const es = editor('sj'); if (es && st.sj.bewerk) st.sj.bewerk.html = es.innerHTML;
  }

  // ── Acties ────────────────────────────────────────────────────────────────
  async function verstuurWa() {
    const t = gekozenTemplate(st);
    if (!t || waKnopStatus(st).uit) return;
    st.bezig = true; st.fout = null; repaintVoet();
    try {
      const j = await api('/api/lead-bericht', { method: 'POST', body: JSON.stringify({ lead_id: st.leadId, kanaal: 'whatsapp', template: t.name, taal: t.language, variabelen: st.wa.waarden }) });
      toast(`WhatsApp "${t.name}" verstuurd naar ${st.data.lead.telefoon}` + (j && j.in_draad === false ? ' (let op: niet in de draad gelogd)' : ' · staat in de gesprekkendraad'), true);
      sluit(true);
    } catch (e) {
      console.error('[stuur-bericht] WA mislukt:', e && e.status, e && (e.body || e.message));
      st.bezig = false; st.fout = (e && e.message) || 'Versturen mislukt'; repaintVoet();
    }
  }
  async function verstuurMail() {
    bewaarEditor();
    if (mailKnopStatus(st, st.mail.html).uit) { repaintVoet(); return; }
    st.bezig = true; st.fout = null; repaintVoet();
    try {
      const j = await api('/api/lead-bericht', { method: 'POST', body: JSON.stringify({ lead_id: st.leadId, kanaal: 'mail', onderwerp: st.mail.onderwerp, html: st.mail.html }) });
      toast(`E-mail "${(j && j.onderwerp) || st.mail.onderwerp}" verstuurd naar ${st.data.lead.email}` + (j && j.in_draad === false ? ' (let op: niet in de draad gelogd)' : ' · staat in de gesprekkendraad'), true);
      sluit(true);
    } catch (e) {
      console.error('[stuur-bericht] mail mislukt:', e && e.status, e && (e.body || e.message));
      st.bezig = false; st.fout = (e && e.message) || 'Versturen mislukt'; repaintVoet();
    }
  }
  async function sjOpslaan() {
    bewaarEditor();
    const b = st.sj.bewerk;
    st.bezig = true; st.fout = null; repaintVoet();
    try {
      await api('/api/lead-mail-sjablonen', { method: 'POST', body: JSON.stringify({ id: b.id || undefined, naam: b.naam, onderwerp: b.onderwerp, html: b.html }) });
      toast('Sjabloon "' + b.naam + '" opgeslagen', true);
      st.sj.bewerk = null; st.bezig = false;
      await laadSjablonen(true);
    } catch (e) {
      console.error('[stuur-bericht] sjabloon opslaan mislukt:', e && e.status, e && (e.body || e.message));
      st.bezig = false; st.fout = (e && e.message) || 'Opslaan mislukt'; repaintVoet();
    }
  }
  async function sjVerwijder(id) {
    const x = (st.sj.lijst || []).find((s) => s.id === id);
    if (!x || !window.confirm('Sjabloon "' + x.naam + '" verwijderen?')) return;
    try {
      await api('/api/lead-mail-sjablonen?id=' + encodeURIComponent(id), { method: 'DELETE' });
      toast('Sjabloon verwijderd', true);
      await laadSjablonen(true);
    } catch (e) {
      console.error('[stuur-bericht] sjabloon verwijderen mislukt:', e && e.status, e && (e.body || e.message));
      toast('Verwijderen mislukt: ' + ((e && e.message) || 'onbekend'), false);
    }
  }
  function gebruikSjabloon(id) {
    const x = (st.sj.lijst || []).find((s) => s.id === id);
    if (!x) return;
    const ed = editor('mail');
    const heeftInhoud = ed ? tekstVan(ed.innerHTML) : tekstVan(st.mail.html);
    if (heeftInhoud && !window.confirm('De huidige tekst vervangen door sjabloon "' + x.naam + '"?')) return;
    st.mail.onderwerp = x.onderwerp; st.mail.html = x.html; st.tab = 'mail'; st.fout = null;
    render();
  }

  function onClick(e) {
    const r = root();
    if (!r || !st) return;
    if (e.target === r) { if (!st.bezig) sluit(); return; }
    const tabEl = e.target.closest('[data-sb-tab]');
    if (tabEl) {
      bewaarEditor(); st.tab = tabEl.getAttribute('data-sb-tab'); st.fout = null;
      if (st.tab !== 'whatsapp') laadSjablonen(false);
      render(); return;
    }
    const cmdEl = e.target.closest('[data-sb-cmd]');
    if (cmdEl) {
      const ed = editor(cmdEl.getAttribute('data-sb-ed')); if (ed) ed.focus();
      const cmd = cmdEl.getAttribute('data-sb-cmd');
      if (cmd === 'createLink') {
        const url = window.prompt('Link-adres (https://… of {{boekingslink}}):', 'https://');
        if (url && /^(https?:\/\/|mailto:|\{\{\s*\w+\s*\}\})/i.test(url.trim())) document.execCommand('createLink', false, url.trim());
      } else if (cmd === 'formatBlock') {
        document.execCommand('formatBlock', false, cmdEl.getAttribute('data-sb-arg'));
      } else {
        document.execCommand(cmd, false, null);
      }
      bewaarEditor(); repaintVoet(); if (st.mail.voorbeeld) repaintMailPreview();
      return;
    }
    const varEl = e.target.closest('[data-sb-var]');
    if (varEl) {
      const ed = editor(varEl.getAttribute('data-sb-ed')); if (ed) ed.focus();
      document.execCommand('insertText', false, '{{' + varEl.getAttribute('data-sb-var') + '}}');
      bewaarEditor(); repaintVoet(); if (st.mail.voorbeeld) repaintMailPreview();
      return;
    }
    const a = e.target.closest('[data-sb-actie]');
    if (!a || a.disabled) return;
    const actie = a.getAttribute('data-sb-actie');
    const id = a.getAttribute('data-sb-id');
    if (actie === 'sluit') { if (!st.bezig) sluit(); }
    else if (actie === 'verstuur-wa') verstuurWa();
    else if (actie === 'verstuur-mail') verstuurMail();
    else if (actie === 'voorbeeld') { bewaarEditor(); st.mail.voorbeeld = !st.mail.voorbeeld; render(); }
    else if (actie === 'sj-nieuw') { st.sj.bewerk = { id: null, naam: '', onderwerp: '', html: '' }; st.fout = null; render(); }
    else if (actie === 'sj-bewerk') { const x = st.sj.lijst.find((s) => s.id === id); if (x) { st.sj.bewerk = { ...x }; st.fout = null; render(); } }
    else if (actie === 'sj-annuleer') { st.sj.bewerk = null; st.fout = null; render(); }
    else if (actie === 'sj-opslaan') sjOpslaan();
    else if (actie === 'sj-verwijder') sjVerwijder(id);
    else if (actie === 'sj-gebruik') gebruikSjabloon(id);
  }

  function onInput(e) {
    if (!st) return;
    const el = e.target;
    if (el.matches('[data-sb-wavar]')) { st.wa.waarden[Number(el.getAttribute('data-sb-wavar'))] = el.value; repaintWaPreview(); repaintVoet(); return; }
    const veld = el.getAttribute && el.getAttribute('data-sb-veld');
    if (veld === 'onderwerp') { st.mail.onderwerp = el.value; repaintVoet(); if (st.mail.voorbeeld) repaintMailPreview(); return; }
    if (veld === 'sjnaam' && st.sj.bewerk) { st.sj.bewerk.naam = el.value; return; }
    if (veld === 'sjonderwerp' && st.sj.bewerk) { st.sj.bewerk.onderwerp = el.value; return; }
    if (el.matches('[data-sb-editor]')) { repaintVoet(); if (st.mail.voorbeeld && el.getAttribute('data-sb-editor') === 'mail') repaintMailPreview(); }
  }
  function onChange(e) {
    if (!st) return;
    const veld = e.target.getAttribute && e.target.getAttribute('data-sb-veld');
    if (veld === 'template') {
      st.wa.gekozen = e.target.value || null; st.fout = null;
      const t = gekozenTemplate(st);
      st.wa.waarden = t ? (t.variabelen || []).map((v) => v.waarde || '') : [];
      render();
    } else if (veld === 'sjabloon' && e.target.value) {
      gebruikSjabloon(e.target.value);
    }
  }
  // Plakken als platte tekst: geen Word/Gmail-opmaak in de mail.
  function onPaste(e) {
    if (!e.target.closest || !e.target.closest('[data-sb-editor]')) return;
    e.preventDefault();
    const t = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, t);
  }
  function onKey(e) { if (e.key === 'Escape' && st && !st.bezig) { e.preventDefault(); sluit(); } }

  function sluit(verstuurd) {
    const r = root();
    if (r) r.remove();
    document.removeEventListener('keydown', onKey, true);
    const klaar = st && st.onKlaar;
    st = null;
    if (verstuurd && typeof klaar === 'function') { try { klaar(); } catch (_) { /* noop */ } }
  }

  function open(leadId, naam, opts) {
    if (!leadId) return;
    sluit();
    st = {
      leadId: String(leadId), naam: naam || '', onKlaar: opts && opts.onKlaar,
      tab: 'whatsapp', laden: true, laadFout: null, data: null, bezig: false, fout: null,
      wa: { gekozen: null, waarden: [] },
      mail: { onderwerp: '', html: '', voorbeeld: false },
      sj: { laden: false, geladen: false, fout: null, lijst: [], bewerk: null },
    };
    const r = document.createElement('div');
    r.id = ROOT_ID;
    r.setAttribute('style', 'position:fixed;inset:0;z-index:9500;background:rgba(10,20,35,.45);display:flex;align-items:center;justify-content:center;padding:16px');
    r.innerHTML = '<div data-sb-box role="dialog" aria-modal="true" aria-label="Stuur bericht" style="background:var(--surface,#fff);color:var(--text,#1b2430);width:100%;max-width:780px;max-height:92vh;display:flex;flex-direction:column;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.25)"></div>';
    r.addEventListener('click', onClick);
    r.addEventListener('input', onInput);
    r.addEventListener('change', onChange);
    r.addEventListener('paste', onPaste);
    document.body.appendChild(r);
    document.addEventListener('keydown', onKey, true);
    render();
    laadLead();
  }

  window.StuurBericht = { open, sluit, _intern: { renderWaTekst, vulVars, onbekendeVars, waKnopStatus, mailKnopStatus } };
})();
