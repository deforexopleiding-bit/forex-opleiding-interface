// api/_lib/events-geen-gehoor-reactie.js
//
// HEEFT DEZE PERSOON SINDS DE BELSTATUS IETS VAN ZICH LATEN HOREN?
//
// Eén meting, twee gebruikers — zelfde patroon als
// _lib/invoice-payment-link.js (lesson learned 17):
//
//   1. de condition-check 'geen_reactie_sinds_belstatus' in de
//      events-automation-engine: die annuleert de inschrijving alleen als
//      hier NUL treffers uitkomen;
//   2. api/cron-events-geen-gehoor-reacties.js: die meldt elke treffer aan
//      Maxim zodat een antwoord niet in de inbox blijft liggen terwijl de
//      klok doorloopt.
//
// ── DE BELANGRIJKSTE REGEL VAN DIT BESTAND ──────────────────────────────
// 'Niet gemeten' is nooit 'geen reactie'. Kan de meting niet draaien — geen
// telefoonnummer en geen e-mailadres, geen nulpunt, of een query die faalt —
// dan komt er `niet_gemeten: true` terug en GEEN lege treffer-lijst die als
// 'hij heeft niets gestuurd' te lezen valt. Een plek afnemen op een meting die
// niet kon draaien is precies de fout die niemand terugvindt.
//
// Vandaar ook dat elke tak een `reden` zet: een controle die niets kan meten
// moet dat kunnen zeggen, niet stil slagen.

import { supabaseAdmin } from '../supabase.js';

/** Hoeveel treffers we hoogstens teruggeven. Genoeg voor een melding. */
const MAX_TREFFERS = 20;

/**
 * Alles behalve cijfers eruit. Klantnummers staan inconsistent in de databank
 * (met of zonder '+', met of zonder landcode, soms met spaties), dus
 * vergelijken gebeurt op pure digits — lesson learned 18.
 */
export function normalizeerTelefoon(s) {
  if (!s) return '';
  return String(s).replace(/\D/g, '');
}

/**
 * De spellingen waarop een conversatie-rij gevonden kan worden.
 *
 * whatsapp_conversations.phone_number wordt door zowel de inbound-webhook als
 * conv-upsert als '+<digits>' geschreven, maar oudere rijen en hand-invoer
 * staan er anders in. De laatste-9-variant vangt de lokale spelling zonder
 * landcode.
 */
export function telefoonVarianten(phone) {
  const digits = normalizeerTelefoon(phone);
  if (!digits) return { digits: '', laatste9: '', orFilter: null };
  const laatste9 = digits.slice(-9);
  const delen = [
    `phone_number.eq.+${digits}`,
    `phone_number.eq.${digits}`,
  ];
  // Alleen zinvol als er echt 9 cijfers zijn; anders matcht '%123' half de
  // databank.
  if (laatste9.length === 9) delen.push(`phone_number.ilike.%${laatste9}`);
  return { digits, laatste9, orFilter: delen.join(',') };
}

/**
 * Zoekt inkomende berichten van deze persoon sinds een tijdstip.
 *
 * @param {object}  opts
 * @param {?string} opts.phone     telefoonnummer van de deelnemer
 * @param {?string} opts.email     e-mailadres van de deelnemer
 * @param {?string} opts.sinceIso  het nulpunt (call_status_at)
 * @param {object}  [opts.db]      supabase-client (injecteerbaar voor tests)
 * @param {number}  [opts.max]     hoeveel treffers hoogstens
 *
 * @returns {Promise<{
 *   meetbaar: boolean,
 *   niet_gemeten: boolean,
 *   reden: ?string,
 *   kanalen: string[],
 *   treffers: Array<{ bericht_id: string, kanaal: 'whatsapp'|'email',
 *                     tijdstip: ?string, tekst: string }>,
 * }>}
 */
