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

  const jitsiContainer   = document.getElementById('jitsi-container');
  const placeholder      = document.getElementById('room-placeholder');
  const attendanceEl     = document.getElementById('attendance-count');
  const tickerEl         = document.getElementById('ticker-text');
  const handBtn          = document.getElementById('hand-btn');
  const speakBtn         = document.getElementById('speak-btn');
  const permToast        = document.getElementById('perm-toast');
  const closingOverlay   = document.getElementById('closing-overlay');
  const closingReturnBtn = document.getElementById('closing-return-btn');

  let jitsiApi      = null;
  let handRaised    = false;
  let hasPermission = false;
  let isSpeaking    = false;
  let recentJoiners = [];

  const { data: session } = await sb.from('sessions').select('is_active').eq('id', sessionId).maybeSingle();
  if (!session || !session.is_active) {
    placeholder.classList.remove('hidden');
  } else {
    placeholder.classList.add('hidden');
    initJitsi();
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
    tickerEl.textContent = recentJoiners.join(' • ');
  }

  sb.channel(`perm:${pid}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'participants', filter: `id=eq.${pid}` },
      (payload) => {
        const granted = payload.new.has_speaking_permission;
        if (granted && !hasPermission)       { hasPermission = true;  showPermissionUI(); }
        else if (!granted && hasPermission)  { hasPermission = false; hidePermissionUI();
          if (isSpeaking && jitsiApi) { jitsiApi.isAudioMuted().then(m => { if (!m) jitsiApi.executeCommand('toggleAudio'); }); isSpeaking = false; }
        }
      })
    .subscribe();

  sb.channel(`session:${sessionId}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` },
      (payload) => { if (!payload.new.is_active) showClosingMessage(); })
    .subscribe();

  // Also subscribe to session-started (so waiting students get let in)
  sb.channel('session-start-watch')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sessions' },
      (payload) => { if (payload.new.is_active && placeholder && !placeholder.classList.contains('hidden')) { placeholder.classList.add('hidden'); initJitsi(); } })
    .subscribe();

  function initJitsi() {
    if (!window.JitsiMeetExternalAPI) { console.error('Jitsi API not loaded'); return; }
    jitsiApi = new JitsiMeetExternalAPI(CFG.JITSI_DOMAIN, {
      roomName, parentNode: jitsiContainer, width: '100%', height: '100%',
      userInfo: { displayName: name },
      configOverwrite: {
        startWithAudioMuted: true, startWithVideoMuted: true,
        disableDeepLinking: true, prejoinPageEnabled: false,
        disableInviteFunctions: true, toolbarButtons: [],
        hideConferenceSubject: true, disablePolls: true, disableReactions: true,
        disableShortcuts: true, notifications: [], disableNotifications: true,
        enableNoisyMicDetection: false, enableNoAudioDetection: false,
        gatherStats: false, remoteVideoMenu: { disabled: true },
        disableSelfViewSettings: true, p2p: { enabled: false },
      },
      interfaceConfigOverwrite: {
        TOOLBAR_BUTTONS: [], SHOW_JITSI_WATERMARK: false,
        SHOW_WATERMARK_FOR_GUESTS: false, SHOW_BRAND_WATERMARK: false,
        BRAND_WATERMARK_LINK: '', SHOW_POWERED_BY: false,
        SHOW_PROMOTIONAL_CLOSE_PAGE: false, MOBILE_APP_PROMO: false,
        ENABLE_FEEDBACK_ANIMATION: false, DISABLE_JOIN_LEAVE_NOTIFICATIONS: true,
        HIDE_INVITE_MORE_HEADER: true, DEFAULT_BACKGROUND: '#202124',
        FILM_STRIP_MAX_HEIGHT: 80,
      },
    });
    jitsiApi.on('audioMuteStatusChanged', ({ muted }) => {
      isSpeaking = !muted;
      if (speakBtn) {
        speakBtn.textContent = muted ? '🎤 Tap to Speak' : '🔴 Click to Mute';
        speakBtn.classList.toggle('is-speaking', !muted);
      }
    });
  }

  handBtn.addEventListener('click', async () => {
    handRaised = !handRaised;
    handBtn.classList.toggle('raised', handRaised);
    handBtn.innerHTML = handRaised ? '✋' : '🖐️';
    await sb.from('participants').update({ has_raised_hand: handRaised }).eq('id', pid);
  });

  if (speakBtn) {
    speakBtn.addEventListener('click', () => {
      if (!hasPermission || !jitsiApi) return;
      jitsiApi.executeCommand('toggleAudio');
    });
  }

  function showPermissionUI() {
    permToast.classList.remove('hidden');
    speakBtn.classList.remove('hidden');
    permToast.textContent = '🎉 Coach Victor has unmuted you — you may speak!';
  }
  function hidePermissionUI() {
    permToast.classList.add('hidden');
    speakBtn.classList.add('hidden');
    speakBtn.textContent = '🎤 Tap to Speak';
    speakBtn.classList.remove('is-speaking');
  }

  function showClosingMessage() {
    closingOverlay.classList.remove('hidden');
    if (jitsiApi) { try { jitsiApi.executeCommand('hangup'); } catch(_) {} setTimeout(() => { try { jitsiApi.dispose(); } catch(_) {} }, 800); }
  }

  closingReturnBtn.addEventListener('click', () => { window.location.href = 'index.html'; });
})();
