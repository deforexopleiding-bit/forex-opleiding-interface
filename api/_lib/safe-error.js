// api/_lib/safe-error.js
//
// Publieke error-responder (M2 security). Doel: DB/exception-detail NIET
// aan de client lekken, wel volledig loggen naar Vercel zodat we het kunnen
// debuggen.
//
// Gebruik:
//   } catch (err) {
//     return safeError(res, 500, err);
//     // of met eigen publieke tekst:
//     return safeError(res, 400, err, 'Ongeldige invoer.');
//   }
//
// Alleen gebruiken bij server-side fouten (5xx) of validatie-fouten waar je
// GEEN details wil lekken. Bewuste, nette gebruikersfeedback (bv.
// 'E-mailadres ongeldig') blijft gewoon als literal string — die is bedoeld.

/**
 * Log de echte fout naar de server-logs (console.error blijft in Vercel
 * zichtbaar), stuur een generieke boodschap naar de client.
 *
 * @param {object} res             — Vercel response
 * @param {number} status          — HTTP status code
 * @param {unknown} err            — Error, Supabase-error-object, of string
 * @param {string} [publicMessage] — client-message (default: generiek NL)
 * @returns {object} de res.json-return van Vercel
 */
export function safeError(res, status, err, publicMessage = 'Er ging iets mis. Probeer het later opnieuw.') {
  const errMsg   = err?.message || (typeof err === 'string' ? err : '');
  const errCode  = err?.code || err?.status;
  const stackTail = err?.stack ? '\n' + err.stack : '';
  // Één regel voor grep-baarheid; stack op nieuwe regel voor leesbaarheid.
  console.error('[safe-error]', 'status=' + status, 'code=' + (errCode || '-'), 'msg=' + errMsg + stackTail);
  return res.status(status).json({ error: publicMessage });
}
