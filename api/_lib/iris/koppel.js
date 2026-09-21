// api/_lib/iris/koppel.js
//
// Wie is dit? En weten we dat zeker genoeg?
//
// ── DE ENIGE REGEL DIE ERTOE DOET ────────────────────────────────────────────
// Bij precies één kandidaat koppelen we. Bij nul of bij meer dan één koppelen
// we niet, en zetten we de zaak op 'te bevestigen'. Iris gokt nooit.
//
// Dat klinkt streng en dat is het ook. De verleiding om bij twee kandidaten de
// meest recente te kiezen is groot, en die verleiding is precies waar het
// misgaat: een betalingsherinnering die bij de verkeerde persoon uitkomt, is
// niet een ongemak maar een privacylek. Twee mensen met dezelfde laatste negen
// cijfers is zeldzaam — en zeldzaam betekent dat het gebeurt.
//
// ── WAAROM NIET DE BESTAANDE HELPERS ─────────────────────────────────────────
// Ze worden juist wél gebruikt: stripToDigits, last9Digits en normaliseerStrict
// komen uit _lib/phone-normalize.js en _lib/phone-e164.js. Wat hier bijkomt is
// het BESLUIT dat erop volgt, met een reden die een mens kan lezen. De
// bestaande findCustomerByPhone in inbox-webhook.js geeft bij twee kandidaten
// gewoon null terug; dan weet je wel dát er niet gekoppeld is, maar niet
// waarom. Dat verschil — "niemand gevonden" tegenover "drie gevonden" — is
// precies wat iemand nodig heeft die het handmatig moet oplossen.
//
// ── NORMALISEREN ─────────────────────────────────────────────────────────────
// Mail: kleine letters, getrimd. Geen plus-adres-truc (het adres na de + bij
// gmail), want dat is niet zomaar hetzelfde adres in andermans systeem.
// Telefoon: alle niet-cijfers eruit. Eerst op het volle nummer vergelijken,
// dan pas op de laatste negen cijfers. Zo wint een volledig internationaal
// nummer het altijd van een toevallige staartmatch.

import { stripToDigits, last9Digits } from '../phone-normalize.js';

/** Mailadres normaliseren. Leeg of onzin wordt een lege tekst. */
export function normaliseerEmail(ruw) {
  const s = String(ruw ?? '').trim().toLowerCase();
  // Een adres zonder apenstaartje of zonder punt erna is geen adres.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return '';
  return s;
}

/** Telefoonnummer normaliseren tot alleen cijfers. */
export function normaliseerTelefoon(ruw) {
  return stripToDigits(ruw);
}

/**
 * Vergelijk twee telefoonnummers en zeg HOE goed ze matchen.
 *
 * 'volledig' — alle cijfers gelijk. Onbetwist.
 * 'staart'   — de laatste negen cijfers gelijk. Waarschijnlijk hetzelfde
 *              nummer met en zonder landcode, maar niet zeker.
 * null       — geen match.
 */
export function telefoonMatch(a, b) {
  const da = normaliseerTelefoon(a);
  const db = normaliseerTelefoon(b);
  if (!da || !db) return null;
  if (da === db) return 'volledig';
  const sa = last9Digits(da);
  const sb = last9Digits(db);
  if (sa && sb && sa.length === 9 && sa === sb) return 'staart';
  return null;
}

/**
 * Kies uit een lijst kandidaten, en zeg waarom.
 *
 * Een volledige match verslaat een staartmatch. Zijn er meerdere volledige
 * matches, dan is er geen keuze — dan is de data zelf dubbelzinnig en moet een
 * mens kijken.
 *
 * @param {Array<{id: string, score: 'volledig'|'staart'|'email'}>} kandidaten
 * @returns {{status: 'gekoppeld'|'te_bevestigen'|'onbekend', id: string|null, reden: string}}
 */
export function kiesKandidaat(kandidaten) {
  const lijst = Array.isArray(kandidaten) ? kandidaten.filter(Boolean) : [];
  if (lijst.length === 0) {
    return { status: 'onbekend', id: null, reden: 'geen kandidaat gevonden' };
  }

  const volledig = lijst.filter((k) => k.score === 'volledig' || k.score === 'email');
  if (volledig.length === 1) {
    const hoe = volledig[0].score === 'email' ? 'uniek e-mailadres' : 'volledig telefoonnummer';
    return { status: 'gekoppeld', id: volledig[0].id, reden: hoe };
  }
  if (volledig.length > 1) {
    return {
      status: 'te_bevestigen',
      id: null,
      reden: `${volledig.length} kandidaten met een volledige match — de gegevens zelf zijn dubbelzinnig`,
    };
  }

  const staart = lijst.filter((k) => k.score === 'staart');
  if (staart.length === 1) {
    return {
      status: 'te_bevestigen',
      id: staart[0].id,
      reden: 'alleen de laatste negen cijfers komen overeen — waarschijnlijk hetzelfde nummer zonder landcode, maar niet zeker',
    };
  }
  return {
    status: 'te_bevestigen',
    id: null,
    reden: `${staart.length} kandidaten op de laatste negen cijfers`,
  };
}

/**
 * Zoek de klant achter een mailadres en/of telefoonnummer.
 *
 * Gaat over ALLE actieve klanten heen en vergelijkt genormaliseerd. Dat is
 * overvragen, en dat is bewust: het klantbestand telt duizenden rijen, niet
 * miljoenen, en het alternatief (een LIKE op een niet-genormaliseerde kolom)
 * mist juist de gevallen waar het om gaat — nummers met spaties, met haakjes,
 * met een landcode die er soms wel en soms niet staat. Dezelfde afweging als
 * customer-check-duplicate.js en findCustomerByPhone in de webhook.
 *
 * @returns {Promise<{status, id, reden, kandidaten}>}
 */
