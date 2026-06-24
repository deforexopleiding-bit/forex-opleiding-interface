// api/inbox-link-conversation-to-customer.js
// POST -> handmatig een whatsapp_conversation koppelen aan een bestaande klant
// (use-case: inbox-paneel state='unknown', user picked klant via typeahead).
// Optioneel kan het telefoonnummer van de conversation aan de klant toegevoegd
// worden als die nog geen phone heeft (default false; UI mag default-checken
// als customer.phone IS NULL).
//
// Permission: finance.inbox.send OF events.simone.use (write-actie binnen
// dezelfde semantische scope als inbox-send / inbox-send-template — zelfde
// OR-patroon. Events-hub Koppel-klant-flow hangt sinds stap 6d op dit
// endpoint zonder finance-rechten te hebben). Additief; finance-callers
// blijven byte-identiek.
//
// Body:
//   conversation_id        uuid    required
//   customer_id            uuid    required
//   add_phone_to_customer  bool    optional, default false
//
// Response 200:
//   {
//     conversation_id, customer_id, customer_name,
//     previous_customer_id, phone_added,
//     relinked (bool)
//   }
//
// Edge cases:
//   - Conversation al aan dezelfde customer gekoppeld: 200, geen update, audit-skip.
//   - Conversation aan andere customer gekoppeld: re-link (previous_customer_id
//     in audit). UI moet dat eerder bevestigen.
//   - Customer / conversation niet gevonden (of archived/anonymized): 404.
//
// Audit-log: action='whatsapp.customer_linked', entity_type='whatsapp_conversation',
// entity_id=conv.id, after_json met match_reason='manual' + bool's.
// Fail-soft: audit-fout breekt de business-actie niet (pattern uit
// inbox-webhook.js logInboxAudit).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';
import { customerDisplayName } from './_lib/customer-name.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Strip alles behalve cijfers — geen '+' bewaren (consistent met PR #132 fix
// in inbox-conversation-context.js, niet de inbox-webhook variant die '+'
// behoudt). Reden: customer.phone is vrij geformatteerd in DB en we vergelijken
// hier op pure digits om mismatches op '+' te vermijden.
function digitsOnly(s) {
  if (!s) return '';
  return String(s).replace(/\D/g, '');
}

