// api/_lib/wa-gesprek-lijn.js
//
// Eén gesprek per lead per LIJN — ook na een nummerwissel.
//
// Probleem (2026-10-06): na de overstap naar het nieuwe 360dialog-nummer
// stonden de bestaande lead-gesprekken nog op de oude lijn-ID's. Een nieuw
// uitgaand bericht werd in dat oude gesprek gelogd (met het oude ID), een
// inbox-antwoord ging daardoor via de oude, geblokkeerde lijn, en een
// antwoord van de lead kwam in een NIEUW gesprek op de nieuwe lijn terecht
// → gesplitste inbox.
//
// Regel: een gesprek hoort bij de HUIDIGE lijn. Staat het nog op een lijn die
// vervangen is (wa-nummers.js → vervangt_phone_number_ids), dan wordt het bij
// het eerstvolgende bericht aan de huidige lijn GEHECHT (phone_number_id
// bijgewerkt). Het gesprek, z'n berichten en alle verwijzingen blijven
// hetzelfde — er gaat geen historie verloren. Bestaan er al gesprekken op
// beide (al gesplitst), dan voegt de datafix-SQL ze samen
// (docs/sql-migrations/2026-10-06-whatsapp-gesprekken-lijn-samenvoegen.sql).
//
// Lijnen die niet in de registry staan (finance, onboarding) gedragen zich
// exact als voorheen: alleen een match op (telefoon, lijn).

import { huidigeLijnId, lijnFamilie } from './meta-whatsapp.js';

/**
 * Zoek het gesprek voor (telefoon, lijn). Valt terug op een gesprek op een
 * vervangen lijn van dezelfde familie en hecht dat aan de huidige lijn.
 *
 * @param {object} sb             supabaseAdmin
 * @param {object} opts
 * @param {string} opts.phoneE164Plus
 * @param {string} opts.phoneNumberId   lijn waarover (ont)vangen wordt (mag een oud ID zijn)
 * @param {string} [opts.select]        kolommen (id en phone_number_id worden altijd meegenomen)
 * @returns {Promise<{ conv: object|null, lijnId: string, gehecht: boolean }>}
 *          lijnId = de huidige lijn-ID (gebruik die bij een INSERT).
 */
export async function vindOfHechtGesprek(sb, { phoneE164Plus, phoneNumberId, select = 'id, phone_number_id' }) {
  const kolommen = [...new Set(['id', 'phone_number_id', ...String(select).split(',').map((s) => s.trim()).filter(Boolean)])].join(', ');
  const { huidig, alle } = await lijnFamilie(phoneNumberId);
  const lijnId = String(huidig || phoneNumberId);

  // 1) Gesprek op de huidige lijn.
  const r1 = await sb.from('whatsapp_conversations').select(kolommen)
    .eq('phone_number', phoneE164Plus).eq('phone_number_id', lijnId).maybeSingle();
  if (r1.error) throw new Error('conv select: ' + r1.error.message);
  if (r1.data) return { conv: r1.data, lijnId, gehecht: false };

  // 2) Gesprek op een vervangen lijn van dezelfde familie → hechten.
  const oud = alle.filter((id) => id !== lijnId);
  if (!oud.length) return { conv: null, lijnId, gehecht: false };
  const r2 = await sb.from('whatsapp_conversations').select(kolommen)
    .eq('phone_number', phoneE164Plus).in('phone_number_id', oud)
    .order('last_message_at', { ascending: false, nullsFirst: false }).limit(1);
  if (r2.error) throw new Error('conv select (oude lijn): ' + r2.error.message);
  const kandidaat = r2.data && r2.data[0];
  if (!kandidaat) return { conv: null, lijnId, gehecht: false };

  const upd = await sb.from('whatsapp_conversations').update({ phone_number_id: lijnId })
    .eq('id', kandidaat.id).eq('phone_number_id', kandidaat.phone_number_id);
  if (upd.error) {
    // 23505: intussen bestaat er tóch een gesprek op de huidige lijn (race) → dat nemen.
    if (upd.error.code === '23505' || /duplicate key/i.test(upd.error.message || '')) {
      const r3 = await sb.from('whatsapp_conversations').select(kolommen)
        .eq('phone_number', phoneE164Plus).eq('phone_number_id', lijnId).maybeSingle();
      if (r3.data) return { conv: r3.data, lijnId, gehecht: false };
    }
    console.warn('[wa-gesprek-lijn] hechten mislukt (soft):', kandidaat.id, upd.error.message);
    return { conv: kandidaat, lijnId, gehecht: false };
  }
  return { conv: { ...kandidaat, phone_number_id: lijnId }, lijnId, gehecht: true };
}

/**
 * Na een send uit een bestaand gesprek (inbox-antwoord): staat het gesprek
 * nog op een vervangen lijn, hecht het dan aan de huidige — mits er voor deze
 * lead nog geen gesprek op de huidige lijn is (dan voegt de datafix samen).
 * Fail-soft: gooit nooit.
 *
 * @returns {Promise<string|null>} de nieuwe lijn-ID als er gehecht is, anders null
 */
export async function hechtAanHuidigeLijn(sb, conv) {
  try {
    if (!conv || !conv.id || !conv.phone_number_id || !conv.phone_number) return null;
    const huidig = await huidigeLijnId(conv.phone_number_id);
    if (!huidig || huidig === String(conv.phone_number_id)) return null;
    const { data: bezet } = await sb.from('whatsapp_conversations').select('id')
      .eq('phone_number', conv.phone_number).eq('phone_number_id', huidig).maybeSingle();
    if (bezet) return null;
    const { error } = await sb.from('whatsapp_conversations').update({ phone_number_id: huidig })
      .eq('id', conv.id).eq('phone_number_id', conv.phone_number_id);
    if (error) { console.warn('[wa-gesprek-lijn] hechten na send (soft):', conv.id, error.message); return null; }
    return huidig;
  } catch (e) {
    console.warn('[wa-gesprek-lijn] hechten na send exception (soft):', e?.message || e);
    return null;
  }
}
