// api/inbox-parkeer.js
//
// Een bericht dertig seconden in de wacht zetten — op de SERVER.
//
//   POST  { conversation_id, mode, body|template_*|media_* }
//         → { id, verstuur_na }   het bericht staat geparkeerd
//   GET   ?conversation_id=<uuid>
//         → { wacht: [...] }      wat er voor dit gesprek nog in de wacht staat
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
// ── HET 24-UURSVENSTER WORDT HIER NIET GECONTROLEERD ─────────────────────────
// Dat gebeurt bij het VERSTUREN. Een venster dat nu open is, kan over dertig
// seconden dicht zijn, en dán is het moment om dat te weten — niet nu, toen het
// nog niet zeker was. Wat hier wél gebeurt is de keuring van de opdracht zelf
// (dezelfde die /api/inbox-send doet), want iets parkeren dat straks toch
// geweigerd wordt, levert een bericht op dat eeuwig in de wacht staat.
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
import { leesVerzendOpdracht, UUID_RE } from './_lib/inbox-verzendopdracht.js';
import { metaKlaar } from './_lib/inbox-verzenden.js';
import { naarWachtrij, OPEN_STATUS } from './_lib/inbox-uitgesteld.js';

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
      return res.status(200).json({ wacht: data || [] });
    }

    const gelezen = leesVerzendOpdracht(req.body);
    if (!gelezen.ok) return res.status(gelezen.http).json(gelezen.payload);

    // Meta moet klaarstaan. Een bericht dertig seconden laten wachten om dan te
    // ontdekken dat er geen verbinding is, is dertig seconden verspilde hoop.
    const meta = metaKlaar();
    if (!meta.ok) return res.status(meta.http).json(meta.payload);

    // Bestaat het gesprek? Dat is goedkoop om nu te weten en vervelend om over
    // dertig seconden te ontdekken.
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, phone_number, phone_number_id')
      .eq('id', gelezen.opdracht.convId)
      .maybeSingle();
    if (convErr) throw new Error('conversation lookup: ' + convErr.message);
    if (!conv) return res.status(404).json({ error: 'Conversation niet gevonden' });
    if (!conv.phone_number) return res.status(400).json({ error: 'Conversation heeft geen phone_number' });

    // Welke module is dit? Hetzelfde afleidingspad als bij versturen, zodat de
    // rij weet waar hij bij hoort.
    let module = 'finance';
    if (conv.phone_number_id) {
      try {
        const { data: modCfg } = await supabaseAdmin
          .from('whatsapp_module_config')
          .select('module')
          .eq('phone_number_id', conv.phone_number_id)
          .eq('is_active', true)
          .maybeSingle();
        if (modCfg?.module) module = String(modCfg.module).toLowerCase();
      } catch (e) {
        console.error('[inbox-parkeer] module-config:', e.message);
      }
    }
    // De rechten-controle per module doet verstuurInGesprek straks opnieuw en
    // autoritatief. Hier alvast, zodat je niet dertig seconden wacht op een
    // weigering die nu al vaststaat.
    if (module === 'events' && !hasSimoneUse) {
      return res.status(403).json({ error: 'Geen rechten (events.simone.use voor events-conv)' });
    }
    if (module === 'onboarding' && !hasOnboardingSend) {
      return res.status(403).json({ error: 'Geen rechten (onboarding.inbox.send voor onboarding-conv)' });
    }
    if (module !== 'events' && module !== 'onboarding' && !hasFinanceSend) {
      return res.status(403).json({ error: 'Geen rechten (finance.inbox.send voor finance-conv)' });
    }

    const rij = naarWachtrij(gelezen.opdracht, { module, doorGebruiker: user.id });
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
