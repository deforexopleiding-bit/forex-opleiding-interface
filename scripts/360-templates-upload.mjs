#!/usr/bin/env node
// scripts/360-templates-upload.mjs
//
// Dient de WhatsApp-templates van de LEAD-flows in één keer in bij 360dialog
// (nieuwe WABA van het hoofdnummer +31 6 57210825), met EXACT dezelfde naam,
// taal, tekst en variabele-volgorde als in de database — zodat de bestaande
// CRM-code (meta_param_mapping, templatenamen in flows) ze herkent.
//
// GEBRUIK
//   node --env-file=<pad/naar/.env> scripts/360-templates-upload.mjs --dry-run
//   node --env-file=<pad/naar/.env> scripts/360-templates-upload.mjs --apply
//   Optioneel: --only=naam1,naam2   (alleen deze templates)
//              --json               (dry-run-uitvoer als JSON)
//
// ENV (nooit in code, nooit geprint)
//   SUPABASE_URL (of NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY — alleen LEZEN
//   D360_API_KEY_HOOFDNUMMER — vereist voor --apply; bij --dry-run optioneel
//                              (dan toont de dry-run ook wat al bij 360dialog staat)
//
// WAT HET DOET
//   1. Verzamelt de benodigde namen: de vaste lijst uit PR #1729 + de namen die
//      in de DB staan (onderhoud_sjablonen.meta_template, event_automations
//      steps[].config.template_name, leadsonderhoud_bulk_jobs.template_name).
//   2. Leest per naam de rij uit whatsapp_meta_templates (voorkeur: APPROVED,
//      dan meest recent) en bouwt de components met dezelfde functie als het
//      CRM-indienscherm (api/_lib/wa-template-components.js).
//   3. Kiest een categorie (UTILITY/MARKETING) met reden, en waarschuwt als de
//      opnieuw opgebouwde variabele-volgorde afwijkt van de opgeslagen
//      meta_param_mapping (dan zou de CRM de verkeerde waarden invullen).
//   4. --dry-run: print alles, dient NIETS in, schrijft NIETS.
//      --apply:   POST https://waba-v2.360dialog.io/message_templates per template;
//                 bestaat de naam (+taal) al bij 360dialog → overgeslagen.
//
// Schrijft NOOIT naar de database.

import { createClient } from '@supabase/supabase-js';
import { buildComponents, extractBodyVarIndices } from '../api/_lib/wa-template-components.js';
import { getExampleForKey } from '../api/_lib/template-variables.js';

const D360 = 'https://waba-v2.360dialog.io';

// Vaste lijst (PR #1729, tabel D) — per flow.
export const VASTE_TEMPLATES = Object.freeze({
  afspraken: ['afspraak_bevestiging_v1', 'afspraak_reminder_24u_v1', 'afspraak_reminder_2u_v1',
    'afspraak_reminder_30m_v1', 'afspraak_zoom_5min_v1', 'afspraak_annulering_v1', 'afspraak_verzet_v1'],
  toegang: ['bevestig_toegang_a', 'bevestig_toegang_b', 'reminder_toegang_2u', 'reminder_toegang_24u',
    'reminder_toegang_48u_v3', 'dag6_checkin_a', 'dag6_checkin_b'],
  leadsonderhoud: ['toegang_verlengd_nl'],
  opvolging: ['agenda_doorsturen_v1', 'agenda_herinnering_v1'],
  events: ['events_keuze_link', 'vragenlijst_herinnering_v3', 'event_vragenlijst_definitief'],
  intern: ['interne_nieuwe_afspraak_nl', 'nieuwe_lead'],
});

// Voorbeeldwaarden voor templates zonder opgeslagen voorbeelden/mapping (alleen
// de sample die Meta bij de beoordeling ziet — de tekst zelf verandert niet).
export const VOORBEELD_OVERRIDES = Object.freeze({
  bevestig_toegang_a: ['Jeffrey', 'dinsdag 9 september om 11:30'],
  interne_nieuwe_afspraak_nl: ['Bram Jansen', 'dinsdag 9 september om 11:30', '7-daagse'],
  reminder_toegang_48u_v3: ['Jeffrey'],
});

