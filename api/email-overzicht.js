// api/email-overzicht.js
// GET → read-only overzicht van ALLE e-mails/templates die de flow raakt, in 3
// categorieën, voor de Leadsonderhoud → E-mails-tab.
//
//   1) email_templates      (CRM-DB)          — bewerkbaar via de bestaande
//                                                email_templates-editor (Instellingen).
//   2) onderhoud_sjablonen  (gedeelde Supabase, kanaal='mail') — READ-ONLY hier
//                                                (toelating/afwijzing-mails van dfo-website).
//   3) code                 (statische catalogus) — hardcoded transactionele
//                                                mails; bewerkbaar:false.
//
// Permission: email.module.access. Read-only. Geen writes.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

// Statische catalogus van code-mails (geen DB-registratie — handmatig bijhouden).
const CODE_CATALOG = [
  { key: 'afspraak_bevestiging',   naam: 'Afspraak — bevestiging',        doel: 'Bevestiging kennismakingsgesprek', trigger: 'cron-afspraak-reminders (zodra Zoom-link binnen)', mailbox: 'onboarding@', bestand: 'api/_lib/afspraak-berichten.js' },
  { key: 'afspraak_24u',           naam: 'Afspraak — reminder 24u',       doel: 'Herinnering 24u vooraf',           trigger: 'cron-afspraak-reminders',                          mailbox: 'onboarding@', bestand: 'api/_lib/afspraak-berichten.js' },
  { key: 'afspraak_2u',            naam: 'Afspraak — reminder 2u',        doel: 'Herinnering 2u vooraf',            trigger: 'cron-afspraak-reminders',                          mailbox: 'onboarding@', bestand: 'api/_lib/afspraak-berichten.js' },
  { key: 'afspraak_30m',           naam: 'Afspraak — reminder 30m',       doel: 'Herinnering 30m vooraf',           trigger: 'cron-afspraak-reminders',                          mailbox: 'onboarding@', bestand: 'api/_lib/afspraak-berichten.js' },
  { key: 'afspraak_5min',          naam: 'Afspraak — join (5 min)',       doel: 'Join-link vlak vooraf',            trigger: 'cron-afspraak-reminders',                          mailbox: 'onboarding@', bestand: 'api/_lib/afspraak-berichten.js' },
  { key: 'afspraak_annulering',    naam: 'Afspraak — annulering',         doel: 'Bevestiging annulering',           trigger: 'public-afspraak-annuleren / setter-annuleer',      mailbox: 'onboarding@', bestand: 'api/_lib/afspraak-status-notify.js' },
  { key: 'afspraak_verzet',        naam: 'Afspraak — verzet',             doel: 'Bevestiging verzetting',           trigger: 'public-afspraak-verzetten / setter-wijzig',        mailbox: 'onboarding@', bestand: 'api/_lib/afspraak-status-notify.js' },
  { key: 'dunning_brief',          naam: 'Dunning — WIK-brief',           doel: '14-dagenbrief (PDF)',              trigger: 'UI/actie',                                         mailbox: 'administratie@', bestand: 'api/dunning-brief-email-send.js' },
  { key: 'dunning_bulk',           naam: 'Dunning — bulk',                doel: 'Bulk wanbetalers (tekst uit dunning-templates)', trigger: 'cron-dunning-bulk-send',              mailbox: 'administratie@', bestand: 'api/cron-dunning-bulk-send.js' },
  { key: 'incasso_dossier',        naam: 'Incassodossier',                doel: 'Dossier naar incassobureau (PDF)', trigger: 'UI',                                               mailbox: 'info@',       bestand: 'api/incasso-dossier-email.js' },
  { key: 'welkom_onboarding_cron', naam: 'Welkom / onboarding-cron',      doel: 'Welkom + laatste-dag',             trigger: 'cron-toegang-aanvragen',                           mailbox: 'welkom@',     bestand: 'api/cron-toegang-aanvragen.js' },
  { key: 'onboarding_credentials', naam: 'Onboarding — inloggegevens',    doel: 'Credentials-mail',                 trigger: 'onboarding-flow',                                  mailbox: 'onboarding@', bestand: 'api/_lib/onboarding-credentials.js' },
  { key: 'first_call_payment',     naam: 'Eerste-call betaalreminder',    doel: 'Betaalreminder 24u vóór 1e call',  trigger: 'cron/first-call-payment-reminder',                 mailbox: 'onboarding@', bestand: 'api/cron/first-call-payment-reminder.js' },
  { key: 'events_mails',           naam: 'Events — invites/vragenlijst/automations', doel: 'Event-mails',           trigger: 'UI + cron-events-automations',                     mailbox: 'events@',     bestand: 'api/_lib/events-send.js' },
];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'email.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (email.module.access)' });
  }

  try {
    // 1) email_templates (CRM-DB, bewerkbaar).
    let dbTemplates = [];
    try {
      const { data: et } = await supabaseAdmin
        .from('email_templates')
        .select('id, name, subject, category, is_active, updated_at, body_html')
        .order('name', { ascending: true });
      dbTemplates = (et || []).map((t) => ({
        id: t.id,
        naam: t.name,
        doel: t.category || 'algemeen',
        subject: t.subject || null,
        mailbox: 'compose (per verzending)',
        bron: 'email_templates',
        bewerkbaar: true,
        actief: t.is_active !== false,
        trigger: 'Compose-picker in de E-mail-module',
        preview_html: t.body_html || '',
      }));
    } catch (e) { console.warn('[email-overzicht] email_templates:', e?.message || e); }

    // 2) onderhoud_sjablonen (gedeelde Supabase, kanaal='mail', read-only).
    let sjablonen = [];
    try {
      const { data: os } = await supabaseAdmin
        .from('onderhoud_sjablonen')
        .select('id, soort, traject_slug, kanaal, onderwerp, html, actief')
        .eq('kanaal', 'mail')
        .order('soort', { ascending: true });
      const triggerVoor = (soort) => soort === 'toelating' ? 'Toelatingsmail (na WhatsApp-bevestiging, dfo-website)'
        : soort === 'afwijzing' ? 'Afwijzingsmail (na lead-quiz, dfo-website)'
        : 'Leadsonderhoud-mail (dfo-website)';
      sjablonen = (os || []).map((s) => ({
        id: s.id,
        naam: `${s.soort} · ${s.traject_slug}`,
        doel: s.soort,
        subject: s.onderwerp || null,
        mailbox: 'Strato (dfo-website)',
        bron: 'onderhoud_sjablonen',
        bewerkbaar: false,
        actief: s.actief !== false,
        trigger: triggerVoor(s.soort),
        preview_html: s.html || '',
      }));
    } catch (e) { console.warn('[email-overzicht] onderhoud_sjablonen:', e?.message || e); }

    // 3) code-catalogus (statisch, read-only).
    const code = CODE_CATALOG.map((c) => ({
      id: c.key, naam: c.naam, doel: c.doel, subject: null,
      mailbox: c.mailbox, bron: 'code', bewerkbaar: false, actief: true,
      trigger: c.trigger, bestand: c.bestand, preview_html: null,
    }));

    return res.status(200).json({
      ok: true,
      generated_at: new Date().toISOString(),
      categories: { email_templates: dbTemplates, onderhoud_sjablonen: sjablonen, code },
      totalen: { email_templates: dbTemplates.length, onderhoud_sjablonen: sjablonen.length, code: code.length },
    });
  } catch (e) {
    console.error('[email-overzicht]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Overzicht laden mislukt' });
  }
}
