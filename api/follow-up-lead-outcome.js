// api/follow-up-lead-outcome.js
//
// POST — cadans-motor voor Sales-cockpit Leads-tab (Fase 2).
//
// Body: {
//   lead_id: uuid,
//   outcome: 'geen_gehoor' | 'voicemail' | 'foutief_nummer' |
//            'terugbel' | 'zoom_ingepland' |
//            'sale' | 'geen_interesse' | 'snooze' |
//            'noshow' | 'gesprek_gehad',
//   terugbel_datum?: ISO,     // vereist bij terugbel / zoom_ingepland
//   is_hot?: boolean,          // alleen zinvol bij terugbel
//   snooze_months?: 6 | 12,    // vereist bij snooze
//   reason?: string,           // optioneel bij geen_interesse
// }
//
// Permissie + owner-gate: exact zoals api/follow-up-lead-update.js.
// Cadans-constante: [+2u, +1d, +3d] voor poging 1→2→3. MAX_ATTEMPTS = 4.
// Elke succesvolle mutatie logt automatisch een follow_up_lead_notes-rij
// met entry_kind='outcome' + Nederlands leesbare tekst. Bij 42703 op
// entry_kind fallback zonder die kolom (schema-vriendelijk).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OUTCOMES = new Set([
  'geen_gehoor', 'voicemail', 'foutief_nummer',
  'terugbel', 'zoom_ingepland',
  'sale', 'geen_interesse', 'snooze',
  'noshow', 'gesprek_gehad',
  // WhatsApp gestuurd: lead wordt NIET afgesloten — komt terug op de
  // Werklijst na WHATSAPP_FOLLOWUP_DAYS zodat sales/Dave hem opvolgt.
  'whatsapp_gestuurd',
  // Systeem-outcome: alleen loggen als entry_kind='system' + outcome_code='offerte'.
  // Wordt vanuit de UI aangeroepen wanneer de sales-user op "Offerte maken" klikt,
  // zodat het dashboard offerte-starts kan tellen zonder eerdere state te muteren.
  'offerte_gestart',
]);

const CADENCE_HOURS = [2, 24, 72];
const MAX_ATTEMPTS  = 4;
// WhatsApp-opvolging: standaard 2 dagen terug in de Werklijst.
const WHATSAPP_FOLLOWUP_DAYS = 2;

const ADMIN_ROLES = new Set(['super_admin', 'admin', 'manager']);

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

