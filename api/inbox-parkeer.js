// api/inbox-parkeer.js
//
// Een bericht dertig seconden in de wacht zetten — op de SERVER.
//
//   POST  { conversation_id, mode, body|template_*|media_* }
//         → { id, verstuur_na }   het bericht staat geparkeerd
//   GET   ?conversation_id=<uuid>
//         → { wacht: [...], aandacht: [...] }
//
// ── WAAROM DIT BESTAAT ───────────────────────────────────────────────────────
// Het ongedaan-venster wachtte tot nu toe in het scherm. Sluit je het tabblad
// binnen die dertig seconden, dan vertrok het bericht nooit — en niets zei dat.
// Je denkt dat je geantwoord hebt, en de klant wacht.
//
// Sinds dit endpoint staat het bericht op de server geparkeerd. Blijft het
// tabblad open, dan geeft datzelfde scherm na dertig seconden het startsein (en
// dan is het exact dertig seconden). Is het dicht, dan pikt de cron het op.
//
// ── DE KEURING IS DEZELFDE ALS BIJ VERSTUREN ─────────────────────────────────
// Letterlijk dezelfde: keurGesprek() uit _lib/inbox-verzenden.js. Dat is geen
// luiheid maar de hele bedoeling. Iets parkeren dat straks tóch geweigerd
// wordt, levert een bericht op dat dertig seconden hoop geeft en dan alsnog
// nergens is. Twee plekken die dezelfde vraag stellen, horen hem met dezelfde
// code te stellen.
//
// Dat het 24-uursvenster hier dus óók gecontroleerd wordt, is geen probleem:
// een venster dat nu dicht is, is over dertig seconden zeker dicht. Het
// omgekeerde (nu open, straks dicht) wordt bij het versturen alsnog gezien,
// want daar draait precies dezelfde keuring nog een keer.
//
// ── ACHTER DE VLAG ───────────────────────────────────────────────────────────
// Staat GESPREKKEN_V2 uit, dan bestaat dit endpoint niet (404) en valt het
// scherm terug op wat het altijd deed: wachten in het scherm. Geen fout, geen
// melding, hetzelfde gedrag als vandaag.
//
// Permission: dezelfde als versturen. Wie mag versturen, mag parkeren — het is
// hetzelfde bericht, alleen dertig seconden later.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { gesprekkenV2Aan } from './_lib/gesprekken-vlag.js';
import { getConfigStatus } from './_lib/meta-whatsapp.js';
import { leesVerzendOpdracht, UUID_RE } from './_lib/inbox-verzendopdracht.js';
import { keurGesprek } from './_lib/inbox-verzenden.js';
import { naarWachtrij, OPEN_STATUS, aandachtVoorGesprek } from './_lib/inbox-uitgesteld.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'GET of POST' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const hasFinanceSend    = await requirePermission(req, 'finance.inbox.send');
  const hasSimoneUse      = hasFinanceSend ? true : await requirePermission(req, 'events.simone.use');
  const hasOnboardingSend = (hasFinanceSend || hasSimoneUse)
    ? true : await requirePermission(req, 'onboarding.inbox.send');
  if (!hasFinanceSend && !hasSimoneUse && !hasOnboardingSend) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.send, events.simone.use of onboarding.inbox.send)' });
  }

  if (!gesprekkenV2Aan()) {
    return res.status(404).json({ error: 'Uitgesteld versturen staat uit (GESPREKKEN_V2)' });
  }

  try {
    if (req.method === 'GET') {
      const convId = String((req.query || {}).conversation_id || '').trim();
      if (!UUID_RE.test(convId)) {
        return res.status(400).json({ error: 'conversation_id (uuid) vereist' });
      }
      // Wat staat er nog in de wacht? Het scherm heeft dit nodig na een
      // verversing: anders ziet iemand die net op Verstuur drukte en F5 gaf,
      // geen aftelling meer terwijl het bericht wél onderweg is.
      const { data, error } = await supabaseAdmin
        .from('inbox_uitgesteld')
        .select('id, mode, body, template_name, verstuur_na, status, aangemaakt_op')
        .eq('conversation_id', convId)
        .eq('status', OPEN_STATUS)
        .order('verstuur_na', { ascending: true });
      if (error) throw new Error('wachtrij: ' + error.message);
      // En wat ging er mis? Een bericht dat niet vertrok mag nooit stil
      // blijven, ook niet als je het tabblad tussendoor dicht had.
      const aandacht = await aandachtVoorGesprek(convId);
      return res.status(200).json({ wacht: data || [], aandacht });
    }

    const gelezen = leesVerzendOpdracht(req.body);
    if (!gelezen.ok) return res.status(gelezen.http).json(gelezen.payload);

    // De transportlaag moet klaarstaan. Een bericht dertig seconden laten
    // wachten om dan te ontdekken dat er geen verbinding is, is dertig
    // seconden verspilde hoop.
    const cfg = getConfigStatus();
    if (!cfg.configured) {
      return res.status(503).json({ error: 'Meta WhatsApp niet geconfigureerd', missing: cfg.missing });
    }

    // Exact de keuring van het versturen: bestaat het gesprek, bij welke
    // module hoort het (via de klant, want het hoofdnummer draagt er meerdere),
    // mag deze medewerker daarin, en staat het venster open?
    const gekeurd = await keurGesprek(
      gelezen.opdracht,
      { hasFinanceSend, hasSimoneUse, hasOnboardingSend },
    );
    if (!gekeurd.ok) return res.status(gekeurd.http).json(gekeurd.payload);

    const rij = naarWachtrij(gelezen.opdracht, {
      module: gekeurd.convModule,
      doorGebruiker: user.id,
    });
    const { data: gezet, error: insErr } = await supabaseAdmin
      .from('inbox_uitgesteld')
      .insert(rij)
      .select('id, verstuur_na')
      .single();
    if (insErr) throw new Error('parkeren: ' + insErr.message);

    return res.status(200).json({ id: gezet.id, verstuur_na: gezet.verstuur_na });
  } catch (e) {
    console.error('[inbox-parkeer]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
