import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.warn('Supabase env vars niet geconfigureerd (SUPABASE_URL / SUPABASE_ANON_KEY)');
}

export const supabase = createClient(
  process.env.SUPABASE_URL  || '',
  process.env.SUPABASE_ANON_KEY || ''
);
