// Wrapper voor Vercel cron — roept agent-approval expire_pending aan
import handler from './agent-approval.js';

export default function (req, res) {
  // Injecteer de action zodat de main handler het juist verwerkt
  req.query = { ...req.query, action: 'expire_pending' };
  return handler(req, res);
}
