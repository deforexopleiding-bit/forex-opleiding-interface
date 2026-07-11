// api/incasso-dossier-email.js
// POST { dossier_id } → verstuurt dossier-PDF naar bureau.email met nette
// subject + body.
//
// Respecteert de globale dunning_dry_run-vlag (app_settings) → in dry-run
// NIET versturen, wel { ok:true, dry_run:true, would_send_to } teruggeven.
// Permission: finance.incasso.manage.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { buildDossierPdfBuffer } from './_lib/incasso-pdf.js';
import { isDryRunEnabled } from './_lib/dunning-dry-run.js';
import { customerDisplayName } from './_lib/customer-name.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function eur(n) {
  const v = Number(n) || 0;
  return '€ ' + v.toFixed(2).replace('.', ',');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.incasso.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.incasso.manage)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const dossierId = typeof body.dossier_id === 'string' && UUID_RE.test(body.dossier_id) ? body.dossier_id : null;
  if (!dossierId) return res.status(400).json({ error: 'dossier_id (uuid) verplicht' });

  try {
    // Dossier + bureau + klant-context ophalen (nodig voor subject/body).
    const { data: dossier, error: dErr } = await supabaseAdmin
      .from('dunning_incasso_dossiers')
      .select('id, customer_id, country, status, debt_snapshot, ' +
        'bureau:bureau_id(id, name, email, country), ' +
        'customer:customer_id(id, first_name, last_name, company_name, is_company, email)')
      .eq('id', dossierId).maybeSingle();
    if (dErr) throw new Error('dossier lookup: ' + dErr.message);
    if (!dossier) return res.status(404).json({ error: 'Dossier niet gevonden' });
    if (!dossier.bureau) return res.status(400).json({ error: 'Dossier heeft geen gekoppeld bureau' });
    if (!dossier.bureau.email) return res.status(400).json({ error: 'Bureau heeft geen e-mailadres' });

    const custName  = dossier.customer ? customerDisplayName(dossier.customer, '(zonder naam)') : '(onbekend)';
    const totalOpen = Number(dossier.debt_snapshot?.total_open_eur) || 0;
    const subject   = `Incassodossier ${dossierId.slice(0, 8)} — ${custName} — ${eur(totalOpen)}`;
    const bodyText  = [
      'Beste ' + dossier.bureau.name + ',',
      '',
      'Hierbij het incassodossier van ' + custName + '.',
      'Openstaand bedrag bij aanmelding: ' + eur(totalOpen) + ' (' + (dossier.debt_snapshot?.open_invoice_count || 0) + ' facturen).',
      'Land: ' + (dossier.country || 'NL') + '.',
      '',
      'Zie de bijlage voor het volledige dossier (klant, vordering, offerte, aanmaan-historie, regelingen).',
      'De bedragen zijn exclusief incassokosten en wettelijke rente — die berekent u zelf.',
      '',
      'Met vriendelijke groet,',
      process.env.COMPANY_NAME || 'De Forex Opleiding NL B.V.',
    ].join('\n');

    // Dry-run: nog niet versturen, wel de PDF gebouwd zodat we in de log
    // aantoonbaar hebben dat het complete proces slaagt.
    const dry = await isDryRunEnabled();
    const buffer = await buildDossierPdfBuffer(dossierId);
    if (dry) {
      console.log('[incasso-dossier-email] DRY-RUN skip send', {
        dossier_id: dossierId, would_send_to: dossier.bureau.email, bytes: buffer?.length || 0,
      });
      return res.status(200).json({
        ok: true, dry_run: true,
        would_send_to: dossier.bureau.email,
        bureau_name: dossier.bureau.name,
        subject,
        pdf_bytes: buffer?.length || 0,
      });
    }

    // Echte send. De reeds gebouwde `buffer` (uit builDossierPdfBuffer)
    // gaat mee als bijlage via de nodemailer-attachments-shape.
    const { sendMail } = await import('./mailer.js');
    const attachmentName = `incassodossier_${dossierId.slice(0, 8)}.pdf`;
    const result = await sendMail({
      to      : dossier.bureau.email,
      subject,
      text    : bodyText,
      html    : '<pre style="font-family:system-ui,sans-serif;white-space:pre-wrap">' +
                String(bodyText).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
                '</pre>',
      attachments: [{ filename: attachmentName, content: buffer, contentType: 'application/pdf' }],
    });
    if (!result || !result.success) {
      return res.status(502).json({ error: result?.error || 'SMTP fail' });
    }

    // Log naar dunning_log zodat de bureau-verzending in de historie zichtbaar is.
    try {
      await supabaseAdmin.from('dunning_log').insert({
        run_id     : null,
        step_id    : null,
        event_type : 'incasso_dossier_emailed',
        payload    : {
          customer_id : dossier.customer_id,
          dossier_id  : dossierId,
          bureau_id   : dossier.bureau.id,
          bureau_email: dossier.bureau.email,
          message_id  : result.messageId || null,
        },
      });
    } catch (e) {
      console.warn('[incasso-dossier-email] dunning_log soft-fail', e?.message || e);
    }

    return res.status(200).json({
      ok: true, dry_run: false,
      sent_to: dossier.bureau.email, bureau_name: dossier.bureau.name,
      subject, message_id: result.messageId || null,
    });
  } catch (e) {
    console.error('[incasso-dossier-email]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
