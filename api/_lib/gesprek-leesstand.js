// api/_lib/gesprek-leesstand.js
//
// Gelezen / ongelezen van een GESPREK in de gesprekkenmodule (Wanbetalers ›
// Gesprekken, Inbox, Onboarding-inbox). Eén gesprek = WhatsApp + mail van
// dezelfde klant, dus "gelezen" moet beide kanalen raken, in de databank.
//
// ── WAAROM DIT BESTAAT (29 okt 2026) ────────────────────────────────────────
// De badge in de lijst is `unread_count` (WA) + het aantal rijen in
// `email_messages` met is_read=false voor die klant in de mailbox van de
// module (inbox-conversations-list). Bij openen riep het scherm per mail
// `/api/email-actions {action:'mark-read'}` aan — maar dat endpoint doet niets
// anders dan een auditregel in `email_actions` invoegen. Het antwoordde
// 200 {ok:true} en `is_read` bleef false: na herladen stond elke badge terug.
// Gemeten: 3.676 zulke auditregels, nul gelezen mails.
//
// Nu één call bij openen, en de databank is de waarheid:
//   • WA: unread_count → 0 op het geopende gesprek én op de andere gesprekken
//     van dezelfde klant op HETZELFDE nummer (dezelfde lijst). Gesprekken op
//     een ander nummer horen bij een andere module en blijven onaangeroerd.
//   • Mail: is_read → true op alle ongelezen mails van die klant in de mailbox
//     van de module (precies wat de badge telt). Andere mailboxen (info@,
//     welkom@, …) zijn het postvak van een ander team en blijven staan.
// Fouten worden NIET ingeslikt: wie "gelezen" antwoordt, heeft het geschreven.
//
// IMAP \Seen wordt hier bewust niet gezet: sync-emails leest alleen nieuwe
// UIDs en backfill doet ignoreDuplicates, dus niets zet is_read ooit terug
// vanuit IMAP. Alle CRM-schermen lezen is_read uit de databank.

import { mailboxLabel as labelVoorModule } from './module-mailbox.js';

const ONZE_DOMEIN_ILIKE = '%@deforexopleiding.nl';

// Eén label, een lijst of niets → een lijst zonder lege waarden.
function labels(mailboxLabel) {
  const arr = Array.isArray(mailboxLabel) ? mailboxLabel : [mailboxLabel];
  return [...new Set(arr.filter((x) => typeof x === 'string' && x))];
}

/**
 * Welke mailbox(en) horen bij dit gesprek?
 * Met module (zoals de schermen die meesturen): de mailbox van die module.
 * Zonder module (een oudere, gecachte client of een directe aanroep): de
 * mailboxen van de modules die op het nummer van het gesprek draaien, uit
 * whatsapp_module_config. Zo hangt "gelezen" niet af van wat de browser
 * meestuurt (29 okt: v=69 uit de cache stuurde geen module → 0 mails).
 */
export async function mailboxenVoorGesprek(sb, { conv, module }) {
  if (module) return labels(labelVoorModule(module));
  if (!conv?.phone_number_id) return [];
  const { data, error } = await sb
    .from('whatsapp_module_config')
    .select('module')
    .eq('phone_number_id', conv.phone_number_id)
    .eq('is_active', true);
  if (error) throw new Error('module-config: ' + error.message);
  return labels((data || []).map((r) => labelVoorModule(r.module)));
}

/**
 * Markeer een heel gesprek als gelezen.
 * @param sb           supabase admin-client
 * @param conv         { id, customer_id, phone_number_id }
 * @param mailboxLabel short label(s) uit module-mailbox.js (string of lijst), of null (dan geen mail)
 * @returns { wa_gemarkeerd: string[], mails_gemarkeerd: number }
 */
