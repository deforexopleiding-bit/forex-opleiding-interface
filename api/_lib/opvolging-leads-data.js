// api/_lib/opvolging-leads-data.js
//
// Het LEZEN achter 'Leads bellen'. Alle beslissingen staan in
// opvolging-leads-pot.js (puur, getest); hier alleen de queries die de ruwe
// rijen ophalen, in zo weinig rondjes als kan.
//
// Een leesfout van een HULPBRON (trial_warmte, lms_gebruikers, WA-regels) is
// geen dood scherm: de pot werkt dan zonder dat stuk en er komt een melding bij.
// Een leesfout van de KERN (leads, leadkaarten, afspraken, daglijst) gooit wel:
// zonder die lezing is de uitsluiting niet te maken, en een pot die mensen toont
// die eigenlijk een call hebben is erger dan geen pot.

import { alleenDaglijst, alleenLeadlijst } from './opvolging-lijst.js';
import {
  POT_MAX_DAGEN, normaliseerTrial, stelPottenSamen, staart9, telefoonVan,
  beoordeelCalls, afspraakHoortBij, berekenWarmte, dagInZone,
  dagstatistiek, weekstatistiek,
} from './opvolging-leads-pot.js';
import {
  leesLijsten, splitsKaarten, aparteStaarten, lijstWeergave, lijstKop, LIJST_STATUS_ACTIEF,
} from './opvolging-leads-lijsten.js';
import { telPogingen } from './opvolging-poging-telling.js';
import { haalWaRegelsVanaf, volledigeHistorie } from './opvolging-call-wa.js';
import { WACHT_UREN } from './opvolging-doorrol.js';
import { leesLabStandPerEmail, labTrialAlsWarmte } from './lab-trial-stand.js';

const DAG_MS = 86400000;
const AFSPRAKEN_TERUG_DAGEN = 365;
const WA_TERUG_DAGEN = 60;
const BLOK = 100;

const isoDagUtc = (d) => new Date(d).toISOString().slice(0, 10);

/** .in() in blokken, zodat de URL niet te lang wordt. */
async function inBlokken(ids, maak) {
  const uit = [];
  const lijst = [...new Set((ids || []).filter(Boolean))];
  for (let i = 0; i < lijst.length; i += BLOK) {
    const { data, error } = await maak(lijst.slice(i, i + BLOK));
    if (error) throw new Error(error.message);
    uit.push(...(data || []));
  }
  return uit;
}

/** De kandidaat-leads: proefleads van de laatste POT_MAX_DAGEN dagen. */
export async function leesKandidaten(db, nuMs) {
  const vanIso = new Date(nuMs - POT_MAX_DAGEN * DAG_MS).toISOString();
  const { data, error } = await db
    .from('leads')
    .select('*')
    .is('verwijderd_op', null)
    .gte('aangemaakt', vanIso)
    .or('traject.ilike.minicursus,traject.ilike.7-daagse,bron.ilike.kennismakingscursus*,bron.ilike.7-daagse*')
    .order('aangemaakt', { ascending: false })
    .limit(3000);
  if (error) throw new Error('leads lezen: ' + error.message);
  return data || [];
}

/** Alle leadkaarten, elke status. Klein: ontstaan pas bij actie. */
export async function leesLeadkaarten(db) {
  const { data, error } = await alleenLeadlijst(db.from('opvolging_taken').select('*'))
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) throw new Error('leadkaarten lezen: ' + error.message);
  return data || [];
}

/** Telefoons van wat er op Daves daglijst loopt. */
async function leesDaglijstTelefoons(db) {
  const { data, error } = await alleenDaglijst(db.from('opvolging_taken').select('telefoon'))
    .in('status', ['open', 'wacht_inplanning'])
    .not('telefoon', 'is', null)
    .limit(5000);
  if (error) throw new Error('daglijst lezen: ' + error.message);
  return (data || []).map((t) => t.telefoon);
}

/** Afspraken in het venster. Zonder de kolom uitkomst: één keer opnieuw zonder. */
async function leesAfspraken(db, nuMs, meldingen) {
  const vanIso = new Date(nuMs - AFSPRAKEN_TERUG_DAGEN * DAG_MS).toISOString();
  const basis = 'id, lead_phone, lead_email, status, scheduled_at, is_test, created_at';
  const eerst = await db.from('follow_up_appointments').select(basis + ', uitkomst')
    .gte('scheduled_at', vanIso).limit(10000);
  if (!eerst.error) return eerst.data || [];
  const tweede = await db.from('follow_up_appointments').select(basis)
    .gte('scheduled_at', vanIso).limit(10000);
  if (tweede.error) throw new Error('afspraken lezen: ' + tweede.error.message);
  meldingen.push('De uitkomst van eerdere calls was niet te lezen; alleen de status telt nu mee.');
  return tweede.data || [];
}

