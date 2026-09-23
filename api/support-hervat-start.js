// api/support-hervat-start.js
//
// POST — iemand wil een bestaand gesprek heropenen vanaf een ander apparaat.
// Body: { kenmerk }. Wij sturen een code naar het mailadres dat al bij dat
// gesprek staat; het adres komt nooit uit dit endpoint terug.
//
// Het antwoord is ALTIJD hetzelfde. Bestaat het kenmerk niet, hoort er geen
// mailadres bij, is het gesprek geblokkeerd of is de codelimiet bereikt — de
// bezoeker ziet in alle gevallen "kijk in je mailbox". Zie de kop van
// _lib/support-hervat.js voor waarom dat hier zwaarder weegt dan behulpzaam
// zijn: elk verschil in het antwoord maakt van dit endpoint een vinkenlijst
// voor geldige dossiernummers.

import { supabaseAdmin } from './supabase.js';
import { applySupportCors, handledPreflight } from './_lib/support-cors.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import { hashToken } from './_lib/support-sessie.js';
import { stuurVerificatieCode } from './_lib/support-mail.js';
import {
  kenmerkUitBody, gesprekUitKenmerk, maakCode, magCodeVersturen,
} from './_lib/support-hervat.js';

const GELDIG_MS = 10 * 60 * 1000;

// Eén antwoord voor alle uitkomsten. Bewust een functie en geen constante,
// zodat er nooit per ongeluk een veld aan gehangen wordt op één plek.
function altijdHetzelfde(res) {
  return res.status(200).json({
    ok: true,
    melding: 'Als dit kenmerk bij ons bekend is, staat er een code in de mailbox waar je onze mail op kreeg.',
  });
}

export default async function handler(req, res) {
  applySupportCors(req, res, 'POST, OPTIONS');
  if (handledPreflight(req, res, 'POST')) return;

  // Strenger dan de gewone verificatie: daar heeft de bezoeker al een sessie,
  // hier is het kenmerk het enige wat 'ie hoeft te raden.
  const { limited } = await checkRateLimit({
    req, bucket: 'support-hervat-start', maxHits: 5, withinSeconds: 900,
  });
  if (limited) return res.status(429).json({ error: 'Te veel pogingen. Probeer het over een kwartier nog eens.' });

  const kenmerk = kenmerkUitBody(req.body);
  if (!kenmerk) return altijdHetzelfde(res);

  const gesprek = await gesprekUitKenmerk(kenmerk);
  if (!gesprek || !gesprek.email || gesprek.verificatie_geblokkeerd) return altijdHetzelfde(res);
  if (!(await magCodeVersturen(gesprek.id))) return altijdHetzelfde(res);

  const code = maakCode();

  try {
    const { error } = await supabaseAdmin.from('support_verificaties').insert({
      gesprek_id: gesprek.id,
      email: gesprek.email,
      code_hash: hashToken(code),
      vervalt_op: new Date(Date.now() + GELDIG_MS).toISOString(),
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.error('[support-hervat-start] code opslaan mislukt:', e?.message || e);
    return altijdHetzelfde(res);
  }

  let mailbox = 'info@deforexopleiding.nl';
  try {
    const { data } = await supabaseAdmin
      .from('app_settings').select('value').eq('key', 'support_widget').maybeSingle();
    if (data?.value?.antwoord_mailbox) mailbox = data.value.antwoord_mailbox;
  } catch (_) { /* standaard */ }

  const verstuurd = await stuurVerificatieCode({
    naar: gesprek.email, code, kenmerk: gesprek.kenmerk, vanMailbox: mailbox,
  }).catch((e) => {
    console.error('[support-hervat-start] mail mislukt:', e?.message || e);
    return null;
  });

  // Ook een mislukte verzending krijgt hetzelfde antwoord. Dat is vervelend
  // voor wie zit te wachten, maar het alternatief verklapt dat het kenmerk
  // bestaat. De fout staat in de logs en de bezoeker kan altijd nog gewoon
  // een nieuw gesprek beginnen of terugmailen.
  if (!verstuurd?.ok) console.error('[support-hervat-start] niet verstuurd:', verstuurd?.reason);

  return altijdHetzelfde(res);
}
