// ─── Student room logic ───────────────────────────────────
(async function () {
  'use strict';
  if (!window.EEM26_CONFIG) { console.error('config.js not loaded'); return; }
  const CFG = window.EEM26_CONFIG;

  const params = new URLSearchParams(window.location.search);
  let pid, name, sessionId, roomName;

  if (params.get('pid')) {
    pid       = params.get('pid');
    name      = params.get('n')  || 'Guest';
    sessionId = params.get('sid');
    roomName  = params.get('rm');
    sessionStorage.setItem('eem26_p', JSON.stringify({ id: pid, name, sessionId, roomName }));
  } else {
    const stored = sessionStorage.getItem('eem26_p');
    if (!stored) { window.location.href = 'index.html'; return; }
    ({ id: pid, name, sessionId, roomName } = JSON.parse(stored));
  }
  if (!pid || !roomName) { window.location.href = 'index.html'; return; }

  const { createClient } = window.supabase;
  const sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

  const placeholder      = document.getElementById('room-placeholder');
  const liveLobby        = document.getElementById('live-lobby');
  const joinCallBtn      = document.getElementById('join-call-btn');
  const lobbyNameDisplay = document.getElementById('lobby-name-display');
  const attendanceEl     = document.getElementById('attendance-count');
  const tickerEl         = document.getElementById('ticker-text');
  const tickerCard       = document.getElementById('ticker-card');
  const handBtn          = document.getElementById('hand-btn');
  const speakBtn         = document.getElementById('speak-btn');
  const permToast        = document.getElementById('perm-toast');
  const closingOverlay   = document.getElementById('closing-overlay');
  const closingReturnBtn = document.getElementById('closing-return-btn');

  let handRaised    = false;
  let hasPermission = false;
  let recentJoiners = [];

  function buildMeetingUrl() {
    const fragment = [
      `config.startWithAudioMuted=true`,
      `config.startWithVideoMuted=true`,
      `config.disableDeepLinking=true`,
      `config.prejoinPageEnabled=false`,
      `userInfo.displayName=${encodeURIComponent(name)}`,
    ].join('&');
    return `https://${CFG.JITSI_DOMAIN}/${roomName}#${fragment}`;
  }

  function showLiveLobby() {
    placeholder.classList.add('hidden');
    liveLobby.classList.remove('hidden');
    if (lobbyNameDisplay) lobbyNameDisplay.textContent = `Logged in as ${name}`;
  }

  function showWaiting() {
    liveLobby.classList.add('hidden');
    placeholder.classList.remove('hidden');
  }

  const { data: session } = await sb.from('sessions').select('is_active').eq('id', sessionId).maybeSingle();
  if (session && session.is_active) {
    showLiveLobby();
  } else {
    showWaiting();
  }

  await sb.from('participants').upsert({
    id: pid, session_id: sessionId, name,
    joined_at: new Date().toISOString(), is_active: true,
    has_speaking_permission: false, has_raised_hand: false,
  }, { onConflict: 'id', ignoreDuplicates: false });

  window.addEventListener('beforeunload', () => {
    if (!pid) return;
    fetch(`${CFG.SUPABASE_URL}/rest/v1/participants?id=eq.${pid}`, {
      method: 'PATCH',
      headers: { 'apikey': CFG.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${CFG.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ is_active: false, left_at: new Date().toISOString() }),
      keepalive: true,
    });
  });

  const presenceCh = sb.channel(`presence:${roomName}`, { config: { presence: { key: pid } } });
  presenceCh
    .on('presence', { event: 'sync' }, () => {
      const count = Object.values(presenceCh.presenceState()).flat().length;
      attendanceEl.textContent = `${count} watching`;
    })
    .on('presence', { event: 'join' }, ({ key, newPresences }) => {
      if (key !== pid) addToTicker(newPresences[0]?.name || 'Someone');
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') await presenceCh.track({ name, userId: pid });
    });

  function addToTicker(joinerName) {
    recentJoiners.unshift(`${joinerName} joined`);
    if (recentJoiners.length > 6) recentJoiners.pop();
    const text = recentJoiners.join(' • ');
    tickerEl.textContent = text;
    if (tickerCard) tickerCard.textContent = text;
  }

  sb.channel(`perm:${pid}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'participants', filter: `id=eq.${pid}` },
      (payload) => {
        const granted = payload.new.has_speaking_permission;
        if (granted && !hasPermission)      { hasPermission = true;  showPermissionUI(); }
        else if (!granted && hasPermission) { hasPermission = false; hidePermissionUI(); }
      })
    .subscribe();

  sb.channel(`session:${sessionId}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` },
      (payload) => { if (!payload.new.is_active) showClosingMessage(); })
    .subscribe();

  sb.channel('session-start-watch')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sessions' },
      (payload) => {
        if (payload.new.is_active && liveLobby.classList.contains('hidden')) {
          showLiveLobby();
        }
      })
    .subscribe();

  if (joinCallBtn) {
    joinCallBtn.addEventListener('click', () => window.open(buildMeetingUrl(), '_blank'));
  }

  handBtn.addEventListener('click', async () => {
    handRaised = !handRaised;
    handBtn.classList.toggle('raised', handRaised);
    handBtn.innerHTML = handRaised ? '✋' : '🖐️';
    await sb.from('participants').update({ has_raised_hand: handRaised }).eq('id', pid);
  });

  if (speakBtn) {
    speakBtn.addEventListener('click', () => window.open(buildMeetingUrl(), '_blank'));
  }

  function showPermissionUI() {
    permToast.textContent = '🎉 Coach Victor says you can speak — go to the video call and unmute yourself!';
    permToast.classList.remove('hidden');
    if (speakBtn) {
      speakBtn.textContent = '🎤 Go to Call & Unmute';
      speakBtn.classList.remove('hidden');
    }
    setTimeout(() => permToast.classList.add('hidden'), 8000);
  }

  function hidePermissionUI() {
    permToast.classList.add('hidden');
    if (speakBtn) speakBtn.classList.add('hidden');
  }

  function showClosingMessage() {
    closingOverlay.classList.remove('hidden');
  }

  closingReturnBtn.addEventListener('click', () => { window.location.href = 'index.html'; });
})();
