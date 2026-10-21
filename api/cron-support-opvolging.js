// api/cron-support-opvolging.js
//
// Elk kwartier. Drie dingen die anders stilletjes misgaan:
//
//   1. Een gesprek dat te lang in de wachtrij staat → opnieuw een
//      notificatie, met hoge prioriteit. De eerste melding kan tijdens een
//      drukke dag ondergesneeuwd raken; deze niet.
//   2. Een gesprek dat op 'wacht_op_klant' staat en al dagen stil is →
//      automatisch afhandelen. Anders groeit de werklijst vol met gesprekken
//      waar niemand meer iets van verwacht, en dan kijkt niemand er nog naar.
//   3. Aanwezigheid van mensen met een dode hartslag hard op false zetten.
//      De beschikbaarheidscheck filtert daar al op, maar zo klopt ook het
//      lijstje "wie staat er online" in de module.
//   4. Vangnet voor de teammail "nieuwe chat" (_lib/support-alarm.js): een
//      gesprek van het afgelopen uur dat nog nooit een teammail kreeg (de
//      SMTP-server weigerde, of Vercel kapte de functie af) krijgt 'm alsnog.
//
// Idempotent: elke stap kijkt naar een tijdstempel die 'ie zelf verzet, dus
// twee keer draaien binnen een kwartier doet niets dubbel.

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { createNotification, resolveOntvangersVoorRecht } from './_lib/notify.js';
import { HARTSLAG_VENSTER_MS } from './_lib/support-beschikbaarheid.js';
import { meldTeam, crmGesprekPad, haalAlarmInstellingen } from './_lib/support-alarm.js';

const WACHT_HERINNERING_MIN = 45;
const STIL_AFHANDELEN_DAGEN = 5;
// Hoe ver het vangnet voor de teammail terugkijkt. Ruim over het cron-interval
// heen (15 min), kort genoeg om na een storing geen stapel oude mails te sturen.
const TEAMMAIL_VANGNET_MIN = 60;

export default async function handler(req, res) {
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const uit = { herinnerd: 0, afgehandeld: 0, offline_gezet: 0, teammail_ingehaald: 0, fouten: [] };

  // ── 1. Te lang in de wachtrij ───────────────────────────────────────────
  try {
    const grens = new Date(Date.now() - WACHT_HERINNERING_MIN * 60 * 1000).toISOString();
    const { data } = await supabaseAdmin
      .from('support_gesprekken')
      .select('id, kenmerk, naam, onderwerp, laatste_klant_bericht_op')
      .eq('status', 'wacht_op_ons')
      .lt('laatste_klant_bericht_op', grens)
      .limit(50);

    if ((data || []).length) {
      const { userIds } = await resolveOntvangersVoorRecht('support.reply');
      for (const g of data) {
        for (const userId of (userIds || []).slice(0, 25)) {
          await createNotification({
            toUserId: userId,
            type: 'support.te_lang_open',
            title: `Supportvraag ${g.kenmerk} wacht al ${WACHT_HERINNERING_MIN}+ minuten`,
            body: `${g.naam || 'Een bezoeker'} — ${g.onderwerp}`,
            linkUrl: crmGesprekPad(g.id),
            entityType: 'support_gesprek',
            entityId: g.id,
            priority: 'high',
            // Eén herinnering per gesprek per uur, anders wordt het geblaf.
            dedupWithinMs: 60 * 60 * 1000,
          });
        }
        uit.herinnerd++;
      }
    }
  } catch (e) {
    uit.fouten.push('herinnering: ' + (e?.message || e));
  }

  // ── 2. Stille gesprekken afhandelen ─────────────────────────────────────
  try {
    const grens = new Date(Date.now() - STIL_AFHANDELEN_DAGEN * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabaseAdmin
      .from('support_gesprekken')
      .select('id')
      .eq('status', 'wacht_op_klant')
      .lt('laatste_bericht_op', grens)
      .limit(100);

    for (const g of data || []) {
      try {
        await supabaseAdmin.from('support_gesprekken')
          .update({ status: 'afgehandeld', afgehandeld_op: new Date().toISOString() })
          .eq('id', g.id);
        await supabaseAdmin.from('support_berichten').insert({
          gesprek_id: g.id,
          afzender: 'systeem',
          tekst: `We hebben ${STIL_AFHANDELEN_DAGEN} dagen niets meer gehoord, dus we ronden dit gesprek af. Speelt het nog? Mail ons gerust.`,
          meta: { soort: 'auto_afgehandeld' },
        });
        uit.afgehandeld++;
      } catch (e2) {
        // Per gesprek afvangen: één kapotte rij mag de rest niet ophouden.
        uit.fouten.push(`afhandelen ${g.id}: ${e2?.message || e2}`);
      }
    }
  } catch (e) {
    uit.fouten.push('afhandelen: ' + (e?.message || e));
  }

  // ── 3. Dode hartslagen opruimen ─────────────────────────────────────────
  try {
    const grens = new Date(Date.now() - HARTSLAG_VENSTER_MS).toISOString();
    const { data } = await supabaseAdmin
      .from('support_aanwezigheid')
      .update({ beschikbaar: false, sinds: null })
      .eq('beschikbaar', true)
      .lt('bijgewerkt_op', grens)
      .select('user_id');
    uit.offline_gezet = (data || []).length;
  } catch (e) {
    uit.fouten.push('aanwezigheid: ' + (e?.message || e));
  }

  // ── 4. Gemiste teammail "nieuwe chat" inhalen ──────────────────────────
  try {
    const cfg = await haalAlarmInstellingen();
    if (cfg.mail_aan) {
      const grens = new Date(Date.now() - TEAMMAIL_VANGNET_MIN * 60 * 1000).toISOString();
      // Pas na twee minuten: een gesprek dat net begon, heeft zijn mail
      // misschien nog onderweg (waitUntil in support-start).
      const jongerDan = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      const { data } = await supabaseAdmin
        .from('support_gesprekken')
        .select('id')
        .is('team_gemaild_op', null)
        .neq('status', 'afgehandeld')
        .gte('created_at', grens)
        .lt('created_at', jongerDan)
        .limit(20);
      for (const g of data || []) {
        const r = await meldTeam({ gesprekId: g.id, cfg, alleenNieuw: true });
        if (r.verstuurd) uit.teammail_ingehaald++;
        else if (r.fout) uit.fouten.push(`teammail ${g.id}: ${r.fout}`);
      }
    }
  } catch (e) {
    uit.fouten.push('teammail: ' + (e?.message || e));
  }

  return res.status(200).json(uit);
}
