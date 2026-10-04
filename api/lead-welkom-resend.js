// api/lead-welkom-resend.js
//
// "Inloggegevens opnieuw versturen" voor een lead met een BESTAAND LMS-account.
//
// GET  ?lead_id=<uuid>   → info voor de popup: geregistreerd inlogadres,
//                          toegangsstatus (verlopen?), bepaald traject, en of
//                          de gebruiker het adres mag wijzigen.
// POST { lead_id, email?, voornaam? }
//   - zonder email (of gelijk aan het huidige adres): verse inloglink + welkomst-
//     mail naar het GEREGISTREERDE adres van het bestaande account.
//   - met een ander email: het BESTAANDE account wordt naar dat adres verplaatst
//     (auth-login + lms_gebruikers.email + leads.email — dezelfde semantiek als
//     lead-bijwerken.js) en daarna gaat de mail naar het nieuwe adres. Het oude
//     adres werkt daarna niet meer om in te loggen.
//
// NOOIT een nieuw account aanmaken. Vroeger stuurde deze endpoint het adres
// blind door naar dfo-website, en die maakt bij een onbekend adres een TWEEDE
// account (lms_gebruikers + auth-user). Geen account → 409 GEEN_ACCOUNT met de
// hint om "Geef toegang" te gebruiken.
//
// Toegang wordt NIET verlengd. dfo-website /api/interne-welkom-mail kiest het
// sjabloon op `soort`, maar zet bij een bekende soort óók het productvenster op
// [nu, nu + duur_dagen] (geefProductToegang-upsert). Daarom:
//   - soort gaat alleen mee als het account al een grant op dat product heeft;
//   - het venster van die grant wordt vooraf bewaard en na de call teruggezet.
// Zonder soort kiest dfo het 7-daagse-sjabloon en raakt het geen grant.
//
// RBAC: leads.view; het adres wijzigen (muteert account + lead) vereist
// daarnaast leads.update. Audit: audit_log (entity_type='lead').

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { stuurWelkom, welkomUitkomst } from './_lib/welkom.js';
import { getClientIp } from './_lib/audit-customer.js';
import {
  EMAIL_RE, normaliseerEmail, vindLeadAccount, verplaatsAccountEmail, bepaalSoort, toegangStatus,
} from './_lib/lead-lms-account.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Handmatige actie, geen webhook: ruimer budget dan de 4,5 s default, zodat we
// niet afbreken terwijl dfo nog bezig is (en het venster pas daarna terugzetten).
const RESEND_TIMEOUT_MS = 15000;

/** Grants van een account, met product-slug erbij. */
async function laadGrants(sb, gebruikerId) {
  const { data: rijen, error } = await sb.from('lms_toegang')
    .select('id, product_id, toegang_van, toegang_tot').eq('gebruiker_id', gebruikerId);
  if (error) throw new Error('lms_toegang: ' + error.message);
  if (!rijen || !rijen.length) return [];
  const { data: prods, error: pErr } = await sb.from('lms_producten').select('id, slug');
  if (pErr) throw new Error('lms_producten: ' + pErr.message);
  const slugById = new Map((prods || []).map((p) => [String(p.id), p.slug]));
  return rijen.map((r) => ({ ...r, slug: slugById.get(String(r.product_id)) || null }));
}

