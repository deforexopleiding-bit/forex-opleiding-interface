// api/lab-terugbellen.js
//
// "LIEVER EERST EEN VRAAG? → DAVE BELT JE" — vanuit het LMS (einde van The Lab,
// Jouw actieplan). De lead is ingelogd; zijn LMS-sessie gaat als bearer mee en
// wordt bij het LMS zelf gecontroleerd. Er gaat geen naam of nummer mee: die
// komen uit zijn lab-lead-rij.
//
//   POST /api/lab-terugbellen  { vraag?: string (max 300) }
//     → zet METEEN een belopdracht bovenaan Daves Opvolging (reden 'lab_bellen',
//       reden_code 'lab_vraag'), met zijn vraag in de notitie.
//
// Idempotent: één 'lab_vraag'-taak per lead (unieke index). Vraagt hij het
// opnieuw, of staat er al een andere open belopdracht, dan komt zijn vraag bij
// die bestaande kaart — Dave belt één keer.
// Al geboekt? Dan maken we niets (409 al_geboekt): hij spreekt Dave dan al.

import { supabaseAdmin } from './supabase.js';
import { applyLabCors, labPreflight } from './_lib/lab-cors.js';
import { lmsGebruikerUitToken } from './_lib/dfo-lms-lab-account.js';
import { alleenDaglijst } from './_lib/opvolging-lijst.js';
import { telefoonNlBe } from './_lib/phone-e164.js';
import { LAB_BEL_REDEN, taakRij } from './_lib/lab-belmelding.js';
import { checkRateLimit } from './_lib/rate-limit.js';

function bearer(req) {
  const h = String(req.headers?.authorization || '');
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null;
}

/** De vraag schoon: één regel, hoogstens 300 tekens. PURE. */
export function schoneVraag(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 300) : null;
}

export default async function handler(req, res) {
  applyLabCors(req, res, 'POST, OPTIONS');
  if (labPreflight(req, res, ['POST'])) return;

  let wie;
  try {
    wie = await lmsGebruikerUitToken(bearer(req));
  } catch (e) {
    console.error('[lab-terugbellen] LMS-sessie controleren:', e?.message || e);
    return res.status(503).json({ ok: false, code: 'lms_onbereikbaar' });
  }
  if (!wie) return res.status(401).json({ ok: false, code: 'geen_sessie' });
  if (!wie.labLead) return res.status(403).json({ ok: false, code: 'geen_lab_lead' });
  const lab = wie.labLead;

  const rl = await checkRateLimit({ req, bucket: 'lab-terugbellen', maxHits: 5, withinSeconds: 3600 }).catch(() => ({ limited: false }));
  if (rl?.limited) return res.status(429).json({ ok: false, code: 'te_veel' });

  if (lab.sessie_moment && Date.parse(lab.sessie_moment) > Date.now() - 3600 * 1000) {
    return res.status(409).json({ ok: false, code: 'al_geboekt' });
  }

  const nu = Date.now();
  const vraag = schoneVraag(req.body?.vraag);
  const regel = `Vroeg zelf om te bellen (${new Intl.DateTimeFormat('nl-BE', { timeZone: 'Europe/Brussels', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(nu))})${vraag ? `: "${vraag}"` : '.'}`;

  try {
    const { data: open, error: oe } = await alleenDaglijst(supabaseAdmin.from('opvolging_taken')
      .select('id, notitie'))
      .eq('reden', LAB_BEL_REDEN).eq('status', 'open')
      .eq('bron_ref->>lab_lead_id', lab.id)
      .limit(1);
    if (oe) throw new Error('lezen: ' + oe.message);

    if (open?.length) {
      const t = open[0];
      const notitie = [regel, String(t.notitie || '').trim()].filter(Boolean).join('\n\n');
      const { error } = await supabaseAdmin.from('opvolging_taken')
        .update({ notitie, updated_at: new Date(nu).toISOString() }).eq('id', t.id);
      if (error) throw new Error('bijwerken: ' + error.message);
      return res.status(200).json({ ok: true, taak: 'bestaand' });
    }

    // Zijn stand in The Lab, voor op de kaart.
    const rij = taakRij({ labLead: lab, sessie: null, reden: 'lab_vraag', nu });
    rij.notitie = `${regel} ${rij.notitie.replace(/^[^.]*\.\s*/, '')}`.trim();
    rij.telefoon = telefoonNlBe(rij.telefoon, { bron: 'lab-terugbellen' });
    const { error } = await supabaseAdmin.from('opvolging_taken').insert(rij);
    if (error && String(error.code) !== '23505') throw new Error('insert: ' + error.message);
    if (error) {
      // Er was ooit al een lab_vraag-kaart (gearchiveerd): open die opnieuw.
      const { error: he } = await supabaseAdmin.from('opvolging_taken')
        .update({ status: 'open', due: rij.due, gearchiveerd_at: null, archief_reden: null, notitie: rij.notitie, updated_at: new Date(nu).toISOString() })
        .eq('reden', LAB_BEL_REDEN).eq('reden_code', 'lab_vraag').eq('bron_ref->>lab_lead_id', lab.id);
      if (he) throw new Error('heropenen: ' + he.message);
      return res.status(200).json({ ok: true, taak: 'heropend' });
    }
    return res.status(200).json({ ok: true, taak: 'nieuw' });
  } catch (e) {
    console.error('[lab-terugbellen] mislukt', { lab_lead_id: lab.id, fout: e?.message || e });
    return res.status(500).json({ ok: false, code: 'fout' });
  }
}
