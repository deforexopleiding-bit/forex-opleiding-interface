// api/_lib/weekeditie-lancering.js
//
// Contentmachine 2.0, fase 5 — "Keur goed en lanceer" (bouwopdracht §5).
// Eén flow (super_admin): goedkeuren → pagina publiceren + server-side controle
// (200 + juiste titel, ISR max 2 min) → beelden in Storage → nieuwsbrief via GHL:
// vaste template bijwerken, onderwerp in de custom value, en de verzendtag op de
// nieuwsbrieflijst in batches (nu of ingepland; cron api/cron-weekeditie-lancering.js).
//
// VEILIGHEID
// - Zonder geslaagde testmail van DEZE versie van de drop geen lancering.
// - Elk contact wordt eerst geclaimd in weekeditie_lancering_contacten (PK lancering+contact)
//   en pas dan getagd: een herstart of dubbele cron tagt nooit iemand twee keer
//   (de workflow verwijdert de tag na het versturen; opnieuw taggen = opnieuw mailen).
// - DND / uitgeschreven / geen e-mail / had de tag al → overgeslagen (met reden), geteld.
// - Wijzigt de drop na het inplannen (andere versie), dan gaat de lancering niet door.
//
// Tabellen (migratie docs/sql-migrations/2026-10-26-weekeditie-lancering.sql):
// weekeditie_testmails, weekeditie_lanceringen, weekeditie_lancering_contacten.
// Instellingen: app_settings 'contentmachine_weekeditie_ghl'.

import { STANDAARD, zoekContactenMetTag, zetTag, magTaggen, TAG_PAUZE_MS } from './ghl-weekeditie.js';
import { isSocialV2 } from './contentmachine-social.js';
import { isTeaser } from './nieuwsbrief-render.js';
import { TRAINING_ORIGIN } from './contentmachine-social.js';

export const INSTELLING_KEY = 'contentmachine_weekeditie_ghl';
export const SITE_ORIGIN = 'https://www.deforexopleiding.nl';
export const PAGINA_WACHT_MS = 120000;
const LANCERING_KOLOMMEN = 'id,drop_id,drop_versie,status,modus,ingepland_op,onderwerp,onderwerp_index,doelgroep_tag,verzend_tag,template_id,totaal,getagd,overgeslagen,mislukt,cursor,pagina_check,fout,gestart_op,klaar_op,aangemaakt_door,aangemaakt_op,gewijzigd_op';
export { LANCERING_KOLOMMEN };

const wacht = (ms) => new Promise((ok) => setTimeout(ok, ms));

// ── instellingen ────────────────────────────────────────────────────────────
export async function leesInstellingen(db) {
  const { data, error } = await db.from('app_settings').select('key,value').eq('key', INSTELLING_KEY).maybeSingle();
  if (error) throw error;
  return { ...STANDAARD, ...((data && data.value) || {}) };
}
export async function bewaarInstellingen(db, patch, userId) {
  const huidig = await leesInstellingen(db);
  const value = { ...huidig, ...patch };
  const { error } = await db.from('app_settings').upsert({ key: INSTELLING_KEY, value, updated_at: new Date().toISOString(), updated_by_user_id: userId || null }, { onConflict: 'key' });
  if (error) throw error;
  return value;
}
/** Tagnaam controleren (GHL-tags: letters, cijfers, spatie, - _). */
export const geldigeTag = (t) => typeof t === 'string' && /^[\p{L}\p{N} _-]{2,60}$/u.test(t.trim());

// ── kanalen en beelden ──────────────────────────────────────────────────────
export function kanalenVan(drop) {
  const k = (drop && drop.input && Array.isArray(drop.input.kanalen) && drop.input.kanalen.length) ? drop.input.kanalen : ['pagina', 'nieuwsbrief', 'stories', 'post', 'linkedin'];
  return new Set(k);
}

/** Welke beelden er in Storage moeten staan (namen zoals SOCIAL_NAAM_RE). */
export function verwachteBeelden(output, kanalen = null) {
  const o = output || {};
  const k = kanalen || new Set(['pagina', 'nieuwsbrief', 'stories', 'post', 'linkedin']);
  const uit = [];
  if (k.has('stories')) (o.stories || []).forEach((_, i) => uit.push(`story-${i + 1}`));
  if (k.has('post')) { ((o.post && o.post.slides) || []).forEach((_, i) => uit.push(`post-${i + 1}`)); if (o.vierkant) uit.push('vierkant'); }
  if (k.has('linkedin') && o.linkedin) uit.push('linkedin');
  if (k.has('pagina')) uit.push('og');
  if (k.has('nieuwsbrief') && isTeaser(o.nieuwsbrief)) uit.push('nieuwsbrief');
  return uit;
}
export function beeldenCheck(output, kanalen) {
  const b = (output && output.social && output.social.bestanden) || {};
  const nodig = verwachteBeelden(output, kanalen);
  const ontbreekt = nodig.filter((n) => !b[n] || !b[n].url);
  return { ok: ontbreekt.length === 0, nodig: nodig.length, ontbreekt, opgeslagen_op: (output && output.social && output.social.opgeslagen_op) || null };
}

