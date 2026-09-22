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
// ── DRIE SCHRIJFACTIES, IN DEZE VOLGORDE ────────────────────────────────────
// 1. CLAIM   — de actie van zijn huidige stand naar de nieuwe zetten, mét een
//              grendel op die huidige stand. Nul geraakte rijen betekent dat
//              een collega 'm net voor je neus wegkaapte: 409, en er is dan
//              nog NIETS uitgevoerd.
// 2. UITVOEREN — pas daarna, en alleen door wie de claim won.
// 3. VASTLEGGEN — de uitkomst wegschrijven.
//
// Waarom niet in één schrijfactie vooraf: dan staat een actie op 'uitgevoerd'
// voordat het onderliggende systeem iets bevestigd heeft, en dat is precies
// wat deze fase moet voorkomen. Waarom niet in één schrijfactie achteraf: dan
// kunnen twee collega's tegelijk dezelfde handeling uitvoeren, want tussen het
// lezen en het schrijven zit de hele uitvoering.
//
// De claim gebruikt 'goedgekeurd' als tussenstand en heeft daarom geen nieuwe
// status (en geen migratie) nodig. Dat pakt ook goed uit als het proces
// halverwege omvalt: de actie blijft op 'goedgekeurd' staan, en dat is exact
// de S1-toestand waar de knop "Gedaan" voor bestaat.
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
 * Vanuit welke stand een besluit genomen mag worden. Alleen vooruit: een
 * afgewezen actie weer goedkeuren zou de beslisgeschiedenis onleesbaar maken,
 * maak dan een nieuwe aan. 'uitgevoerd' mag óók vanuit 'mislukt', want dat is
 * de knop "Toch gedaan" — de collega heeft het met de hand geregeld. Vanuit
 * 'uitgevoerd' mag niets meer, anders krijgt de klant een tweede bericht.
 */
const CLAIM_VANUIT = {
  goedgekeurd: ['voorgesteld'],
  afgewezen:   ['voorgesteld'],
  uitgevoerd:  ['goedgekeurd', 'mislukt'],
};

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

/**
 * Atomische claim: zet de actie naar `naar`, maar alléén als hij nog in een
 * van de toegestane standen staat. De grendel zit in de query zelf, dus twee
 * gelijktijdige klikken kunnen niet allebei winnen — de database beslist.
 *
 * @returns {Promise<object|null>} de geclaimde rij, of null bij nul geraakte
 *   rijen (iemand anders was eerder).
 */
async function claim(id, naar, velden) {
  const { data, error } = await supabaseAdmin
    .from('support_acties')
    .update({ ...velden, status: naar })
    .eq('id', id)
    .in('status', CLAIM_VANUIT[naar])
    .select();
  if (error) throw new Error(error.message);
  const rijen = Array.isArray(data) ? data : (data ? [data] : []);
  return rijen[0] || null;
}

/** De huidige stand, voor een eerlijke melding na een verloren claim. */
async function huidigeStand(id) {
  try {
    const { data } = await supabaseAdmin
      .from('support_acties').select('status').eq('id', id).maybeSingle();
    return data?.status || null;
  } catch (_) {
    return null;
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
    // Lezen voor de soort, het gesprek en een nette 404. De stand die hier
    // uitkomt is NIET waar we op beslissen — dat doet de claim hieronder,
    // want tussen dit lezen en dat schrijven kan een collega ertussen zitten.
    const { data: actie } = await supabaseAdmin
      .from('support_acties').select('*').eq('id', id).maybeSingle();
    if (!actie) return res.status(404).json({ error: 'Actie niet gevonden' });

    // ── 1. CLAIM ────────────────────────────────────────────────────────
    const velden = { besluit_reden: reden || null };
    if (besluit === 'uitgevoerd') {
      velden.uitgevoerd_op = new Date().toISOString();
    } else {
      velden.besloten_door = staff.user.id;
      velden.besloten_op = new Date().toISOString();
    }

    const geclaimd = await claim(id, besluit, velden);
    if (!geclaimd) {
      // Nul geraakte rijen. Er is niets uitgevoerd en niets gewijzigd.
      const stand = await huidigeStand(id);
      return res.status(409).json({
        error: stand
          ? `Deze actie staat inmiddels op ${stand} — iemand anders was je net voor.`
          : 'Deze actie is niet meer in een stand waarin dit besluit kan.',
        status: stand,
      });
    }

    // ── 2. UITVOEREN ────────────────────────────────────────────────────
    // Alleen wie de claim won komt hier. De actie staat nu op 'goedgekeurd';
    // valt het proces hierna om, dan blijft 'ie daar staan en pakt een collega
    // 'm met de hand op — de S1-toestand.
    let uitkomst = null;
    let rij = geclaimd;

    if (besluit === 'goedgekeurd' && isUitvoerbaar(actie.soort) && await mag_uitvoeren()) {
      uitkomst = await voerActieUit(actie);

      // ── 3. VASTLEGGEN ─────────────────────────────────────────────────
      const slot = {
        status: uitkomst.status,
        uitgevoerd_op: new Date().toISOString(),
        uitvoer_resultaat: uitkomst.resultaat || {},
      };
      // De uitleg bij een mislukking hoort bij het besluit te staan, niet
      // alleen in het resultaat-json: dat is wat de collega in de lijst ziet.
      if (uitkomst.status === 'mislukt' && uitkomst.uitleg) {
        slot.besluit_reden = [reden, uitkomst.uitleg].filter(Boolean).join(' — ').slice(0, 500);
      }

      const { data: na, error: slotFout } = await supabaseAdmin
        .from('support_acties').update(slot).eq('id', id).select().maybeSingle();

      if (slotFout || !na) {
        // De handeling is gebeurd, de administratie niet. Dat mag NOOIT
        // stilletjes voorbijgaan: het resultaat staat nergens meer, dus het
        // gaat hier luid de log in — inclusief wat er precies is uitgevoerd,
        // zodat het handmatig terug te vinden is.
        console.error(
          '[support-actie-besluit] UITGEVOERD MAAR NIET VASTGELEGD — actie', id,
          '| soort', actie.soort,
          '| gesprek', actie.gesprek_id,
          '| uitkomst', uitkomst.status,
          '| resultaat', JSON.stringify(uitkomst.resultaat || {}),
          '| schrijffout:', slotFout?.message || 'nul rijen geraakt',
        );
        // Geen bericht naar de klant: de actie staat nog op 'goedgekeurd', dus
        // de collega zet 'm zo meteen op gedaan en DAN krijgt de klant bericht.
        // Nu al sturen zou dat bericht verdubbelen.
        return res.status(500).json({
          error: 'De actie is WÉL uitgevoerd, maar het vastleggen mislukte. De actie'
            + ' staat nog op goedgekeurd en de klant heeft nog geen bericht gekregen.'
            + ' Controleer of de handeling gelukt is en zet hem daarna op gedaan.',
          uitvoering: {
            status: uitkomst.status,
            uitleg: uitkomst.uitleg || null,
            vastgelegd: false,
          },
        });
      }
      rij = na;
    }

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

    return res.status(200).json({ actie: rij, uitvoering: uitkomst ? {
      status: uitkomst.status, uitleg: uitkomst.uitleg || null, vastgelegd: true,
    } : null });
  } catch (e) {
    console.error('[support-actie-besluit] mislukt:', e?.message || e);
    return res.status(500).json({ error: 'Kon het besluit niet opslaan.' });
  }
}
