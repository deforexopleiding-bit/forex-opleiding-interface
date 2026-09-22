// api/iris-actie.js
//
// Eén stap uitvoeren.
//
//   POST { actie: 'klaarzetten', opdracht_id?, contact_id?, type, parameters, idempotentie? }
//   POST { actie: 'uitvoeren',   id }
//   POST { actie: 'annuleren',   id }
//
// Recht: iris.post.beantwoorden voor klaarzetten, per type een eigen recht
// voor uitvoeren (zie RECHT_PER_TYPE).
//
// ── ÉÉN PLEK WAAR IETS ÉCHT GEBEURT ──────────────────────────────────────────
// De opdracht-module maakt plannen, de post-module maakt concepten, maar
// uitvoeren gebeurt alleen hier. Dat is geen ordelijkheid om de ordelijkheid:
// het betekent dat er precies één plaats is waar de rechten, de idempotentie
// en het logboek geregeld zijn. Twee plekken zouden betekenen dat de tweede de
// eerste na een half jaar stilletjes achterna hinkt.
//
// ── DE IDEMPOTENTIESLEUTEL ───────────────────────────────────────────────────
// UNIQUE op iris_acties. Een dubbele klik botst erop, en dat vangen we op als
// "al gedaan" met de bestaande rij terug. Dat is het enige waterdichte
// antwoord op dubbelklikken — een uitgeschakelde knop niet, want het eerste
// verzoek kan al onderweg zijn.
//
// De sleutel wordt gebouwd uit wat de stap UNIEK maakt, niet uit een
// toevalsgetal. Anders zou elke klik een nieuwe sleutel geven en beschermt de
// constraint nergens tegen.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getDfoLmsClient } from './_lib/dfo-lms-db.js';
import { STAPTYPES } from './_lib/iris/opdracht.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Welk recht welke stap vereist.
 *
 * Niet alles is even zwaar. Iemand op de belrij zetten is een notitie; iemands
 * toegang verlengen raakt wat een klant kan. Daarom per type een eigen sleutel
 * in plaats van één grove poort.
 */
export const RECHT_PER_TYPE = Object.freeze({
  wa_versturen: 'iris.versturen',
  mail_versturen: 'iris.versturen',
  lms_toegang_verlengen: 'iris.lms.acties',
  lms_uitnodiging: 'iris.lms.acties',
  lms_on_hold: 'iris.lms.acties',
  belofte_vastleggen: 'iris.post.beantwoorden',
  afbetalingsplan: 'iris.post.beantwoorden',
  taak_aanmaken: 'iris.post.beantwoorden',
  belrij_toevoegen: 'iris.belrij',
  factuur_nakijken: 'iris.post.beantwoorden',
});

/**
 * Bouw een idempotentiesleutel uit wat een stap uniek maakt.
 *
 * Geen tijdstempel en geen toevalsgetal: die zouden elke klik uniek maken en
 * dan beschermt de constraint nergens tegen. Wel de dag erin, want dezelfde
 * stap morgen opnieuw doen is een geldige handeling.
 */
export function bouwSleutel({ type, contactId, opdrachtId, parameters, op = new Date() }) {
  const dag = op.toISOString().slice(0, 10);
  const kern = [
    type,
    contactId || 'geen-contact',
    opdrachtId || 'los',
    dag,
    stabielJson(parameters),
  ].join('|');
  return kern.slice(0, 400);
}

