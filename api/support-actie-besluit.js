// api/support-actie-besluit.js
//
// POST — keur een voorgestelde actie goed of af.
//
// ── GOEDKEUREN EN UITVOEREN ─────────────────────────────────────────────────
// Staat de vlag `s2_acties_uitvoeren` aan (joost_config, module 'support')
// en is de soort uitvoerbaar, dan voert het systeem de handeling direct uit
// en komt de actie op 'uitgevoerd' of 'mislukt' te staan. Staat de vlag uit,
// of is de soort niet uitvoerbaar, dan blijft het bij 'goedgekeurd' en doet
// een collega het met de hand — precies zoals in S1.
//
// Uitvoeren gebeurt in api/_lib/support-actie-uitvoeren.js. Daar geldt één
// regel: een actie is pas uitgevoerd als het onderliggende systeem dat
// bevestigt. Bij twijfel wordt het 'mislukt' mét uitleg, nooit stilzwijgend
// 'uitgevoerd'.
//
// De belangrijkste grendel om te kennen: een LMS-uitnodiging opnieuw sturen
// mag NIET zomaar. Bij UITNODIGING_MAIL_MISLUKT werkt het oude wachtwoord
// nog en breekt een tweede mail dat. Alleen bij
// UITNODIGING_WACHTWOORD_NIET_GEZET is opnieuw sturen noodzaak. Die reden
// staat in payload.lms_reden zodat wie goedkeurt het ziet.

import { supabaseAdmin } from './supabase.js';
import { staffUit, verkeerdeMethode, basisHeaders } from './_lib/support-staff.js';
import { schrijfBericht } from './_lib/support-sessie.js';
import { voerActieUit, isUitvoerbaar } from './_lib/support-actie-uitvoeren.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BESLUITEN = { goedkeuren: 'goedgekeurd', afwijzen: 'afgewezen', uitgevoerd: 'uitgevoerd' };

/**
 * Staat de S2-vlag aan? Fail-CLOSED: kunnen we de configuratie niet lezen,
 * dan voeren we niets uit en blijft de actie op 'goedgekeurd' staan. Een
 * handeling die per ongeluk draait omdat een query faalde, is erger dan een
 * handeling die een collega zelf moet doen.
 */
async function mag_uitvoeren() {
  try {
    const { data, error } = await supabaseAdmin
      .from('joost_config').select('feature_flags').eq('module', 'support').maybeSingle();
    if (error) throw new Error(error.message);
    return data?.feature_flags?.s2_acties_uitvoeren === true;
  } catch (e) {
    console.warn('[support-actie-besluit] vlag lezen mislukt (fail-closed):', e?.message || e);
    return false;
  }
}

export default async function handler(req, res) {
  basisHeaders(res);
  if (verkeerdeMethode(req, res, 'POST')) return;

  const staff = await staffUit(req, res, 'support.actie.besluit');
  if (!staff) return;

  const id = String(req.body?.actie_id || '');
  const besluit = BESLUITEN[String(req.body?.besluit || '')];
  const reden = String(req.body?.reden || '').trim().slice(0, 500);

  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Ongeldig actie_id' });
  if (!besluit) return res.status(400).json({ error: 'besluit moet goedkeuren, afwijzen of uitgevoerd zijn' });

  try {
    const { data: actie } = await supabaseAdmin
      .from('support_acties').select('*').eq('id', id).maybeSingle();
    if (!actie) return res.status(404).json({ error: 'Actie niet gevonden' });

    // Alleen vooruit. Een afgewezen actie weer goedkeuren zou de
    // beslisgeschiedenis onleesbaar maken; maak dan een nieuwe aan.
    if (besluit !== 'uitgevoerd' && actie.status !== 'voorgesteld') {
      return res.status(409).json({ error: `Deze actie staat al op ${actie.status}.` });
    }
    // Ook een MISLUKTE actie mag alsnog op uitgevoerd: de collega heeft het
    // dan met de hand gedaan — precies waar de knop "Toch gedaan" voor is.
    // Dat is het herstelpad bij de LMS-grendel. Een actie die al op
    // 'uitgevoerd' (of 'afgewezen', of nog 'voorgesteld') staat mag dat niet,
    // zodat een tweede klik de klant geen tweede bericht bezorgt.
    if (besluit === 'uitgevoerd' && !['goedgekeurd', 'mislukt'].includes(actie.status)) {
      return res.status(409).json({ error: `Alleen een goedgekeurde of mislukte actie kan op uitgevoerd (deze staat op ${actie.status}).` });
    }

    const patch = { status: besluit, besluit_reden: reden || null };
    if (besluit === 'uitgevoerd') {
      patch.uitgevoerd_op = new Date().toISOString();
    } else {
      patch.besloten_door = staff.user.id;
      patch.besloten_op = new Date().toISOString();
    }

    // ── S2: direct uitvoeren na goedkeuring ─────────────────────────────
    let uitkomst = null;
    if (besluit === 'goedgekeurd' && isUitvoerbaar(actie.soort) && await mag_uitvoeren()) {
      uitkomst = await voerActieUit(actie);
      patch.status = uitkomst.status;
      patch.uitgevoerd_op = new Date().toISOString();
      patch.uitvoer_resultaat = uitkomst.resultaat || {};
      // De uitleg bij een mislukking hoort bij het besluit te staan, niet
      // alleen in het resultaat-json: dat is wat de collega in de lijst ziet.
      if (uitkomst.status === 'mislukt' && uitkomst.uitleg) {
        patch.besluit_reden = [reden, uitkomst.uitleg].filter(Boolean).join(' — ').slice(0, 500);
      }
    }

    const { data, error } = await supabaseAdmin
      .from('support_acties').update(patch).eq('id', id).select().maybeSingle();
    if (error) throw new Error(error.message);

    // Bij uitvoering mag de bezoeker dat weten — dat is tenslotte waar 'ie
    // op zat te wachten. Bij goedkeuren nog niet: er is dan nog niets
    // gebeurd, en "het is goedgekeurd" leest als "het is geregeld".
    if (besluit === 'uitgevoerd') {
      await schrijfBericht({
        gesprekId: actie.gesprek_id,
        afzender: 'systeem',
        tekst: `We hebben dit voor je gedaan: ${actie.omschrijving}`,
        meta: { soort: 'actie_uitgevoerd', actie_id: id },
      });
    } else if (uitkomst && uitkomst.status === 'uitgevoerd' && uitkomst.klantBericht) {
      // Alleen bij een bevestigde uitvoering, en met de tekst die bij de
      // handeling hoort — niet de interne omschrijving, die is voor ons.
      await schrijfBericht({
        gesprekId: actie.gesprek_id,
        afzender: 'systeem',
        tekst: uitkomst.klantBericht,
        meta: { soort: 'actie_uitgevoerd', actie_id: id, automatisch: true },
      });
    }

    return res.status(200).json({ actie: data, uitvoering: uitkomst ? {
      status: uitkomst.status, uitleg: uitkomst.uitleg || null,
    } : null });
  } catch (e) {
    console.error('[support-actie-besluit] mislukt:', e?.message || e);
    return res.status(500).json({ error: 'Kon het besluit niet opslaan.' });
  }
}
