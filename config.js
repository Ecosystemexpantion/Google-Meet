// EEM26 Selar Setup Training — Platform Configuration
// =====================================================
// To change the training schedule, update TRAINING_DAY, TRAINING_HOUR etc.
// The host password and Cloudflare keys are NOT here — they are secrets on the
// Supabase Edge Function (see README.md → "Secrets").
// =====================================================

window.EEM26_CONFIG = {
  SUPABASE_URL:      'https://leqizarzgfpiriknpnxw.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxlcWl6YXJ6Z2ZwaXJpa25wbnh3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAxNzgxNTcsImV4cCI6MjA5NTc1NDE1N30.LNSMP3LXJv_QKE9COMmm9OS5axVGqw_60m750c6bBeg',

  // Live classroom API. Leave empty to use the Supabase Edge Function at
  // SUPABASE_URL/functions/v1/classroom (which talks to Cloudflare Realtime).
  CLASSROOM_API: '',

  // Branding shown in the classroom
  BRAND_SHORT:    'EEM26',
  CLASS_TITLE:    'Selar Setup Training',
  PRESENTER_NAME: 'Coach Victor',

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
