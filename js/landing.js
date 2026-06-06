// ─── Landing page logic ───────────────────────────────────
(async function () {
  'use strict';

  // Guard: config must be loaded first
  if (!window.EEM26_CONFIG) { console.error('config.js not loaded'); return; }
  const CFG = window.EEM26_CONFIG;

  // ── Supabase client ──────────────────────────────────────
  const { createClient } = window.supabase;
  const sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

  // ── DOM refs ─────────────────────────────────────────────
  const statusStripe    = document.getElementById('status-stripe');
  const countdownWrap   = document.getElementById('countdown-wrap');
  const liveBlock       = document.getElementById('live-block');
  const joinSection     = document.getElementById('join-section');
  const waitingCard     = document.getElementById('waiting-card');
  const nameInput       = document.getElementById('student-name');
  const joinBtn         = document.getElementById('join-btn');
  const cdDays          = document.getElementById('cd-days');
  const cdHours         = document.getElementById('cd-hours');
  const cdMins          = document.getElementById('cd-mins');
  const cdSecs          = document.getElementById('cd-secs');

  // ── State ─────────────────────────────────────────────────
  let activeSession  = null;
  let cdInterval     = null;

  // ── Training time helpers ─────────────────────────────────
  function getNextTrainingUTC() {
    const offsetMs = CFG.TRAINING_TIMEZONE_OFFSET * 60 * 1000;
    const nowUTC   = Date.now();
    const nowLocal = new Date(nowUTC + offsetMs);

    const day  = nowLocal.getUTCDay();
    const hour = nowLocal.getUTCHours();
    const min  = nowLocal.getUTCMinutes();

    const target = CFG.TRAINING_DAY;
    let daysAhead = (target - day + 7) % 7;

    if (daysAhead === 0) {
      const elapsed = (hour - CFG.TRAINING_HOUR) * 60 + (min - CFG.TRAINING_MINUTE);
      if (elapsed > CFG.LIVE_WINDOW_MINUTES) daysAhead = 7;
    }

    const localTarget = new Date(nowLocal);
    localTarget.setUTCDate(localTarget.getUTCDate() + daysAhead);
    localTarget.setUTCHours(CFG.TRAINING_HOUR, CFG.TRAINING_MINUTE, 0, 0);
    return new Date(localTarget.getTime() - offsetMs);
  }

  function withinLiveWindow() {
    const diff = (getNextTrainingUTC() - Date.now()) / 60000;
    return diff <= 0 && diff >= -CFG.LIVE_WINDOW_MINUTES;
  }

  // ── Countdown ─────────────────────────────────────────────
  function tick() {
    const diff = getNextTrainingUTC() - Date.now();
    if (diff <= 0) {
      clearInterval(cdInterval);
      refreshUI();
      return;
    }
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000)  / 60000);
    const s = Math.floor((diff % 60000)    / 1000);
    cdDays.textContent  = String(d).padStart(2, '0');
    cdHours.textContent = String(h).padStart(2, '0');
    cdMins.textContent  = String(m).padStart(2, '0');
    cdSecs.textContent  = String(s).padStart(2, '0');
  }

  function startCountdown() {
    clearInterval(cdInterval);
    tick();
    cdInterval = setInterval(tick, 1000);
  }

  // ── UI state machine ──────────────────────────────────────
  function refreshUI(session) {
    if (session !== undefined) activeSession = session;

    const isLive    = withinLiveWindow();
    const hasSession = activeSession && activeSession.is_active;

    // Hide everything, show what's needed
    countdownWrap.classList.add('hidden');
    liveBlock.classList.add('hidden');
    joinSection.classList.add('hidden');
    waitingCard.classList.add('hidden');
    statusStripe.className = 'status-stripe';
    statusStripe.textContent = '';

    if (hasSession) {
      // ✅ Session started — show join form
      liveBlock.classList.remove('hidden');
      joinSection.classList.remove('hidden');
      statusStripe.classList.add('live');
      statusStripe.textContent = '🔴 Training is LIVE — Enter your name and join now!';
    } else if (isLive) {
      // ⏳ It's training time but host hasn't started
      liveBlock.classList.remove('hidden');
      waitingCard.classList.remove('hidden');
      statusStripe.classList.add('waiting');
      statusStripe.textContent = '⏳ Coach Victor will open the room any moment — stay here!';
    } else {
      // 📅 Upcoming — show countdown
      countdownWrap.classList.remove('hidden');
      statusStripe.classList.add('soon');
      statusStripe.textContent = '📅 Next training: Every Sunday at 8:00 PM (GMT+1)';
      startCountdown();
    }
  }

  // ── Fetch session ─────────────────────────────────────────
  async function fetchSession() {
    const { data, error } = await sb
      .from('sessions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) console.error('Session fetch:', error.message);
    return data;
  }

  // ── Realtime subscription ─────────────────────────────────
  sb.channel('landing-session')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' },
      (payload) => { refreshUI(payload.new); })
    .subscribe();

  // ── Name input ────────────────────────────────────────────
  nameInput.addEventListener('input', () => {
    joinBtn.disabled = nameInput.value.trim().length < 2;
  });
  nameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !joinBtn.disabled) handleJoin();
  });
  joinBtn.addEventListener('click', handleJoin);

  function handleJoin() {
    const raw  = nameInput.value.trim();
    if (!raw || raw.length < 2) return;

    if (!activeSession || !activeSession.is_active) {
      alert('The training hasn\'t started yet. Please wait — Coach Victor will open the room soon.');
      return;
    }

    const firstName     = raw.split(' ')[0];
    const participantId = crypto.randomUUID();
    const payload = {
      id:        participantId,
      name:      firstName,
      fullName:  raw,
      sessionId: activeSession.id,
      roomName:  activeSession.room_name,
    };

    // Store in sessionStorage AND url params so refresh works
    sessionStorage.setItem('eem26_p', JSON.stringify(payload));
    const params = new URLSearchParams({
      n: firstName,
      pid: participantId,
      sid: activeSession.id,
      rm: activeSession.room_name,
    });
    window.location.href = `room.html?${params}`;
  }

  // ── Init ──────────────────────────────────────────────────
  const session = await fetchSession();
  refreshUI(session);
})();
