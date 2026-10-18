// Supabase Edge Function entry point (see README.md → "Setup").
import { createHandler, supabaseStore } from './handler.js';

const env = (key: string) => Deno.env.get(key);

Deno.serve(createHandler({
  env,
  store: supabaseStore({
    url: env('SUPABASE_URL')!,
    serviceKey: env('SUPABASE_SERVICE_ROLE_KEY')!,
  }),
}));
