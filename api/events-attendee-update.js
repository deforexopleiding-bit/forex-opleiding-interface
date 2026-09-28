// api/events-attendee-update.js
// PATCH -> partial update van een deelnemer.
//
// Permission: events.attendee.edit.
//
// Query: ?id=<uuid>  (verplicht — attendee-id)
//
// Body (JSON, partial): { first_name?, last_name?, email?, phone?, customer_id?,
//                         follow_up_flagged?, follow_up_reason? }
//
// NB: status-wijziging gaat via events-attendee-status-change.js (aparte endpoint
//     met capacity-check + auto-tagging + timestamp-stempels).
//
// Audit-log: per veld dat verandert een entry met action='updated.<field>'.
// Email-uniciteit: 409 EMAIL_EXISTS bij duplicate.
//
// Response 200: { attendee: { ...row } }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { onAttendeePlekChange } from './_lib/event-attendee-mutations.js';
import { normaliseerStrict } from './_lib/phone-e164.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 'notitie' is de BROODJESNOTITIE uit de aanwezigenlijst en is iets anders dan
// 'notes' — die laatste is de vrije aantekening in het deelnemer-detailpaneel.
// Zie docs/sql-migrations/2026-09-23-event-attendees-notitie.sql.
const EDITABLE_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'customer_id', 'follow_up_flagged', 'follow_up_reason', 'called', 'call_status', 'notes', 'notitie'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ error: 'PATCH only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.attendee.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (events.attendee.edit)' });
  }

  const id = req.query?.id ? String(req.query.id) : null;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });

  const body = req.body || {};
  const patch = {};

  for (const f of EDITABLE_FIELDS) {
    if (body[f] === undefined) continue;
    const v = body[f];
    switch (f) {
      case 'first_name':
      case 'last_name':
        patch[f] = v === null || v === '' ? null : String(v).trim();
        break;
      // TELEFOON APART — naar E.164 of een leesbare 400. Leeggooien mag, een
      // niet-eenduidig nummer opslaan niet: dat leverde 159 rijen op waar
      // nooit een WhatsApp aankwam. Zie _lib/phone-e164.js.
      case 'phone': {
        if (v === null || v === '') { patch.phone = null; break; }
        const pn = normaliseerStrict(v);
        if (pn.fout) {
          return res.status(400).json({ error: pn.fout, field: 'phone', ambiguous: pn.ambigu });
        }
        patch.phone = pn.e164;
        break;
      }
      case 'email':
        if (v === null || v === '') patch.email = null;
        else {
          const e = String(v).trim();
          if (!EMAIL_RE.test(e)) return res.status(400).json({ error: 'email ongeldig' });
          patch.email = e;
        }
        break;
      case 'customer_id':
        if (v === null || v === '') patch.customer_id = null;
        else {
          if (!UUID_RE.test(String(v))) return res.status(400).json({ error: 'customer_id moet uuid zijn' });
          patch.customer_id = String(v);
        }
        break;
      case 'follow_up_flagged':
        patch.follow_up_flagged = !!v;
        break;
      case 'follow_up_reason':
        patch.follow_up_reason = v === null || v === '' ? null : String(v).trim();
        break;
      case 'called':
        patch.called_at = v ? new Date().toISOString() : null;
        break;
      case 'call_status':
        // Belstatus (vrije text-kolom, geen DB-CHECK — zie migratie 023).
        // Lege waarde → null ('— nog niet gebeld —'); stempel call_status_at.
        patch.call_status = (v === null || v === '') ? null : String(v).trim().toLowerCase();
        patch.call_status_at = new Date().toISOString();
        break;
      case 'notes':
        // FEATURE B — vrije-tekst notitie. Lege string → null zodat een
        // gewiste notitie ook echt weg is (in plaats van een lege string).
        patch.notes = v === null ? null : (String(v).trim() || null);
        break;
      case 'notitie':
        // De broodjesnotitie. Zelfde regel: wissen betekent NULL, niet een
        // lege string — anders staat er in de lijst een rij die 'iets
        // ingevuld' lijkt terwijl er niets staat.
        //
        // Begrensd op 500 tekens. Ruim genoeg voor '2x kaas, 1x hesp, geen
        // tomaat' en te krap om er een dagboek in te zetten dat de kolom in
        // de tabel onleesbaar maakt.
        patch.notitie = v === null ? null : (String(v).trim().slice(0, 500) || null);
        break;
      default:
        // shouldn't reach
        break;
    }
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Geen velden om te updaten' });
  }

  try {
    // Customer-id check: bestaande klant
    if (patch.customer_id) {
      const { data: cust, error: custErr } = await supabaseAdmin
        .from('customers')
        .select('id')
        .eq('id', patch.customer_id)
        .maybeSingle();
      if (custErr) throw new Error('customer-lookup: ' + custErr.message);
      if (!cust)   return res.status(400).json({ error: 'customer_id verwijst niet naar bestaande klant' });
    }

    // Before-state ophalen voor audit-log diff
    const { data: before, error: beforeErr } = await supabaseAdmin
      .from('event_attendees')
      // status / assessment_response_id / is_test staan erbij voor de
      // plek-vergelijking na de write: belstatus 'bevestigd' neemt sinds
      // 15 sep 2026 een plek in, dus een belstatuswijziging kan een event
      // vol maken of juist weer openen.
      .select('id, event_id, first_name, last_name, email, phone, customer_id, follow_up_flagged, follow_up_reason, call_status, status, assessment_response_id, is_test')
      .eq('id', id)
      .maybeSingle();
    if (beforeErr) throw new Error('before-fetch: ' + beforeErr.message);
    if (!before)   return res.status(404).json({ error: 'Deelnemer niet gevonden' });

    // ── WERKT MET ÉN ZONDER DE KOLOM `notitie` ─────────────────────────
    // Draait de migratie nog niet, dan faalt de HELE update met 42703 zodra
    // `notitie` in de patch staat — en dan landt ook een naamswijziging of
    // een belstatus in dezelfde aanroep niet. Dus: bij precies die fout één
    // keer opnieuw zónder dat veld, en eerlijk terugmelden dat de notitie
    // niet is opgeslagen. Stil 200 teruggeven zou erger zijn: dan denkt
    // iemand dat de broodjesbestelling vaststaat terwijl er niets staat.
    const VELDEN_TERUG = `
      id, event_id, first_name, last_name, email, phone, status,
      customer_id, deal_id, subscription_id,
      ghl_contact_id, ghl_form_submission_id, assessment_response_id,
      switched_from_event_id, switched_at,
      registered_at, attended_at, no_show_marked_at, sale_at,
      follow_up_flagged, follow_up_reason, called_at, call_status, call_status_at,
      created_at, updated_at`;
    const schrijf = (p, metNotitie) => supabaseAdmin
      .from('event_attendees')
      .update(p)
      .eq('id', id)
      .select(VELDEN_TERUG + (metNotitie ? ', notitie' : ''))
      .maybeSingle();

    const wilNotitie = Object.prototype.hasOwnProperty.call(patch, 'notitie');
    let notitieKolomOntbreekt = false;
    let { data: row, error } = await schrijf(patch, wilNotitie);
    if (error && error.code === '42703' && /\bnotitie\b/.test(error.message || '')) {
      notitieKolomOntbreekt = true;
      console.warn('[events-attendee-update] kolom notitie bestaat nog niet — '
        + 'draai docs/sql-migrations/2026-09-23-event-attendees-notitie.sql. '
        + 'De rest van deze wijziging is wel opgeslagen.');
      const { notitie: _weg, ...zonder } = patch;
      if (Object.keys(zonder).length === 0) {
        // Er viel verder niets te schrijven. Geen 200 met een lege belofte.
        return res.status(422).json({
          code : 'NOTITIE_KOLOM_ONTBREEKT',
          error: 'De notitie kon niet opgeslagen worden: de kolom bestaat nog niet in de databank. '
               + 'Draai docs/sql-migrations/2026-09-23-event-attendees-notitie.sql.',
        });
      }
      ({ data: row, error } = await schrijf(zonder, false));
    }
    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({
          code:  'EMAIL_EXISTS',
          error: 'Deze email is al aangemeld voor dit event',
        });
      }
      throw new Error('attendee-update: ' + error.message);
    }
    if (!row) return res.status(404).json({ error: 'Deelnemer niet gevonden' });

    // Kruist de belstatus de plek-grens, dan moet het event mee: vol raken
    // (sluiten) of weer plek krijgen (heropenen). Alleen bij een ECHTE
    // kanteling, en volledig fail-soft — de update staat al vast en mag
    // hier nooit meer op stuklopen.
    if (patch.call_status !== undefined) {
      // De update-select geeft is_test niet terug; die verandert hier ook
      // nooit, dus de waarde uit de before-state geldt voor beide kanten.
      await onAttendeePlekChange(
        before,
        { ...row, event_id: row.event_id || before.event_id, is_test: before.is_test },
        { reason: 'events-attendee-update' }
      );
    }

    // Audit-log per veld dat veranderde (fail-soft)
    try {
      const auditRows = [];
      for (const k of Object.keys(patch)) {
        if (before[k] === patch[k]) continue;
        auditRows.push({
          attendee_id:  id,
          action:       `updated.${k}`,
          before_state: { [k]: before[k] },
          after_state:  { [k]: patch[k] },
          by_user_id:   user?.id || null,
        });
      }
      if (auditRows.length > 0) {
        const { error: auErr } = await supabaseAdmin.from('event_attendee_audit_log').insert(auditRows);
        if (auErr) console.error('[events-attendee-update audit-insert]', auErr.message);
      }
    } catch (e) {
      console.error('[events-attendee-update audit]', e.message);
    }

    return res.status(200).json({
      attendee: row,
      // Alleen erbij als er om een notitie gevraagd is. De UI meldt het dan;
      // een stille 200 zou de indruk wekken dat de bestelling vaststaat.
      ...(notitieKolomOntbreekt ? {
        notitie_opgeslagen: false,
        notitie_reden: 'De kolom notitie bestaat nog niet in de databank. '
          + 'Draai docs/sql-migrations/2026-09-23-event-attendees-notitie.sql.',
      } : {}),
    });
  } catch (e) {
    console.error('[events-attendee-update]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