export async function markeerGesprekGelezen(sb, { conv, mailboxLabel }) {
  if (!conv || !conv.id) throw new Error('conv ontbreekt');
  const waIds = new Set();

  const { data: eigen, error: eErr } = await sb
    .from('whatsapp_conversations')
    .update({ unread_count: 0 })
    .eq('id', conv.id)
    .gt('unread_count', 0)
    .select('id');
  if (eErr) throw new Error('unread reset: ' + eErr.message);
  for (const r of eigen || []) waIds.add(String(r.id));

  if (conv.customer_id && conv.phone_number_id) {
    const { data: zussen, error: zErr } = await sb
      .from('whatsapp_conversations')
      .update({ unread_count: 0 })
      .eq('customer_id', conv.customer_id)
      .eq('phone_number_id', conv.phone_number_id)
      .gt('unread_count', 0)
      .select('id');
    if (zErr) throw new Error('unread reset (zelfde klant): ' + zErr.message);
    for (const r of zussen || []) waIds.add(String(r.id));
  }

  let mails = 0;
  const mbs = labels(mailboxLabel);
  if (conv.customer_id && mbs.length) {
    const { data: gelezen, error: mErr } = await sb
      .from('email_messages')
      .update({ is_read: true })
      .eq('customer_id', conv.customer_id)
      .in('mailbox', mbs)
      .eq('is_read', false)
      .select('id');
    if (mErr) throw new Error('mail is_read: ' + mErr.message);
    mails = (gelezen || []).length;
  }

  return { wa_gemarkeerd: [...waIds], mails_gemarkeerd: mails };
}

/**
 * Welk bericht gaat terug op ongelezen? Het laatste inkomende, WA of mail.
 * Puur, zodat de keuze los te toetsen is.
 * @returns 'email' | 'wa'
 */
export function kiesOngelezenKanaal({ laatsteWaInboundAt, laatsteMailAt }) {
  const wa = laatsteWaInboundAt ? Date.parse(laatsteWaInboundAt) : NaN;
  const em = laatsteMailAt ? Date.parse(laatsteMailAt) : NaN;
  if (Number.isFinite(em) && (!Number.isFinite(wa) || em > wa)) return 'email';
  return 'wa';
}

/**
 * Zet een gesprek terug op ongelezen: het laatste inkomende bericht (WA of
 * mail) wordt ongelezen. De badge staat daarna op minstens 1.
 * @param conv { id, customer_id, unread_count, last_inbound_at }
 * @returns { kanaal: 'email'|'wa', email_id: string|null, unread_count: number }
 */
export async function markeerGesprekOngelezen(sb, { conv, mailboxLabel }) {
  if (!conv || !conv.id) throw new Error('conv ontbreekt');
  const cur = Number(conv.unread_count || 0);

  let laatsteMail = null;
  const mbs = labels(mailboxLabel);
  if (conv.customer_id && mbs.length) {
    const { data, error } = await sb
      .from('email_messages')
      .select('id, date_received, is_read')
      .eq('customer_id', conv.customer_id)
      .in('mailbox', mbs)
      .not('from_address', 'ilike', ONZE_DOMEIN_ILIKE)
      .order('date_received', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error('laatste mail: ' + error.message);
    laatsteMail = data || null;
  }

  const kanaal = kiesOngelezenKanaal({
    laatsteWaInboundAt: conv.last_inbound_at,
    laatsteMailAt: laatsteMail?.date_received,
  });

  if (kanaal === 'email') {
    const { error } = await sb
      .from('email_messages')
      .update({ is_read: false })
      .eq('id', laatsteMail.id);
    if (error) throw new Error('mail ongelezen: ' + error.message);
    return { kanaal, email_id: String(laatsteMail.id), unread_count: cur };
  }

  const next = Math.max(1, cur);
  if (next !== cur) {
    const { error } = await sb
      .from('whatsapp_conversations')
      .update({ unread_count: next })
      .eq('id', conv.id);
    if (error) throw new Error('unread set: ' + error.message);
  }
  return { kanaal, email_id: null, unread_count: next };
}
