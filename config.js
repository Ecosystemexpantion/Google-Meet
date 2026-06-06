// EEM26 Selar Setup Training — Platform Configuration
// =====================================================
// To change the training schedule, update TRAINING_DAY, TRAINING_HOUR etc.
// To change the host password, run:  echo -n 'newpassword' | sha256sum
// and paste the result into HOST_PASSWORD_HASH.
// =====================================================

window.EEM26_CONFIG = {
  SUPABASE_URL:      'https://leqizarzgfpiriknpnxw.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxlcWl6YXJ6Z2ZwaXJpa25wbnh3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAxNzgxNTcsImV4cCI6MjA5NTc1NDE1N30.LNSMP3LXJv_QKE9COMmm9OS5axVGqw_60m750c6bBeg',

  // Video provider — switched from meet.jit.si (5-min embed limit) to meet.ffmuc.net
  JITSI_DOMAIN: 'meet.ffmuc.net',

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
