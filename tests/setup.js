// tests/setup.js — preload via `node --import ./tests/setup.js`.
//
// ESM imports zijn gehoist: de env-vars in het testbestand zetten draait
// NA de import van `../api/joost-autonomy-evaluate.js` → te laat, supabase-js
// gooit `supabaseUrl is required.` op module-load.
//
// Deze preload draait vóór alle imports en zet dummy env-vars zodat
// `createClient(...)` niet crasht. evaluateAutonomy doet zelf geen DB-call,
// dus de dummy URL wordt nooit aangesproken.
process.env.SUPABASE_URL              ||= 'http://test.local';
process.env.SUPABASE_ANON_KEY         ||= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