// Fail-soft audit-helper (zelfde shape als logInboxAudit in inbox-webhook.js).
async function logLinkAudit(req, { userId, conversationId, afterJson }) {
  try {
    const { error } = await supabaseAdmin.from('audit_log').insert({
      user_id:     userId || null,
      action:      'whatsapp.customer_linked',
      entity_type: 'whatsapp_conversation',
      entity_id:   conversationId,
      after_json:  afterJson || null,
      ip_address:  getClientIp(req),
    });
    if (error) {
      console.error('[inbox-link-conversation-to-customer] audit insert failed:', error.message);
    }
  } catch (e) {
    console.error('[inbox-link-conversation-to-customer] audit exception:', e && e.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // Auth: zelfde gate als inbox-send / inbox-send-template — koppelen is een
  // write-actie binnen dezelfde scope (niemand mag versturen zonder ook te
  // mogen koppelen, anders blijft state='unknown' permanent vastzitten).
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  // FIX 3 — additief: events.simone.use ook accepteren (parallel met
  // inbox-send.js / inbox-send-template.js). Finance-callers met
  // finance.inbox.send blijven byte-identiek werken.
  // B1 — onboarding.inbox.send als 3e additieve OR.
  const hasFinanceSend    = await requirePermission(req, 'finance.inbox.send');
  const hasSimoneUse      = hasFinanceSend ? true : await requirePermission(req, 'events.simone.use');
  const hasOnboardingSend = (hasFinanceSend || hasSimoneUse)
    ? true : await requirePermission(req, 'onboarding.inbox.send');
  if (!hasFinanceSend && !hasSimoneUse && !hasOnboardingSend) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.send, events.simone.use of onboarding.inbox.send)' });
  }

  // Body parsing
  const body = req.body || {};
  const convId = String(body.conversation_id || '').trim();
  const customerId = String(body.customer_id || '').trim();
  const addPhone = body.add_phone_to_customer === true;

  // Validatie
  if (!convId) return res.status(400).json({ error: 'conversation_id vereist' });
  if (!UUID_RE.test(convId)) {
    return res.status(400).json({ error: 'conversation_id moet geldige uuid zijn' });
  }
  if (!customerId) return res.status(400).json({ error: 'customer_id vereist' });
  if (!UUID_RE.test(customerId)) {
    return res.status(400).json({ error: 'customer_id moet geldige uuid zijn' });
  }

  try {
    // 1) Conversation ophalen — 404 als niet bestaat.
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, phone_number, customer_id')
      .eq('id', convId)
      .maybeSingle();
    if (convErr) throw new Error('conversation lookup: ' + convErr.message);
    if (!conv) return res.status(404).json({ error: 'Conversation niet gevonden' });

    // 2) Customer ophalen — 404 als niet bestaat, gearchiveerd of geanonimiseerd.
    //    archived_at / anonymized_at = NULL filter spiegelt findCustomerByPhone
    //    (inbox-webhook.js): we koppelen niet aan klanten die niet meer actief
    //    in de UI verschijnen.
    const { data: cust, error: custErr } = await supabaseAdmin
      .from('customers')
      .select('id, is_company, company_name, first_name, last_name, email, phone, archived_at, anonymized_at')
      .eq('id', customerId)
      .maybeSingle();
    if (custErr) throw new Error('customer lookup: ' + custErr.message);
    if (!cust) return res.status(404).json({ error: 'Klant niet gevonden' });
    if (cust.archived_at || cust.anonymized_at) {
      return res.status(404).json({ error: 'Klant niet beschikbaar (gearchiveerd of geanonimiseerd)' });
    }

    const previousCustomerId = conv.customer_id || null;
    const alreadyLinkedToSame = previousCustomerId && previousCustomerId === cust.id;
    const isRelink = previousCustomerId && previousCustomerId !== cust.id;

    // 3) Conversation -> customer koppelen. Skip update bij idempotente same-link
    //    om triggers en updated_at-noise te vermijden.
    if (!alreadyLinkedToSame) {
      const { error: updErr } = await supabaseAdmin
        .from('whatsapp_conversations')
        .update({ customer_id: cust.id })
        .eq('id', conv.id);
      if (updErr) throw new Error('conversation update: ' + updErr.message);
    }

    // 4) Optioneel: telefoonnummer toevoegen aan klant (alleen als phone IS NULL,
    //    nooit overwrite). Idempotent: skip als de klant al hetzelfde nummer heeft
    //    (digits-vergelijking) of als de conversation geen phone_number heeft.
    let phoneAdded = false;
    if (addPhone && conv.phone_number) {
      const convDigits = digitsOnly(conv.phone_number);
      const custDigits = digitsOnly(cust.phone);
      const customerHasPhone = !!(cust.phone && custDigits);
      const sameNumber = customerHasPhone && convDigits && convDigits === custDigits;
      if (!customerHasPhone && convDigits) {
        // Bewaar in originele E.164-vorm met '+' (whatsapp_conversations.phone_number
        // is altijd E.164 met '+' per webhook-conventie toE164Plus).
        const { error: phErr } = await supabaseAdmin
          .from('customers')
          .update({ phone: conv.phone_number })
          .eq('id', cust.id)
          .is('phone', null); // dubbele guard: alleen vullen als nog NULL
        if (phErr) {
          // Fail-soft: link is wel geslaagd, phone-update niet. Log en ga door
          // zodat de UI niet een halve link rapporteert. previousCustomerId blijft
          // accuraat in audit.
          console.error('[inbox-link-conversation-to-customer] phone update failed:', phErr.message);
        } else {
          phoneAdded = true;
        }
      } else if (sameNumber) {
        // No-op: klant heeft dit nummer al. Geen waarschuwing nodig.
      }
      // Anders: klant heeft ander nummer; we overschrijven NIET. Multi-phone
      // support staat niet in roadmap — UI moet dit later flow afhandelen.
    }

    // 5) Audit-log (alleen bij echte mutatie, niet bij idempotente same-link
    //    zonder phone-add). Pattern uit inbox-webhook.js: fail-soft, geen throw.
    const auditPayload = {
      customer_id:                cust.id,
      previous_customer_id:       previousCustomerId,
      match_reason:               'manual',
      linked_by_user_id:          user.id,
      phone_added_to_customer:    phoneAdded,
      relinked:                   isRelink,
      conversation_phone_number:  conv.phone_number || null,
    };
    if (!alreadyLinkedToSame || phoneAdded) {
      await logLinkAudit(req, {
        userId:         user.id,
        conversationId: conv.id,
        afterJson:      auditPayload,
      });
    }

    const customerName = customerDisplayName(cust, '') || null;
    return res.status(200).json({
      conversation_id:      conv.id,
      customer_id:          cust.id,
      customer_name:        customerName,
      previous_customer_id: previousCustomerId,
      phone_added:          phoneAdded,
      relinked:             isRelink,
    });
  } catch (e) {
    console.error('[inbox-link-conversation-to-customer]', e && e.message);
    return res.status(500).json({ error: e && e.message ? e.message : 'Interne fout' });
  }
}