/**
 * LMS-gedrag per lead: trial_warmte op lead_id, en anders op e-mail
 * (lower(trial_warmte.email) = lower(leads.email)). Gemeten 2 okt: via lead_id
 * vind je 77 van de 330, via e-mail nog ±120.
 */
async function leesTrials(db, leads, meldingen) {
  const perLead = new Map();
  try {
    const ids = leads.map((l) => l.id);
    const opLead = await inBlokken(ids, (blok) => db.from('trial_warmte').select('*').in('lead_id', blok));
    for (const r of opLead) if (r.lead_id && !perLead.has(r.lead_id)) perLead.set(r.lead_id, normaliseerTrial(r));

    const leadPerMail = new Map();
    for (const l of leads) {
      if (perLead.has(l.id) || !l.email) continue;
      leadPerMail.set(String(l.email).trim().toLowerCase(), l.id);
    }
    if (leadPerMail.size) {
      // Zowel de schrijfwijze uit leads als de kleine letters: .in() is
      // hoofdlettergevoelig, de vergelijking hieronder niet.
      const varianten = new Set();
      for (const l of leads) if (l.email && leadPerMail.has(String(l.email).trim().toLowerCase())) {
        varianten.add(String(l.email).trim());
        varianten.add(String(l.email).trim().toLowerCase());
      }
      const opMail = await inBlokken([...varianten], (blok) => db.from('trial_warmte').select('*').in('email', blok));
      for (const r of opMail) {
        const lid = leadPerMail.get(String(r.email || '').trim().toLowerCase());
        if (lid && !perLead.has(lid)) perLead.set(lid, normaliseerTrial(r));
      }
    }
  } catch (e) {
    console.warn('[opvolging-leads] trial lezen (soft):', e?.message || e);
    meldingen.push('Het LMS-gedrag was niet te lezen; de warmte telt nu alleen aanmelding, kwalificatie en eerdere calls.');
  }
  // Sinds 26 okt 2026 krijgen nieuwe proefleads hun trial in het ECHTE LMS
  // (lab-lead), niet meer in lms_gebruikers/trial_warmte. Wie daar niet stond:
  // de stand uit dfo-lms, in dezelfde vorm (lab-trial-stand.js).
  try {
    const zonder = leads.filter((l) => !perLead.has(l.id) && l.email);
    if (zonder.length) {
      const stand = await leesLabStandPerEmail(zonder.map((l) => l.email));
      for (const l of zonder) {
        const t = labTrialAlsWarmte(stand.get(String(l.email).trim().toLowerCase()));
        if (t) perLead.set(l.id, t);
      }
    }
  } catch (e) {
    console.warn('[opvolging-leads] lab-trials lezen (soft):', e?.message || e);
    meldingen.push('De trials in het nieuwe LMS waren niet te lezen; hun warmte telt nu alleen aanmelding, kwalificatie en eerdere calls.');
  }
  return perLead;
}

/** Pogingen + losse WA-regels per kaart, geteld zoals overal in de module. */
export async function leesTellingen(db, kaarten, nuMs, meldingen) {
  const ids = kaarten.map((k) => k.id);
  const pog = await inBlokken(ids, (blok) => db.from('opvolging_pogingen').select('*')
    .in('taak_id', blok).order('tijdstip', { ascending: true }));
  const perTaak = new Map();
  for (const p of pog) {
    if (!perTaak.has(p.taak_id)) perTaak.set(p.taak_id, []);
    perTaak.get(p.taak_id).push(p);
  }
  for (const lijst of perTaak.values()) lijst.sort((a, b) => (Date.parse(a.tijdstip) || 0) - (Date.parse(b.tijdstip) || 0));

  const wa = await haalWaRegelsVanaf(db, new Date(nuMs - WA_TERUG_DAGEN * DAG_MS).toISOString());
  if (wa.fout) meldingen.push('De WhatsApp-berichten waren niet te lezen; berichten van vóór een kaart tellen nu niet mee.');
  const vandaag = isoDagUtc(nuMs);
  const tel = new Map();
  for (const k of kaarten) {
    tel.set(k.id, telPogingen(volledigeHistorie(perTaak.get(k.id) || [], wa.regels, k), vandaag, isoDagUtc));
  }
  return tel;
}

/** De aparte lijsten; een leesfout is een melding, geen dood scherm. */
async function leesLijstenZacht(db, meldingen) {
  try {
    const r = await leesLijsten(db);
    if (r.fout) {
      console.warn('[opvolging-leads] aparte lijsten lezen (soft):', r.fout);
      meldingen.push('De aparte lijsten waren niet te lezen; hun leads staan nu nergens (ook niet in de algemene pot).');
    }
    return r;
  } catch (e) {
    console.warn('[opvolging-leads] aparte lijsten lezen (soft):', e?.message || e);
    meldingen.push('De aparte lijsten waren niet te lezen; hun leads staan nu nergens (ook niet in de algemene pot).');
    return { beschikbaar: true, lijsten: [], fout: String(e?.message || e) };
  }
}