// ── pagina-controle ─────────────────────────────────────────────────────────
const ENTITEITEN = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function ontsnap(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENTITEITEN[e.toLowerCase()] != null ? ENTITEITEN[e.toLowerCase()] : m;
  });
}
export function titelUit(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return m ? ontsnap(m[1]).replace(/\s+/g, ' ').trim() : null;
}
/** De titel die de website toont: seo_titel van de pagina. */
export function verwachteTitel(output) {
  const p = (output && output.pagina) || {};
  return String(p.seo_titel || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim() || null;
}

/** Eén keer de pagina ophalen. → { ok, url, status, titel, titel_ok, fout } */
export async function haalPagina(url, verwacht, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(url + (url.includes('?') ? '&' : '?') + 'controle=' + Date.now(), { headers: { 'User-Agent': 'DFO-Contentmachine-controle/1.0', Accept: 'text/html' }, redirect: 'follow' });
    const html = await r.text();
    const titel = titelUit(html);
    const titelOk = !verwacht || (!!titel && titel === verwacht);
    return { ok: r.status === 200 && titelOk, url, status: r.status, titel, titel_ok: titelOk, fout: r.status !== 200 ? `HTTP ${r.status}` : (!titelOk ? `titel is "${titel || '—'}", verwacht "${verwacht}"` : null) };
  } catch (e) {
    return { ok: false, url, status: null, titel: null, titel_ok: false, fout: e?.message || String(e) };
  }
}

/**
 * Pagina-controle: training.deforexopleiding.nl/<slug> (de echte link) moet 200 geven met de
 * juiste titel. Lukt dat (nog) niet door ISR, dan opnieuw tot `maxMs`. Is het subdomein niet
 * bereikbaar (DNS), dan ook www.deforexopleiding.nl/training/<slug> proberen en dat melden.
 */
export async function paginaCheck({ slug, verwacht, maxMs = 25000, interval = 5000, fetchImpl = fetch, slaap = wacht }) {
  const live = `${TRAINING_ORIGIN}/${slug}`;
  const site = `${SITE_ORIGIN}/training/${slug}`;
  const start = Date.now();
  let laatste = null;
  for (let poging = 1; ; poging++) {
    laatste = await haalPagina(live, verwacht, fetchImpl);
    if (laatste.ok) return { ...laatste, pogingen: poging, op: new Date().toISOString() };
    if (laatste.status == null) {
      const s = await haalPagina(site, verwacht, fetchImpl);
      if (s.ok) return { ...s, pogingen: poging, via: 'site', live_fout: laatste.fout, op: new Date().toISOString() };
      laatste = { ...laatste, site: s };
    }
    if (Date.now() - start + interval > maxMs) return { ...laatste, pogingen: poging, op: new Date().toISOString() };
    await slaap(interval);
  }
}

// ── lezen ───────────────────────────────────────────────────────────────────
export async function laatsteTest(db, drop) {
  const { data, error } = await db.from('weekeditie_testmails').select('id,drop_versie,onderwerp_index,email,verstuurd_op')
    .eq('drop_id', drop.id).eq('drop_versie', drop.versie).order('verstuurd_op', { ascending: false }).limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}
