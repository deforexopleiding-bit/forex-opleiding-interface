// modules/klanten-v2/views/contentmachine-lanceer-v2.js
//
// Contentmachine 2.0, fase 5 — "Keur goed en lanceer" in het werkblad (super_admin):
//   - bevestigingsscherm met alles wat moet kloppen (api/contentmachine/lanceer.js GET),
//     verplichte testmail van deze versie, keuze nu versturen of inplannen;
//   - bij lanceren eerst de social-beelden + het mailbeeld renderen en bewaren als ze ontbreken;
//   - daarna het statusbord: Pagina live ✓ (server-side controle, max 2 min) · Mail verstuurd ✓
//     (getagd X van Y) · Beelden klaar ✓ · Leads · Calls · per kanaal · top-3 blokken;
//   - "Klaar om te posten": captions per kanaal met kopieer- en downloadknoppen.
//   - GHL instellen/controleren (vaste template, onderwerp, workflow, doelgroep-tag).
//
//   window.__cmLanceerKnop() · window.__cmLanceerPaneel()
(function () {
  'use strict';
  const H = () => window.__cmWbHulp;
  const wb = () => window.__cmWb || {};
  const lz = window.__cmLz = window.__cmLz || { dropId: null, data: null, laden: false, open: false, modus: 'nu', ingepland: '', onderwerp: 0, doelgroep: 'tag', verstuur: '', ontvangers: {}, bezig: null, fout: null, ghl: null, poll: null, cijfers: null };

  const nl = (n) => (n == null ? '—' : Number(n).toLocaleString('nl-NL'));
  const tijd = (s) => (s ? new Date(s).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
  const vink = (ok, bezig) => (bezig ? '<span style="color:var(--amber)">…</span>' : ok ? '<span style="color:var(--green,#1E9E6A);font-weight:700">✓</span>' : '<span style="color:var(--rose);font-weight:700">✗</span>');
  const teken = () => H().teken('cm-lz', binnen());

  async function laad(stil) {
    const d = wb().drop; if (!d) return;
    if (lz.dropId !== d.id) { Object.assign(lz, { dropId: d.id, data: null, open: false, fout: null, ghl: null, onderwerp: 0 }); stopPoll(); }
    if (lz.laden) return;
    lz.laden = true; if (!stil) teken();
    try { lz.data = await H().api('/api/contentmachine/lanceer?id=' + encodeURIComponent(d.id)); lz.fout = null; }
    catch (e) { lz.fout = H().foutTekst(e, 'Lanceerstatus laden mislukt.'); }
    lz.laden = false;
    if (!lz.cijfers && (window.__cmData || (d.status === 'gepubliceerd'))) laadCijfers();
    planPoll(); teken();
    const a = document.getElementById('cm-wb-acties'); if (a && typeof window.__cmWbActiesHtml === 'function') a.innerHTML = window.__cmWbActiesHtml();
  }
  async function laadCijfers() {
    try { const j = window.__cmData || await H().api('/api/contentmachine/data'); window.__cmData = j; lz.cijfers = j; teken(); }
    catch (e) { console.warn('[contentmachine-lanceer] cijfers niet beschikbaar:', e && e.status); }
  }
  function stopPoll() { if (lz.poll) { clearTimeout(lz.poll); lz.poll = null; } }
  function planPoll() {
    stopPoll();
    const l = lz.data && lz.data.lancering;
    if (l && ['ingepland', 'taggen'].includes(l.status)) lz.poll = setTimeout(() => { if (document.getElementById('cm-lz')) laad(true); }, l.status === 'taggen' ? 10000 : 60000);
  }

  // ── knop in de actiebalk ──────────────────────────────────────────────────
  window.__cmLanceerKnop = function () {
    const d = wb().drop; if (!d) return '';
    if (lz.dropId !== d.id && !lz.laden) queueMicrotask(() => laad());
    const s = lz.data;
    if (!s) return '';
    const l = s.lancering;
    const loopt = l && ['ingepland', 'taggen'].includes(l.status);
    if (!s.super_admin) return d.status === 'gegenereerd' ? '<span style="font-size:11.5px;color:var(--text-3)">Lanceren: super_admin</span>' : '';
    if (['gegenereerd', 'goedgekeurd'].includes(d.status) || (d.status === 'gepubliceerd' && !loopt && !(l && l.status === 'klaar' && l.totaal))) {
      return `<button class="btn btn-primary btn-sm" onclick="__cmLzOpen()" ${wb().dirty ? 'disabled title="Bewaar eerst je wijzigingen"' : ''}>🚀 Keur goed en lanceer</button>`;
    }
    return '';
  };
  window.__cmLzOpen = () => { lz.open = true; lz.verstuur = ''; teken(); const el = document.getElementById('cm-lz'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); laad(true); telOntvangers(); };
  /** Verwacht aantal ontvangers van de gekozen doelgroep (GHL), één keer per doelgroep. */
  async function telOntvangers() {
    const k = lz.doelgroep;
    if (lz.ontvangers[k] && !lz.ontvangers[k].fout) return;
    lz.ontvangers[k] = { laden: true }; teken();
    try { lz.ontvangers[k] = await H().post('/api/contentmachine/lanceer', { actie: 'ontvangers', doelgroep: k }); }
    catch (e) { lz.ontvangers[k] = { fout: H().foutTekst(e, 'Tellen mislukt.') }; }
    teken();
  }
  window.__cmLzDoelgroep = (d) => { lz.doelgroep = d === 'alle' ? 'alle' : 'tag'; lz.verstuur = ''; teken(); telOntvangers(); };
  window.__cmLzVerstuur = (v) => {
    lz.verstuur = v;
    const knop = document.getElementById('cm-lz-knop');
    if (knop) knop.disabled = !!knop.dataset.blok || v !== 'VERSTUUR';
  };
  const ontvangersTekst = (o) => {
    if (!o || o.laden) return 'aantal ontvangers tellen…';
    if (o.fout) return o.fout;
    const v = o.zonder_dnd != null ? o.zonder_dnd : o.totaal;
    return `verwacht ±${nl(v)} ontvangers${o.zonder_dnd != null ? ` (${nl(o.totaal)} contacten, zonder DND)` : ` (${nl(o.totaal)} contacten; DND/uitgeschreven vallen nog weg)`}`;
  };
  window.__cmLzSluit = () => { lz.open = false; teken(); };

  // ── paneel ────────────────────────────────────────────────────────────────
  window.__cmLanceerPaneel = function () {
    const d = wb().drop; if (!d) return '';
    if (lz.dropId !== d.id && !lz.laden) queueMicrotask(() => laad());
    return `<div id="cm-lz">${binnen()}</div>`;
  };

  function binnen() {
    const d = wb().drop; const s = lz.data;
    if (!d || !s) return lz.fout ? `<div style="font-size:12px;color:var(--rose);margin-bottom:8px">${H().esc(lz.fout)}</div>` : '';
    const l = s.lancering;
    const toonBord = d.status === 'gepubliceerd' || (l && l.status !== 'geannuleerd');
    return `${lz.open ? bevestiging() : ''}${toonBord ? statusbord() : ''}${s.super_admin && lz.ghl ? ghlRapport() : ''}`;
  }

  function bevestiging() {
    const h = H(); const d = wb().drop; const s = lz.data; const n = (wb().output || {}).nieuwsbrief || {};
    const metMail = s.kanalen.includes('nieuwsbrief');
    const blok = s.voorwaarden.filter((v) => v.blokkeert);
    const rij = (v) => `<li style="margin:3px 0">${vink(v.ok)} ${h.esc(v.tekst)}</li>`;
    const onderwerpen = (n.onderwerpen || []).map((x, i) => `<label style="display:flex;gap:6px;align-items:flex-start;font-size:12.5px;margin:3px 0"><input type="radio" name="cm-lz-ond" ${lz.onderwerp === i ? 'checked' : ''} onchange="__cmLzOnderwerp(${i})"> <span><b>${String.fromCharCode(65 + i)}.</b> ${h.esc(x)}</span></label>`).join('');
    const test = s.test;
    return `<div class="card" style="margin-bottom:10px;border-color:var(--m,#6D3FD4)"><div class="card-head"><div class="card-title">🚀 Keur goed en lanceer — ${h.esc(d.slug)}</div><a href="javascript:void(0)" onclick="__cmLzSluit()" style="font-size:12px">sluiten</a></div>
      <div class="card-body" style="font-size:12.5px">
        <div style="font-weight:700;margin-bottom:4px">Wat er gebeurt</div>
        <ol style="margin:0 0 10px 18px;line-height:1.55">
          ${s.kanalen.includes('pagina') ? `<li><b>Pagina</b> wordt gepubliceerd op training.deforexopleiding.nl/${h.esc(d.slug)}; daarna controleert het CRM dat ze 200 geeft met de juiste titel (max 2 min).</li>` : ''}
          <li><b>Beelden</b>: alle social-beelden${metMail ? ' en het mailbeeld' : ''} gerenderd en in Storage; zip en captions klaar.</li>
          ${metMail ? `<li><b>Nieuwsbrief via GHL</b>: de template "${h.esc(s.instellingen.template_naam)}" en het onderwerp worden bijgewerkt; daarna krijgen ${lz.doelgroep === 'alle' ? '<b>alle contacten</b>' : `de contacten met tag <code>${h.esc(s.instellingen.doelgroep_tag)}</code>`} de tag <code>${h.esc(s.instellingen.verzend_tag)}</code> (DND/uitgeschreven worden overgeslagen) en de workflow "${h.esc(s.instellingen.workflow_naam)}" verstuurt.</li>` : '<li>Het kanaal nieuwsbrief staat uit voor deze drop.</li>'}
        </ol>
        <div style="font-weight:700;margin-bottom:4px">Controle</div>
        <ul style="list-style:none;margin:0 0 10px;padding:0">${s.voorwaarden.map(rij).join('')}</ul>
        ${metMail ? `<div style="font-weight:700;margin-bottom:2px">Onderwerp</div>${onderwerpen}
          <div style="margin:8px 0 12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-sm" onclick="__cmLzTest()" ${lz.bezig ? 'disabled' : ''}>${lz.bezig === 'test' ? 'Versturen…' : '✉ Stuur testmail naar mij'}</button>
            <span style="color:var(--text-3)">${test ? `Laatste test: ${h.esc(tijd(test.verstuurd_op))} naar ${h.esc(test.email)} (variant ${String.fromCharCode(65 + (test.onderwerp_index || 0))})` : 'Verplicht: een testmail van deze versie.'}</span></div>
          <div style="font-weight:700;margin-bottom:4px">Naar wie</div>
          <label style="display:flex;gap:6px;align-items:center;margin:3px 0;flex-wrap:wrap"><input type="radio" name="cm-lz-doel" ${lz.doelgroep === 'tag' ? 'checked' : ''} onchange="__cmLzDoelgroep('tag')"> Contacten met tag <code>${h.esc(s.instellingen.doelgroep_tag)}</code> <span style="color:var(--text-3)">· ${h.esc(lz.doelgroep === 'tag' ? ontvangersTekst(lz.ontvangers.tag) : 'bv. weekeditie-test om te testen')}</span></label>
          <label style="display:flex;gap:6px;align-items:center;margin:3px 0;flex-wrap:wrap"><input type="radio" name="cm-lz-doel" ${lz.doelgroep === 'alle' ? 'checked' : ''} onchange="__cmLzDoelgroep('alle')"> <b>Alle contacten</b> (zonder DND/uitgeschreven, zoals de huidige nieuwsbrief) ${lz.doelgroep === 'alle' ? `<span style="color:var(--text-3)">· ${h.esc(ontvangersTekst(lz.ontvangers.alle))}</span>` : ''}</label>
          ${lz.doelgroep === 'alle' ? `<div style="margin:6px 0 10px;padding:8px 10px;border:1px solid var(--rose);border-radius:8px">Dit stuurt de nieuwsbrief naar de <b>volledige lijst</b>. Typ <b>VERSTUUR</b> om te bevestigen:
            <input class="ib-input cm-mini" style="width:140px;margin-left:6px" value="${h.esc(lz.verstuur)}" oninput="__cmLzVerstuur(this.value)" autocomplete="off"></div>` : ''}
          <div style="font-weight:700;margin-bottom:4px">Versturen</div>
          <label style="display:flex;gap:6px;align-items:center;margin:3px 0"><input type="radio" name="cm-lz-modus" ${lz.modus === 'nu' ? 'checked' : ''} onchange="__cmLzModus('nu')"> Nu versturen</label>
          <label style="display:flex;gap:6px;align-items:center;margin:3px 0;flex-wrap:wrap"><input type="radio" name="cm-lz-modus" ${lz.modus === 'ingepland' ? 'checked' : ''} onchange="__cmLzModus('ingepland')"> Inplannen op
            <input type="datetime-local" class="ib-input cm-mini" style="width:auto" value="${h.esc(lz.ingepland)}" oninput="__cmLzTijd(this.value)" onfocus="__cmLzModus('ingepland', true)"></label>` : ''}
        <div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-primary" id="cm-lz-knop" ${blok.length || lz.bezig ? 'data-blok="1"' : ''} onclick="__cmLzLanceer()" ${blok.length || lz.bezig || (metMail && lz.doelgroep === 'alle' && lz.verstuur !== 'VERSTUUR') ? 'disabled' : ''}>${lz.bezig === 'lanceer' ? 'Bezig met lanceren…' : `Lanceer ${metMail ? (lz.modus === 'nu' ? '(nu versturen)' : '(ingepland)') : ''}`}</button>
          ${blok.length ? `<span style="color:var(--rose)">Eerst: ${h.esc(blok.map((v) => v.sleutel).join(', '))}</span>` : ''}
          ${s.super_admin ? '<a href="javascript:void(0)" style="margin-left:auto;font-size:12px" onclick="__cmLzGhl(\'ghl-check\')">GHL controleren / instellen</a>' : ''}
        </div>
        ${lz.bezig === 'lanceer' && lz.stap ? `<div style="margin-top:6px;color:var(--text-3)">${h.esc(lz.stap)}</div>` : ''}
      </div></div>`;
  }

  function statusbord() {
    const h = H(); const d = wb().drop; const s = lz.data; const l = s.lancering;
    const pc = l && l.pagina_check;
    const c = lz.cijfers && lz.cijfers.drops && lz.cijfers.drops[d.slug];
    const b = s.beelden || {};
    let mail;
    if (!s.kanalen.includes('nieuwsbrief')) mail = 'kanaal uit';
    else if (!l) mail = 'nog niet gelanceerd';
    else if (l.status === 'ingepland') mail = `ingepland op ${tijd(l.ingepland_op)}`;
    else if (l.status === 'taggen') mail = `${l.doelgroep_tag === '*alle-contacten*' ? 'alle contacten · ' : ''}wordt verstuurd: getagd ${nl(l.getagd)} van ${nl(l.totaal)}${l.overgeslagen ? ` · ${nl(l.overgeslagen)} overgeslagen` : ''}`;
    else if (l.status === 'klaar') mail = `${l.doelgroep_tag === '*alle-contacten*' ? 'alle contacten · ' : ''}${nl(l.getagd)} contacten getagd${l.totaal != null ? ` van ${nl(l.totaal)}` : ''}${l.overgeslagen ? ` · ${nl(l.overgeslagen)} overgeslagen (DND/uitgeschreven)` : ''}${l.mislukt ? ` · ${nl(l.mislukt)} mislukt` : ''} · ${tijd(l.klaar_op)}`;
    else mail = `${l.status}${l.fout ? ': ' + l.fout : ''}`;
    const cel = (label, ok, tekst, extra = '') => `<div style="border:1px solid var(--border);border-radius:10px;padding:8px 10px;min-width:150px;flex:1"><div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3)">${label}</div><div style="font-size:13px;margin-top:2px">${ok == null ? '' : vink(ok) + ' '}${tekst}</div>${extra}</div>`;
    const pagina = d.status !== 'gepubliceerd' ? cel('Pagina', false, 'niet gepubliceerd')
      : cel('Pagina live', pc ? pc.ok : null, pc ? (pc.ok ? `200 · juiste titel${pc.via === 'site' ? ' (via www, subdomein nog niet bereikbaar)' : ''}` : h.esc(pc.fout || 'niet bereikbaar')) : 'nog niet gecontroleerd',
        `<div style="margin-top:4px;font-size:11.5px"><a href="https://training.deforexopleiding.nl/${h.esc(d.slug)}" target="_blank" rel="noopener">open ↗</a> · <a href="javascript:void(0)" onclick="__cmLzPagina()">${lz.bezig === 'pagina' ? 'controleren…' : 'controleer'}</a></div>`);
    const kanalen = c && c.kanalen && c.kanalen.length ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:6px">Per kanaal: ${c.kanalen.map((k) => `${h.esc(k.label || k.kanaal)} ${nl(k.bezoekers)}/${nl(k.leads)}/${nl(k.calls)}`).join(' · ')} <span title="bezoekers/leads/calls">(bez/leads/calls)</span></div>` : '';
    const top = c && c.top_blokken && c.top_blokken.length ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:3px">Meest gebruikte blokken: ${c.top_blokken.map((x) => `${h.esc(x.type)} (${nl(x.gebruikt)}× gebruikt, ${nl(x.bekeken)} gezien)`).join(' · ')}</div>` : '';
    return `<div class="card" style="margin-bottom:10px"><div class="card-head"><div class="card-title">Statusbord</div>
        ${l && ['ingepland', 'taggen'].includes(l.status) && s.super_admin ? '<a href="javascript:void(0)" style="font-size:12px;color:var(--rose)" onclick="__cmLzAnnuleer()">versturen stoppen</a>' : ''}</div>
      <div class="card-body"><div style="display:flex;gap:8px;flex-wrap:wrap">
        ${pagina}
        ${cel('Mail', l ? l.status === 'klaar' : null, h.esc(mail))}
        ${cel('Beelden', b.ok, b.ok ? `${nl(b.nodig)} klaar in Storage` : `ontbreekt: ${h.esc((b.ontbreekt || []).join(', '))}`, '<div style="margin-top:4px;font-size:11.5px"><a href="javascript:void(0)" onclick="__cmSocialZip && __cmSocialZip()">zip ⬇</a></div>')}
        ${cel('Leads tot nu toe', null, c ? `<b>${nl(c.leads)}</b> · ${nl(c.bezoekers)} bezoekers${c.bezoekers ? ` · ${String(c.conversie_pct).replace('.', ',')}%` : ''}` : '—')}
        ${cel('Calls tot nu toe', null, c ? `<b>${nl(c.calls)}</b>${c.calls_gehouden ? ` · ${nl(c.calls_gehouden)} gehouden` : ''}` : '—')}
      </div>${kanalen}${top}${klaarOmTePosten()}</div></div>`;
  }

  function klaarOmTePosten() {
    const h = H(); const s = lz.data; const c = s.captions; const o = wb().output || {};
    const best = (o.social && o.social.bestanden) || {};
    const namen = Object.keys(best).filter((n) => n !== 'nieuwsbrief').sort((a, b) => a.localeCompare(b, 'nl', { numeric: true }));
    if (!c && !namen.length) return '';
    const kop = (t, tekst) => `<div style="display:flex;gap:6px;align-items:center;margin-top:4px"><b style="font-size:12px;min-width:150px">${h.esc(t)}</b><a href="javascript:void(0)" style="font-size:12px" onclick="__cmWbKopieerDeel(${h.esc(JSON.stringify(tekst))})">kopieer</a><span style="font-size:11.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px">${h.esc(String(tekst).split('\n')[0])}</span></div>`;
    return `<details style="margin-top:10px"><summary style="cursor:pointer;font-weight:700;font-size:12.5px">Klaar om te posten</summary>
      ${c ? kop('Instagram-caption', c.instagram_post) + kop('Link in bio', c.instagram_bio_link) + kop('Story-linksticker', c.instagram_story_link) + kop('LinkedIn-post', c.linkedin) : ''}
      ${namen.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${namen.map((n) => `<a class="btn btn-ghost btn-sm" style="font-size:11.5px" href="${h.esc(best[n].url)}" target="_blank" rel="noopener" download="drop-${h.esc(wb().drop.slug)}-${h.esc(n)}.png">⬇ ${h.esc(n)}</a>`).join('')}</div>` : ''}
    </details>`;
  }

  function ghlRapport() {
    const h = H(); const r = lz.ghl;
    if (r.fout) return `<div class="card" style="margin-bottom:10px"><div class="card-body" style="font-size:12px;color:var(--rose)">${h.esc(r.fout)}</div></div>`;
    const i = r.instellingen || {};
    const wf = r.workflow || {};
    const t = r.tags || {};
    return `<div class="card" style="margin-bottom:10px"><div class="card-head"><div class="card-title">GHL — nieuwsbrief-instellingen</div><a href="javascript:void(0)" style="font-size:12px" onclick="__cmLzGhlSluit()">sluiten</a></div>
      <div class="card-body" style="font-size:12.5px;line-height:1.6">
        ${r.token ? `<div style="margin-bottom:6px;padding:6px 8px;background:var(--surface-2);border-radius:8px;font-size:12px">Token voor deze calls: <b>${h.esc(r.token.gebruikt || '—')}</b> <code>${h.esc(r.token.vingerafdruk || '—')}</code>${r.token.location ? ` · location <code>${h.esc(r.token.location)}</code>` : ''}
          <div style="color:var(--text-3)">In de env: ${(r.token.alle || []).map((x) => `${h.esc(x.env)} ${x.vingerafdruk ? `<code>${h.esc(x.vingerafdruk)}</code>` : '<i>leeg</i>'}`).join(' · ')}</div></div>` : ''}
        <div>${vink(!!i.template_id)} Vaste template "${h.esc(i.template_naam)}": ${i.template_id ? `<code>${h.esc(i.template_id)}</code>` : 'nog niet aangemaakt'}</div>
        <div>${vink(!!i.custom_value_id)} Onderwerp (custom value): ${i.custom_value_sleutel ? `<code>${h.esc(i.custom_value_sleutel)}</code>` : 'nog niet aangemaakt'}</div>
        <div>${vink(!!wf.id)} Workflow "${h.esc(i.workflow_naam)}": ${wf.id ? `bestaat (${h.esc(wf.status || '?')})` : wf.fout ? h.esc(wf.fout) : 'bestaat nog niet — maak hem in GHL: trigger <i>tag toegevoegd</i> <code>' + h.esc(i.verzend_tag) + '</code> → e-mail met de template, onderwerp ' + h.esc(i.custom_value_sleutel || '{{ custom_values.weekeditie_onderwerp }}') + ' → tag verwijderen'}</div>
        <div style="margin-top:6px"><b>Doelgroep</b> (bestaande nieuwsbrieflijst): ${t.fout ? h.esc(t.fout) : (t.kandidaten || []).map((k) => `<code>${h.esc(k.tag)}</code> ${k.fout ? h.esc(k.fout) : nl(k.contacten) + ' contacten'}${k.tag === i.doelgroep_tag ? ' ← gekozen' : ''}`).join(' · ') || '—'}</div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px">
          <label>Doelgroep-tag <input class="ib-input cm-mini" style="width:160px" id="cm-lz-doel" value="${h.esc(i.doelgroep_tag)}"></label>
          <label>Verzendtag <input class="ib-input cm-mini" style="width:180px" id="cm-lz-verzend" value="${h.esc(i.verzend_tag)}"></label>
          <button class="btn btn-sm" onclick="__cmLzBewaarInst()">Bewaar</button>
          ${!i.template_id || !i.custom_value_id ? `<button class="btn btn-sm btn-primary" onclick="__cmLzGhl('ghl-instellen')">${lz.bezig === 'ghl' ? 'Bezig…' : 'Template + onderwerp aanmaken in GHL'}</button>` : ''}
        </div>
        ${r.links ? `<div style="margin-top:6px;font-size:11.5px"><a href="${h.esc(r.links.templates)}" target="_blank" rel="noopener">Templates in GHL ↗</a></div>` : ''}
        <div style="color:var(--text-3);font-size:11.5px;margin-top:6px">Het CRM verstuurt zelf niets naar de lijst: het zet enkel de verzendtag; de workflow in GHL verstuurt en haalt de tag weer weg. Test eerst met een doelgroep-tag waar enkel een +test-contact op staat.</div>
      </div></div>`;
  }

  // ── acties ────────────────────────────────────────────────────────────────
  window.__cmLzOnderwerp = (i) => { lz.onderwerp = i; };
  window.__cmLzModus = (m, stil) => { lz.modus = m; if (!stil) teken(); else { const r = document.getElementsByName('cm-lz-modus'); if (r[1]) r[1].checked = true; } };
  window.__cmLzTijd = (v) => { lz.ingepland = v; lz.modus = 'ingepland'; };
  window.__cmLzGhlSluit = () => { lz.ghl = null; teken(); };

  window.__cmLzTest = async () => {
    if (lz.bezig) return;
    lz.bezig = 'test'; teken();
    try {
      const r = await H().post('/api/contentmachine/lanceer', { actie: 'test', id: wb().drop.id, onderwerp: lz.onderwerp });
      H().toast(`Testmail verstuurd naar ${r.naar}.`);
    } catch (e) { H().toast(H().foutTekst(e, 'Testmail mislukt.')); }
    lz.bezig = null; await laad(true);
  };

  async function zorgBeelden() {
    const b = lz.data.beelden;
    if (b.ok) return;
    const mail = b.ontbreekt.includes('nieuwsbrief');
    const social = b.ontbreekt.some((n) => n !== 'nieuwsbrief');
    if (social && typeof window.__cmSocialOpslaan === 'function') { lz.stap = 'Social-beelden renderen en bewaren…'; teken(); await window.__cmSocialOpslaan(true); }
    if (mail && typeof window.__cmWeMailBeeld === 'function') { lz.stap = 'Mailbeeld renderen en bewaren…'; teken(); await window.__cmWeMailBeeld(); }
    await laad(true);
    if (!lz.data.beelden.ok) throw new Error('Nog niet in Storage: ' + lz.data.beelden.ontbreekt.join(', '));
  }

  window.__cmLzLanceer = async () => {
    if (lz.bezig) return;
    const s = lz.data; const metMail = s.kanalen.includes('nieuwsbrief');
    let ingepland = null;
    if (metMail && lz.modus === 'ingepland') {
      const t = new Date(lz.ingepland);
      if (!lz.ingepland || !Number.isFinite(t.getTime())) { H().toast('Kies een datum en uur.'); return; }
      ingepland = t.toISOString();
    }
    if (metMail && lz.doelgroep === 'alle' && lz.verstuur !== 'VERSTUUR') { H().toast('Typ VERSTUUR om naar alle contacten te versturen.'); return; }
    const o = lz.ontvangers[lz.doelgroep];
    const wie = lz.doelgroep === 'alle' ? `ALLE contacten${o && !o.fout && !o.laden ? ` (±${nl(o.zonder_dnd != null ? o.zonder_dnd : o.totaal)})` : ''}` : `de tag ${s.instellingen.doelgroep_tag}${o && !o.fout && !o.laden ? ` (±${nl(o.zonder_dnd != null ? o.zonder_dnd : o.totaal)})` : ''}`;
    const vraag = metMail ? (lz.modus === 'nu' ? `Lanceren: pagina online en de nieuwsbrief NU naar ${wie}?` : `Lanceren: pagina online en de nieuwsbrief ingepland op ${tijd(ingepland)} naar ${wie}?`) : 'Lanceren: pagina online?';
    if (!window.confirm(vraag)) return;
    lz.bezig = 'lanceer'; lz.stap = null; teken();
    try {
      await zorgBeelden();
      lz.stap = metMail && lz.modus === 'nu' ? 'Pagina publiceren, template bijwerken en de eerste contacten taggen (± 40 s)…' : 'Pagina publiceren…';
      teken();
      const r = await H().post('/api/contentmachine/lanceer', { actie: 'lanceer', id: wb().drop.id, modus: metMail ? lz.modus : 'nu', ingepland_op: ingepland, onderwerp: lz.onderwerp, doelgroep: lz.doelgroep, ...(lz.doelgroep === 'alle' ? { bevestiging: lz.verstuur } : {}) });
      H().toast('Gelanceerd.');
      if (r.drop) H().zet(r.drop, null, null);
      lz.open = false;
    } catch (e) {
      const b = e && e.body;
      if (b && b.drop) H().zet(b.drop, null, null);
      H().toast(H().foutTekst(e, 'Lanceren mislukt.'));
    }
    lz.bezig = null; lz.stap = null;
    await laad(true);
    H().rerender();
    if (wb().drop && wb().drop.status === 'gepubliceerd') window.__cmLzPagina(true);
  };

  /** Server-side paginacontrole; herhaalt tot 2 min (ISR). */
  window.__cmLzPagina = async (auto) => {
    if (lz.bezig === 'pagina') return;
    lz.bezig = 'pagina'; teken();
    const tot = Date.now() + 120000;
    try {
      for (;;) {
        const r = await H().post('/api/contentmachine/lanceer', { actie: 'controleer-pagina', id: wb().drop.id });
        if (lz.data && lz.data.lancering) lz.data.lancering.pagina_check = r.check;
        teken();
        if (r.check.ok || Date.now() > tot || !auto) break;
      }
    } catch (e) { H().toast(H().foutTekst(e, 'Paginacontrole mislukt.')); }
    lz.bezig = null; await laad(true);
  };

  window.__cmLzAnnuleer = async () => {
    if (!window.confirm('Het versturen stoppen? Wie al getagd is, krijgt de mail wel.')) return;
    try { await H().post('/api/contentmachine/lanceer', { actie: 'annuleer', id: wb().drop.id }); H().toast('Gestopt.'); }
    catch (e) { H().toast(H().foutTekst(e, 'Stoppen mislukt.')); }
    await laad(true);
  };

  window.__cmLzGhl = async (actie) => {
    lz.bezig = 'ghl'; teken();
    try { const r = await H().post('/api/contentmachine/lanceer', { actie }); lz.ghl = r.rapport; }
    catch (e) { lz.ghl = { fout: H().foutTekst(e, 'GHL controleren mislukt.') }; }
    lz.bezig = null; await laad(true);
  };
  window.__cmLzBewaarInst = async () => {
    const doel = (document.getElementById('cm-lz-doel') || {}).value;
    const verzend = (document.getElementById('cm-lz-verzend') || {}).value;
    try { await H().post('/api/contentmachine/lanceer', { actie: 'instellingen', doelgroep_tag: doel, verzend_tag: verzend }); H().toast('Bewaard.'); await window.__cmLzGhl('ghl-check'); }
    catch (e) { H().toast(H().foutTekst(e, 'Bewaren mislukt.')); }
  };
})();