/**
 * Alles voor het scherm in één keer.
 *
 * De kaarten van een APARTE LIJST (bron_ref.aparte_lijst_id) tellen niet mee
 * in de algemene potten, de belrij of de badge: per lijst rekent
 * stelPottenSamen() apart. De dag- en weekstatistiek blijven over ALLE
 * leadkaarten gaan (dat is wat er gebeld werd, zoals voorheen).
 *
 * @param {object} [opties]
 * @param {string} [opties.lijstId] ook de volledige weergave van deze lijst
 * @returns {Promise<object>} uitvoer van stelPottenSamen() + meldingen + lijsten
 */
export async function laadLeadsOverzicht(db, nuMs = Date.now(), { lijstId = null } = {}) {
  const meldingen = [];
  const [leads, kaarten, daglijstTelefoons, lijstInfo] = await Promise.all([
    leesKandidaten(db, nuMs),
    leesLeadkaarten(db),
    leesDaglijstTelefoons(db),
    leesLijstenZacht(db, meldingen),
  ]);
  const afspraken = await leesAfspraken(db, nuMs, meldingen);

  // Leads achter kaarten die buiten het venster van 60 dagen vallen.
  const bekend = new Set(leads.map((l) => l.id));
  const ontbrekend = [...new Set(kaarten.map((k) => k.lead_id).filter((id) => id && !bekend.has(id)))];
  let extraLeads = [];
  if (ontbrekend.length) {
    try {
      extraLeads = await inBlokken(ontbrekend, (blok) => db.from('leads').select('*').in('id', blok));
    } catch (e) {
      console.warn('[opvolging-leads] extra leads (soft):', e?.message || e);
    }
  }

  const trialPerLead = await leesTrials(db, [...leads, ...extraLeads], meldingen);
  const telPerKaart = await leesTellingen(db, kaarten, nuMs, meldingen);

  const { algemeen, perLijst } = splitsKaarten(kaarten);
  const actieveIds = lijstInfo.lijsten.filter((l) => l.status === LIJST_STATUS_ACTIEF).map((l) => l.id);

  const uit = stelPottenSamen({
    leads, extraLeads, kaarten: algemeen, daglijstTelefoons, afspraken,
    trialPerLead, telPerKaart, nuMs, wachtUren: WACHT_UREN,
    aparteStaarten: aparteStaarten(perLijst, actieveIds),
  });
  // Zoals vóór de aparte lijsten: wat er vandaag/deze week gebeurde, overal.
  uit.dag = dagstatistiek(kaarten, telPerKaart, uit.vandaag);
  uit.week = weekstatistiek(kaarten, telPerKaart, nuMs);

  const perLijstUit = (l) => {
    const eigen = perLijst.get(l.id) || [];
    const o = stelPottenSamen({ kaarten: eigen, telPerKaart, nuMs, wachtUren: WACHT_UREN, zonderVenster: true });
    return { eigen, o };
  };
  const lijsten = [];
  const lijstenArchief = [];
  let lijstWeer = null;
  for (const l of lijstInfo.lijsten) {
    const actief = l.status === LIJST_STATUS_ACTIEF;
    // Een gearchiveerde lijst hoeft geen belrij; alleen de telling.
    const { eigen, o } = actief || l.id === lijstId ? perLijstUit(l) : { eigen: perLijst.get(l.id) || [], o: null };
    (actief ? lijsten : lijstenArchief).push(lijstKop(l, eigen, o ? o.belrij : null));
    if (l.id === lijstId) lijstWeer = lijstWeergave({ lijst: l, uit: o, kaarten: eigen });
  }
  lijstenArchief.sort((a, b) => String(b.gearchiveerd_at || '').localeCompare(String(a.gearchiveerd_at || '')));

  return {
    ...uit, meldingen, kandidaten: leads.length,
    aparte_lijsten: { beschikbaar: lijstInfo.beschikbaar, actief: lijsten, archief: lijstenArchief },
    lijst_weergave: lijstWeer,
  };
}

/**
 * De warmte van één lead op dit moment — voor de notitie op een nieuwe kaart.
 * Fail-soft: lukt het lezen niet, dan een kaart zonder warmteregel.
 */
export async function warmteVoorLead(db, lead, nuMs = Date.now()) {
  const meldingen = [];
  try {
    const afspraken = await leesAfspraken(db, nuMs, meldingen);
    const trialPerLead = await leesTrials(db, [lead], meldingen);
    const s = staart9(telefoonVan(lead));
    const calls = beoordeelCalls(afspraken.filter((a) => afspraakHoortBij({ staart: s, email: lead.email }, a)), nuMs);
    const trial = trialPerLead.get(lead.id) || null;
    return berekenWarmte({ lead, trial, calls, vandaag: dagInZone(nuMs) });
  } catch (e) {
    console.warn('[opvolging-leads] warmte voor lead (soft):', e?.message || e);
    return null;
  }
}
