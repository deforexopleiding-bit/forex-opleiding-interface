// api/_lib/contentmachine-opslag.js
//
// Contentmachine — output van een drop bewaren als NIEUWE versie (content_drops.versie
// +1 én een rij in content_drop_versies). Optimistisch: de update lukt enkel als de
// versie intussen niet veranderde (twee tabbladen tegelijk = 409, niets overschreven).
// Plus de context die generator en grenscontrole nodig hebben (beelden, vorige drops,
// verboden namen).

import { supabaseAdmin } from '../supabase.js';
import { kiesBibliotheek } from './contentmachine-generator.js';

export const ASSET_KOLOMMEN = 'id,drop_id,soort,storage_path,publieke_url,breedte,hoogte,bijschrift,ai_beschrijving,ai_details,persoon_naam,toestemming_publiek,tags,laatst_gebruikt_op';
export const MAX_BEELDEN = 12;

export class VersieConflict extends Error {
  constructor() { super('De drop werd intussen gewijzigd (ander tabblad?). Herlaad en probeer opnieuw.'); this.code = 'VERSIE_CONFLICT'; this.publiek = this.message; }
}

/**
 * → de bijgewerkte drop. patch = extra kolommen (status, format_key, gegenereerd_op …).
 */
export async function bewaarVersie({ db = supabaseAdmin, drop, output, input, reden, userId, patch = {} }) {
  const nieuw = (drop.versie || 1) + 1;
  const upd = { ...patch, versie: nieuw, gewijzigd_op: new Date().toISOString() };
  if (output !== undefined) upd.output = output;
  if (input !== undefined) upd.input = input;
  const { data, error } = await db.from('content_drops').update(upd).eq('id', drop.id).eq('versie', drop.versie || 1).select('*');
  if (error) throw error;
  if (!data || !data.length) throw new VersieConflict();
  const { error: vErr } = await db.from('content_drop_versies').insert({
    drop_id: drop.id, versie: nieuw, reden: String(reden || '').slice(0, 300) || null,
    input: input !== undefined ? input : drop.input || null, output: output !== undefined ? output : drop.output || null, aangemaakt_door: userId || null,
  });
  if (vErr) console.error('[contentmachine-opslag] versie-rij mislukt (drop wel bewaard):', vErr.message);
  return data[0];
}

/** Voornamen die niet in publieke content mogen: mentoren/team (behalve Dave en Maxim) en studenten zonder toestemming. */
export function verbodenNamenUit({ teamNamen = [], beelden = [] }) {
  const toegestaan = new Set(['dave', 'maxim']);
  for (const a of beelden) if (a.persoon_naam && a.toestemming_publiek) toegestaan.add(a.persoon_naam.trim().split(/\s+/)[0].toLowerCase());
  const namen = new Set();
  for (const n of teamNamen) {
    const voor = String(n || '').trim().split(/\s+/)[0];
    if (voor && voor.length > 2 && !toegestaan.has(voor.toLowerCase()) && /^[A-Za-zÀ-ÿ'-]+$/.test(voor)) namen.add(voor);
  }
  for (const a of beelden) {
    if (a.persoon_naam && !a.toestemming_publiek) {
      const voor = a.persoon_naam.trim().split(/\s+/)[0];
      if (voor && !toegestaan.has(voor.toLowerCase())) namen.add(voor);
    }
  }
  return [...namen].sort();
}

/** Alles wat de generator nodig heeft voor één drop. */
export async function laadContext({ db = supabaseAdmin, drop }) {
  const input = drop.input || {};
  const gekozen = Array.isArray(input.gekozen_asset_ids) ? input.gekozen_asset_ids : [];
  const [eigen, bib, vorig, team] = await Promise.all([
    db.from('content_assets').select(ASSET_KOLOMMEN).eq('drop_id', drop.id).is('verwijderd_op', null).order('aangemaakt_op', { ascending: true }),
    db.from('content_assets').select(ASSET_KOLOMMEN).is('drop_id', null).is('verwijderd_op', null).limit(1000),
    db.from('content_drops').select('id,slug,datum,format_key,output').neq('id', drop.id).neq('status', 'gearchiveerd')
      .order('datum', { ascending: false }).order('aangemaakt_op', { ascending: false }).limit(12),
    db.from('team_members').select('name').eq('is_active', true).limit(500),
  ]);
  if (eigen.error) throw eigen.error;
  if (bib.error) throw bib.error;
  if (vorig.error) throw vorig.error;
  if (team.error) console.error('[contentmachine-opslag] team_members lezen mislukt:', team.error.message);

  const bibliotheek = bib.data || [];
  const gekozenAssets = gekozen.map((id) => bibliotheek.find((a) => a.id === id)).filter(Boolean);
  const bibKeuze = gekozenAssets.length ? gekozenAssets : kiesBibliotheek(bibliotheek, 4);
  const beelden = [
    ...(eigen.data || []).map((a) => ({ ...a, bron: 'drop' })),
    ...bibKeuze.map((a) => ({ ...a, bron: 'bibliotheek' })),
  ].slice(0, MAX_BEELDEN);
  const vorige = (vorig.data || []).filter((d) => d.output && d.datum <= drop.datum).slice(0, 6);
  return {
    beelden,
    alleAssets: [...(eigen.data || []), ...bibliotheek],
    vorige,
    verbodenNamen: verbodenNamenUit({ teamNamen: (team.data || []).map((t) => t.name), beelden: [...(eigen.data || []), ...bibliotheek] }),
  };
}
