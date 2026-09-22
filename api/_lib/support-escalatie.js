// api/_lib/support-escalatie.js
//
// Eén plek waar een gesprek van de bot naar een mens gaat. Drie dingen
// moeten dan altijd samen gebeuren — status omzetten, een systeemregel in de
// thread, en iemand op de hoogte stellen — en als dat op drie plekken apart
// geregeld wordt, gaat er op den duur één ontbreken en wacht er iemand voor
// niets.

import { supabaseAdmin } from '../supabase.js';
import { schrijfBericht } from './support-sessie.js';
import { beschikbaarheidsTekst } from './support-beschikbaarheid.js';
import { createNotification, resolveOntvangersVoorRecht } from './notify.js';

/**
 * Zet een gesprek in de wachtrij.
 *
 * @param {object} opts
 * @param {object} opts.gesprek
 * @param {string} opts.reden          — machineleesbaar, voor de audit
 * @param {object} opts.beschikbaarheid
 * @param {string} [opts.antwoordMailbox]
 * @param {boolean} [opts.stilleMelding] — geen systeemregel in de thread
 * @returns {Promise<{melding:string|null}>}
 */
export async function escaleerGesprek({ gesprek, reden, beschikbaarheid, antwoordMailbox, stilleMelding = false }) {
  // Al opgepakt of al afgehandeld? Dan niet terugzetten naar de wachtrij —
  // dat zou een gesprek uit de handen van een collega trekken.
  const terugZetten = gesprek.status === 'bot' || gesprek.status === 'wacht_op_klant';

  try {
    if (terugZetten) {
      await supabaseAdmin
        .from('support_gesprekken')
        .update({
          status: 'wacht_op_ons',
          escalatie_reden: String(reden || '').slice(0, 200),
        })
        .eq('id', gesprek.id);
    }
  } catch (e) {
    console.warn('[support-escalatie] status bijwerken mislukt:', e?.message || e);
  }

  let melding = null;
  if (!stilleMelding) {
    melding = beschikbaarheid?.live
      ? 'Ik zet je vraag door naar een collega — er zit nu iemand aan de chat.'
      : beschikbaarheidsTekst(beschikbaarheid, antwoordMailbox);
    await schrijfBericht({
      gesprekId: gesprek.id,
      afzender: 'systeem',
      tekst: melding,
      meta: { reden },
    });
  }

  // Notificatie naar iedereen met het recht om te antwoorden. Fail-soft:
  // createNotification vangt zelf af, maar de resolve kan ook stuklopen.
  try {
    // resolveOntvangersVoorRecht geeft { ok, userIds, ... } terug, geen
    // kale array — en bij een fout is userIds leeg, niet undefined.
    const { userIds } = await resolveOntvangersVoorRecht('support.reply');
    for (const userId of (userIds || []).slice(0, 25)) {
      await createNotification({
        toUserId: userId,
        type: 'support.wacht_op_ons',
        title: `Supportvraag ${gesprek.kenmerk}`,
        body: `${gesprek.naam || 'Een bezoeker'} wacht op antwoord (${gesprek.onderwerp}).`,
        linkUrl: `/modules/klanten-v2/?mod=support&gesprek=${gesprek.id}`,
        entityType: 'support_gesprek',
        entityId: gesprek.id,
        priority: beschikbaarheid?.live ? 'high' : 'normal',
        dedupWithinMs: 5 * 60 * 1000,
      });
    }
  } catch (e) {
    console.warn('[support-escalatie] notificatie mislukt:', e?.message || e);
  }

  return { melding };
}