export async function laatsteLancering(db, dropId) {
  const { data, error } = await db.from('weekeditie_lanceringen').select(LANCERING_KOLOMMEN)
    .eq('drop_id', dropId).order('aangemaakt_op', { ascending: false }).limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

/**
 * Wat er moet kloppen vóór de lancering (het bevestigingsscherm). → [{ sleutel, ok, tekst, blokkeert }]
 * problemen = grens-/editieproblemen van de drop (zoals bij goedkeuren).
 */
export function voorwaarden({ drop, problemen = [], test = null, cfg = { ok: false, ontbreekt: [] }, instellingen = STANDAARD, beelden, kanalen, rol }) {
  const uit = [];
  const add = (sleutel, ok, tekst, blokkeert = true) => uit.push({ sleutel, ok: !!ok, tekst, blokkeert: !ok && blokkeert });
  add('rol', rol === 'super_admin', rol === 'super_admin' ? 'Je bent super_admin.' : 'Lanceren kan enkel een super_admin.');
  add('status', ['gegenereerd', 'goedgekeurd', 'gepubliceerd'].includes(drop.status) && !!drop.output, `Status: ${drop.status}.`);
  add('grenzen', problemen.length === 0, problemen.length ? `Eerst aanpassen: ${problemen.slice(0, 2).map((x) => `${x.pad} (${x.regel})`).join('; ')}` : 'Teksten, blokken en cijfers zijn in orde.');
  add('beelden', beelden.ok, beelden.ok ? `Alle ${beelden.nodig} beelden staan in Storage.` : `Nog niet in Storage: ${beelden.ontbreekt.join(', ')} (wordt bij het lanceren eerst gerenderd en bewaard).`, false);
  if (kanalen.has('nieuwsbrief')) {
    add('ghl', cfg.ok, cfg.ok ? 'GHL is gekoppeld.' : `GHL niet gekoppeld (ontbreekt: ${cfg.ontbreekt.join(', ')}).`);
    add('template', !!instellingen.template_id, instellingen.template_id ? `Vaste template "${instellingen.template_naam}" (${instellingen.template_id}).` : 'De vaste GHL-template is nog niet ingesteld (knop "GHL controleren / instellen").');
    add('test', !!test, test ? `Testmail van deze versie (v${drop.versie}) verstuurd naar ${test.email}.` : `Stuur eerst een testmail van deze versie (v${drop.versie}) naar jezelf.`);
  }
  return uit;
}

// ── taggen ──────────────────────────────────────────────────────────────────
/**
 * Tag de doelgroep in batches tot `deadline` (ms-tijdstip, of een functie die true geeft
 * als de tijd op is). Hervatbaar: cursor + tellers in de lancering, elk contact geclaimd
 * vóór het taggen. → bijgewerkte lancering
 */
export async function verwerkLancering(db, cfg, lancering, { deadline, fetchImpl = fetch, pauze = TAG_PAUZE_MS, slaap = wacht } = {}) {
  const op = typeof deadline === 'function' ? deadline : () => Date.now() > deadline;
  let l = { ...lancering };
  const nu = () => new Date().toISOString();
  const bewaar = async (patch) => {
    const { data, error } = await db.from('weekeditie_lanceringen').update({ ...patch, gewijzigd_op: nu() }).eq('id', l.id).select(LANCERING_KOLOMMEN).single();
    if (error) throw error;
    l = data;
    return l;
  };
  if (l.status === 'ingepland') await bewaar({ status: 'taggen', gestart_op: l.gestart_op || nu() });
  if (l.status !== 'taggen') return l;

  let tel = { getagd: l.getagd || 0, overgeslagen: l.overgeslagen || 0, mislukt: l.mislukt || 0 };
  for (;;) {
    if (op()) return bewaar({ ...tel });
    const pagina = await zoekContactenMetTag(cfg, { tag: l.doelgroep_tag, searchAfter: l.cursor || null }, fetchImpl);
    if (l.totaal == null && pagina.totaal != null) await bewaar({ totaal: pagina.totaal });
    let afgebroken = false;
    for (const c of pagina.contacten) {
      if (op()) { afgebroken = true; break; }
      const m = magTaggen(c, { verzendTag: l.verzend_tag });
      const claim = await db.from('weekeditie_lancering_contacten').insert({ lancering_id: l.id, contact_id: String(c.id || ''), status: m.ok ? 'bezig' : 'overgeslagen', reden: m.ok ? null : m.reden });
      if (claim.error) {
        if (String(claim.error.code) === '23505') continue; // al verwerkt in een vorige run
        throw claim.error;
      }
      if (!m.ok) { tel.overgeslagen++; continue; }
      try {
        await zetTag(cfg, c.id, l.verzend_tag, fetchImpl);
        tel.getagd++;
        const { error } = await db.from('weekeditie_lancering_contacten').update({ status: 'getagd', op: nu() }).eq('lancering_id', l.id).eq('contact_id', String(c.id));
        if (error) console.error('[weekeditie-lancering] status getagd bewaren mislukt:', error.message);
      } catch (e) {
        tel.mislukt++;
        console.error('[weekeditie-lancering] tag zetten mislukt:', c.id, e?.message);
        const { error } = await db.from('weekeditie_lancering_contacten').update({ status: 'mislukt', reden: String(e?.message || e).slice(0, 300), op: nu() }).eq('lancering_id', l.id).eq('contact_id', String(c.id));
        if (error) console.error('[weekeditie-lancering] status mislukt bewaren mislukt:', error.message);
      }
      if (pauze) await slaap(pauze);
    }
    if (afgebroken) return bewaar({ ...tel });
    if (!pagina.volgende) return bewaar({ ...tel, status: 'klaar', klaar_op: nu(), cursor: l.cursor });
    await bewaar({ ...tel, cursor: pagina.volgende });
  }
}

// ── statusbord ──────────────────────────────────────────────────────────────
/** Samenvatting voor het statusbord van een drop. */
export function statusbord({ drop, lancering, beelden, data }) {
  const pc = lancering && lancering.pagina_check;
  return {
    pagina: { ok: drop.status === 'gepubliceerd' && !!(pc && pc.ok), live: drop.status === 'gepubliceerd', check: pc || null },
    mail: lancering ? { status: lancering.status, getagd: lancering.getagd, totaal: lancering.totaal, overgeslagen: lancering.overgeslagen, mislukt: lancering.mislukt, ingepland_op: lancering.ingepland_op, klaar_op: lancering.klaar_op, ok: lancering.status === 'klaar' } : null,
    beelden,
    leads: data ? data.leads : null,
    calls: data ? data.calls : null,
    bezoekers: data ? data.bezoekers : null,
    social_v2: isSocialV2(drop.output),
  };
}