/** JSON met gesorteerde sleutels, zodat dezelfde inhoud dezelfde tekst geeft. */
function stabielJson(o) {
  if (!o || typeof o !== 'object') return String(o ?? '');
  if (Array.isArray(o)) return '[' + o.map(stabielJson).join(',') + ']';
  return '{' + Object.keys(o).sort().map((k) => `${k}:${stabielJson(o[k])}`).join(',') + '}';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Alleen POST' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet aangemeld' });

  const actie = String(req.body?.actie || '').trim();

  try {
    if (actie === 'klaarzetten') return await klaarzetten(req, res, user);
    if (actie === 'uitvoeren') return await uitvoeren(req, res, user);
    if (actie === 'annuleren') return await annuleren(req, res, user);
    return res.status(400).json({ error: `onbekende actie: ${actie || '(leeg)'}` });
  } catch (e) {
    console.error('[iris-actie]', actie, e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

// ── Klaarzetten ──────────────────────────────────────────────────────────────

async function klaarzetten(req, res, user) {
  if (!(await requirePermission(req, 'iris.post.beantwoorden'))) {
    return res.status(403).json({ error: 'Geen rechten (iris.post.beantwoorden)' });
  }

  const type = String(req.body?.type || '').trim();
  if (!STAPTYPES.includes(type)) {
    return res.status(400).json({ error: `onbekend type: ${type || '(leeg)'}`, toegestaan: STAPTYPES });
  }
  const contactId = String(req.body?.contact_id || '').trim() || null;
  const opdrachtId = String(req.body?.opdracht_id || '').trim() || null;
  if (contactId && !UUID_RE.test(contactId)) return res.status(400).json({ error: 'contact_id moet een geldige uuid zijn' });
  if (opdrachtId && !UUID_RE.test(opdrachtId)) return res.status(400).json({ error: 'opdracht_id moet een geldige uuid zijn' });

  const parameters = (req.body?.parameters && typeof req.body.parameters === 'object' && !Array.isArray(req.body.parameters))
    ? req.body.parameters : {};
  const sleutel = String(req.body?.idempotentie || '').trim()
    || bouwSleutel({ type, contactId, opdrachtId, parameters });

  const { data, error } = await supabaseAdmin
    .from('iris_acties')
    .insert({
      opdracht_id: opdrachtId,
      contact_id: contactId,
      type,
      parameters,
      status: 'klaar',
      idempotentie: sleutel,
    })
    .select('*')
    .single();

  if (error) {
    if (String(error.code) === '23505') {
      // Al klaargezet. Dat is geen fout: de gebruiker wilde deze stap, en die
      // staat er. Geef de bestaande rij terug zodat het scherm "✓ gedaan" kan
      // tonen met een verwijzing naar wat er al is.
      const { data: bestaand } = await supabaseAdmin
        .from('iris_acties').select('*').eq('idempotentie', sleutel).maybeSingle();
      return res.status(200).json({ actie: bestaand, al_gedaan: true });
    }
    throw new Error('actie opslaan: ' + error.message);
  }

  return res.status(200).json({ actie: data, al_gedaan: false });
}

// ── Uitvoeren ────────────────────────────────────────────────────────────────

async function uitvoeren(req, res, user) {
  const id = String(req.body?.id || '').trim();
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id moet een geldige uuid zijn' });

  const { data: actie, error } = await supabaseAdmin
    .from('iris_acties').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error('actie: ' + error.message);
  if (!actie) return res.status(404).json({ error: 'Stap niet gevonden' });

  const recht = RECHT_PER_TYPE[actie.type];
  if (!recht || !(await requirePermission(req, recht))) {
    return res.status(403).json({ error: `Geen rechten (${recht || 'onbekend type'})` });
  }

  // De claim. Van klaar/goedgekeurd naar uitgevoerd lukt één keer. Zou dit een
  // gewone update zijn, dan kon dezelfde stap bij een samenloop twee keer
  // gedaan worden — en twee keer toegang verlengen is twee keer zo lang.
  const { data: geclaimd, error: claimFout } = await supabaseAdmin
    .from('iris_acties')
    .update({ status: 'uitgevoerd', uitgevoerd_op: new Date().toISOString(), uitgevoerd_door: user.id })
    .eq('id', id)
    .in('status', ['klaar', 'goedgekeurd'])
    .select('*')
    .maybeSingle();
  if (claimFout) throw new Error('claim: ' + claimFout.message);
  if (!geclaimd) {
    return res.status(409).json({
      error: 'Deze stap is al opgepakt',
      status: actie.status,
      uitleg: actie.status === 'uitgevoerd' ? 'Hij is al uitgevoerd.' : `Status is "${actie.status}".`,
    });
  }

  try {
    const resultaat = await voerUit(geclaimd, user);
    await supabaseAdmin.from('iris_acties').update({ resultaat, fout: null }).eq('id', id);
    await logStap(user, geclaimd, 'ok', null);
    return res.status(200).json({ ok: true, resultaat });
  } catch (e) {
    const tekst = e?.message || String(e);
    console.error('[iris-actie] uitvoeren mislukt:', geclaimd.type, tekst);
    // Terug naar 'mislukt', niet naar 'klaar'. Anders blijft iets wat
    // structureel niet kan, eindeloos opnieuw geprobeerd worden.
    await supabaseAdmin
      .from('iris_acties')
      .update({ status: 'mislukt', fout: tekst.slice(0, 500) })
      .eq('id', id);
    await logStap(user, geclaimd, 'mislukt', tekst);
    return res.status(502).json({ error: 'Stap mislukt', uitleg: tekst });
  }
}

async function annuleren(req, res, user) {
  if (!(await requirePermission(req, 'iris.post.beantwoorden'))) {
    return res.status(403).json({ error: 'Geen rechten (iris.post.beantwoorden)' });
  }
  const id = String(req.body?.id || '').trim();
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id moet een geldige uuid zijn' });

  const { data, error } = await supabaseAdmin
    .from('iris_acties')
    .update({ status: 'geannuleerd' })
    .eq('id', id)
    .in('status', ['klaar', 'goedgekeurd'])
    .select('id, status')
    .maybeSingle();
  if (error) throw new Error('annuleren: ' + error.message);
  if (!data) return res.status(409).json({ error: 'Deze stap is niet meer te annuleren' });
  return res.status(200).json({ ok: true });
}

// ── Wat elke stap doet ───────────────────────────────────────────────────────

async function voerUit(actie, user) {
  const p = actie.parameters || {};

  switch (actie.type) {
    case 'belofte_vastleggen': {
      if (!actie.contact_id) throw new Error('belofte zonder contact');
      if (!p.datum) throw new Error('belofte zonder datum');
      const { data: contact } = await supabaseAdmin
        .from('iris_contacten').select('customer_id').eq('id', actie.contact_id).maybeSingle();
      const { data, error } = await supabaseAdmin
        .from('iris_beloftes')
        .insert({
          contact_id: actie.contact_id,
          customer_id: contact?.customer_id || null,
          factuur_ids: Array.isArray(p.factuur_ids) ? p.factuur_ids : [],
          bedrag: p.bedrag != null ? Number(p.bedrag) : null,
          datum: p.datum,
          bron: ['klant', 'maxim', 'dave', 'iris'].includes(p.bron) ? p.bron : 'iris',
          notitie: p.notitie || null,
          aangemaakt_door: user.id,
        })
        .select('id, datum, bedrag')
        .single();
      if (error) throw new Error('belofte opslaan: ' + error.message);
      return { belofte_id: data.id, datum: data.datum, bedrag: data.bedrag };
    }

    case 'belrij_toevoegen': {
      if (!actie.contact_id) throw new Error('belrij zonder contact');
      const { data, error } = await supabaseAdmin
        .from('iris_belrij')
        .insert({
          contact_id: actie.contact_id,
          reden: String(p.reden || 'handmatig toegevoegd').slice(0, 200),
          reden_detail: p.detail || null,
          eigenaar: p.eigenaar || null,
          prioriteit: Number.isFinite(Number(p.prioriteit)) ? Number(p.prioriteit) : 50,
          bron: ['wanbetaler', 'onboarding', 'mentorsignaal', 'geen_reactie', 'hand'].includes(p.bron) ? p.bron : 'hand',
        })
        .select('id')
        .single();
      if (error) throw new Error('belrij opslaan: ' + error.message);
      return { belrij_id: data.id };
    }

    case 'lms_toegang_verlengen': {
      const client = getDfoLmsClient();
      if (!client) throw new Error('LMS-koppeling niet geconfigureerd');
      const dagen = Number(p.dagen);
      if (!Number.isInteger(dagen) || dagen < 1 || dagen > 365) {
        throw new Error('dagen moet tussen 1 en 365 liggen');
      }
      const studentId = p.student_id || (await zoekStudent(client, actie.contact_id));
      if (!studentId) throw new Error('geen student gevonden');

      const { data: student, error: lFout } = await client
        .from('hlms_student').select('id, eind_datum').eq('id', studentId).maybeSingle();
      if (lFout) throw new Error('student lezen: ' + lFout.message);
      if (!student) throw new Error('student niet gevonden');

      // Verlengen gaat altijd vooruit vanaf de HUIDIGE einddatum, of vanaf
      // vandaag als die al verstreken is. Vooruit vanaf een verlopen datum zou
      // betekenen dat iemand die drie maanden geleden afliep, na een verlenging
      // van twee weken nog steeds geen toegang heeft.
      const nu = new Date();
      const huidig = student.eind_datum ? new Date(student.eind_datum + 'T00:00:00') : nu;
      const basis = huidig.getTime() > nu.getTime() ? huidig : nu;
      const nieuw = new Date(basis.getTime() + dagen * 24 * 3600 * 1000);
      const nieuweDatum = nieuw.toISOString().slice(0, 10);

      const { error: sFout } = await client
        .from('hlms_student').update({ eind_datum: nieuweDatum }).eq('id', studentId);
      if (sFout) throw new Error('einddatum zetten: ' + sFout.message);

      return { student_id: studentId, was: student.eind_datum, wordt: nieuweDatum, dagen };
    }

    case 'factuur_nakijken': {
      // Iris zet NOOIT een factuur op betaald. Ze maakt er een taak van voor
      // een mens, in het bestaande takenbakje.
      const { data, error } = await supabaseAdmin
        .from('pending_actions')
        .insert({
          action_type: 'MANUAL_VERIFY_PAYMENT',
          status: 'PENDING',
          invoice_id: p.factuur_id || null,
          payload: {
            source: 'iris',
            iris_actie_id: actie.id,
            toelichting: p.toelichting || 'Klant zegt betaald te hebben.',
          },
        })
        .select('id')
        .single();
      if (error) throw new Error('taak aanmaken: ' + error.message);
      return { taak_id: data.id };
    }

    case 'taak_aanmaken': {
      const { data, error } = await supabaseAdmin
        .from('pending_actions')
        .insert({
          action_type: 'MANUAL_FOLLOWUP',
          status: 'PENDING',
          payload: {
            source: 'iris',
            iris_actie_id: actie.id,
            omschrijving: String(p.omschrijving || 'Taak vanuit Iris').slice(0, 500),
          },
        })
        .select('id')
        .single();
      if (error) throw new Error('taak aanmaken: ' + error.message);
      return { taak_id: data.id };
    }

    // Verzenden en de overige LMS-stappen komen in een volgende stap. Ze
    // staan hier uitdrukkelijk als "nog niet", zodat er geen stap is die
    // stilletjes niets doet en er in het scherm uitziet alsof hij lukte.
    case 'wa_versturen':
    case 'mail_versturen':
      throw new Error('Versturen loopt via de Post, niet via deze stap.');

    case 'lms_uitnodiging':
    case 'lms_on_hold':
    case 'afbetalingsplan':
      throw new Error(`Stap "${actie.type}" is nog niet ingebouwd.`);

    default:
      throw new Error(`Onbekend staptype: ${actie.type}`);
  }
}

async function zoekStudent(client, contactId) {
  if (!contactId) return null;
  const { data: contact } = await supabaseAdmin
    .from('iris_contacten').select('hlms_student_id, emails').eq('id', contactId).maybeSingle();
  if (contact?.hlms_student_id) return contact.hlms_student_id;
  const emails = (contact?.emails || []).map((e) => String(e).toLowerCase());
  if (!emails.length) return null;
  const { data } = await client.from('hlms_student').select('id').in('email', emails).limit(2);
  // Bij twee studenten op hetzelfde adres kiezen we er geen. Toegang verlengen
  // van de verkeerde persoon is niet terug te draaien zonder dat iemand het merkt.
  return (data || []).length === 1 ? data[0].id : null;
}

async function logStap(user, actie, resultaat, fout) {
  const { error } = await supabaseAdmin.from('iris_log').insert({
    wie: user.id,
    wat: `stap uitgevoerd: ${actie.type}`,
    contact_id: actie.contact_id,
    resultaat,
    fout: fout ? String(fout).slice(0, 500) : null,
    details: { actie_id: actie.id, opdracht_id: actie.opdracht_id },
  });
  if (error) console.warn('[iris-actie] logregel mislukt:', error.message);
}