function monthsFromNow(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

async function insertOutcomeNote(leadId, userId, text, {
  entryKind    = 'outcome',
  outcomeCode  = null,
} = {}) {
  // Insert met entry_kind + outcome_code voor dashboard-aggregatie. Bij
  // 42703 op afzonderlijke kolommen strippen we die en retry-en, zodat het
  // endpoint werkt op oudere schema's zonder migratie.
  const trimmed = String(text || '').slice(0, 4000);
  const attempt = async (payload) => supabaseAdmin
    .from('follow_up_lead_notes')
    .insert(payload)
    .select('id, created_at')
    .maybeSingle();

  const buildPayload = (opts) => {
    const p = {
      lead_id: leadId,
      note: trimmed,
      created_by_user_id: userId,
    };
    if (opts.withEntryKind)  p.entry_kind   = entryKind;
    if (opts.withCode)       p.outcome_code = outcomeCode;
    return p;
  };
  const tries = [
    { withEntryKind: true,  withCode: true  },
    { withEntryKind: true,  withCode: false },
    { withEntryKind: false, withCode: false },
  ];
  let lastError = null;
  for (const opts of tries) {
    if (opts.withCode && !outcomeCode) continue;
    const { data, error } = await attempt(buildPayload(opts));
    if (!error) return data || null;
    lastError = error;
    if (error.code !== '42703') break;
  }
  if (lastError) {
    if (lastError.code === '42P01') {
      const err = new Error('follow_up_lead_notes ontbreekt');
      err.code = 'MIGRATION_REQUIRED';
      throw err;
    }
    console.warn('[follow-up-lead-outcome] note insert:', lastError.message);
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const leadId = typeof body.lead_id === 'string' ? body.lead_id.trim() : '';
  if (!leadId || !UUID_RE.test(leadId)) return res.status(400).json({ error: 'lead_id (uuid) vereist' });

  const outcome = String(body.outcome || '').trim();
  if (!OUTCOMES.has(outcome)) return res.status(400).json({ error: 'outcome ongeldig' });

  // 'offerte_gestart' is een fire-and-forget log-actie zonder state-mutatie:
  // dashboard telt hem, maar de lead-status blijft ongewijzigd zodat de
  // normale bel-flow doorloopt. Owner-gate wel toepassen zodat sales geen
  // andermans leads kan taggen.
  if (outcome === 'offerte_gestart') {
    // Rol + lead ophalen enkel voor owner-check.
    const { data: myp } = await supabaseAdmin
      .from('profiles').select('role').eq('id', user.id).maybeSingle();
    const rRole = String(myp?.role || '').toLowerCase();
    const rAdmin = ADMIN_ROLES.has(rRole);
    const rSales = rRole === 'sales';
    const { data: lRow, error: lErr } = await supabaseAdmin
      .from('follow_up_leads').select('id, owner_id').eq('id', leadId).maybeSingle();
    if (lErr) {
      if (lErr.code === '42P01') return res.status(501).json({ error: 'Tabel follow_up_leads ontbreekt', code: 'MIGRATION_REQUIRED' });
      return res.status(500).json({ error: 'lead fetch: ' + lErr.message });
    }
    if (!lRow) return res.status(404).json({ error: 'Lead niet gevonden' });
    if (!rAdmin) {
      if (!rSales) return res.status(403).json({ error: 'Geen rechten (rol vereist: sales/manager/admin)' });
      if (lRow.owner_id && lRow.owner_id !== user.id) {
        return res.status(403).json({ error: 'Deze lead is aan een andere sales toegewezen' });
      }
    }
    try {
      await insertOutcomeNote(leadId, user.id, 'Offerte-flow gestart vanuit cockpit', {
        entryKind: 'system', outcomeCode: 'offerte',
      });
    } catch (_) { /* fail-soft */ }
    return res.status(200).json({ ok: true, logged: true });
  }

  // Rol resolven voor owner-gate (zelfde patroon als lead-update).
  const { data: myProfile, error: mpErr } = await supabaseAdmin
    .from('profiles').select('role, is_active').eq('id', user.id).maybeSingle();
  if (mpErr) return res.status(500).json({ error: 'profile lookup: ' + mpErr.message });
  const myRole      = String(myProfile?.role || '').toLowerCase();
  const isAdmin     = ADMIN_ROLES.has(myRole);
  const isSales     = myRole === 'sales';

  // Huidige lead ophalen — nodig voor attempts, lead_kind én owner-check.
  const CORE_COLS = 'id, customer_id, source, lead_name, lead_email, lead_phone, lead_status, terugbel_datum, owner_id, last_contact_at, source_ref, created_at, updated_at';
  const RICH_COLS = CORE_COLS + ', attempts, is_hot, snoozed_until, lead_kind, last_outcome';
  let leadRow = null;
  let hasRichCols = true;
  {
    const { data, error } = await supabaseAdmin
      .from('follow_up_leads').select(RICH_COLS).eq('id', leadId).maybeSingle();
    if (error) {
      if (error.code === '42P01') return res.status(501).json({ error: 'Tabel follow_up_leads ontbreekt', code: 'MIGRATION_REQUIRED' });
      if (error.code === '42703') {
        hasRichCols = false;
        const { data: d2, error: e2 } = await supabaseAdmin
          .from('follow_up_leads').select(CORE_COLS).eq('id', leadId).maybeSingle();
        if (e2) return res.status(500).json({ error: 'lead fetch: ' + e2.message });
        leadRow = d2;
      } else {
        return res.status(500).json({ error: 'lead fetch: ' + error.message });
      }
    } else {
      leadRow = data;
    }
  }
  if (!leadRow) return res.status(404).json({ error: 'Lead niet gevonden' });

  // Owner-gate: sales mag alleen eigen of ongeclaimde leads muteren.
  if (!isAdmin) {
    if (!isSales) return res.status(403).json({ error: 'Geen rechten (rol vereist: sales/manager/admin)' });
    if (leadRow.owner_id && leadRow.owner_id !== user.id) {
      return res.status(403).json({ error: 'Deze lead is aan een andere sales toegewezen' });
    }
  }

  const nowIso = new Date().toISOString();
  const currentAttempts = Number(leadRow.attempts || 0);
  const currentKind     = String(leadRow.lead_kind || 'call');

  // Bouw patch + noteText per outcome.
  const patch = {
    updated_at      : nowIso,
    last_contact_at : nowIso,
    last_outcome    : outcome,
  };
  let noteText  = '';
  let attemptsAfter = currentAttempts;

  if (outcome === 'geen_gehoor') {
    attemptsAfter = currentAttempts + 1;
    patch.attempts = attemptsAfter;
    if (attemptsAfter >= MAX_ATTEMPTS) {
      patch.lead_status    = 'niet_bereikbaar';
      patch.terugbel_datum = null;
      noteText = `Geen gehoor — poging ${attemptsAfter}/${MAX_ATTEMPTS} · onbereikbaar, actie nodig`;
    } else {
      const cadIdx = Math.max(0, Math.min(CADENCE_HOURS.length - 1, attemptsAfter - 1));
      patch.lead_status    = 'terugbellen';
      patch.terugbel_datum = hoursFromNow(CADENCE_HOURS[cadIdx]);
      noteText = `Geen gehoor — poging ${attemptsAfter}/${MAX_ATTEMPTS}, terugbellen gepland`;
    }
  } else if (outcome === 'voicemail') {
    attemptsAfter = currentAttempts + 1;
    patch.attempts       = attemptsAfter;
    patch.lead_status    = 'terugbellen';
    patch.terugbel_datum = hoursFromNow(24);
    noteText = `Voicemail ingesproken — poging ${attemptsAfter}`;
  } else if (outcome === 'foutief_nummer') {
    patch.lead_status    = 'niet_bereikbaar';
    patch.terugbel_datum = null;
    noteText = 'Foutief nummer — nummer controleren';
  } else if (outcome === 'terugbel') {
    if (!body.terugbel_datum) return res.status(400).json({ error: 'terugbel_datum vereist' });
    const d = new Date(body.terugbel_datum);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'terugbel_datum ongeldig' });
    patch.lead_status    = 'terugbellen';
    patch.attempts       = 0;
    patch.terugbel_datum = d.toISOString();
    patch.is_hot         = (body.is_hot === true);
    attemptsAfter = 0;
    noteText = 'Terugbel-afspraak gepland' + (patch.is_hot ? ' · hotlead' : '');
  } else if (outcome === 'zoom_ingepland') {
    if (!body.terugbel_datum) return res.status(400).json({ error: 'terugbel_datum vereist' });
    const d = new Date(body.terugbel_datum);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'terugbel_datum ongeldig' });
    patch.lead_kind      = 'zoom';
    patch.lead_status    = 'terugbellen';
    patch.terugbel_datum = d.toISOString();
    noteText = 'Zoom-call ingepland';
  } else if (outcome === 'sale') {
    patch.lead_status = 'verlengd';
    noteText = 'Sale geworden 🎉';
  } else if (outcome === 'geen_interesse') {
    patch.lead_status = 'verloren';
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    noteText = 'Geen interesse' + (reason ? ' — ' + reason.slice(0, 500) : '');
  } else if (outcome === 'snooze') {
    const months = Number(body.snooze_months);
    if (![6, 12].includes(months)) return res.status(400).json({ error: 'snooze_months moet 6 of 12 zijn' });
    patch.snoozed_until = monthsFromNow(months);
    patch.is_hot        = false;
    noteText = `Gesluimerd — opnieuw contact over ${months} maanden`;
  } else if (outcome === 'noshow') {
    if (currentKind !== 'zoom') return res.status(400).json({ error: "No-show alleen zinvol bij lead_kind='zoom'" });
    attemptsAfter = currentAttempts + 1;
    patch.attempts       = attemptsAfter;
    patch.lead_status    = 'terugbellen';
    patch.terugbel_datum = hoursFromNow(24);
    noteText = 'No-show bij Zoom-call';
  } else if (outcome === 'gesprek_gehad') {
    // Geen status/datum-mutatie — alleen note + last_contact_at.
    noteText = 'Zoom-gesprek gehad';
  } else if (outcome === 'whatsapp_gestuurd') {
    // WhatsApp verstuurd — lead moet TERUGKOMEN voor opvolging (WHATSAPP_
    // FOLLOWUP_DAYS dagen later). Attempts wordt NIET verhoogd (dit was
    // geen belpoging). Status blijft actief zodat de lead in de Werklijst
    // opduikt op de opvolg-dag; last_contact_at markeert wanneer we
    // laatst iets deden.
    const days = WHATSAPP_FOLLOWUP_DAYS;
    patch.lead_status    = 'terugbellen';
    patch.terugbel_datum = hoursFromNow(days * 24);
    noteText = 'WhatsApp gestuurd — opvolgen over ' + days + ' dagen';
  }

  // Als schema geen rijke kolommen heeft, strippen we ze uit de patch
  // zodat we niet op 42703 crashen.
  if (!hasRichCols) {
    delete patch.attempts;
    delete patch.is_hot;
    delete patch.snoozed_until;
    delete patch.lead_kind;
    delete patch.last_outcome;
  }

  try {
    // Update de lead. Bij 42703 (bv. entry_kind/attempts kolommen niet in
    // oude schema): stripp die keys en retry.
    let updated = null;
    let updateAttempt = { ...patch };
    for (let i = 0; i < 3; i++) {
      const { data, error } = await supabaseAdmin
        .from('follow_up_leads')
        .update(updateAttempt)
        .eq('id', leadId)
        .select(hasRichCols ? RICH_COLS : CORE_COLS)
        .maybeSingle();
      if (!error) { updated = data; break; }
      if (error.code === '42P01') return res.status(501).json({ error: 'Tabel follow_up_leads ontbreekt', code: 'MIGRATION_REQUIRED' });
      if (error.code === '42703') {
        // Detecteer welke kolom, en strip die.
        const msg = String(error.message || '').toLowerCase();
        const stripped = { ...updateAttempt };
        let didStrip = false;
        for (const k of ['attempts', 'is_hot', 'snoozed_until', 'lead_kind', 'last_outcome']) {
          if (msg.includes(k) && k in stripped) { delete stripped[k]; didStrip = true; }
        }
        if (!didStrip) return res.status(500).json({ error: 'update: ' + error.message });
        updateAttempt = stripped;
        continue;
      }
      return res.status(500).json({ error: 'update: ' + error.message });
    }
    if (!updated) return res.status(500).json({ error: 'update: geen resultaat' });

    // Auto-note-insert. Failure blokkeert de state-transitie niet.
    try {
      await insertOutcomeNote(leadId, user.id, noteText, {
        entryKind: 'outcome', outcomeCode: outcome,
      });
    } catch (nErr) {
      if (nErr?.code === 'MIGRATION_REQUIRED') {
        // Note-tabel ontbreekt — waarschuwen maar succes teruggeven.
        console.warn('[follow-up-lead-outcome] notes-tabel ontbreekt, note niet opgeslagen');
      } else {
        console.warn('[follow-up-lead-outcome] note error:', nErr?.message || nErr);
      }
    }

    return res.status(200).json({ ok: true, lead: updated });
  } catch (e) {
    console.error('[follow-up-lead-outcome]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
