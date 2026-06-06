// ─── Host control panel ───────────────────────────────────
(async function () {
  'use strict';
  if (sessionStorage.getItem('eem26_host') !== 'ok') { window.location.href = 'host.html'; return; }
  if (!window.EEM26_CONFIG) { console.error('config.js not loaded'); return; }
  const CFG = window.EEM26_CONFIG;

  const { createClient } = window.supabase;
  const sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

  const jitsiArea        = document.getElementById('jitsi-area');
  const startBtn         = document.getElementById('start-btn');
  const endBtn           = document.getElementById('end-btn');
  const muteAllBtn       = document.getElementById('mute-all-btn');
  const sessionBadge     = document.getElementById('session-badge');
  const sessionBadgeDot  = document.getElementById('badge-dot');
  const sessionBadgeText = document.getElementById('badge-text');
  const watchingEl       = document.getElementById('watching-count');
  const handsEl          = document.getElementById('hands-count');
  const participantsList = document.getElementById('participants-list');
  const noParticipants   = document.getElementById('no-participants');

  let currentSession = null;
  let jitsiApi       = null;
  let participants   = new Map();

  function getWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - y) / 86400000) + 1) / 7);
  }
  function buildRoomName() {
    const now = new Date();
    return `${CFG.ROOM_PREFIX}${now.getFullYear()}W${String(getWeek(now)).padStart(2, '0')}`;
  }

  async function fetchSession() {
    const { data } = await sb.from('sessions').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle();
    return data;
  }

  async function startSession() {
    startBtn.disabled = true; startBtn.textContent = 'Starting…';
    const roomName = buildRoomName();
    let session = await fetchSession();
    if (!session) {
      const { data } = await sb.from('sessions').insert({ room_name: roomName, is_active: true, started_at: new Date().toISOString() }).select().single();
      session = data;
    } else {
      await sb.from('sessions').update({ room_name: roomName, is_active: true, started_at: new Date().toISOString(), ended_at: null }).eq('id', session.id);
      session.room_name = roomName; session.is_active = true;
    }
    currentSession = session;
    updateSessionUI(true);
    await loadParticipants();
    subscribeParticipants();
    await initPresence();
    initJitsi(session.room_name);
    const ph = document.getElementById('host-placeholder');
    if (ph) ph.style.display = 'none';
  }

  async function endSession() {
    if (!currentSession) return;
    if (!confirm('End the session now? All students will see the closing message.')) return;
    endBtn.disabled = true; endBtn.textContent = 'Ending…';
    await sb.from('participants').update({ has_speaking_permission: false, is_active: false, left_at: new Date().toISOString() }).eq('session_id', currentSession.id);
    await sb.from('sessions').update({ is_active: false, ended_at: new Date().toISOString() }).eq('id', currentSession.id);
    if (jitsiApi) { try { jitsiApi.executeCommand('endConference'); } catch(_) {} }
    currentSession.is_active = false;
    updateSessionUI(false);
  }

  function updateSessionUI(active) {
    sessionBadge.className    = `session-badge ${active ? 'active' : 'inactive'}`;
    sessionBadgeDot.className = `badge-dot ${active ? 'active' : 'inactive'}`;
    sessionBadgeText.textContent = active ? 'LIVE' : 'Not started';
    startBtn.classList.toggle('hidden', active);
    endBtn.classList.toggle('hidden', !active);
    muteAllBtn.disabled = !active;
    startBtn.disabled = false; startBtn.textContent = '▶ Start Training';
    endBtn.disabled   = false; endBtn.textContent   = '⏹ End for Everyone';
  }

  function initJitsi(roomName) {
    if (!window.JitsiMeetExternalAPI) { console.error('Jitsi API not loaded'); return; }
    if (jitsiApi) { try { jitsiApi.dispose(); } catch(_) {} }
    jitsiApi = new JitsiMeetExternalAPI(CFG.JITSI_DOMAIN, {
      roomName, parentNode: jitsiArea, width: '100%', height: '100%',
      userInfo: { displayName: 'Coach Victor (Host)' },
      configOverwrite: { startWithAudioMuted: false, startWithVideoMuted: false, prejoinPageEnabled: false, disableDeepLinking: true, disableInviteFunctions: true, p2p: { enabled: false } },
      interfaceConfigOverwrite: {
        SHOW_JITSI_WATERMARK: false, SHOW_WATERMARK_FOR_GUESTS: false, SHOW_BRAND_WATERMARK: false,
        BRAND_WATERMARK_LINK: '', SHOW_POWERED_BY: false, SHOW_PROMOTIONAL_CLOSE_PAGE: false,
        MOBILE_APP_PROMO: false, ENABLE_FEEDBACK_ANIMATION: false,
        DISABLE_JOIN_LEAVE_NOTIFICATIONS: true, DEFAULT_BACKGROUND: '#202124',
        TOOLBAR_BUTTONS: ['microphone','camera','desktop','participants-pane','chat','raisehand','tileview','settings','fullscreen','security','hangup'],
      },
    });
  }

  async function initPresence() {
    if (!currentSession) return;
    const ch = sb.channel(`presence:${currentSession.room_name}`, { config: { presence: { key: 'host' } } });
    ch.on('presence', { event: 'sync' }, () => {
      watchingEl.textContent = Object.values(ch.presenceState()).flat().length;
    });
    await ch.subscribe(async (status) => { if (status === 'SUBSCRIBED') await ch.track({ name: 'Host' }); });
  }

  async function loadParticipants() {
    if (!currentSession) return;
    const { data } = await sb.from('participants').select('*').eq('session_id', currentSession.id).eq('is_active', true).order('joined_at');
    participants.clear();
    (data || []).forEach(p => participants.set(p.id, p));
    renderParticipants();
  }

  function subscribeParticipants() {
    if (!currentSession) return;
    sb.channel(`host-p:${currentSession.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'participants', filter: `session_id=eq.${currentSession.id}` },
        (payload) => {
          if (payload.eventType === 'INSERT') participants.set(payload.new.id, payload.new);
          else if (payload.eventType === 'UPDATE') participants.set(payload.new.id, payload.new);
          else if (payload.eventType === 'DELETE') participants.delete(payload.old.id);
          renderParticipants();
        })
      .subscribe();
  }

  function renderParticipants() {
    const list = [...participants.values()].filter(p => p.is_active);
    handsEl.textContent = list.filter(p => p.has_raised_hand).length;
    if (list.length === 0) { participantsList.innerHTML = ''; noParticipants.classList.remove('hidden'); return; }
    noParticipants.classList.add('hidden');
    list.sort((a, b) => {
      if (a.has_raised_hand !== b.has_raised_hand) return b.has_raised_hand - a.has_raised_hand;
      return new Date(a.joined_at) - new Date(b.joined_at);
    });
    participantsList.innerHTML = list.map(p => `
      <div class="participant-row" id="prow-${p.id}">
        <div class="p-avatar">${esc(p.name).charAt(0).toUpperCase()}</div>
        <div class="p-info">
          <div class="p-name">${esc(p.name)}</div>
          <div class="p-badges">
            ${p.has_raised_hand ? '<span class="badge-hand">✋ Hand raised</span>' : ''}
            ${p.has_speaking_permission ? '<span class="badge-speak">🎤 Speaking</span>' : ''}
          </div>
        </div>
        <div class="p-actions">
          ${p.has_speaking_permission
            ? `<button class="p-btn revoke" onclick="hostRevokePermission('${p.id}')">Mute</button>`
            : `<button class="p-btn" onclick="hostGrantPermission('${p.id}')">Allow Speak</button>`
          }
        </div>
      </div>
    `).join('');
  }

  function esc(str) { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  window.hostGrantPermission = async (id) => {
    await sb.from('participants').update({ has_speaking_permission: true, has_raised_hand: false }).eq('id', id);
    const p = participants.get(id); if (p) { p.has_speaking_permission = true; p.has_raised_hand = false; }
    renderParticipants();
  };
  window.hostRevokePermission = async (id) => {
    await sb.from('participants').update({ has_speaking_permission: false }).eq('id', id);
    const p = participants.get(id); if (p) p.has_speaking_permission = false;
    renderParticipants();
  };

  startBtn.addEventListener('click', startSession);
  endBtn.addEventListener('click', endSession);
  muteAllBtn.addEventListener('click', async () => {
    if (!currentSession) return;
    await sb.from('participants').update({ has_speaking_permission: false }).eq('session_id', currentSession.id);
    if (jitsiApi) { try { jitsiApi.executeCommand('muteEveryone', 'audio'); } catch(_) {} }
  });

  const existingSession = await fetchSession();
  if (existingSession) {
    currentSession = existingSession;
    updateSessionUI(existingSession.is_active);
    if (existingSession.is_active) {
      await loadParticipants(); subscribeParticipants(); await initPresence(); initJitsi(existingSession.room_name);
      const ph = document.getElementById('host-placeholder'); if (ph) ph.style.display = 'none';
    }
  } else { updateSessionUI(false); }
})();