export async function zoekKlant(supabase, { email, telefoon } = {}) {
  const mail = normaliseerEmail(email);
  const tel = normaliseerTelefoon(telefoon);

  if (!mail && !tel) {
    return { status: 'onbekend', id: null, reden: 'geen e-mailadres en geen telefoonnummer', kandidaten: [] };
  }
  if (!supabase) {
    return { status: 'onbekend', id: null, reden: 'geen databank-client', kandidaten: [] };
  }

  let rijen;
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('id, name, email, phone')
      .is('archived_at', null)
      .is('anonymized_at', null);
    if (error) {
      console.error('[iris/koppel] klanten lezen mislukt:', error.message);
      return { status: 'onbekend', id: null, reden: 'klanten niet gelezen: ' + error.message, kandidaten: [] };
    }
    rijen = data || [];
  } catch (e) {
    console.error('[iris/koppel] uitzondering bij klanten lezen:', e?.message || e);
    return { status: 'onbekend', id: null, reden: 'klanten niet gelezen', kandidaten: [] };
  }

  const kandidaten = [];
  for (const r of rijen) {
    if (mail && normaliseerEmail(r.email) === mail) {
      kandidaten.push({ id: r.id, naam: r.name, score: 'email' });
      continue;
    }
    if (tel) {
      const m = telefoonMatch(tel, r.phone);
      if (m) kandidaten.push({ id: r.id, naam: r.name, score: m });
    }
  }

  const keuze = kiesKandidaat(kandidaten);
  return { ...keuze, kandidaten };
}

/**
 * Zorg dat er een iris_contacten-rij is voor deze persoon, en geef hem terug.
 *
 * Zoekt eerst op een bestaand contact met dit mailadres of telefoonnummer
 * (beide staan als array op de rij, met een gin-index erop). Vindt hij er een,
 * dan vult hij het ontbrekende gegeven aan — een contact dat we via WhatsApp
 * leerden kennen en dat later mailt, hoort één contact te blijven en geen twee.
 *
 * Fail-zacht: bij een fout komt er null terug en logt de aanroeper het.
 */
export async function zorgVoorContact(supabase, { email, telefoon, naam } = {}) {
  const mail = normaliseerEmail(email);
  const tel = normaliseerTelefoon(telefoon);
  if (!mail && !tel) return null;
  if (!supabase) return null;

  try {
    // 1. Bestaat er al een contact met dit adres of dit nummer?
    const orDelen = [];
    if (mail) orDelen.push(`emails.cs.{"${mail}"}`);
    if (tel) orDelen.push(`telefoons.cs.{"${tel}"}`);
    const { data: bestaand, error: zoekFout } = await supabase
      .from('iris_contacten')
      .select('id, customer_id, emails, telefoons, koppelstatus, weergavenaam')
      .or(orDelen.join(','))
      .limit(2);
    if (zoekFout) {
      console.error('[iris/koppel] contact zoeken mislukt:', zoekFout.message);
      return null;
    }

    if (bestaand && bestaand.length === 1) {
      const c = bestaand[0];
      const emails = new Set(c.emails || []);
      const telefoons = new Set(c.telefoons || []);
      const voor = emails.size + telefoons.size;
      if (mail) emails.add(mail);
      if (tel) telefoons.add(tel);
      if (emails.size + telefoons.size !== voor || (naam && !c.weergavenaam)) {
        const { error: bijFout } = await supabase
          .from('iris_contacten')
          .update({
            emails: [...emails],
            telefoons: [...telefoons],
            weergavenaam: c.weergavenaam || naam || null,
            bijgewerkt_op: new Date().toISOString(),
          })
          .eq('id', c.id);
        if (bijFout) console.warn('[iris/koppel] contact aanvullen mislukt:', bijFout.message);
      }
      return { ...c, emails: [...emails], telefoons: [...telefoons] };
    }

    if (bestaand && bestaand.length > 1) {
      // Twee contacten die allebei dit adres of nummer dragen. Dat hoort niet
      // te kunnen en is het soort ding dat je wilt weten in plaats van stil
      // oplossen door er eentje te kiezen.
      console.warn('[iris/koppel] meer dan één contact op hetzelfde adres/nummer — niet gekoppeld');
      return null;
    }

    // 2. Nog geen contact. Zoek de klant erbij en maak de rij.
    const klant = await zoekKlant(supabase, { email: mail, telefoon: tel });
    const { data: nieuw, error: maakFout } = await supabase
      .from('iris_contacten')
      .insert({
        customer_id: klant.status === 'gekoppeld' ? klant.id : null,
        emails: mail ? [mail] : [],
        telefoons: tel ? [tel] : [],
        koppelstatus: klant.status,
        koppel_reden: klant.reden,
        weergavenaam: naam || klant.kandidaten?.[0]?.naam || null,
      })
      .select('id, customer_id, emails, telefoons, koppelstatus, weergavenaam')
      .single();
    if (maakFout) {
      console.error('[iris/koppel] contact aanmaken mislukt:', maakFout.message);
      return null;
    }
    return nieuw;
  } catch (e) {
    console.error('[iris/koppel] uitzondering:', e?.message || e);
    return null;
  }
}