// ── Categorie ───────────────────────────────────────────────────────────────
// UTILITY = een bericht over iets wat de ontvanger zelf in gang zette of nu
// gebruikt (afspraak, toegang, inschrijving, vragenlijst, lopende cursusweek)
// of een interne melding. MARKETING = zodra de tekst iets AANBIEDT of
// aanspoort tot een vervolgstap die verkoop is (de gratis opstartsessie is een
// salesgesprek), of klassieke promo-woorden bevat. De productnaam
// ("Masterclass") of "gratis toegang" als beschrijving van wat iemand al
// aanvroeg is GEEN promotie. Meta herclassificeert zelf; liever vooraf eerlijk.
const UTILITY_NAMEN = [
  [/^afspraak_/, 'afspraak-bevestiging/-reminder'],
  [/^(bevestig_toegang|reminder_toegang|toegang_verlengd)/, 'toegang tot de aangevraagde cursus'],
  [/^dag6_checkin/, 'check-in binnen de aangevraagde 7-daagse'],
  [/^agenda_(doorsturen|herinnering)/, 'agenda-link na een gesprek'],
  [/^(events_keuze_link|vragenlijst_herinnering|event_vragenlijst)/, 'inschrijving/vragenlijst event'],
  [/^(interne_|nieuwe_lead$)/, 'interne melding aan het team'],
];
const PROMO = [
  [/\bplan\b[^.!?\n]{0,40}\bopstartsessie\b/i, 'spoort aan een opstartsessie (salesgesprek) in te plannen'],
  [/vergeet je gesprek niet in te plannen/i, 'spoort aan een gesprek in te plannen'],
  [/wil je er (echt )?mee verder/i, 'vraagt naar vervolg (verkoop)'],
  [/unieke kans|laatste kans|beperkt aantal|op=op/i, 'urgentie/schaarste'],
  [/korting|aanbieding|cadeau|black ?friday|\b\d+\s?%/i, 'aanbod/korting'],
  [/🎁/u, 'cadeau-emoji'],
];

