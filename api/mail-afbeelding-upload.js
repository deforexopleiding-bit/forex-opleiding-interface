// api/mail-afbeelding-upload.js
//
// Mailbouwer (2026-10-11): een afbeelding voor een e-mailsjabloon uploaden naar
// de PUBLIEKE bucket `mail-afbeeldingen` (mailclients halen hem op via een
// absolute https-URL). Uploaden kan alleen via dit endpoint (service role, na
// login + recht) — de bucket heeft geen insert-policy voor gebruikers.
//
// POST { bestandsnaam, content_type, data_base64 }
//   → 200 { ok, url, pad, content_type, grootte }
//   → 400 geen afbeelding / te groot / inhoud klopt niet met het type
//   → 409 MIGRATIE_NODIG (bucket bestaat nog niet)
// Toegestaan: PNG, JPEG, GIF, WebP — max 2 MB. Het type wordt aan de eerste
// bytes gecontroleerd (niet alleen aan de opgegeven content_type).
// RBAC: leads.view — hetzelfde recht als e-mailsjablonen bewerken.

import crypto from 'node:crypto';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export const BUCKET = 'mail-afbeeldingen';
export const MAX_BYTES = 2 * 1024 * 1024;
const MIGRATIE = '2026-10-11-mail-bouwer.sql';

const TYPES = {
  'image/png': { ext: 'png', klopt: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  'image/jpeg': { ext: 'jpg', klopt: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/gif': { ext: 'gif', klopt: (b) => b.length > 6 && b.slice(0, 6).toString('ascii').startsWith('GIF8') },
  'image/webp': { ext: 'webp', klopt: (b) => b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
};

/** Controle van een upload. PURE. -> { ok, ext, bytes } of { ok:false, status, fout } */
export function controleerUpload(b = {}) {
  const type = String(b.content_type || '').toLowerCase().replace('image/jpg', 'image/jpeg');
  const t = TYPES[type];
  if (!t) return { ok: false, status: 400, fout: 'Alleen PNG, JPEG, GIF of WebP.' };
  const ruw = String(b.data_base64 || '').replace(/^data:[^,]*,/, '');
  if (!ruw || !/^[A-Za-z0-9+/=\s]+$/.test(ruw)) return { ok: false, status: 400, fout: 'Geen (geldige) bestandsinhoud.' };
  if (ruw.length > Math.ceil(MAX_BYTES * 4 / 3) + 16) return { ok: false, status: 400, fout: 'De afbeelding is groter dan 2 MB.' };
  const bytes = Buffer.from(ruw, 'base64');
  if (!bytes.length) return { ok: false, status: 400, fout: 'Leeg bestand.' };
  if (bytes.length > MAX_BYTES) return { ok: false, status: 400, fout: 'De afbeelding is groter dan 2 MB.' };
  if (!t.klopt(bytes)) return { ok: false, status: 400, fout: 'De inhoud is geen ' + type.replace('image/', '').toUpperCase() + '-afbeelding.' };
  return { ok: true, type, ext: t.ext, bytes };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) return res.status(403).json({ error: 'Geen rechten (leads.view)' });

  const c = controleerUpload(req.body && typeof req.body === 'object' ? req.body : {});
  if (!c.ok) return res.status(c.status).json({ error: c.fout });
  const nu = new Date();
  const pad = `sjablonen/${nu.getUTCFullYear()}/${String(nu.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}.${c.ext}`;
  try {
    const { error } = await supabaseAdmin.storage.from(BUCKET).upload(pad, c.bytes, { contentType: c.type, cacheControl: '31536000', upsert: false });
    if (error) {
      if (/bucket not found|not found/i.test(error.message || '')) return res.status(409).json({ error: `De bucket ${BUCKET} bestaat nog niet — draai ${MIGRATIE}.`, code: 'MIGRATIE_NODIG' });
      throw error;
    }
    const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(pad);
    return res.status(200).json({ ok: true, url: data?.publicUrl, pad, content_type: c.type, grootte: c.bytes.length });
  } catch (e) {
    console.error('[mail-afbeelding-upload] fout:', { gebruiker: user.id, fout: e?.message || e });
    return res.status(500).json({ error: 'Uploaden mislukt' });
  }
}
