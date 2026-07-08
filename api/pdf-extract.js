// Lazy import zodat een ontbrekende dep tijdens module-init geen 500 oplevert
// op andere endpoints.
import { safeError } from './_lib/safe-error.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed — use POST' });
  }

  const body = typeof req.body === 'string'
    ? JSON.parse(req.body || '{}')
    : (req.body || {});
  const { data } = body;
  if (!data) {
    return res.status(400).json({ error: 'Body moet "data" bevatten (base64-encoded PDF).' });
  }

  // Strip data-URI prefix als die meekomt
  const cleanData = data.includes(',') ? data.split(',')[1] : data;

  try {
    const buffer = Buffer.from(cleanData, 'base64');
    const { default: pdfParse } = await import('pdf-parse');
    const result = await pdfParse(buffer);
    return res.status(200).json({
      text: (result.text || '').trim(),
      pages: result.numpages || 0
    });
  } catch (err) {
    return safeError(res, 500, err, 'PDF kon niet worden ingelezen.');
  }
}
