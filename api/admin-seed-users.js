// One-time seed endpoint — creates initial admin/sales users in Supabase Auth
// Protected by SEED_SECRET header. Run once, then optionally remove SEED_SECRET from env.
//
// Usage:
//   curl -X POST https://forex-opleiding-interface.vercel.app/api/admin-seed-users \
//     -H "Content-Type: application/json" \
//     -H "x-seed-secret: <SEED_SECRET>" \
//     -d '{}'
//
// After seeding: users set their real password via "Wachtwoord vergeten" on login.html

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// Initial users — replace placeholder emails with real addresses before first run
const SEED_USERS = [
  { email: 'biemoldjeffrey@gmail.com', name: 'Jeffrey Biemold', role: 'admin'  },
  { email: 'TODO_maxim@deforexopleiding.nl',  name: 'Maxim',           role: 'admin'  },
  { email: 'TODO_amigo@deforexopleiding.nl',  name: 'Amigo',           role: 'admin'  },
  { email: 'TODO_dave@deforexopleiding.nl',   name: 'Dave',            role: 'sales'  },
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const providedSecret = req.headers['x-seed-secret'];
  if (!providedSecret || providedSecret !== process.env.SEED_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  }

  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Guard: refuse if TODO placeholders are still present
  const hasTodos = SEED_USERS.some(u => u.email.startsWith('TODO_'));
  if (hasTodos) {
    const todos = SEED_USERS.filter(u => u.email.startsWith('TODO_')).map(u => u.email);
    return res.status(400).json({
      error: 'Placeholder emails still present — update SEED_USERS in api/admin-seed-users.js first',
      todos,
    });
  }

  const results = [];
  for (const user of SEED_USERS) {
    // Random temp password — user resets via magic link / forgot password
    const tempPassword = crypto.randomBytes(16).toString('hex') + '!Aa1';

    try {
      const { data, error } = await supabaseAdmin.auth.admin.createUser({
        email: user.email,
        password: tempPassword,
        email_confirm: true,
        user_metadata: {
          full_name: user.name,
          role: user.role,
        },
      });

      results.push({
        email: user.email,
        role: user.role,
        success: !error,
        error: error?.message || null,
        user_id: data?.user?.id || null,
      });
    } catch (e) {
      results.push({
        email: user.email,
        role: user.role,
        success: false,
        error: e.message,
        user_id: null,
      });
    }
  }

  const succeeded = results.filter(r => r.success).length;
  const failed    = results.filter(r => !r.success).length;

  return res.status(200).json({
    message: `Seed complete — ${succeeded} aangemaakt, ${failed} mislukt`,
    results,
    next_steps: [
      '1. Controleer in Supabase: SELECT id, email, role, is_active FROM profiles ORDER BY role;',
      '2. Elke user vraagt via login.html → "Wachtwoord vergeten" een wachtwoord aan',
      '3. SEED_SECRET kan nu worden verwijderd uit Vercel env vars (optioneel)',
    ],
  });
}
