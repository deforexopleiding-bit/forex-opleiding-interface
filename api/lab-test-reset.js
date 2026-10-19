// api/lab-test-reset.js
//
// "RESET — BEGIN ALS VERSE AANMELDING" — de CRM-kant van de resetknop in het
// "Lab-lead (test)"-account van een admin (LMS: /api/lab/testaccount, actie
// reset). Het LMS roept dit aan vóór het zijn eigen testdata wist, met de
// sessie van het testaccount als bearer.
//
//   POST /api/lab-test-reset  {}
//     → archiveert de TEST-belopdrachten van dit testaccount en annuleert een
//       geboekte TEST-afspraak. Daarna kan alles opnieuw: de belmelding kan
//       weer komen, de sessie kan weer geboekt worden.
//
// WIE MAG. Alleen een beheerd testaccount zelf: de lab-lead-rij van de
// aanroeper moet is_test = true én beheerd_door_auth_id gezet hebben (dat
// laatste staat alleen op de "Lab-lead (test)"-accounts — CHECK in het LMS).
// Een echte lead, een gewone testlead, een student of een zaalaccount krijgt
// 403. Dat het de EIGEN admin is die reset, bewaakt het LMS met het
// wisselbewijs; hier kan de aanroeper hoe dan ook enkel zijn eigen testdata
// raken.
//
// WAT ER GERAAKT WORDT, en niets anders:
//   · opvolging_taken  reden 'lab_bellen', is_test = true, van DEZE lab-lead.
//     Gearchiveerd (niet gewist) en losgekoppeld: `lab_lead_id` schuift naar
//     `lab_lead_id_voor_reset`. Anders blokkeert de unieke index (één taak per
//     lead per reden, ook na archiveren) elke nieuwe test-belmelding.
//   · follow_up_appointments  is_test = true, bron the-lab, van DIT adres, nog
//     gepland → geannuleerd. Een test-afspraak heeft geen GHL-afspraak (zie
//     lab-sessie.js), dus er valt in Daves agenda niets te annuleren.

import { supabaseAdmin } from './supabase.js';
import { applyLabCors, labPreflight } from './_lib/lab-cors.js';
import { lmsGebruikerUitToken } from './_lib/dfo-lms-lab-account.js';
import { LAB_BEL_REDEN } from './_lib/lab-belmelding.js';
import { LAB_SLUG } from './_lib/lab-config.js';
import { alleenDaglijst } from './_lib/opvolging-lijst.js';

const OPEN_AFSPRAAK = ['scheduled', 'wacht_op_reschedule'];

function bearer(req) {
  const h = String(req.headers?.authorization || '');
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null;
}

/** Is dit een beheerd testaccount? PURE. */
export function isBeheerdTestaccount(labLead) {
  return !!labLead && labLead.is_test === true && !!labLead.beheerd_door_auth_id;
}

export default async function handler(req, res) {
  applyLabCors(req, res, 'POST, OPTIONS');
  if (labPreflight(req, res, ['POST'])) return;

  let wie;
  try {
    wie = await lmsGebruikerUitToken(bearer(req));
  } catch (e) {
    console.error('[lab-test-reset] LMS-sessie controleren:', e?.message || e);
    return res.status(503).json({ ok: false, code: 'lms_onbereikbaar' });
  }
  if (!wie) return res.status(401).json({ ok: false, code: 'geen_sessie' });
  if (!isBeheerdTestaccount(wie.labLead)) return res.status(403).json({ ok: false, code: 'geen_testaccount' });
  const lab = wie.labLead;
  const nu = new Date().toISOString();

  // ── 1. De test-belopdrachten ──────────────────────────────────────────────
  // Belopdrachten van The Lab staan op de daglijst (taakRij in lab-belmelding.js).
  const { data: taken, error: te } = await alleenDaglijst(supabaseAdmin.from('opvolging_taken')
    .select('id, status, bron_ref'))
    .eq('reden', LAB_BEL_REDEN)
    .eq('is_test', true)
    .eq('bron_ref->>lab_lead_id', lab.id);
  if (te) {
    console.error('[lab-test-reset] taken lezen:', te.message);
    return res.status(500).json({ ok: false, code: 'taken_lezen' });
  }
  let gearchiveerd = 0;
  for (const t of taken || []) {
    const { lab_lead_id: weg, ...rest } = t.bron_ref || {};
    const patch = {
      bron_ref: { ...rest, lab_lead_id_voor_reset: weg, gereset_op: nu },
      updated_at: nu,
      ...(t.status === 'gearchiveerd' ? {} : { status: 'gearchiveerd', gearchiveerd_at: nu, archief_reden: 'Testaccount gereset' }),
    };
    const { error } = await supabaseAdmin.from('opvolging_taken').update(patch).eq('id', t.id).eq('is_test', true);
    if (error) {
      console.error('[lab-test-reset] taak archiveren:', { id: t.id, fout: error.message });
      return res.status(500).json({ ok: false, code: 'taak_archiveren' });
    }
    gearchiveerd++;
  }

  // ── 2. De test-afspraak ───────────────────────────────────────────────────
  const { data: afspraken, error: ae } = await supabaseAdmin.from('follow_up_appointments')
    .update({ status: 'cancelled', updated_at: nu })
    .eq('is_test', true)
    .eq('booking_source', LAB_SLUG)
    .eq('lead_email', String(lab.email || '').toLowerCase())
    .in('status', OPEN_AFSPRAAK)
    .select('id');
  if (ae) {
    console.error('[lab-test-reset] afspraak annuleren:', ae.message);
    return res.status(500).json({ ok: false, code: 'afspraak_annuleren' });
  }

  // ── 3. De test-strategiescan ──────────────────────────────────────────────
  // Bij elke Lab-boeking staat er een scan klaar (_lib/lab-scan.js). Voor een
  // test-afspraak is dat een TEST-concept in Daves Strategie-scans; dat gaat
  // weg met de afspraak. Alleen concepten van DEZE geannuleerde test-afspraken
  // met de TEST-naam — een scan die Dave al invulde (afgerond) blijft staan.
  const ids = (afspraken || []).map((a) => a.id);
  let scansGewist = 0;
  if (ids.length) {
    const { data: weg, error: se } = await supabaseAdmin.from('scans')
      .delete()
      .in('afspraak_id', ids)
      .eq('status', 'concept')
      .like('deelnemer_naam', 'TEST · %')
      .select('id');
    if (se) {
      console.error('[lab-test-reset] test-scan opruimen:', se.message);
      return res.status(500).json({ ok: false, code: 'scan_opruimen' });
    }
    scansGewist = (weg || []).length;
  }

  return res.status(200).json({ ok: true, taken_gearchiveerd: gearchiveerd, afspraken_geannuleerd: (afspraken || []).length, scans_gewist: scansGewist });
}
