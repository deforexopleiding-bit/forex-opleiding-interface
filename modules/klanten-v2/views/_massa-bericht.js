// modules/klanten-v2/views/_massa-bericht.js
//
// Massabericht (fase 2a, 2026-10-10) — ÉÉN popup, geopend vanuit:
//   - Leads → "Massabericht" / selectiemodus   (leads-v2.js)
//   - Leadsonderhoud → Contacten → idem          (leadsonderhoud-v2.js)
// Stappen:
//   1. Selectie  — combineerbare filters (AND) + vinkjes; standaard staat alles
//                  aan wat aan het filter voldoet. Toont het aantal geselecteerd.
//   2. Bericht   — kanaal E-mail / WhatsApp / Beide (2b), verplichte campagnenaam.
//                  E-mail: soort mail (voorkeuren), onderwerp + editor of een
//                  e-mailsjabloon, tempo (portie). WhatsApp: een goedgekeurde
//                  MARKETING-template van de lead-WABA; {{1}} = voornaam per
//                  ontvanger, {{2}} = één campagnetekst voor iedereen, live voorbeeld.
//   3. Controle  — de server rekent het EXACTE aantal ontvangers uit (afgemeld /
//                  geen adres / dubbel → overgeslagen) + een voorbeeldmail.
//   4. Wachtrij  — bevestigen → campagne in de wachtrij; voortgang, "nu een
//                  portie", pauzeren, annuleren. Tab "Campagnes" = overzicht.
// Hangt aan document.body (zoals _stuur-bericht.js): de lijst-polls vervangen de
// editor dus nooit onder je vingers. Zet alleen window.MassaBericht.

