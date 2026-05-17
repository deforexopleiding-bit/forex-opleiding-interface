// api/ghl-tag-helper.js
//
// Herbruikbare helper voor het zetten van GHL contact-tags.
// Geen default export → Vercel serveert dit niet als route.
//
// Gebruik:
//   import { addGhlTags } from './ghl-tag-helper.js';
//   const result = await addGhlTags(contactId, ['followup-no-show']);

import { supabaseAdmin } from './supabase.js';

const GHL_API_BASE = 'https://services.leadconnectorhq.com';

/**
 * Zet één of meerdere tags op een GHL contact.
 *
 * @param {string} ghlContactId - GHL contact ID (e.g. ZvTcan7k...)
 * @param {string[]} tags - Array van tag-namen
 * @param {Object} options - { source: 'no-show-detect'|'outcome-save', appointment_id?, owner_id? }
 * @returns {Promise<{success: boolean, tagsAdded: string[], errors: string[]}>}
 */
export async function addGhlTags(ghlContactId, tags, options = {}) {
  const result = {
    success: false,
    tagsAdded: [],
    errors: [],
  };

  if (!ghlContactId || typeof ghlContactId !== 'string') {
    result.errors.push('ghlContactId ontbreekt of ongeldig');
    return result;
  }

  if (!Array.isArray(tags) || tags.length === 0) {
    result.errors.push('tags array leeg');
    return result;
  }

  if (!process.env.GHL_API_KEY || !process.env.GHL_LOCATION_ID) {
    result.errors.push('GHL env vars niet geconfigureerd');
    return result;
  }

  try {
    const ghlRes = await fetch(`${GHL_API_BASE}/contacts/${ghlContactId}/tags`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GHL_API_KEY}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ tags }),
    });

    if (!ghlRes.ok) {
      const errText = await ghlRes.text();
      console.error('[ghl-tag-helper] GHL error:', ghlRes.status, 'contact:', ghlContactId, 'tags:', tags, 'body:', errText.slice(0, 300));
      result.errors.push(`GHL API ${ghlRes.status}: ${errText.slice(0, 200)}`);

      // Log naar events_log voor audit
      await supabaseAdmin
        .from('follow_up_events_log')
        .insert({
          source: 'ghl-tag',
          event_type: 'tag_add_failed',
          payload: {
            ghlContactId,
            tags,
            status: ghlRes.status,
            error: errText.slice(0, 300),
            ...options,
          },
          processed: false,
        })
        .then(() => {})
        .catch(err => console.error('[ghl-tag-helper] audit log failed:', err.message));

      return result;
    }

    result.success = true;
    result.tagsAdded = tags;

    // Audit-trail
    await supabaseAdmin
      .from('follow_up_events_log')
      .insert({
        source: 'ghl-tag',
        event_type: 'tag_added',
        payload: {
          ghlContactId,
          tags,
          ...options,
        },
        processed: true,
      })
      .then(() => {})
      .catch(err => console.error('[ghl-tag-helper] audit log failed:', err.message));

    return result;
  } catch (err) {
    console.error('[ghl-tag-helper] exception:', err.message);
    result.errors.push(`Exception: ${err.message}`);
    return result;
  }
}

/**
 * Bepaalt welke tags geset moeten worden op basis van outcome-data.
 *
 * @param {Object} outcome - { outcome, bezwaren }
 * @returns {string[]} - Array van tag-namen
 */
export function tagsFromOutcome(outcome) {
  const tags = [];

  if (outcome.outcome === 'klant_geworden') {
    tags.push('followup-klant');
  } else if (outcome.outcome === 'geen_klant') {
    tags.push('followup-geen-klant');

    if (Array.isArray(outcome.bezwaren)) {
      if (outcome.bezwaren.includes('te_duur')) tags.push('followup-bezwaar-te-duur');
      if (outcome.bezwaren.includes('partner_overleg')) tags.push('followup-bezwaar-partner');
      if (outcome.bezwaren.includes('timing')) tags.push('followup-bezwaar-timing');
    }
  } else if (outcome.outcome === 'no_show') {
    tags.push('followup-no-show');
  }

  return tags;
}
