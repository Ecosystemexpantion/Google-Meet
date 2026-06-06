// ─── Student room logic ───────────────────────────────────
(async function () {
  'use strict';
  if (!window.EEM26_CONFIG) { console.error('config.js not loaded'); return; }
  const CFG = window.EEM26_CONFIG;

  // ── Read identity from URL params or sessionStorage ───────
  const params = new URLSearchParams(window.location.search);
  let pid, name, sessionId, roomName;

  if (params.get('pid')) {
    pid       = params.get('pid');
    name      = params.get('n')  || 'Guest';
    sessionId = params.get('sid');
    roomName  = params.get('rm');
    // Re-persist so refresh still works
    sessionStorage.setItem('eem26_p', JSON.stringify({ id: pid, name, sessionId, roomName }));
  } else {
    const stored = sessionStorage.getItem('eem26_p');
    if (!stored) { window.location.href = 'index.html'; return; }
    ({ id: pid, name, sessionId, roomName } = JSON.parse(stored));
  }
  if (!pid || !roomName) { window.location.href = 'index.html'; return; }

  // ── Supabase ──────────────────────────────────────────────
  const { createClient } = window.supabase;
  const sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

  // ── DOM refs ──────────────────────────────────────────────
  const jitsiContainer  = document.getElementById('jitsi-container');
  const placeholder     = document.getElementById('room-placeholder');
  const attendanceEl    = document.getElementById('attendance-count');
  const tickerEl        = document.getElementById('ticker-text');
  const handBtn         = document.getElementById('hand-btn');
  const speakBtn        = document.getElementById('speak-btn');
  const permToast       = document.getElementById('perm-toast');
  const closingOverlay  = document.getElementById('closing-overlay');
  const closingReturnBtn = document.getElementById('closing-return-btn');

  // ── State ─────────────────────────────────────────────────
  let jitsiApi           = null;
  let handRaised         = false;
  let hasPermission      = false;
  let isSpeaking         = false;
  let recentJoiners      = [];
  let jitsiReady         = false;

  // ── Verify session is active ──────────────────────────────
  const { data: session } = await sb
    .from('sessions')
    .select('is_active')
    .eq('id', sessionId)
    .maybeSingle();

  if (!session || !session.is_active) {
    placeholder.classList.remove('hidden');
    jitsiContainer.style.display = 'none';
  } else {
    placeholder.classList.add('hidden');
    initJitsi();
  }

  // ── Insert participant row ────────────────────────────────
  await sb.from('participants').upsert({
    id:                     pid,
    session_id:             sessionId,
    name:                   name,
    joined_at:              new Date().toISOString(),
    is_active:              true,
    has_speaking_permission: false,
    has_raised_hand:        false,
  }, { onConflict: 'id', ignoreDuplicates: false });

  // ── Leave cleanup (best effort) ───────────────────────────
  window.addEventListener('beforeunload', () => {
    if (!pid) return;
    fetch(`${CFG.SUPABASE_URL}/rest/v1/participants?id=eq.${pid}`, {
      method:  'PATCH',
      headers: {
        'apikey':        CFG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${CFG.SUPABASE_ANON_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
      },
      body:     JSON.stringify({ is_active: false, left_at: new Date().toISOString() }),
      keepalive: true,
    });
  });

  // ── Supabase Presence (attendance counter) ────────────────
  const presenceCh = sb.channel(`presence:${roomName}`, {
    config: { presence: { key: pid } },
  });

  presenceCh
    .on('presence', { event: 'sync' }, () => {
      const count = Object.values(presenceCh.presenceState()).flat().length;
      attendanceEl.textContent = `${count} watching`;
    })
    .on('presence', { event: 'join' }, ({ key, newPresences }) => {
      if (key !== pid) {
        const joinerName = newPresences[0]?.name || 'Someone';
        addToTicker(joinerName);
      }
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await presenceCh.track({ name, userId: pid });
      }
    });

  // ── Ticker ────────────────────────────────────────────────
  function addToTicker(joinerName) {
    recentJoiners.unshift(`${joinerName} joined`);
    if (recentJoiners.length > 6) recentJoiners.pop();
    tickerEl.textContent = recentJoiners.join(' • ');
  }

  // ── Permission subscription ───────────────────────────────
  sb.channel(`perm:${pid}`)
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'participants',
      filter: `id=eq.${pid}`,
    }, (payload) => {
      const granted = payload.new.has_speaking_permission;
      if (granted && !hasPermission) {
        hasPermission = true;
        showPermissionUI();
      } else if (!granted && hasPermission) {
        hasPermission = false;
        hidePermissionUI();
        if (isSpeaking && jitsiApi) {
          jitsiApi.isAudioMuted().then(muted => {
            if (!muted) jitsiApi.executeCommand('toggleAudio');
          });
          isSpeaking = false;
        }
      }
    })
    .subscribe();

  // ── Session-end subscription ──────────────────────────────
  sb.channel(`session:${sessionId}`)
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'sessions',
      filter: `id=eq.${sessionId}`,
    }, (payload) => {
      if (!payload.new.is_active) showClosingMessage();
    })
    .subscribe();

  // ── Jitsi init ────────────────────────────────────────────
  function initJitsi() {
    if (!window.JitsiMeetExternalAPI) {
      console.error('Jitsi API not loaded');
      return;
    }
    jitsiApi = new JitsiMeetExternalAPI(CFG.JITSI_DOMAIN, {
      roomName,
      parentNode:  jitsiContainer,
      width:       '100%',
      height:      '100%',
      userInfo:    { displayName: name },
      configOverwrite: {
        startWithAudioMuted:    true,
        startWithVideoMuted:    true,
        disableDeepLinking:     true,
        prejoinPageEnabled:     false,
        disableInviteFunctions: true,
        toolbarButtons:         [],
        hideConferenceSubject:  true,
        disableProfile:         false,
        disablePolls:           true,
        disableReactions:       true,
        disableShortcuts:       true,
        notifications:          [],
        disableNotifications:   true,
        enableNoisyMicDetection: false,
        enableNoAudioDetection:  false,
        gatherStats:             false,
        remoteVideoMenu:         { disabled: true },
        disableSelfViewSettings: true,
        filmStripOnly:           false,
        p2p:                     { enabled: false },
      },
      interfaceConfigOverwrite: {
        TOOLBAR_BUTTONS:              [],
        SHOW_JITSI_WATERMARK:         false,
        SHOW_WATERMARK_FOR_GUESTS:    false,
        SHOW_BRAND_WATERMARK:         false,
        BRAND_WATERMARK_LINK:         '',
        SHOW_POWERED_BY:              false,
        SHOW_PROMOTIONAL_CLOSE_PAGE:  false,
        MOBILE_APP_PROMO:             false,
        ENABLE_FEEDBACK_ANIMATION:    false,
        DISABLE_JOIN_LEAVE_NOTIFICATIONS: true,
        HIDE_INVITE_MORE_HEADER:      true,
        DEFAULT_BACKGROUND:           '#202124',
        FILM_STRIP_MAX_HEIGHT:        80,
        DEFAULT_REMOTE_DISPLAY_NAME:  'Participant',
      },
    });
    jitsiReady = true;

    jitsiApi.on('audioMuteStatusChanged', ({ muted }) => {
      isSpeaking = !muted;
      if (speakBtn) {
        speakBtn.textContent = muted ? '🎤 Tap to Speak' : '🔴 Click to Mute';
        speakBtn.classList.toggle('is-speaking', !muted);
      }
    });
  }

  // ── Hand raise ────────────────────────────────────────────
  handBtn.addEventListener('click', async () => {
    handRaised = !handRaised;
    handBtn.classList.toggle('raised', handRaised);
    handBtn.innerHTML = handRaised ? '✋' : '🖐️';

    await sb.from('participants')
      .update({ has_raised_hand: handRaised })
      .eq('id', pid);
  });

  // ── Speak button ──────────────────────────────────────────
  if (speakBtn) {
    speakBtn.addEventListener('click', () => {
      if (!hasPermission || !jitsiApi) return;
      jitsiApi.executeCommand('toggleAudio');
    });
  }

  // ── Permission UI ─────────────────────────────────────────
  function showPermissionUI() {
    permToast.classList.remove('hidden');
    speakBtn.classList.remove('hidden');
    permToast.textContent = '🎉 Coach Victor has unmuted you — you may speak!';
  }

  function hidePermissionUI() {
    permToast.classList.add('hidden');
    speakBtn.classList.add('hidden');
    speakBtn.textContent  = '🎤 Tap to Speak';
    speakBtn.classList.remove('is-speaking');
  }

  // ── Closing message ───────────────────────────────────────
  function showClosingMessage() {
    closingOverlay.classList.remove('hidden');
    if (jitsiApi) {
      try { jitsiApi.executeCommand('hangup'); } catch(_) {}
      setTimeout(() => { try { jitsiApi.dispose(); } catch(_) {} }, 800);
    }
  }

  closingReturnBtn.addEventListener('click', () => {
    window.location.href = 'index.html';
  });
})();
