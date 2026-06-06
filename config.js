// EEM26 Selar Setup Training — Platform Configuration
// =====================================================
// REQUIRED SETUP:
//  1. Go to https://app.supabase.com → your project → Settings → API
//  2. Copy "Project URL"  → paste below as SUPABASE_URL
//  3. Copy "anon public"  → paste below as SUPABASE_ANON_KEY
//  4. Run supabase-setup.sql in your Supabase SQL editor
// =====================================================

const EEM26_CONFIG = {
  // ⚠️  Replace these two values with your Supabase project credentials
  SUPABASE_URL:      'https://YOUR_PROJECT_ID.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_ANON_KEY_HERE',

  // Video provider (do not change unless self-hosting Jitsi)
  JITSI_DOMAIN: 'meet.jit.si',

  // Host password — SHA-256 hash of 'EEM26@2026'
  // To change: run  echo -n 'newpassword' | sha256sum  and paste result here
  HOST_PASSWORD_HASH: 'c9ff041c67a228bc7c4bcaf9df652d62f593ec33c1dd3921e06fe75f0b9a038e',

  // Training schedule (used for the countdown timer)
  TRAINING_DAY:              0,   // 0 = Sunday
  TRAINING_HOUR:            20,   // 8 PM  (24-hour clock)
  TRAINING_MINUTE:           0,
  TRAINING_TIMEZONE_OFFSET: 60,   // GMT+1 = 60 minutes ahead of UTC
  LIVE_WINDOW_MINUTES:     120,   // Show "LIVE NOW" within 2 hours of training time

  // Room name base — a week-number suffix is appended automatically each week
  ROOM_PREFIX: 'EEM26SelarSetup',

  // Closing message broadcast when host ends the session
  CLOSING_MESSAGE: 'This opportunity ends by 12 midnight. Don\'t miss this opportunity. Message Coach Victor to keep a slot for you.',
};