export async function meetInkomendeReacties({
  phone, email, sinceIso, db = supabaseAdmin, max = MAX_TREFFERS,
} = {}) {
  const uit = {
    meetbaar: false, niet_gemeten: true, reden: null, kanalen: [], treffers: [],
  };

  // GEEN NULPUNT IS GEEN METING. Zonder call_status_at weten we niet vanaf
  // wanneer we moeten kijken, en 'sinds het begin der tijden' zou elk oud
  // bericht als reactie laten tellen.
  if (!sinceIso || !Number.isFinite(Date.parse(sinceIso))) {
    uit.reden = 'geen bruikbaar nulpunt (call_status_at ontbreekt of is onleesbaar)';
    return uit;
  }

  const { orFilter } = telefoonVarianten(phone);
  const mail = String(email || '').trim().toLowerCase();

  if (!orFilter && !mail) {
    uit.reden = 'geen telefoonnummer en geen e-mailadres — niets om op te zoeken';
    return uit;
  }

  const treffers = [];

  // ── WhatsApp ───────────────────────────────────────────────────────────
  if (orFilter) {
    let convIds = [];
    try {
      const { data, error } = await db
        .from('whatsapp_conversations')
        .select('id, phone_number')
        .or(orFilter)
        .limit(25);
      if (error) throw new Error(error.message);
      convIds = (data || []).map((c) => c.id).filter(Boolean);
    } catch (e) {
      // EEN GEFAALDE QUERY IS NIET 'GEEN REACTIE'. Hier stoppen, met de
      // letterlijke fout erbij, zodat het log het verschil toont met een
      // meting die wél draaide en niets vond.
      console.error('[events-geen-gehoor-reactie] conversaties:', e?.message || e);
      uit.reden = 'de WhatsApp-conversaties konden niet opgezocht worden: ' + (e?.message || e);
      return uit;
    }

    // Geen conversatie is een GELDIGE meting met nul WhatsApp-treffers: er is
    // dan nooit een gesprek geweest, dus ook geen antwoord.
    if (convIds.length > 0) {
      try {
        const { data, error } = await db
          .from('whatsapp_messages')
          .select('id, body, created_at, direction')
          .in('conversation_id', convIds)
          .eq('direction', 'in')
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: true })
          .limit(max);
        if (error) throw new Error(error.message);
        for (const m of (data || [])) {
          treffers.push({
            bericht_id: 'wa:' + m.id,
            kanaal    : 'whatsapp',
            tijdstip  : m.created_at || null,
            tekst     : String(m.body || '').trim() || '(geen tekst — media of sticker)',
          });
        }
      } catch (e) {
        console.error('[events-geen-gehoor-reactie] wa-berichten:', e?.message || e);
        uit.reden = 'de WhatsApp-berichten konden niet opgezocht worden: ' + (e?.message || e);
        return uit;
      }
    }
    uit.kanalen.push('whatsapp');
  }

  // ── Inkomende mail ─────────────────────────────────────────────────────
  // email_messages bevat uitsluitend binnengekomen mail (IMAP-sync), dus er is
  // geen richting-kolom om op te filteren — zie het commentaar in
  // _lib/dunning-engine.js. Kolomnamen zijn die van sync-emails.js:
  // from_address en date_received, niet received_at.
  if (mail) {
    try {
      const { data, error } = await db
        .from('email_messages')
        .select('id, from_address, subject, snippet, date_received')
        .ilike('from_address', mail)
        .gte('date_received', sinceIso)
        .order('date_received', { ascending: true })
        .limit(max);
      if (error) throw new Error(error.message);
      for (const m of (data || [])) {
        const tekst = [m.subject, m.snippet].filter(Boolean).join(' — ').trim();
        treffers.push({
          bericht_id: 'mail:' + m.id,
          kanaal    : 'email',
          tijdstip  : m.date_received || null,
          tekst     : tekst || '(geen onderwerp en geen fragment)',
        });
      }
    } catch (e) {
      console.error('[events-geen-gehoor-reactie] inkomende mail:', e?.message || e);
      uit.reden = 'de inkomende mail kon niet opgezocht worden: ' + (e?.message || e);
      return uit;
    }
    uit.kanalen.push('email');
  }

  treffers.sort((a, b) => String(a.tijdstip || '').localeCompare(String(b.tijdstip || '')));

  uit.meetbaar     = true;
  uit.niet_gemeten = false;
  uit.treffers     = treffers.slice(0, max);
  uit.reden        = treffers.length === 0
    ? 'gemeten op ' + uit.kanalen.join(' + ') + ': geen inkomend bericht'
    : 'gemeten op ' + uit.kanalen.join(' + ') + ': ' + treffers.length + ' inkomend bericht'
      + (treffers.length === 1 ? '' : 'en');
  return uit;
}

/**
 * De conditie zoals de automation-engine hem nodig heeft.
 *
 * Waar = er is sinds de belstatus NIETS binnengekomen. Niet meetbaar = NIET
 * waar, want dan mag de inschrijving niet vervallen.
 *
 * @returns {Promise<{ waar: boolean, niet_gemeten: boolean, reden: ?string,
 *                     kanalen: string[], aantal_treffers: number }>}
 */
export async function geenReactieSindsBelstatus({ phone, email, sinceIso, db } = {}) {
  const meting = await meetInkomendeReacties({ phone, email, sinceIso, db });
  if (meting.niet_gemeten) {
    return {
      waar: false, niet_gemeten: true, reden: meting.reden,
      kanalen: meting.kanalen, aantal_treffers: 0,
    };
  }
  return {
    waar           : meting.treffers.length === 0,
    niet_gemeten   : false,
    reden          : meting.reden,
    kanalen        : meting.kanalen,
    aantal_treffers: meting.treffers.length,
  };
}
