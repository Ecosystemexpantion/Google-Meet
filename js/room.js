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
  const streamContainer  = document.getElementById('stream-container');
  const streamIframe     = document.getElementById('stream-iframe');
  const liveLobby        = document.getElementById('live-lobby');
  const joinCallBtn      = document.getElementById('join-call-btn');
  const lobbyTitle       = document.getElementById('lobby-title');
  const lobbyNameDisplay = document.getElementById('lobby-name-display');
  const joinHint         = document.getElementById('join-hint');
  const attendanceEl     = document.getElementById('attendance-count');
  const tickerEl         = document.getElementById('ticker-text');
  const tickerCard       = document.getElementById('ticker-card');
  const handBtn          = document.getElementById('hand-btn');
  const speakBtn         = document.getElementById('speak-btn');
  const permToast        = document.getElementById('perm-toast');
  const closingOverlay   = document.getElementById('closing-overlay');
  const closingReturnBtn = document.getElementById('closing-return-btn');
  const appHint          = document.getElementById('app-hint');
  const appStoreLink     = document.getElementById('app-store-link');

  // Show app install hint on Android phones
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isIOS     = /iPhone|iPad/i.test(navigator.userAgent);
  if (appHint && (isAndroid || isIOS)) {
    appHint.classList.remove('hidden');
    if (appStoreLink && isIOS) {
      appStoreLink.href = 'https://apps.apple.com/app/jitsi-meet/id1165103905';
    }
    // Dismiss hint after 12 seconds
    setTimeout(() => appHint.classList.add('hidden'), 12000);
  }

  let handRaised    = false;
  let hasPermission = false;
  let recentJoiners = [];
  let callWindow    = null;

  // Convert any stream URL to an embeddable URL
  function toEmbedUrl(url) {
    if (!url) return null;
    // YouTube: watch, short, live URLs
    const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/live\/)([a-zA-Z0-9_-]+)/);
    if (yt) return `https://www.youtube.com/embed/${yt[1]}?autoplay=1&rel=0&modestbranding=1`;
    if (url.includes('youtube.com/embed/')) return url;
    // Twitch: channel URL → embed player
    const tw = url.match(/twitch\.tv\/([a-zA-Z0-9_]+)/);
    if (tw) {
      const parent = window.location.hostname || 'localhost';
      return `https://player.twitch.tv/?channel=${tw[1]}&parent=${parent}&autoplay=true&muted=false`;
    }
    return null;
  }

  function buildJitsiUrl() {
    const fragment = [
      `config.startWithAudioMuted=true`,
      `config.startWithVideoMuted=true`,
      `config.disableDeepLinking=true`,
      `config.prejoinPageEnabled=false`,
      `userInfo.displayName=${encodeURIComponent(name)}`,
    ].join('&');
    return `https://${CFG.JITSI_DOMAIN}/${roomName}#${fragment}`;
  }

  function showStream(streamUrl) {
    const embedUrl = toEmbedUrl(streamUrl);
    if (!embedUrl) { showLiveLobby(); return; }
    placeholder.classList.add('hidden');
    liveLobby.classList.add('hidden');
    streamIframe.src = embedUrl;
    streamContainer.classList.remove('hidden');
  }

  function showLiveLobby() {
    placeholder.classList.add('hidden');
    streamContainer.classList.add('hidden');
    liveLobby.classList.remove('hidden');
    if (lobbyNameDisplay) lobbyNameDisplay.textContent = `Logged in as ${name}`;
  }

  function showWaiting() {
    streamContainer.classList.add('hidden');
    liveLobby.classList.add('hidden');
    placeholder.classList.remove('hidden');
  }

  // After student clicks "Join" — switch the lobby to an "in-call" state
  function showInCallState() {
    if (lobbyTitle) lobbyTitle.textContent = 'You\'re in the video call';
    if (lobbyNameDisplay) lobbyNameDisplay.textContent = 'Raise your hand below ✋ — come back here anytime';
    if (joinHint) joinHint.textContent = 'Tap above to re-open the video tab.';
    if (joinCallBtn) {
      joinCallBtn.innerHTML = '📺 &nbsp;Re-open Video Tab';
      joinCallBtn.onclick = () => {
        if (callWindow && !callWindow.closed) {
          callWindow.focus();
        } else {
          callWindow = window.open(buildJitsiUrl(), '_jitsi_call');
        }
      };
    }
  }

  // Initial session check
  const { data: session } = await sb.from('sessions')
    .select('is_active, stream_url')
    .eq('id', sessionId).maybeSingle();

  if (session && session.is_active) {
    if (session.stream_url) {
      showStream(session.stream_url);
    } else {
      showLiveLobby();
    }
  } else {
    showWaiting();
  }

  // Register participant
  await sb.from('participants').upsert({
    id: pid, session_id: sessionId, name,
    joined_at: new Date().toISOString(), is_active: true,
    has_speaking_permission: false, has_raised_hand: false,
  }, { onConflict: 'id', ignoreDuplicates: false });

  // Leave tracking
  window.addEventListener('beforeunload', () => {
    if (!pid) return;
    fetch(`${CFG.SUPABASE_URL}/rest/v1/participants?id=eq.${pid}`, {
      method: 'PATCH',
      headers: { 'apikey': CFG.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${CFG.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ is_active: false, left_at: new Date().toISOString() }),
      keepalive: true,
    });
  });

  // Presence (attendance counter)
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

  // Speaking permission changes
  sb.channel(`perm:${pid}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'participants', filter: `id=eq.${pid}` },
      (payload) => {
        const granted = payload.new.has_speaking_permission;
        if (granted && !hasPermission)      { hasPermission = true;  showPermissionUI(); }
        else if (!granted && hasPermission) { hasPermission = false; hidePermissionUI(); }
      })
    .subscribe();

  // Session state changes (stream URL update, session end)
  sb.channel(`session:${sessionId}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` },
      (payload) => {
        if (!payload.new.is_active) {
          showClosingMessage();
        } else if (payload.new.stream_url) {
          showStream(payload.new.stream_url);
        } else if (!payload.new.stream_url && streamContainer && !streamContainer.classList.contains('hidden')) {
          showLiveLobby();
        }
      })
    .subscribe();

  // Session start (student arrived before host started)
  sb.channel('session-start-watch')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sessions' },
      (payload) => {
        if (payload.new.is_active && !placeholder.classList.contains('hidden')) {
          if (payload.new.stream_url) {
            showStream(payload.new.stream_url);
          } else {
            showLiveLobby();
          }
        }
      })
    .subscribe();

  // Join Jitsi fallback button
  if (joinCallBtn) {
    joinCallBtn.addEventListener('click', () => {
      callWindow = window.open(buildJitsiUrl(), '_jitsi_call');
      showInCallState();
    });
  }

  // Hand raise
  handBtn.addEventListener('click', async () => {
    handRaised = !handRaised;
    handBtn.classList.toggle('raised', handRaised);
    handBtn.innerHTML = handRaised ? '✋' : '🖐️';
    await sb.from('participants').update({ has_raised_hand: handRaised }).eq('id', pid);
  });

  // Speak button — opens Jitsi for Q&A
  if (speakBtn) {
    speakBtn.addEventListener('click', () => {
      callWindow = window.open(buildJitsiUrl(), '_jitsi_call');
    });
  }

  function showPermissionUI() {
    // Vibrate the phone so student knows even if they're watching Jitsi
    if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 500]);

    // Flash tab title so it's visible even when another tab is in focus
    const originalTitle = document.title;
    document.title = '🔴 Coach says you can speak! — EEM26';
    document.addEventListener('visibilitychange', function restoreTitle() {
      if (!document.hidden) {
        document.title = originalTitle;
        document.removeEventListener('visibilitychange', restoreTitle);
      }
    });

    permToast.textContent = '🎉 Coach Victor says you can speak! Switch back here then tap below.';
    permToast.classList.remove('hidden');
    if (speakBtn) speakBtn.classList.remove('hidden');
    setTimeout(() => permToast.classList.add('hidden'), 15000);
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