export function kiesCategorie({ naam, bronnen = [], body = '', dbCategorie = null }) {
  const promo = PROMO.find(([re]) => re.test(String(body || '')));
  if (promo) return { categorie: 'MARKETING', reden: 'tekst ' + promo[1] };
  for (const [re, reden] of UTILITY_NAMEN) {
    if (re.test(naam)) return { categorie: 'UTILITY', reden: reden + ' (transactioneel)' };
  }
  if (bronnen.includes('onderhoud_sjablonen')) return { categorie: 'UTILITY', reden: 'lead-onderhoud: dienstbericht over de lopende toegang/sessie, geen aanbod' };
  if (bronnen.includes('event_automations')) return { categorie: 'UTILITY', reden: 'event-automation: bericht over de eigen inschrijving' };
  const db = String(dbCategorie || '').toUpperCase();
  if (db === 'UTILITY' || db === 'MARKETING') return { categorie: db, reden: 'geen regel van toepassing — categorie uit de database' };
  return { categorie: 'UTILITY', reden: 'geen regel van toepassing — standaard UTILITY' };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function leesArgs(argv) {
  const a = { apply: false, dryRun: true, only: null, json: false };
  for (const x of argv) {
    if (x === '--apply') { a.apply = true; a.dryRun = false; }
    else if (x === '--dry-run') { a.dryRun = true; a.apply = false; }
    else if (x === '--json') a.json = true;
    else if (x.startsWith('--only=')) a.only = new Set(x.slice(7).split(',').map((s) => s.trim()).filter(Boolean));
  }
  return a;
}

/** Beste rij per naam: APPROVED eerst, dan meest recent bijgewerkt. */
export function kiesRij(rijen) {
  const score = (r) => (String(r.status || '').toUpperCase() === 'APPROVED' ? 1 : 0);
  return [...rijen].sort((a, b) => score(b) - score(a)
    || String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0] || null;
}

/** Positie → sleutel; vergelijkt de opnieuw gebouwde body-mapping met de opgeslagen. */
export function mappingAfwijking(opgeslagen, nieuw, aantalVariabelen = 0) {
  const o = opgeslagen && typeof opgeslagen === 'object' ? (opgeslagen.body || null) : null;
  const n = nieuw && typeof nieuw === 'object' ? (nieuw.body || null) : null;
  if (!o && !n) return null;
  // Body stond al positioneel ({{1}} …) in de DB: dan bouwt buildComponents
  // geen nieuwe mapping en blijft de opgeslagen gelden. Consistent zolang de
  // opgeslagen posities precies 1..N zijn.
  if (o && !n) {
    const posities = Object.keys(o).filter((k) => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
    const verwacht = Array.from({ length: aantalVariabelen }, (_, i) => i + 1);
    return JSON.stringify(posities) === JSON.stringify(verwacht) ? null : { opgeslagen: o, nieuw: n };
  }
  if (JSON.stringify(o || {}) === JSON.stringify(n || {})) return null;
  return { opgeslagen: o, nieuw: n };
}

/**
 * Generieke 'voorbeeld'-waarden vervangen door een echt voorbeeld uit de
 * opgeslagen mapping (positie → variabele → AVAILABLE_VARIABLES-voorbeeld).
 * Meta keurt templates met nietszeggende samples sneller af. Muteert components.
 */
export function verbeterVoorbeelden(components, opgeslagenMapping) {
  const body = components.find((c) => c.type === 'BODY');
  const map = opgeslagenMapping && typeof opgeslagenMapping === 'object' ? (opgeslagenMapping.body || null) : null;
  if (!body || !body.example || !Array.isArray(body.example.body_text?.[0])) return 0;
  const arr = body.example.body_text[0];
  let verbeterd = 0;
  arr.forEach((v, i) => {
    if (v !== 'voorbeeld' || !map) return;
    const sleutel = map[String(i + 1)];
    const ex = sleutel ? getExampleForKey(sleutel) : null;
    if (typeof ex === 'string' && ex.trim()) { arr[i] = ex; verbeterd++; }
  });
  return verbeterd;
}

export function bouwPayload(rij, categorie) {
  const { components, meta_param_mapping } = buildComponents(rij);
  const body = components.find((c) => c.type === 'BODY');
  return {
    payload: { name: rij.name, language: rij.language || 'nl', category: categorie, components },
    meta_param_mapping,
    bodyTekst: body ? body.text : '',
    aantalVariabelen: extractBodyVarIndices(body ? body.text : '').length,
    voorbeelden: body && body.example ? body.example.body_text[0] : [],
  };
}

async function d360(pad, init = {}) {
  const key = process.env.D360_API_KEY_HOOFDNUMMER;
  const res = await fetch(D360 + pad, {
    ...init,
    headers: { 'D360-API-KEY': key, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const tekst = await res.text();
  let json = null;
  try { json = tekst ? JSON.parse(tekst) : null; } catch { /* tekst houden */ }
  return { ok: res.ok, status: res.status, json, tekst };
}

/** Bestaande templates bij 360dialog → Set van 'naam|taal'. null als de lijst niet op te halen is. */
async function bestaandeBij360() {
  const set = new Set();
  let pad = '/message_templates?limit=100';
  for (let i = 0; i < 50 && pad; i++) {
    const r = await d360(pad);
    if (!r.ok) {
      console.error(`  ! 360dialog-lijst ophalen mislukt: HTTP ${r.status} ${String(r.tekst || '').slice(0, 200)}`);
      return null;
    }
    for (const t of (r.json?.data || r.json?.waba_templates || [])) set.add(`${t.name}|${t.language}`);
    const na = r.json?.paging?.cursors?.after;
    pad = r.json?.paging?.next && na ? `/message_templates?limit=100&after=${encodeURIComponent(na)}` : null;
  }
  return set;
}

const isBestaatFout = (r) => /already exists|bestaat al|duplicate|2388024/i.test(JSON.stringify(r.json || r.tekst || ''));

// ── Hoofdprogramma ──────────────────────────────────────────────────────────

async function main() {
  const args = leesArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL (of NEXT_PUBLIC_SUPABASE_URL) en SUPABASE_SERVICE_ROLE_KEY zijn nodig (via --env-file).');
    process.exit(2);
  }
  const heeft360 = !!(process.env.D360_API_KEY_HOOFDNUMMER || '').trim();
  if (args.apply && !heeft360) {
    console.error('--apply vereist D360_API_KEY_HOOFDNUMMER in de env.');
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  // 1. Namen + bron(nen).
  const bronnen = new Map();
  const voegToe = (naam, bron) => {
    const n = String(naam || '').trim();
    if (!n) return;
    if (!bronnen.has(n)) bronnen.set(n, new Set());
    bronnen.get(n).add(bron);
  };
  for (const [flow, namen] of Object.entries(VASTE_TEMPLATES)) for (const n of namen) voegToe(n, 'vast:' + flow);

  const fouten = [];
  const { data: sjablonen, error: sErr } = await db.from('onderhoud_sjablonen').select('meta_template').not('meta_template', 'is', null);
  if (sErr) fouten.push('onderhoud_sjablonen: ' + sErr.message);
  for (const r of sjablonen || []) voegToe(r.meta_template, 'onderhoud_sjablonen');

  const { data: autos, error: aErr } = await db.from('event_automations').select('steps');
  if (aErr) fouten.push('event_automations: ' + aErr.message);
  for (const a of autos || []) for (const s of (Array.isArray(a.steps) ? a.steps : [])) voegToe(s?.config?.template_name, 'event_automations');

  const { data: jobs, error: jErr } = await db.from('leadsonderhoud_bulk_jobs').select('template_name').not('template_name', 'is', null);
  if (jErr) fouten.push('leadsonderhoud_bulk_jobs: ' + jErr.message);
  for (const j of jobs || []) voegToe(j.template_name, 'bulk-historie');

  let namen = [...bronnen.keys()].sort();
  if (args.only) namen = namen.filter((n) => args.only.has(n));

  // 2. Rijen uit whatsapp_meta_templates.
  const { data: rijen, error: tErr } = await db.from('whatsapp_meta_templates')
    .select('name, language, category, header_type, header_content, body_text, body_examples, footer_text, buttons, status, meta_param_mapping, business_account_id, updated_at')
    .in('name', namen.length ? namen : ['-']);
  if (tErr) { console.error('whatsapp_meta_templates lezen mislukt:', tErr.message); process.exit(1); }
  const perNaam = new Map();
  for (const r of rijen || []) {
    if (!perNaam.has(r.name)) perNaam.set(r.name, []);
    perNaam.get(r.name).push(r);
  }

  // 3. Wat staat al bij 360dialog? (alleen als er een key is)
  const bestaand = heeft360 ? await bestaandeBij360() : null;
  if (args.apply && bestaand === null) {
    console.error('Kan de bestaande 360dialog-templates niet ophalen — stop (anders geen idempotentie).');
    process.exit(1);
  }

  // 4. Plan per template.
  const plan = [];
  for (const naam of namen) {
    const varianten = perNaam.get(naam) || [];
    const bron = [...bronnen.get(naam)];
    if (!varianten.length) { plan.push({ naam, bron, actie: 'ONTBREEKT', reden: 'niet in whatsapp_meta_templates — handmatig aanmaken' }); continue; }
    const rij = kiesRij(varianten);
    const andereTeksten = new Set(varianten.map((v) => v.body_text)).size > 1;
    const { payload, meta_param_mapping, bodyTekst, aantalVariabelen, voorbeelden } = bouwPayload(rij, 'UTILITY');
    verbeterVoorbeelden(payload.components, rij.meta_param_mapping);
    const bodyComp = payload.components.find((c) => c.type === 'BODY');
    const override = VOORBEELD_OVERRIDES[naam];
    if (override && bodyComp?.example?.body_text?.[0]?.length === override.length) bodyComp.example.body_text[0] = [...override];
    const definitieveVoorbeelden = bodyComp?.example?.body_text?.[0] || voorbeelden;
    const generiek = definitieveVoorbeelden.filter((v) => v === 'voorbeeld').length;
    const cat = kiesCategorie({ naam, bronnen: bron, body: rij.body_text, dbCategorie: rij.category });
    payload.category = cat.categorie;
    const afwijking = mappingAfwijking(rij.meta_param_mapping, meta_param_mapping, aantalVariabelen);
    const sleutel = `${payload.name}|${payload.language}`;
    plan.push({
      naam, bron, taal: payload.language, categorie: cat.categorie, reden: cat.reden,
      db_categorie: rij.category || null, db_status: rij.status || null,
      varianten_in_db: varianten.length, verschillende_teksten: andereTeksten,
      body: bodyTekst, aantal_variabelen: aantalVariabelen, voorbeelden: definitieveVoorbeelden,
      header: payload.components.find((c) => c.type === 'HEADER') || null,
      footer: payload.components.find((c) => c.type === 'FOOTER')?.text || null,
      knoppen: payload.components.find((c) => c.type === 'BUTTONS')?.buttons || null,
      mapping_afwijking: afwijking,
      generieke_voorbeelden: generiek,
      al_bij_360: bestaand ? bestaand.has(sleutel) : null,
      actie: afwijking ? 'GEBLOKKEERD' : (bestaand && bestaand.has(sleutel) ? 'OVERSLAAN' : 'INDIENEN'),
      payload,
    });
  }

  // 5. Uitvoer / indienen.
  if (args.dryRun) {
    if (args.json) { console.log(JSON.stringify({ plan: plan.map(({ payload, ...p }) => ({ ...p, components: payload?.components })), fouten }, null, 2)); return; }
    printDryRun(plan, fouten, heeft360);
    return;
  }
  const uitkomst = { aangemaakt: [], overgeslagen: [], fout: [] };
  for (const p of plan) {
    if (p.actie === 'ONTBREEKT') { uitkomst.fout.push({ naam: p.naam, reden: p.reden }); continue; }
    if (p.actie === 'GEBLOKKEERD') { uitkomst.fout.push({ naam: p.naam, reden: 'variabele-volgorde wijkt af van meta_param_mapping' }); continue; }
    if (p.actie === 'OVERSLAAN') { uitkomst.overgeslagen.push({ naam: p.naam, reden: 'bestaat al bij 360dialog' }); continue; }
    const r = await d360('/message_templates', { method: 'POST', body: JSON.stringify(p.payload) });
    if (r.ok) uitkomst.aangemaakt.push({ naam: p.naam, categorie: p.categorie, status: r.json?.status || null, id: r.json?.id || null });
    else if (isBestaatFout(r)) uitkomst.overgeslagen.push({ naam: p.naam, reden: 'bestaat al (melding van 360dialog)' });
    else uitkomst.fout.push({ naam: p.naam, reden: `HTTP ${r.status}: ${String(r.json?.error?.message || r.json?.meta?.developer_message || r.tekst || '').slice(0, 300)}` });
    await new Promise((ok) => setTimeout(ok, 400));
  }
  console.log(`\nAANGEMAAKT (${uitkomst.aangemaakt.length})`);
  for (const x of uitkomst.aangemaakt) console.log(`  + ${x.naam}  [${x.categorie}]  status=${x.status || '?'}`);
  console.log(`OVERGESLAGEN (${uitkomst.overgeslagen.length})`);
  for (const x of uitkomst.overgeslagen) console.log(`  = ${x.naam}  — ${x.reden}`);
  console.log(`FOUT (${uitkomst.fout.length})`);
  for (const x of uitkomst.fout) console.log(`  ! ${x.naam}  — ${x.reden}`);
  if (uitkomst.fout.length) process.exitCode = 1;
}

function printDryRun(plan, fouten, heeft360) {
  console.log('DRY-RUN — er wordt NIETS ingediend en NIETS geschreven.');
  console.log(heeft360 ? '360dialog-key aanwezig: bestaande templates zijn gecontroleerd.' : 'Geen D360_API_KEY_HOOFDNUMMER: niet gecontroleerd wat al bij 360dialog staat.');
  if (fouten.length) console.log('Leesfouten: ' + fouten.join(' · '));
  const telling = plan.reduce((m, p) => { m[p.actie] = (m[p.actie] || 0) + 1; return m; }, {});
  console.log('Samenvatting: ' + Object.entries(telling).map(([k, v]) => `${k} ${v}`).join(' · ') + ` (totaal ${plan.length})\n`);
  for (const p of plan) {
    console.log('━'.repeat(72));
    console.log(`${p.naam}   →   ${p.actie}`);
    console.log(`  bron:       ${p.bron.join(', ')}`);
    if (p.actie === 'ONTBREEKT') { console.log(`  ${p.reden}`); continue; }
    console.log(`  categorie:  ${p.categorie}   (${p.reden})${p.db_categorie && p.db_categorie !== p.categorie ? `   ⚠ DB had ${p.db_categorie}` : ''}`);
    console.log(`  taal:       ${p.taal}   ·   DB-status: ${p.db_status || '-'}${p.varianten_in_db > 1 ? `   ·   ${p.varianten_in_db} rijen in DB${p.verschillende_teksten ? ' (VERSCHILLENDE teksten — nieuwste APPROVED gekozen)' : ''}` : ''}`);
    console.log(`  variabelen: ${p.aantal_variabelen}${p.voorbeelden?.length ? `   voorbeelden: ${p.voorbeelden.map((v) => JSON.stringify(v)).join(', ')}` : ''}${p.generieke_voorbeelden ? `   ⚠ ${p.generieke_voorbeelden}× generiek "voorbeeld" (Meta kan afkeuren)` : ''}`);
    if (p.header) console.log(`  header:     ${p.header.format}${p.header.text ? ' — ' + p.header.text : ''}`);
    if (p.footer) console.log(`  footer:     ${p.footer}`);
    if (p.knoppen) console.log(`  knoppen:    ${p.knoppen.map((b) => `${b.type}:${b.text}${b.url ? ' → ' + b.url : ''}`).join(' | ')}`);
    if (p.mapping_afwijking) console.log(`  ⚠ VARIABELE-VOLGORDE WIJKT AF van meta_param_mapping: opgeslagen=${JSON.stringify(p.mapping_afwijking.opgeslagen)} nieuw=${JSON.stringify(p.mapping_afwijking.nieuw)}`);
    console.log('  body:');
    for (const regel of String(p.body).split('\n')) console.log('    │ ' + regel);
  }
}

// Alleen draaien als script (niet bij import in tests).
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}` || process.argv[1]?.endsWith('360-templates-upload.mjs')) {
  main().catch((e) => { console.error('Fout:', e?.message || e); process.exit(1); });
}
