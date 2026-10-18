// Supabase Edge Function entry point.
// Deploy:  supabase functions deploy livekit --no-verify-jwt
// Secrets: supabase secrets set LIVEKIT_URL=wss://... LIVEKIT_API_KEY=... \
//            LIVEKIT_API_SECRET=... HOST_PASSWORD=... HOST_NAME="Coach Victor"
import { createHandler } from './handler.js';

const handle = createHandler((key) => Deno.env.get(key));

Deno.serve(handle);
