// api/_lib/opvolging-leads-logboek.js
//
// LEADS BELLEN — HET LOGBOEK VAN ÉÉN DAG.
//
// Wat er die dag met de leadkaarten gebeurde, in volgorde: elke call (met duur
// en uitkomst), elk bericht, elke doorgestuurde agenda, elke inplanning,
// terugbelafspraak en afronding. Plus de tellers bovenaan. Zelfde idee als
// 'Alle gebeurtenissen' in het Rapport, maar voor Leads bellen.
//
// PUUR: de aanroeper leest, hier wordt alleen geordend en geteld.
//
// Woorden zoals in het Rapport: een POGING is gebeld hebben; OPGENOMEN is de
// lijn kwam tot stand (dat kan een voicemail zijn, tenzij Dave 'voicemail'
// aanklikte); een GESPREK is opgenomen én door Dave niet als voicemail of geen
// gehoor gemeld.

import { classificeerResultaat, GESPROKEN, NIET_OPGENOMEN } from './opvolging-poging-telling.js';
import { dagInZone, logVan, belRondes, UITKOMSTEN, AFROND_CATEGORIEEN } from './opvolging-leads-pot.js';

const ZONE = 'Europe/Amsterdam';
const uurVan = (ms) => new Intl.DateTimeFormat('nl-NL', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

function regelVoorPoging(p) {
  const r = String(p.resultaat || '');
  const inkomend = p.richting === 'in';
  switch (p.soort) {
    case 'call': {
      if (/^afgebroken/i.test(r)) return null;  // wij hingen op vóór het overging: geen poging
      const k = classificeerResultaat(r);
      const vm = /voicemail/i.test(r);
      return {
        soort: 'call',
        icoon: k === GESPROKEN ? '📞' : '☎',
        tekst: k === GESPROKEN ? 'Gebeld — opgenomen' : vm ? 'Gebeld — voicemail' : k === NIET_OPGENOMEN ? 'Gebeld — geen gehoor' : 'Gebeld',
        klasse: k === GESPROKEN ? 'opgenomen' : vm ? 'voicemail' : 'geen_gehoor',
        duur_sec: Number.isFinite(p.duur_sec) ? p.duur_sec : null,
        zelf_gemeld: p.automatisch === false,
      };
    }
    case 'whatsapp':
    case 'spraakbericht': {
      if (!inkomend && /^WhatsApp (afgeleverd|gelezen)/i.test(r)) return null;  // statusregels
      const wat = p.soort === 'spraakbericht' ? 'Spraakbericht' : 'WhatsApp';
      return { soort: inkomend ? 'wa_in' : 'wa_uit', icoon: inkomend ? '💬' : '✉', tekst: inkomend ? wat + ' ontvangen' : wat + ' verstuurd' };
    }
    case 'agenda_doorgestuurd': return { soort: 'doorgestuurd', icoon: '📨', tekst: 'Agenda doorgestuurd' };
    case 'agenda_herinnering': return { soort: 'herinnering', icoon: '🔔', tekst: 'Herinnering met agendalink' };
    case 'ingepland': return { soort: 'ingepland', icoon: '✅', tekst: r && /zelf/i.test(r) ? 'Plande zelf in via de agenda' : 'Zoomcall ingepland' };
    default: return null;
  }
}

function regelVoorLog(e) {
  if (e.soort === 'terugbel') return { soort: 'terugbel', icoon: '⏰', tekst: e.tekst || 'Terugbelafspraak' };
  if (e.soort === 'opnieuw') return { soort: 'opnieuw', icoon: '↻', tekst: e.tekst || 'Opnieuw proberen' };
  if (e.soort === 'afgerond') return null;  // komt uit gearchiveerd_at, met categorie
  if (UITKOMSTEN[e.soort]) return { soort: 'uitkomst', icoon: '✎', tekst: 'Uitkomst: ' + (e.tekst || UITKOMSTEN[e.soort]) };
  return null;
}

/**
 * @param {object} p
 * @param {object[]} p.kaarten        leadkaarten (elke status)
 * @param {Map<string,object[]>} p.histPerKaart taak_id → volledige historie
 * @param {string} p.dag              YYYY-MM-DD (Amsterdam)
 * @returns {{ dag, kpi, rijen, per_lead }}
 */
export function bouwLogboek({ kaarten = [], histPerKaart = new Map(), dag }) {
  const rijen = [];
  const perLead = new Map();
  const kpi = {
    pogingen: 0, leads_gebeld: 0, rondes: 0, opgenomen: 0, voicemail: 0, geen_gehoor: 0, belseconden: 0,
    wa_uit: 0, wa_in: 0, doorgestuurd: 0, ingepland: 0, terugbel: 0, afgerond: 0, nieuw_aangeraakt: 0,
  };
  const opDag = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) && dagInZone(t) === dag; };

  for (const k of kaarten) {
    const naam = k.naam || '(zonder naam)';
    const eigen = [];
    const hist = histPerKaart.get(k.id) || [];
    const vanDag = hist.filter((p) => p && opDag(p.tijdstip));
    for (const p of vanDag) {
      const r = regelVoorPoging(p);
      if (!r) continue;
      eigen.push({ ...r, ms: Date.parse(p.tijdstip) });
    }
    for (const e of logVan(k)) {
      if (!opDag(e.op)) continue;
      const r = regelVoorLog(e);
      if (r) eigen.push({ ...r, ms: Date.parse(e.op) });
    }
    if (k.status === 'gearchiveerd' && opDag(k.gearchiveerd_at)) {
      eigen.push({ soort: 'afgerond', icoon: '🗂', ms: Date.parse(k.gearchiveerd_at),
        tekst: 'Afgerond: ' + (AFROND_CATEGORIEEN[k.archief_categorie] || k.archief_categorie || 'zonder categorie') +
          (k.archief_reden ? ' — ' + String(k.archief_reden).slice(0, 140) : '') });
    }
    if (opDag(k.created_at)) kpi.nieuw_aangeraakt += 1;
    if (!eigen.length) continue;

    const calls = eigen.filter((r) => r.soort === 'call');
    kpi.pogingen += calls.length;
    if (calls.length) kpi.leads_gebeld += 1;
    kpi.rondes += belRondes(vanDag, 0).length;
    for (const c of calls) {
      if (c.klasse === 'opgenomen') kpi.opgenomen += 1;
      else if (c.klasse === 'voicemail') kpi.voicemail += 1;
      else kpi.geen_gehoor += 1;
      if (c.duur_sec) kpi.belseconden += c.duur_sec;
    }
    for (const r of eigen) {
      if (r.soort === 'wa_uit') kpi.wa_uit += 1;
      else if (r.soort === 'wa_in') kpi.wa_in += 1;
      else if (r.soort === 'doorgestuurd') kpi.doorgestuurd += 1;
      else if (r.soort === 'ingepland') kpi.ingepland += 1;
      else if (r.soort === 'terugbel') kpi.terugbel += 1;
      else if (r.soort === 'afgerond') kpi.afgerond += 1;
      rijen.push({ tijd: uurVan(r.ms), ms: r.ms, taak_id: k.id, naam, soort: r.soort, icoon: r.icoon, tekst: r.tekst,
        duur_sec: r.duur_sec == null ? null : r.duur_sec, zelf_gemeld: !!r.zelf_gemeld });
    }
    perLead.set(k.id, {
      taak_id: k.id, naam, calls: calls.length,
      opgenomen: calls.filter((c) => c.klasse === 'opgenomen').length,
      laatste: eigen.sort((a, b) => a.ms - b.ms)[eigen.length - 1].tekst,
      status: k.status,
    });
  }
  rijen.sort((a, b) => b.ms - a.ms);
  for (const r of rijen) delete r.ms;
  return {
    dag, kpi,
    rijen,
    per_lead: [...perLead.values()].sort((a, b) => b.calls - a.calls || a.naam.localeCompare(b.naam)),
  };
}