async function logLeadAudit({ req, userId, leadId, before, after }) {
  try {
    const { error } = await supabaseAdmin.from('audit_log').insert({
      user_id: userId || null,
      action: 'lead.inlog_opnieuw_verstuurd',
      entity_type: 'lead',
      entity_id: leadId,
      before_json: before ?? null,
      after_json: after ?? null,
      reason_text: null,
      ip_address: getClientIp(req),
    });
    if (error) console.error('[lead-welkom-resend] audit insert failed:', error.message);
  } catch (e) {
    console.error('[lead-welkom-resend] audit exception:', e?.message || e);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'GET of POST' });
  }

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  const body = req.method === 'POST' ? (req.body || {}) : {};
  const leadId = String((req.method === 'GET' ? req.query?.lead_id : body.lead_id) || '').trim();
  if (!UUID_RE.test(leadId)) {
    return res.status(400).json({ error: 'lead_id (uuid) is verplicht.' });
  }

  try {
    const { data: lead, error: leadErr } = await supabaseAdmin
      .from('leads')
      .select('id, voornaam, achternaam, email, traject')
      .eq('id', leadId)
      .maybeSingle();
    if (leadErr) throw new Error('lead fetch: ' + leadErr.message);
    if (!lead) return res.status(404).json({ error: 'Lead niet gevonden.' });

    const { account, fout } = await vindLeadAccount(supabaseAdmin, { leadId, email: lead.email });
    if (fout) throw new Error(fout);
    const grants = account ? await laadGrants(supabaseAdmin, account.id) : [];
    const soort = bepaalSoort({ traject: lead.traject, grantSlugs: grants.map((g) => g.slug) });

    // ── GET: info voor de popup ──────────────────────────────────────────
    if (req.method === 'GET') {
      const magWijzigen = await requirePermission(req, 'leads.update');
      return res.status(200).json({
        lead: {
          id: lead.id,
          naam: [lead.voornaam, lead.achternaam].filter(Boolean).join(' ').trim() || null,
          email: lead.email || null,
          traject: lead.traject || null,
        },
        account: account ? { email: account.email, ...toegangStatus(account, grants) } : null,
        soort,
        mag_adres_wijzigen: !!magWijzigen,
      });
    }

    // ── POST ─────────────────────────────────────────────────────────────
    if (!account) {
      return res.status(409).json({
        code: 'GEEN_ACCOUNT',
        error: 'Deze lead heeft nog geen LMS-account. Gebruik "Geef toegang" om een account aan te maken en de inlog te sturen.',
      });
    }

    const huidig = normaliseerEmail(account.email);
    const alt = normaliseerEmail(typeof body.email === 'string' ? body.email : '');
    let emailGewijzigd = null;
    if (alt && alt !== huidig) {
      if (!EMAIL_RE.test(alt)) return res.status(400).json({ code: 'ONGELDIG_EMAIL', error: `Ongeldig e-mailadres: ${alt}` });
      if (!(await requirePermission(req, 'leads.update'))) {
        return res.status(403).json({ error: 'Geen rechten om het inlogadres te wijzigen (leads.update)' });
      }
      const r = await verplaatsAccountEmail(supabaseAdmin, {
        account, leadId, oudeLeadEmail: lead.email || null, nieuweEmail: alt,
      });
      if (!r.ok) return res.status(r.status).json({ code: r.code, error: r.error });
      emailGewijzigd = { van: huidig, naar: alt };
    }
    const doelEmail = emailGewijzigd ? alt : huidig;
    if (!EMAIL_RE.test(doelEmail)) {
      return res.status(422).json({ code: 'GEEN_ADRES', error: 'Het account heeft geen geldig e-mailadres. Vul een ander adres in.' });
    }

    const voornaamRaw = typeof body.voornaam === 'string' ? body.voornaam.trim() : '';
    const voornaam = voornaamRaw || String(lead.voornaam || '').trim() || null;

    // Soort alleen meesturen als we het productvenster kunnen terugzetten.
    const snapshot = soort ? grants.find((g) => g.slug === soort) || null : null;
    const soortVoorMail = snapshot ? soort : null;

    const resultaten = await stuurWelkom({
      email: doelEmail, voornaam, kanalen: ['email'],
      soort: soortVoorMail, timeoutMs: RESEND_TIMEOUT_MS,
    });
    const uitkomst = welkomUitkomst(resultaten, 'email');

    let toegangHersteld = null;
    if (snapshot) {
      const { error: hErr } = await supabaseAdmin.from('lms_toegang')
        .update({ toegang_van: snapshot.toegang_van, toegang_tot: snapshot.toegang_tot })
        .eq('id', snapshot.id);
      toegangHersteld = !hErr;
      if (hErr) console.error('[lead-welkom-resend] toegangsvenster terugzetten mislukt:', snapshot.id, hErr.message);
    }
    if (!uitkomst.ok) console.warn('[lead-welkom-resend] send failed:', leadId, uitkomst.reden);

    await logLeadAudit({
      req, userId: user.id, leadId,
      before: { email: huidig },
      after: {
        email: doelEmail, sent: uitkomst.ok, reden: uitkomst.reden,
        email_gewijzigd: !!emailGewijzigd, soort: soortVoorMail, toegang_hersteld: toegangHersteld,
      },
    });

    return res.status(200).json({
      ok: true,
      sent: uitkomst.ok,
      doel_email: doelEmail,
      voornaam,
      email_gewijzigd: emailGewijzigd,
      soort: soortVoorMail,
      soort_bepaald: soort,
      toegang_hersteld: toegangHersteld,
      reden: uitkomst.reden,
      resultaat: uitkomst.resultaat || { ok: false, reden: 'no-response' },
    });
  } catch (e) {
    console.error('[lead-welkom-resend]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Onbekende fout.' });
  }
}