(function () {
  'use strict';
  const ROOT_ID = 'massaBerichtRoot';
  const VARS = ['voornaam', 'achternaam', 'naam', 'email', 'boekingslink'];
  const SOORTEN = { tips: 'Tips & lessen over traden', events: 'Webinars & events', aanbod: 'Aanbiedingen & cursusnieuws' };
  const CATS = { wanbetaler: 'Wanbetaler', onboarding: 'Onboarding', leadsonderhoud: 'Leadsonderhoud', lead_aanmelding: 'Lead (aanmelding)', events: 'Events', klant: 'Klant', onbekend: 'Onbekend' };
  const STANDAARD_FILTER = Object.freeze({ toestemming: 'ja', email: 'ja', afgemeld: 'verbergen' });
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  let st = null;
  let filterTimer = null;

  // ── Helpers (puur; getest) ────────────────────────────────────────────────
  function tekstVan(html) {
    const d = document.createElement('div');
    d.innerHTML = String(html || '');
    return (d.textContent || '').trim();
  }
  function onbekendeVars(tekst) {
    const namen = [...String(tekst || '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
    return [...new Set(namen.filter((n) => VARS.indexOf(n) < 0))];
  }
  /** De gekozen WhatsApp-template ("naam|taal") uit de lijst. */
  function waTemplateVan(b, templates) {
    return (templates || []).find((t) => t.name + '|' + t.language === b.wa_template) || null;
  }
  /** WhatsApp-voorbeeld: {{1}} = voornaam, {{2}} = campagnetekst. PURE. */
  function waVoorbeeld(body, voornaam, param2) {
    return String(body || '').replace(/\{\{(\d+)\}\}/g, (m, n) => (n === '1' ? (voornaam || 'daar') : n === '2' ? (String(param2 || '').trim() || m) : m));
  }
  /** Wat ontbreekt er nog in stap 2? '' = niets. waTemplates = de geladen lijst. */
  function berichtFout(b, html, waTemplates) {
    if (!String(b.naam || '').trim()) return 'Geef de campagne een naam.';
    const kanaal = b.kanaal || 'email';
    if (kanaal !== 'email') {
      if (!b.wa_template) return 'Kies een WhatsApp-template.';
      const t = waTemplateVan(b, waTemplates);
      if (t && t.aantal_vars >= 2 && !String(b.wa_param2 || '').trim()) return 'Vul de tekst voor {{2}} in.';
      if (/[\n\r\t]| {4,}/.test(String(b.wa_param2 || ''))) return 'De tekst voor {{2}} mag geen enters, tabs of 4+ spaties bevatten.';
    }
    if (kanaal === 'whatsapp') return '';
    if (!SOORTEN[b.soort]) return 'Kies het soort mail.';
    if (!String(b.onderwerp || '').trim()) return 'Vul een onderwerp in.';
    if (!tekstVan(html)) return 'Het bericht is leeg.';
    const onb = onbekendeVars(b.onderwerp + ' ' + html);
    if (onb.length) return 'Onbekende variabele: ' + onb.map((x) => '{{' + x + '}}').join(', ');
    const p = Number(b.portie);
    if (!Number.isFinite(p) || p < 1 || p > 500) return 'Portie moet tussen 1 en 500 liggen.';
    return '';
  }
  /** Filter uit de UI-velden naar het API-formaat (enkelvoudige keuzes → lijsten). */
  function filterVoorApi(f) {
    const uit = {};
    for (const k of ['q', 'klant', 'kennismaking', 'kwalificatie', 'categorie', 'wanbetaler_onboarding', 'van', 'tot', 'email', 'nummer', 'toestemming', 'afgemeld']) if (f[k]) uit[k] = f[k];
    for (const k of ['status', 'bron', 'soort', 'traject']) if (f[k]) uit[k] = [f[k]];
    if (f.massa_modus) uit.massa = { modus: f.massa_modus, dagen: Number(f.massa_dagen) || 30, campagne_id: f.massa_campagne || '' };
    if (f.lead_ids && f.lead_ids.length) uit.lead_ids = f.lead_ids;
    return uit;
  }
  function datum(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const KANAAL_LABEL = { email: 'E-mail', whatsapp: 'WhatsApp', beide: 'E-mail + WhatsApp' };
  const REDENEN = { geen_geldig_nummer: 'geen geldig telefoonnummer (WhatsApp)', dubbel_nummer: 'dubbel telefoonnummer (WhatsApp)', geen_geldig_email: 'geen geldig e-mailadres', afgemeld: 'afgemeld', voorkeur_uit: 'wil dit soort mail niet', dubbel_email: 'dubbel e-mailadres', lead_niet_gevonden: 'lead niet (meer) gevonden', lead_verwijderd: 'lead verwijderd', geannuleerd: 'geannuleerd' };

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
  function editor() { const r = root(); return r ? r.querySelector('[data-mb-editor]') : null; }
  function bewaarEditor() { const ed = editor(); if (ed && st) st.bericht.html = ed.innerHTML; }

  function sel(veld, opties, waarde, label) {
    return `<label style="display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--text-3)">${esc(label)}
      <select class="ib-input" data-mb-f="${veld}" style="font-size:12.5px">${opties.map(([v, l]) => `<option value="${esc(v)}" ${String(waarde || '') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  }
  function filtersHtml() {
    const f = st.filter;
    const o = st.opties || { bron: [], soort: [], traject: [] };
    const metAlle = (arr) => [['', 'alle'], ...arr.map((x) => [x, x])];
    return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px 10px">
      <label style="display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--text-3)">Zoeken
        <input class="ib-input" data-mb-f="q" value="${esc(f.q || '')}" placeholder="naam / e-mail" style="font-size:12.5px"></label>
      ${sel('status', [['', 'alle'], ['nieuw', 'nieuw'], ['opgevolgd', 'opgevolgd'], ['gewonnen', 'gewonnen'], ['verloren', 'verloren']], f.status, 'CRM-status')}
      ${sel('klant', [['', 'alle'], ['ja', 'is klant'], ['nee', 'geen klant']], f.klant, 'Klant')}
      ${sel('kennismaking', [['', 'alle'], ['gehad', 'gehad'], ['ingepland', 'ingepland'], ['ooit', 'gehad of ingepland'], ['geen', 'geen']], f.kennismaking, 'Kennismakingsgesprek')}
      ${sel('bron', metAlle(o.bron), f.bron, 'Bron / funnel')}
      ${sel('soort', metAlle(o.soort), f.soort, 'Herkomst')}
      ${sel('traject', metAlle(o.traject), f.traject, 'Traject')}
      ${sel('kwalificatie', [['', 'alle'], ['toegang', 'gekwalificeerd'], ['geen toegang', 'afgewezen'], ['geen', 'geen vragenlijst']], f.kwalificatie, 'Kwalificatie')}
      ${sel('categorie', [['', 'alle'], ...Object.entries(CATS)], f.categorie, 'Categorie')}
      ${sel('wanbetaler_onboarding', [['', 'niet filteren'], ['uitsluiten', 'uitsluiten'], ['alleen_wanbetaler', 'alleen wanbetalers'], ['alleen_onboarding', 'alleen onboarding']], f.wanbetaler_onboarding, 'Wanbetaler / onboarding')}
      <label style="display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--text-3)">Aangemeld vanaf
        <input type="date" class="ib-input" data-mb-f="van" value="${esc(f.van || '')}" style="font-size:12.5px"></label>
      <label style="display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--text-3)">Aangemeld tot en met
        <input type="date" class="ib-input" data-mb-f="tot" value="${esc(f.tot || '')}" style="font-size:12.5px"></label>
      ${sel('email', [['', 'alle'], ['ja', 'heeft e-mail'], ['nee', 'geen e-mail']], f.email, 'E-mailadres')}
      ${sel('nummer', [['', 'alle'], ['ja', 'heeft nummer'], ['nee', 'geen nummer']], f.nummer, 'Telefoonnummer')}
      ${sel('toestemming', [['', 'alle'], ['ja', 'ja'], ['nee', 'nee']], f.toestemming, 'Toestemming (aanmelding)')}
      ${sel('afgemeld', [['', 'tonen'], ['verbergen', 'verbergen'], ['alleen', 'alleen afgemelden']], f.afgemeld, 'Afgemeld')}
      ${sel('massa_modus', [['', 'niet filteren'], ['nooit', 'uitsluiten: ooit gehad'], ['dagen', 'uitsluiten: laatste N dagen'], ['campagne', 'uitsluiten: in campagne…'], ['alleen_gehad', 'alleen wie er al één kreeg']], f.massa_modus, 'Al massabericht gehad')}
      ${f.massa_modus === 'dagen' ? `<label style="display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--text-3)">Aantal dagen
        <input type="number" min="1" max="3650" class="ib-input" data-mb-f="massa_dagen" value="${esc(f.massa_dagen || 30)}" style="font-size:12.5px"></label>` : ''}
      ${f.massa_modus === 'campagne' ? sel('massa_campagne', [['', '— kies campagne —'], ...(st.campagnes || []).map((c) => [c.id, c.naam + ' · ' + datum(c.aangemaakt_op)])], f.massa_campagne, 'Campagne') : ''}
    </div>
    ${f.lead_ids && f.lead_ids.length ? `<div style="margin-top:8px;font-size:12px;padding:6px 10px;border-radius:8px;background:var(--surface-2,#f6f8fa);display:inline-flex;gap:8px;align-items:center">Alleen je eigen selectie (${f.lead_ids.length} leads) <button type="button" class="btn btn-ghost btn-sm" data-mb-actie="selectie-los" style="padding:0 6px">✕ alle leads</button></div>` : ''}
    <div style="margin-top:6px"><button type="button" class="btn btn-ghost btn-sm" data-mb-actie="filters-wis">Filters terugzetten</button></div>`;
  }

  function lijstHtml() {
    if (st.laden) return '<div style="color:var(--text-3);padding:10px 0">Selectie laden…</div>';
    if (st.laadFout) return `<div style="color:var(--rose);padding:10px 0">${esc(st.laadFout)}</div>`;
    const items = st.items || [];
    const n = st.gekozen.size;
    const kop = `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0 8px">
      <b>${items.length}</b> lead${items.length === 1 ? '' : 's'} voldoen aan het filter · <b data-mb-aantal>${n}</b> geselecteerd
      <button type="button" class="btn btn-ghost btn-sm" data-mb-actie="alles">Selecteer alles (${items.length})</button>
      <button type="button" class="btn btn-ghost btn-sm" data-mb-actie="niets">Niets</button>
      ${st.tabelOntbreekt ? '<span style="color:var(--amber);font-size:12px">⚠ De massa-tabellen bestaan nog niet (migratie 2026-10-10-massa-mail-fase2a.sql) — geschiedenis en afmeldingen ontbreken.</span>' : ''}
    </div>`;
    if (!items.length) return kop + '<div style="color:var(--text-3);font-size:13px">Geen leads met deze filters.</div>';
    const rij = (l) => `<tr>
      <td><input type="checkbox" data-mb-vink="${esc(l.id)}" ${st.gekozen.has(l.id) ? 'checked' : ''}></td>
      <td><div style="font-weight:600">${esc(l.naam)}</div><div class="mono" style="font-size:11px;color:${l.geldig_email ? 'var(--text-3)' : 'var(--rose)'}">${esc(l.email || 'geen e-mail')}</div></td>
      <td style="font-size:12px">${esc(l.bron || '—')}<div style="font-size:11px;color:var(--text-3)">${esc(l.traject || '')}</div></td>
      <td style="font-size:12px">${esc(l.status)}${l.is_klant ? ' · <span style="color:var(--emerald)">klant</span>' : ''}</td>
      <td style="font-size:12px">${esc(CATS[l.categorie] || '—')}</td>
      <td style="font-size:12px">${esc(l.kennismaking)}</td>
      <td style="font-size:12px">${datum(l.aangemaakt)}</td>
      <td style="font-size:12px">${l.laatst_massa_op ? datum(l.laatst_massa_op) : '—'}</td>
      <td style="font-size:11px">${l.afgemeld ? '<span style="color:var(--rose)">afgemeld</span>' : ''}${l.toestemming ? '' : ' <span style="color:var(--text-3)">geen toestemming</span>'}</td>
    </tr>`;
    return kop + `<div style="border:1px solid var(--border);border-radius:10px;overflow:auto;max-height:42vh">
      <table style="width:100%;border-collapse:collapse;font-size:12.5px"><thead style="position:sticky;top:0;background:var(--surface,#fff)"><tr style="text-align:left;color:var(--text-3);font-size:11px">
        <th style="padding:6px 8px"></th><th>Naam</th><th>Bron · traject</th><th>Status</th><th>Categorie</th><th>Kennism.</th><th>Aangemeld</th><th>Laatst massa</th><th></th></tr></thead>
        <tbody>${items.map(rij).join('')}</tbody></table></div>`;
  }

  function toolbarHtml() {
    const knop = (cmd, label, title, arg) => `<button type="button" class="btn btn-ghost btn-sm" data-mb-cmd="${cmd}" data-mb-arg="${esc(arg || '')}" title="${esc(title)}" style="min-width:30px;padding:4px 8px">${label}</button>`;
    return `<div style="display:flex;flex-wrap:wrap;gap:2px;align-items:center;padding:4px;border:1px solid var(--border);border-bottom:0;border-radius:8px 8px 0 0;background:var(--surface-2,#f6f8fa)">
      ${knop('bold', '<b>B</b>', 'Vet')}${knop('italic', '<i>I</i>', 'Cursief')}${knop('underline', '<u>U</u>', 'Onderstreept')}
      <span style="width:1px;height:18px;background:var(--border);margin:0 4px"></span>
      ${knop('formatBlock', 'Kop', 'Tussenkop', 'h3')}${knop('formatBlock', '¶', 'Gewone tekst', 'p')}
      ${knop('insertUnorderedList', '• Lijst', 'Opsomming')}${knop('insertOrderedList', '1. Lijst', 'Genummerde lijst')}
      ${knop('createLink', '🔗 Link', 'Link toevoegen')}${knop('removeFormat', '⌫ Opmaak', 'Opmaak weghalen')}
      <span style="width:1px;height:18px;background:var(--border);margin:0 4px"></span>
      <span style="font-size:11px;color:var(--text-3);margin-right:2px">Invoegen:</span>
      ${VARS.map((v) => `<button type="button" class="btn btn-ghost btn-sm" data-mb-var="${v}" style="padding:2px 6px;font-size:11px" title="Wordt per ontvanger ingevuld">{{${v}}}</button>`).join('')}
    </div>
    <div data-mb-editor contenteditable="true" spellcheck="true" style="min-height:200px;max-height:320px;overflow:auto;padding:12px 14px;border:1px solid var(--border);border-radius:0 0 8px 8px;background:var(--surface,#fff);font-size:14px;line-height:1.6;outline:none"></div>`;
  }

  function eersteVoornaam() {
    const l = (st.items || []).find((x) => st.gekozen.has(x.id) && x.voornaam);
    return l ? String(l.voornaam).trim().split(/\s+/)[0] : 'Jeffrey';
  }
  function waBlokHtml() {
    const b = st.bericht;
    if (st.wa.laden) return '<div style="color:var(--text-3)">WhatsApp-templates laden…</div>';
    if (st.wa.fout) return `<div style="padding:10px 12px;border-radius:8px;background:var(--rose-soft);color:var(--rose);border:1px solid var(--rose-line)">${esc(st.wa.fout)}</div>`;
    const t = waTemplateVan(b, st.wa.templates);
    const opties = (st.wa.templates || []).map((x) => `<option value="${esc(x.name + '|' + x.language)}" ${b.wa_template === x.name + '|' + x.language ? 'selected' : ''} ${x.bruikbaar ? '' : 'disabled'}>${esc(x.name)} (${esc(x.language)})${x.bruikbaar ? '' : ' — te veel variabelen'}</option>`).join('');
    return `<div style="font-size:11.5px;color:var(--text-3);margin-bottom:6px">Goedgekeurde MARKETING-templates van de lead-WABA${st.wa.waba ? ' <span class="mono">' + esc(st.wa.waba) + '</span>' : ''}. Meta voegt zelf een afmeldoptie toe.</div>
      ${(st.wa.templates || []).length ? `<select class="ib-input" data-mb-b="wa_template" style="width:100%"><option value="">— Kies een WhatsApp-template —</option>${opties}</select>` : '<div style="color:var(--text-3)">Er staat nog geen goedgekeurde MARKETING-template op de lead-WABA.</div>'}
      ${t ? `<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;margin-top:10px">
        <div>
          <div style="font-size:12px;color:var(--text-3)"><span class="mono">{{1}}</span> = voornaam, automatisch per ontvanger (anders "daar")</div>
          ${t.aantal_vars >= 2 ? `<label style="display:block;font-size:12px;color:var(--text-3);margin-top:8px"><span class="mono">{{2}}</span> = campagnetekst, voor iedereen gelijk
            <input class="ib-input" data-mb-b="wa_param2" value="${esc(b.wa_param2)}" maxlength="200" placeholder="bv. een gratis live webinar over onze strategie" style="width:100%;margin-top:3px"></label>` : ''}
          <div style="font-size:11.5px;color:var(--text-3);margin-top:10px">Tempo: max <b>${esc(st.wa.portie || '—')}</b> WhatsApps per ronde (elke 15 min)${st.wa.dagMax ? ', daglimiet ' + esc(st.wa.dagMax) : ''}. Alleen naar leads met een geldig nummer; hetzelfde nummer krijgt hem één keer.</div>
        </div>
        <div><div style="font-size:12px;color:var(--text-3);margin-bottom:4px">Voorbeeld (voor ${esc(eersteVoornaam())})</div>
          <div data-mb-wapreview style="white-space:pre-wrap;background:#dcf8c6;color:#111;border-radius:10px 10px 2px 10px;padding:10px 12px;font-size:13.5px;line-height:1.45;box-shadow:0 1px 1px rgba(0,0,0,.08)">${esc(waVoorbeeld(t.body, eersteVoornaam(), b.wa_param2))}</div>
          ${t.footer ? `<div style="font-size:11px;color:var(--text-3);margin-top:4px">${esc(t.footer)}</div>` : ''}
          ${(t.knoppen || []).length ? `<div style="display:flex;flex-direction:column;gap:4px;margin-top:6px">${t.knoppen.map((k) => `<div style="text-align:center;background:#fff;border:1px solid var(--border);border-radius:8px;padding:6px;font-size:12.5px;color:#0a7cff">${esc(k.text)}</div>`).join('')}</div>` : ''}
        </div></div>` : ''}`;
  }
  function berichtHtml() {
    const b = st.bericht;
    const sj = st.sj.lijst || [];
    const kanaal = b.kanaal || 'email';
    const metMail = kanaal !== 'whatsapp';
    const metWa = kanaal !== 'email';
    const radio = (v, l) => `<label style="cursor:pointer"><input type="radio" name="mb-kanaal" data-mb-b="kanaal" value="${v}" ${kanaal === v ? 'checked' : ''}> ${l}</label>`;
    return `<div style="display:flex;gap:16px;align-items:center;margin-bottom:10px;font-size:13px">
        <span style="color:var(--text-3)">Kanaal:</span>${radio('email', 'E-mail')}${radio('whatsapp', 'WhatsApp')}${radio('beide', 'Beide')}
        <span style="margin-left:auto;font-size:12px;color:var(--text-3)">${st.gekozen.size} ontvanger(s) geselecteerd</span>
      </div>
      <input class="ib-input" data-mb-b="naam" value="${esc(b.naam)}" placeholder="Campagnenaam (verplicht, alleen intern)" maxlength="120" style="width:100%;margin-bottom:8px">
      ${kanaal === 'beide' ? '<div style="font-size:11.5px;color:var(--text-3);margin:-2px 0 8px">Beide = iedereen krijgt wat hij kan ontvangen: met nummer én mailadres beide, anders het ene kanaal dat er is.</div>' : ''}
      ${metWa ? `<div style="border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:10px"><div style="font-weight:600;margin-bottom:6px">WhatsApp</div>${waBlokHtml()}</div>` : ''}
      ${metMail ? `<div${metWa ? ' style="border:1px solid var(--border);border-radius:10px;padding:10px 12px"' : ''}>${metWa ? '<div style="font-weight:600;margin-bottom:6px">E-mail</div>' : ''}
      <div style="display:grid;grid-template-columns:minmax(0,2fr) minmax(0,110px);gap:8px;margin-bottom:8px">
        <select class="ib-input" data-mb-b="soort"><option value="">— Soort mail —</option>${Object.entries(SOORTEN).map(([k, l]) => `<option value="${k}" ${b.soort === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <input class="ib-input" data-mb-b="portie" type="number" min="1" max="500" value="${esc(b.portie)}" title="Max. aantal mails per portie (één portie per 15 minuten)">
      </div>
      <div style="font-size:11px;color:var(--text-3);margin:-4px 0 8px">Soort mail = waar de ontvanger zich via de voorkeurenpagina voor kan af- of aanmelden. Portie = max. mails per ronde (elke 15 min, standaard 100; er geldt ook een daglimiet).</div>
      <select class="ib-input" data-mb-b="sjabloon" style="width:100%;margin-bottom:8px"><option value="">${st.sj.laden ? 'Sjablonen laden…' : (st.sj.fout ? 'Sjablonen niet beschikbaar' : '— Optioneel: e-mailsjabloon laden —')}</option>
        ${sj.map((x) => `<option value="${esc(x.id)}">${esc(x.naam)}</option>`).join('')}</select>
      <input class="ib-input" data-mb-b="onderwerp" value="${esc(b.onderwerp)}" placeholder="Onderwerp" maxlength="200" style="width:100%;margin-bottom:8px">
      ${toolbarHtml()}
      <div style="font-size:11px;color:var(--text-3);margin-top:6px">Elke mail krijgt de huisstijl (kop, logo, groet) en onderaan automatisch een link om voorkeuren aan te passen of af te melden. Verstuurd als welkom@; staat in de gesprekkendraad van de lead.</div></div>` : ''}`;
  }

  function controleHtml() {
    if (st.preview.laden) return '<div style="color:var(--text-3)">Aantal ontvangers uitrekenen…</div>';
    if (st.preview.fout) return `<div style="color:var(--rose)">${esc(st.preview.fout)}</div>`;
    const p = st.preview.data;
    if (!p) return '';
    const redenen = Object.entries(p.redenen || {}).map(([k, n]) => `<li>${n} × ${esc(REDENEN[k] || k)}</li>`).join('');
    const pk = p.per_kanaal || { email: { verzenden: p.aantal_verzenden } };
    const nMail = pk.email ? pk.email.verzenden : 0;
    const nWa = pk.whatsapp ? pk.whatsapp.verzenden : 0;
    const delen = [];
    if (pk.email) delen.push(`<b>${nMail}</b> e-mail${nMail === 1 ? '' : 's'}`);
    if (pk.whatsapp) delen.push(`<b>${nWa}</b> WhatsApp${nWa === 1 ? '' : 's'}`);
    const tempo = [];
    if (pk.email) tempo.push(`e-mail max <b>${p.portie}</b> per ronde (≈ ${Math.ceil(nMail / Math.max(1, p.portie))} ronde${Math.ceil(nMail / Math.max(1, p.portie)) === 1 ? '' : 's'})`);
    if (pk.whatsapp) tempo.push(`WhatsApp max <b>${p.wa_portie || '—'}</b> per ronde (≈ ${Math.ceil(nWa / Math.max(1, p.wa_portie || 1))} ronde${Math.ceil(nWa / Math.max(1, p.wa_portie || 1)) === 1 ? '' : 's'})`);
    const w = p.voorbeeld_wa;
    return `<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:16px">
      <div>
        <div style="font-size:28px;font-weight:700">${p.aantal_verzenden}</div>
        <div style="font-size:13px">${pk.whatsapp ? 'bericht' + (p.aantal_verzenden === 1 ? '' : 'en') : 'mail' + (p.aantal_verzenden === 1 ? '' : 's')} gaan de wachtrij in voor campagne <b>${esc(st.bericht.naam)}</b></div>
        <div data-mb-perkanaal style="font-size:14px;margin-top:6px">${delen.join(' · ')}</div>
        <div style="font-size:12px;color:var(--text-3);margin-top:6px">${p.aantal_geselecteerd} geselecteerd · ${p.aantal_overgeslagen} overgeslagen</div>
        ${redenen ? `<ul style="font-size:12px;color:var(--text-3);margin:6px 0 0;padding-left:18px">${redenen}</ul>` : ''}
        <div style="font-size:12px;margin-top:12px;padding:8px 10px;border-radius:8px;background:var(--surface-2,#f6f8fa)">Tempo, elke 15 minuten: ${tempo.join('; ')}. Stille uren 21:00–08:00 en de daglimiet gaan voor.</div>
        ${w ? `<div style="font-size:12px;margin-top:12px"><b>WhatsApp-template:</b> <span class="mono">${esc(w.template)}</span>${st.bericht.wa_param2 ? ` · <b>{{2}}</b>: ${esc(st.bericht.wa_param2)}` : ''}</div>
          <div style="white-space:pre-wrap;background:#dcf8c6;color:#111;border-radius:10px 10px 2px 10px;padding:10px 12px;font-size:13px;line-height:1.45;margin-top:6px">${esc(w.tekst)}</div>
          ${(w.knoppen || []).length ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:4px">Knoppen: ${w.knoppen.map((k) => esc(k.text)).join(' · ')}</div>` : ''}` : ''}
      </div>
      <div>${p.voorbeeld ? `<div style="font-size:12px;color:var(--text-3);margin-bottom:4px">Voorbeeld voor ${esc(p.voorbeeld.aan)} — onderwerp: <b style="color:var(--text)">${esc(p.voorbeeld.onderwerp)}</b></div>
        <iframe data-mb-voorbeeld sandbox="" style="width:100%;height:360px;border:1px solid var(--border);border-radius:10px;background:#eef1f5"></iframe>` : ''}</div>
    </div>`;
  }

  function campagneHtml(c) {
    if (!c) return '<div style="color:var(--text-3)">Laden…</div>';
    const pct = c.aantal ? Math.round(((c.aantal_verstuurd || 0) + (c.aantal_mislukt || 0)) / c.aantal * 100) : 0;
    const kan = (s) => s.includes(c.status);
    return `<div style="font-weight:600;font-size:15px">${esc(c.naam)}</div>
      <div style="font-size:12px;color:var(--text-3);margin:2px 0 10px">${esc(KANAAL_LABEL[c.kanaal || 'email'] || c.kanaal)}${c.onderwerp ? ' · ' + esc(SOORTEN[c.soort] || c.soort || '') + ' · onderwerp: ' + esc(c.onderwerp) + ' · portie ' + esc(c.portie) : ''}${c.wa_template ? ' · WhatsApp: <span class="mono">' + esc(c.wa_template) + '</span>' + (c.wa_param2 ? ' ({{2}}: ' + esc(c.wa_param2) + ')' : '') : ''} · status <b>${esc(c.status)}</b></div>
      <div style="height:8px;border-radius:6px;background:var(--surface-2,#eef1f5);overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--emerald,#10b981)"></div></div>
      <div style="display:flex;gap:16px;font-size:13px;margin:8px 0 12px;flex-wrap:wrap">
        <span><b>${c.aantal_verstuurd || 0}</b> verstuurd</span><span><b>${c.in_wachtrij != null ? c.in_wachtrij : '—'}</b> in de wachtrij</span>
        <span><b>${c.aantal_mislukt || 0}</b> mislukt</span><span><b>${c.aantal_overgeslagen || 0}</b> overgeslagen</span>
      </div>
      ${c.per_kanaal && Object.keys(c.per_kanaal).length > 1 || (c.per_kanaal && c.per_kanaal.whatsapp) ? `<div data-mb-voortgang-kanaal style="font-size:12px;color:var(--text-3);margin:-4px 0 12px">${Object.entries(c.per_kanaal).map(([k, v]) => `${esc(KANAAL_LABEL[k] || k)}: ${v.sent} verstuurd · ${v.queued} in de wachtrij · ${v.failed} mislukt · ${v.skipped} overgeslagen`).join('<br>')}</div>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${kan(['wachtrij', 'bezig']) ? `<button class="btn btn-primary btn-sm" data-mb-actie="verwerk" ${st.bezig ? 'disabled' : ''}>${st.bezig ? 'Bezig…' : 'Nu een portie versturen'}</button><button class="btn btn-ghost btn-sm" data-mb-actie="pauzeer" ${st.bezig ? 'disabled' : ''}>Pauzeren</button>` : ''}
        ${kan(['gepauzeerd']) ? `<button class="btn btn-primary btn-sm" data-mb-actie="hervat" ${st.bezig ? 'disabled' : ''}>Hervatten</button>` : ''}
        ${kan(['wachtrij', 'bezig', 'gepauzeerd']) ? `<button class="btn btn-ghost btn-sm" data-mb-actie="annuleer" style="color:var(--rose)" ${st.bezig ? 'disabled' : ''}>Annuleren</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-mb-actie="ververs">Vernieuwen</button>
      </div>
      ${(st.campDetail && st.campDetail.mislukt || []).length ? `<div style="margin-top:12px;font-size:12px"><b>Mislukt</b><ul style="margin:4px 0 0;padding-left:18px">${st.campDetail.mislukt.map((m) => `<li>${esc(m.kanaal === 'whatsapp' ? 'WhatsApp' : (m.email || '—'))}: ${esc(m.fout || '')}</li>`).join('')}</ul></div>` : ''}`;
  }

  function campagnesHtml() {
    if (st.camps.laden) return '<div style="color:var(--text-3)">Campagnes laden…</div>';
    if (st.camps.fout) return `<div style="color:var(--rose)">${esc(st.camps.fout)}</div>`;
    if (st.campagneId) return `<button class="btn btn-ghost btn-sm" data-mb-actie="camps-terug" style="margin-bottom:10px">← Alle campagnes</button>${campagneHtml(st.campDetail && st.campDetail.campagne)}`;
    const l = st.camps.lijst || [];
    if (!l.length) return '<div style="color:var(--text-3);font-size:13px">Nog geen campagnes.</div>';
    return `<div style="border:1px solid var(--border);border-radius:10px;overflow:hidden">${l.map((c) => `
      <div style="display:flex;gap:10px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--border);cursor:pointer" data-mb-actie="camp-open" data-mb-id="${esc(c.id)}">
        <div style="flex:1;min-width:0"><div style="font-weight:600">${esc(c.naam)}</div><div style="font-size:12px;color:var(--text-3)">${datum(c.aangemaakt_op)} · ${esc(KANAAL_LABEL[c.kanaal || 'email'] || c.kanaal)} · ${esc(c.onderwerp || c.wa_template || '')}</div></div>
        <div style="font-size:12px;text-align:right">${c.aantal_verstuurd}/${c.aantal} verstuurd${c.aantal_mislukt ? ` · <span style="color:var(--rose)">${c.aantal_mislukt} mislukt</span>` : ''}<div style="color:var(--text-3)">${esc(c.status)}</div></div>
      </div>`).join('')}</div>`;
  }

  function voetHtml() {
    const k = (actie, label, prim, uit) => `<button class="btn ${prim ? 'btn-primary' : 'btn-ghost'} btn-sm" data-mb-actie="${actie}" ${uit || st.bezig ? 'disabled style="opacity:.5;cursor:not-allowed"' : ''}>${label}</button>`;
    let links = '';
    let knoppen = k('sluit', 'Sluiten');
    if (st.tab === 'nieuw') {
      if (st.stap === 'selectie') {
        knoppen += k('naar-bericht', `Volgende: bericht (${st.gekozen.size}) →`, true, !st.gekozen.size);
      } else if (st.stap === 'bericht') {
        links = berichtFout(st.bericht, st.bericht.html, st.wa.templates); // st.bericht.html loopt mee met de editor
        knoppen = k('naar-selectie', '← Selectie') + knoppen + k('naar-controle', 'Controleren →', true, !!links);
      } else if (st.stap === 'controle') {
        const p = st.preview.data;
        const wat = (st.bericht.kanaal || 'email') === 'email' ? 'mails' : 'berichten';
        knoppen = k('naar-bericht-terug', '← Bericht') + knoppen + k('start', st.bezig ? 'Bezig…' : `Bevestig: ${p ? p.aantal_verzenden : '…'} ${wat} in de wachtrij`, true, !p || !p.aantal_verzenden);
      }
    }
    return `<span style="flex:1;font-size:12px;color:${st.fout ? 'var(--rose)' : 'var(--text-3)'}">${esc(st.fout || links)}</span>${knoppen}`;
  }

  function render() {
    const r = root();
    if (!r || !st) return;
    // Let op: hier NIET de editor uitlezen — wie st.bericht.html net zette (sjabloon
    // laden) zou anders overschreven worden. De editor houdt st.bericht.html zelf
    // bij (onInput / toolbar / bewaarEditor vóór elke stap- of tabwissel).
    const box = r.querySelector('[data-mb-box]');
    const tab = (id, label) => `<button type="button" data-mb-tab="${id}" style="border:0;background:none;padding:10px 4px;margin-right:14px;font-size:13.5px;cursor:pointer;border-bottom:2px solid ${st.tab === id ? 'var(--accent,#10284A)' : 'transparent'};font-weight:${st.tab === id ? 600 : 400};color:${st.tab === id ? 'inherit' : 'var(--text-3)'}">${label}</button>`;
    const stappen = ['selectie', 'bericht', 'controle'].map((s, i) => `<span style="font-size:12px;${st.stap === s ? 'font-weight:600' : 'color:var(--text-3)'}">${i + 1}. ${s === 'selectie' ? 'Selectie' : s === 'bericht' ? 'Bericht' : 'Controle'}</span>`).join(' <span style="color:var(--text-3)">›</span> ');
    let body;
    if (st.tab === 'campagnes') body = campagnesHtml();
    else if (st.stap === 'selectie') body = filtersHtml() + `<div data-mb-lijst>${lijstHtml()}</div>`;
    else if (st.stap === 'bericht') body = berichtHtml();
    else if (st.stap === 'controle') body = controleHtml();
    else body = campagneHtml(st.campDetail && st.campDetail.campagne);
    box.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:14px 18px 0">
        <div style="flex:1;min-width:0"><div style="font-weight:600;font-size:15px">Massabericht</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">${st.tab === 'nieuw' && st.stap !== 'wachtrij' ? stappen : 'E-mail aan een groep leads, via een rustige wachtrij'}</div></div>
        <button class="btn btn-ghost btn-sm" data-mb-actie="sluit" aria-label="Sluiten">✕</button>
      </div>
      <div style="padding:0 18px;border-bottom:1px solid var(--border)">${tab('nieuw', st.stap === 'wachtrij' ? 'Verzonden campagne' : 'Nieuw massabericht')}${tab('campagnes', 'Campagnes')}</div>
      <div style="padding:14px 18px;font-size:13px;line-height:1.5;overflow:auto;flex:1">${body}</div>
      <div data-mb-voet style="display:flex;gap:8px;align-items:center;justify-content:flex-end;padding:12px 18px;border-top:1px solid var(--border)">${voetHtml()}</div>`;
    const ed = editor(); if (ed) ed.innerHTML = st.bericht.html || '';
    const fr = r.querySelector('[data-mb-voorbeeld]');
    if (fr && st.preview.data && st.preview.data.voorbeeld) fr.srcdoc = st.preview.data.voorbeeld.html;
  }
  function repaintVoet() { const v = root() && root().querySelector('[data-mb-voet]'); if (v) v.innerHTML = voetHtml(); }
  function repaintLijst() { const l = root() && root().querySelector('[data-mb-lijst]'); if (l) l.innerHTML = lijstHtml(); repaintVoet(); }

  // ── Data ──────────────────────────────────────────────────────────────────
  async function laadSelectie() {
    st.laden = true; st.laadFout = null; repaintLijst();
    const vraag = ++st.vraag;
    try {
      const j = await api('/api/massa-selectie', { method: 'POST', body: JSON.stringify({ filter: filterVoorApi(st.filter) }) });
      if (!st || vraag !== st.vraag) return;
      st.items = j.items || [];
      st.opties = j.opties || st.opties;
      st.campagnes = j.campagnes || [];
      st.tabelOntbreekt = !!j.tabel_ontbreekt;
      // "Selecteer alles wat aan het filter voldoet" is de standaard na elk filter.
      st.gekozen = new Set(st.items.map((x) => x.id));
    } catch (e) {
      if (!st || vraag !== st.vraag) return;
      console.error('[massa-bericht] selectie laden mislukt:', e && e.status, e && (e.body || e.message));
      st.laadFout = e && e.status === 403 ? 'Je hebt geen rechten voor massaberichten (leads.update).' : 'Kon de selectie niet laden: ' + ((e && e.message) || 'onbekend');
    }
    st.laden = false;
    // Na het laden van de opties (bron/traject) ook de filterbalk opnieuw.
    if (st.stap === 'selectie' && st.tab === 'nieuw') render(); else repaintLijst();
  }
  async function laadSjablonen() {
    if (st.sj.geladen || st.sj.laden) return;
    st.sj.laden = true;
    try {
      const j = await api('/api/lead-mail-sjablonen');
      if (!st) return;
      st.sj.lijst = j.sjablonen || []; st.sj.geladen = true;
    } catch (e) {
      if (!st) return;
      console.error('[massa-bericht] sjablonen laden mislukt:', e && e.status, e && (e.body || e.message));
      st.sj.fout = 'Kon de sjablonen niet laden.';
    }
    st.sj.laden = false;
    if (st.stap === 'bericht') render();
  }
  async function laadWaTemplates() {
    if (st.wa.geladen || st.wa.laden) return;
    st.wa.laden = true; st.wa.fout = null; if (st.stap === 'bericht') render();
    try {
      const j = await api('/api/massa-campagne?wa_templates=1');
      if (!st) return;
      if (!j.ok) st.wa.fout = j.melding || 'WhatsApp is nu niet beschikbaar voor massaberichten.';
      st.wa.templates = j.templates || []; st.wa.waba = j.waba_id || null;
      st.wa.portie = j.wa_portie || null; st.wa.dagMax = j.wa_dag_max || null; st.wa.geladen = !!j.ok;
      const bruikbaar = st.wa.templates.filter((t) => t.bruikbaar);
      if (!st.bericht.wa_template && bruikbaar.length === 1) st.bericht.wa_template = bruikbaar[0].name + '|' + bruikbaar[0].language;
    } catch (e) {
      if (!st) return;
      console.error('[massa-bericht] WhatsApp-templates laden mislukt:', e && e.status, e && (e.body || e.message));
      st.wa.fout = 'Kon de WhatsApp-templates niet laden: ' + ((e && e.message) || 'onbekend');
    }
    st.wa.laden = false;
    if (st.stap === 'bericht') render();
  }
  function repaintWaPreview() {
    const p = root() && root().querySelector('[data-mb-wapreview]');
    const t = waTemplateVan(st.bericht, st.wa.templates);
    if (p && t) p.textContent = waVoorbeeld(t.body, eersteVoornaam(), st.bericht.wa_param2);
  }
  function campagneBody(extra) {
    bewaarEditor();
    const b = st.bericht;
    const kanaal = b.kanaal || 'email';
    const body = { ...extra, naam: b.naam, kanaal, filter: filterVoorApi(st.filter), lead_ids: (st.items || []).filter((x) => st.gekozen.has(x.id)).map((x) => x.id) };
    if (kanaal !== 'whatsapp') Object.assign(body, { soort: b.soort, onderwerp: b.onderwerp, html: b.html, portie: Number(b.portie) || 100, sjabloon_id: b.sjabloon_id || null });
    if (kanaal !== 'email') {
      const [naam, taal] = String(b.wa_template || '').split('|');
      Object.assign(body, { wa_template: naam || '', wa_taal: taal || 'nl', wa_param2: String(b.wa_param2 || '').trim() });
    }
    return JSON.stringify(body);
  }
  async function laadPreview() {
    st.stap = 'controle'; st.preview = { laden: true, fout: null, data: null }; st.fout = null; render();
    try {
      const j = await api('/api/massa-campagne', { method: 'POST', body: campagneBody({ actie: 'preview' }) });
      if (!st) return;
      st.preview.data = j;
    } catch (e) {
      if (!st) return;
      console.error('[massa-bericht] controle mislukt:', e && e.status, e && (e.body || e.message));
      st.preview.fout = (e && e.message) || 'Controle mislukt';
    }
    st.preview.laden = false; render();
  }
  async function start() {
    const p = st.preview.data;
    if (!p || !p.aantal_verzenden) return;
    st.bezig = true; st.fout = null; repaintVoet();
    try {
      const j = await api('/api/massa-campagne', { method: 'POST', body: campagneBody({ actie: 'start', bevestig_aantal: p.aantal_verzenden }) });
      if (!st) return;
      toast(`Campagne "${st.bericht.naam}": ${j.aantal_verzenden} ${(st.bericht.kanaal || 'email') === 'email' ? 'mails' : 'berichten'} in de wachtrij`, true);
      st.campagneId = j.campagne_id; st.stap = 'wachtrij'; st.bezig = false;
      await laadCampagne();
    } catch (e) {
      if (!st) return;
      console.error('[massa-bericht] starten mislukt:', e && e.status, e && (e.body || e.message));
      st.bezig = false;
      if (e && e.body && e.body.code === 'AANTAL_GEWIJZIGD' && e.body.samenvatting) { st.preview.data = e.body.samenvatting; render(); }
      st.fout = (e && e.message) || 'Starten mislukt'; repaintVoet();
    }
  }
  async function laadCampagne() {
    try {
      const j = await api('/api/massa-campagne?id=' + encodeURIComponent(st.campagneId));
      if (!st) return;
      st.campDetail = j;
    } catch (e) {
      if (!st) return;
      console.error('[massa-bericht] campagne laden mislukt:', e && e.status, e && (e.body || e.message));
      st.fout = 'Kon de campagne niet laden: ' + ((e && e.message) || 'onbekend');
    }
    render();
  }
  async function laadCampagnes() {
    st.camps = { laden: true, fout: null, lijst: [] }; render();
    try {
      const j = await api('/api/massa-campagne');
      if (!st) return;
      st.camps.lijst = j.campagnes || [];
      if (j.tabel_ontbreekt) st.camps.fout = 'De massa-tabellen bestaan nog niet (migratie 2026-10-10-massa-mail-fase2a.sql).';
    } catch (e) {
      if (!st) return;
      st.camps.fout = 'Kon de campagnes niet laden: ' + ((e && e.message) || 'onbekend');
    }
    st.camps.laden = false; render();
  }
  async function campagneActie(actie) {
    if (actie === 'annuleer' && !window.confirm('Campagne annuleren? Wat nog in de wachtrij staat, wordt niet meer verstuurd.')) return;
    st.bezig = true; st.fout = null; render();
    try {
      const j = await api('/api/massa-campagne', { method: 'POST', body: JSON.stringify({ actie: actie === 'verwerk' ? 'verwerk_nu' : actie, id: st.campagneId }) });
      if (actie === 'verwerk') toast(`Portie verwerkt: ${j.verstuurd} verstuurd, ${j.mislukt} mislukt, ${j.overgeslagen} overgeslagen` + (j.reden ? ` (${j.reden})` : ''), !j.mislukt);
    } catch (e) {
      console.error('[massa-bericht] actie mislukt:', actie, e && e.status, e && (e.body || e.message));
      if (st) st.fout = (e && e.message) || 'Actie mislukt';
    }
    if (!st) return;
    st.bezig = false;
    await laadCampagne();
  }

  // ── Events ────────────────────────────────────────────────────────────────
  function onClick(e) {
    const r = root();
    if (!r || !st) return;
    if (e.target === r) { if (!st.bezig) sluit(); return; }
    bewaarEditor();
    const tabEl = e.target.closest('[data-mb-tab]');
    if (tabEl) {
      st.tab = tabEl.getAttribute('data-mb-tab'); st.fout = null;
      if (st.tab === 'campagnes') { if (st.stap !== 'wachtrij') st.campagneId = null; laadCampagnes(); } else render();
      return;
    }
    const cmdEl = e.target.closest('[data-mb-cmd]');
    if (cmdEl) {
      const ed = editor(); if (ed) ed.focus();
      const cmd = cmdEl.getAttribute('data-mb-cmd');
      if (cmd === 'createLink') {
        const url = window.prompt('Link-adres (https://… of {{boekingslink}}):', 'https://');
        if (url && /^(https?:\/\/|mailto:|\{\{\s*\w+\s*\}\})/i.test(url.trim())) document.execCommand('createLink', false, url.trim());
      } else if (cmd === 'formatBlock') document.execCommand('formatBlock', false, cmdEl.getAttribute('data-mb-arg'));
      else document.execCommand(cmd, false, null);
      bewaarEditor(); repaintVoet(); return;
    }
    const varEl = e.target.closest('[data-mb-var]');
    if (varEl) {
      const ed = editor(); if (ed) ed.focus();
      document.execCommand('insertText', false, '{{' + varEl.getAttribute('data-mb-var') + '}}');
      bewaarEditor(); repaintVoet(); return;
    }
    const vink = e.target.closest('[data-mb-vink]');
    if (vink) {
      const id = vink.getAttribute('data-mb-vink');
      if (vink.checked) st.gekozen.add(id); else st.gekozen.delete(id);
      const a = r.querySelector('[data-mb-aantal]'); if (a) a.textContent = String(st.gekozen.size);
      repaintVoet(); return;
    }
    const a = e.target.closest('[data-mb-actie]');
    if (!a || a.disabled) return;
    const actie = a.getAttribute('data-mb-actie');
    if (actie === 'sluit') { if (!st.bezig) sluit(); }
    else if (actie === 'alles') { st.gekozen = new Set((st.items || []).map((x) => x.id)); repaintLijst(); }
    else if (actie === 'niets') { st.gekozen = new Set(); repaintLijst(); }
    else if (actie === 'filters-wis') { st.filter = { ...STANDAARD_FILTER, lead_ids: st.filter.lead_ids }; render(); laadSelectie(); }
    else if (actie === 'selectie-los') { st.filter = { ...st.filter, lead_ids: [] }; render(); laadSelectie(); }
    else if (actie === 'naar-bericht') { st.stap = 'bericht'; st.fout = null; render(); laadSjablonen(); if ((st.bericht.kanaal || 'email') !== 'email') laadWaTemplates(); }
    else if (actie === 'naar-selectie') { st.stap = 'selectie'; st.fout = null; render(); }
    else if (actie === 'naar-controle') laadPreview();
    else if (actie === 'naar-bericht-terug') { st.stap = 'bericht'; st.fout = null; render(); }
    else if (actie === 'start') start();
    else if (actie === 'camp-open') { st.campagneId = a.getAttribute('data-mb-id'); st.campDetail = null; render(); laadCampagne(); }
    else if (actie === 'camps-terug') { st.campagneId = null; laadCampagnes(); }
    else if (actie === 'ververs') laadCampagne();
    else if (['verwerk', 'pauzeer', 'hervat', 'annuleer'].includes(actie)) campagneActie(actie);
  }
  function onInput(e) {
    if (!st) return;
    const el = e.target;
    const f = el.getAttribute && el.getAttribute('data-mb-f');
    if (f && (f === 'q' || f === 'massa_dagen')) {
      st.filter[f] = el.value;
      clearTimeout(filterTimer); filterTimer = setTimeout(() => { if (st) laadSelectie(); }, 350);
      return;
    }
    const b = el.getAttribute && el.getAttribute('data-mb-b');
    if (b === 'wa_param2') { st.bericht.wa_param2 = el.value; repaintWaPreview(); repaintVoet(); return; }
    if (b && !['sjabloon', 'soort', 'kanaal', 'wa_template'].includes(b)) { st.bericht[b] = el.value; repaintVoet(); return; }
    if (el.matches && el.matches('[data-mb-editor]')) { bewaarEditor(); repaintVoet(); }
  }
  function onChange(e) {
    if (!st) return;
    const el = e.target;
    const f = el.getAttribute && el.getAttribute('data-mb-f');
    if (f && f !== 'q') {
      st.filter[f] = el.value;
      if (f === 'massa_modus' || f === 'massa_campagne') render();
      laadSelectie();
      return;
    }
    const b = el.getAttribute && el.getAttribute('data-mb-b');
    if (b === 'soort') { st.bericht.soort = el.value; repaintVoet(); }
    else if (b === 'kanaal') {
      st.bericht.kanaal = el.value; st.fout = null;
      if (el.value !== 'email') laadWaTemplates();
      render();
    }
    else if (b === 'wa_template') { st.bericht.wa_template = el.value; render(); }
    else if (b === 'sjabloon' && el.value) {
      const x = (st.sj.lijst || []).find((s) => s.id === el.value);
      if (!x) return;
      bewaarEditor();
      if (tekstVan(st.bericht.html) && !window.confirm('De huidige tekst vervangen door sjabloon "' + x.naam + '"?')) { el.value = ''; return; }
      st.bericht.onderwerp = x.onderwerp; st.bericht.html = x.html; st.bericht.sjabloon_id = x.id;
      render();
    }
  }
  function onPaste(e) {
    if (!e.target.closest || !e.target.closest('[data-mb-editor]')) return;
    e.preventDefault();
    const t = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, t);
  }
  function onKey(e) { if (e.key === 'Escape' && st && !st.bezig) { e.preventDefault(); sluit(); } }

  function sluit() {
    const r = root();
    if (r) r.remove();
    document.removeEventListener('keydown', onKey, true);
    clearTimeout(filterTimer);
    const klaar = st && st.onKlaar;
    const gestart = st && !!st.campagneId;
    st = null;
    if (gestart && typeof klaar === 'function') { try { klaar(); } catch (_) { /* noop */ } }
  }

  /**
   * opts.filter   — beginfilter (de lijstfilters van het scherm), bv. { traject:'7-daagse' }
   * opts.leadIds  — met de hand aangevinkte leads (alleen die worden getoond)
   * opts.onKlaar  — na het starten van een campagne
   */
  function open(opts) {
    const o = opts || {};
    sluit();
    st = {
      tab: 'nieuw', stap: 'selectie', vraag: 0,
      filter: { ...STANDAARD_FILTER, ...(o.filter || {}), lead_ids: Array.isArray(o.leadIds) ? o.leadIds.slice(0, 5000) : [] },
      items: [], gekozen: new Set(), opties: null, campagnes: [], laden: true, laadFout: null, tabelOntbreekt: false,
      bericht: { naam: '', kanaal: 'email', soort: '', onderwerp: '', html: '', portie: 100, sjabloon_id: null, wa_template: '', wa_param2: '' },
      wa: { laden: false, geladen: false, fout: null, templates: [], waba: null, portie: null, dagMax: null },
      sj: { laden: false, geladen: false, fout: null, lijst: [] },
      preview: { laden: false, fout: null, data: null },
      camps: { laden: false, fout: null, lijst: [] }, campagneId: null, campDetail: null,
      bezig: false, fout: null, onKlaar: o.onKlaar,
    };
    const r = document.createElement('div');
    r.id = ROOT_ID;
    r.setAttribute('style', 'position:fixed;inset:0;z-index:9500;background:rgba(10,20,35,.45);display:flex;align-items:center;justify-content:center;padding:16px');
    r.innerHTML = '<div data-mb-box role="dialog" aria-modal="true" aria-label="Massabericht" style="background:var(--surface,#fff);color:var(--text,#1b2430);width:100%;max-width:1080px;max-height:94vh;display:flex;flex-direction:column;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.25)"></div>';
    r.addEventListener('click', onClick);
    r.addEventListener('input', onInput);
    r.addEventListener('change', onChange);
    r.addEventListener('paste', onPaste);
    document.body.appendChild(r);
    document.addEventListener('keydown', onKey, true);
    render();
    laadSelectie();
  }

  window.MassaBericht = { open, sluit, _intern: { berichtFout, filterVoorApi, onbekendeVars, waVoorbeeld, STANDAARD_FILTER } };
})();
