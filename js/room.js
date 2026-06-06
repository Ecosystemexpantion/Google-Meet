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
  const appHint          = document.getElementById('app-hint');

  // Show mobile hint on phones
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isIOS     = /iPhone|iPad/i.test(navigator.userAgent);
  if (appHint && (isAndroid || isIOS)) {
    appHint.classList.remove('hidden');
    setTimeout(() => appHint.classList.add('hidden'), 14000);
  }

  let handRaised    = false;
  let hasPermission = false;
  let recentJoiners = [];
  let callWindow    = null;

  // Parse stream_url — may be JSON {meetA, meetB} or a plain URL
  function parseMeetUrls(streamUrl) {
    if (!streamUrl) return null;
    try {
      const parsed = JSON.parse(streamUrl);
      if (parsed && parsed.meetA) return parsed;
    } catch (_) {}
    return { meetA: streamUrl, meetB: null };
  }

  // Deterministically split student between Meeting A and B based on participant ID
  function getAssignedMeetUrl(urls) {
    if (!urls || !urls.meetA) return null;
    if (!urls.meetB) return urls.meetA;
    const hash = pid.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
    return hash % 2 === 0 ? urls.meetA : urls.meetB;
  }

  // Video call platforms — open in new tab
  function isCallPlatformUrl(url) {
    if (!url) return false;
    return /meet\.google\.com|zoom\.us|us0[0-9]\.zoom\.us|teams\.microsoft\.com|webex\.com|whereby\.com/i.test(url);
  }

  // Streaming platforms — embeddable in iframe
  function toEmbedUrl(url) {
    if (!url) return null;
    if (isCallPlatformUrl(url)) return null;
    const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/live\/)([a-zA-Z0-9_-]+)/);
    if (yt) return `https://www.youtube.com/embed/${yt[1]}?autoplay=1&rel=0&modestbranding=1`;
    if (url.includes('youtube.com/embed/')) return url;
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
    const meetUrls = parseMeetUrls(streamUrl);
    if (meetUrls && meetUrls.meetA && isCallPlatformUrl(meetUrls.meetA)) {
      // Google Meet (or similar) — show lobby with assigned link
      const assignedUrl = getAssignedMeetUrl(meetUrls);
      showLiveLobby();
      if (joinCallBtn) {
        joinCallBtn.innerHTML = '📹 &nbsp;Join Live Video Call';
        joinCallBtn.onclick = () => {
          callWindow = window.open(assignedUrl, '_call');
          showInCallState(assignedUrl);
        };
      }
      return;
    }
    // Try embedding (YouTube / Twitch)
    if (isCallPlatformUrl(streamUrl)) {
      showLiveLobby();
      if (joinCallBtn) {
        joinCallBtn.innerHTML = '📹 &nbsp;Join Live Video Call';
        joinCallBtn.onclick = () => {
          callWindow = window.open(streamUrl, '_call');
          showInCallState(streamUrl);
        };
      }
      return;
    }
    const embedUrl = toEmbedUrl(streamUrl);
    if (embedUrl) {
      placeholder.classList.add('hidden');
      liveLobby.classList.add('hidden');
      const sc = document.getElementById('stream-container');
      const si = document.getElementById('stream-iframe');
      if (sc && si) { si.src = embedUrl; sc.classList.remove('hidden'); }
      return;
    }
    showLiveLobby();
  }

  function showLiveLobby() {
    placeholder.classList.add('hidden');
    const sc = document.getElementById('stream-container');
    if (sc) sc.classList.add('hidden');
    liveLobby.classList.remove('hidden');
    if (lobbyNameDisplay) lobbyNameDisplay.textContent = `Logged in as ${name}`;
    // Default: fallback to Jitsi
    if (joinCallBtn) {
      joinCallBtn.innerHTML = '📺 &nbsp;Join Live Video Call';
      joinCallBtn.onclick = () => {
        callWindow = window.open(buildJitsiUrl(), '_jitsi_call');
        showInCallState(null);
      };
    }
  }

  function showWaiting() {
    const sc = document.getElementById('stream-container');
    if (sc) sc.classList.add('hidden');
    liveLobby.classList.add('hidden');
    placeholder.classList.remove('hidden');
  }

  // After student joins — switch lobby to "in-call" state
  function showInCallState(assignedUrl) {
    if (joinCallBtn) {
      joinCallBtn.innerHTML = '📺 &nbsp;Re-open Video Tab';
      joinCallBtn.onclick = () => {
        const url = assignedUrl || buildJitsiUrl();
        if (callWindow && !callWindow.closed) callWindow.focus();
        else callWindow = window.open(url, '_call');
      };
    }
  }

  // Initial session check
  const { data: session } = await sb.from('sessions')
    .select('is_active, stream_url').eq('id', sessionId).maybeSingle();

  if (session && session.is_active) {
    if (session.stream_url) showStream(session.stream_url);
    else showLiveLobby();
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

  // Session state changes
  sb.channel(`session:${sessionId}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` },
      (payload) => {
        if (!payload.new.is_active) {
          showClosingMessage();
        } else if (payload.new.stream_url) {
          showStream(payload.new.stream_url);
        } else {
          showLiveLobby();
        }
      })
    .subscribe();

  // Session start (student arrived before host started)
  sb.channel('session-start-watch')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sessions' },
      (payload) => {
        if (payload.new.is_active && liveLobby.classList.contains('hidden') && placeholder && !placeholder.classList.contains('hidden')) {
          if (payload.new.stream_url) showStream(payload.new.stream_url);
          else showLiveLobby();
        }
      })
    .subscribe();

  // Hand raise
  handBtn.addEventListener('click', async () => {
    handRaised = !handRaised;
    handBtn.classList.toggle('raised', handRaised);
    handBtn.innerHTML = handRaised ? '✋' : '🖐️';
    await sb.from('participants').update({ has_raised_hand: handRaised }).eq('id', pid);
  });

  // Speak button — opens assigned call for Q&A
  if (speakBtn) {
    speakBtn.addEventListener('click', () => {
      if (callWindow && !callWindow.closed) callWindow.focus();
      else callWindow = window.open(buildJitsiUrl(), '_call');
    });
  }

  function showPermissionUI() {
    if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 500]);

    const originalTitle = document.title;
    document.title = '🔴 Coach says you can speak! — EEM26';
    document.addEventListener('visibilitychange', function restoreTitle() {
      if (!document.hidden) {
        document.title = originalTitle;
        document.removeEventListener('visibilitychange', restoreTitle);
      }
    });

    permToast.textContent = '🎉 Coach Victor says you can speak — go to the video call and unmute yourself!';
    permToast.classList.remove('hidden');
    if (speakBtn) {
      speakBtn.textContent = '🎤 Go to Call & Unmute';
      speakBtn.classList.remove('hidden');
    }
    setTimeout(() => permToast.classList.add('hidden'), 12000);
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
