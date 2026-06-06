// ─── Host control panel ───────────────────────────────────
(async function () {
  'use strict';
  if (sessionStorage.getItem('eem26_host') !== 'ok') { window.location.href = 'host.html'; return; }
  if (!window.EEM26_CONFIG) { console.error('config.js not loaded'); return; }
  const CFG = window.EEM26_CONFIG;

  const { createClient } = window.supabase;
  const sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

  const hostPlaceholder   = document.getElementById('host-placeholder');
  const hostCallCard      = document.getElementById('host-call-card');
  const hostOpenCallBtn   = document.getElementById('host-open-call-btn');
  const hostStreamStatus  = document.getElementById('host-stream-status');
  const startBtn          = document.getElementById('start-btn');
  const endBtn            = document.getElementById('end-btn');
  const muteAllBtn        = document.getElementById('mute-all-btn');
  const openCallBtn       = document.getElementById('open-call-btn');
  const sessionBadge      = document.getElementById('session-badge');
  const sessionBadgeDot   = document.getElementById('badge-dot');
  const sessionBadgeText  = document.getElementById('badge-text');
  const watchingEl        = document.getElementById('watching-count');
  const handsEl           = document.getElementById('hands-count');
  const participantsList  = document.getElementById('participants-list');
  const noParticipants    = document.getElementById('no-participants');
  const streamUrlSection  = document.getElementById('stream-url-section');
  const meetUrlA          = document.getElementById('meet-url-a');
  const meetUrlB          = document.getElementById('meet-url-b');
  const setStreamBtn      = document.getElementById('set-stream-btn');
  const streamUrlStatus   = document.getElementById('stream-url-status');

  let currentSession = null;
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

  function buildHostJitsiUrl(roomName) {
    const fragment = [
      `config.startWithAudioMuted=false`,
      `config.startWithVideoMuted=true`,
      `config.disableDeepLinking=true`,
      `config.prejoinPageEnabled=false`,
      `userInfo.displayName=${encodeURIComponent('Coach Victor (Host)')}`,
    ].join('&');
    return `https://${CFG.JITSI_DOMAIN}/${roomName}#${fragment}`;
  }

  function openVideoCall() {
    if (!currentSession) return;
    window.open(buildHostJitsiUrl(currentSession.room_name), '_blank');
  }

  async function fetchSession() {
    const { data } = await sb.from('sessions').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle();
    return data;
  }

  function parseMeetUrls(streamUrl) {
    if (!streamUrl) return { meetA: null, meetB: null };
    try {
      const parsed = JSON.parse(streamUrl);
      if (parsed && parsed.meetA) return parsed;
    } catch (_) {}
    return { meetA: streamUrl, meetB: null };
  }

  function buildStreamVal() {
    const urlA = meetUrlA ? meetUrlA.value.trim() : '';
    const urlB = meetUrlB ? meetUrlB.value.trim() : '';
    if (urlA && urlB) return JSON.stringify({ meetA: urlA, meetB: urlB });
    if (urlA) return JSON.stringify({ meetA: urlA, meetB: null });
    return null;
  }

  function updateStreamStatusDisplay(streamUrl) {
    if (!hostStreamStatus) return;
    const { meetA, meetB } = parseMeetUrls(streamUrl);
    if (meetA) {
      hostStreamStatus.textContent = meetB
        ? '✅ Two Google Meet links active — students split 50/50.'
        : '✅ One Google Meet link active — all students join together.';
      hostStreamStatus.style.color = '#4ade80';
      if (streamUrlStatus) {
        streamUrlStatus.innerHTML = '<span class="stream-active-badge">🟢 Meet links saved — students routed automatically</span>';
      }
    } else {
      hostStreamStatus.textContent = 'No meeting links — students see a Jitsi fallback button.';
      hostStreamStatus.style.color = '';
      if (streamUrlStatus) streamUrlStatus.innerHTML = '';
    }
  }

  async function startSession() {
    startBtn.disabled = true; startBtn.textContent = 'Starting…';
    const roomName = buildRoomName();
    const streamVal = buildStreamVal();
    let session = await fetchSession();
    if (!session) {
      const { data } = await sb.from('sessions').insert({
        room_name: roomName, is_active: true, started_at: new Date().toISOString(),
        stream_url: streamVal,
      }).select().single();
      session = data;
    } else {
      await sb.from('sessions').update({
        room_name: roomName, is_active: true,
        started_at: new Date().toISOString(), ended_at: null,
        stream_url: streamVal,
      }).eq('id', session.id);
      session.room_name = roomName; session.is_active = true;
      session.stream_url = streamVal;
    }
    currentSession = session;
    updateSessionUI(true);
    await loadParticipants();
    subscribeParticipants();
    await initPresence();
  }

  async function endSession() {
    if (!currentSession) return;
    if (!confirm('End the session now? All students will see the closing message.')) return;
    endBtn.disabled = true; endBtn.textContent = 'Ending…';
    await sb.from('participants').update({ has_speaking_permission: false, is_active: false, left_at: new Date().toISOString() }).eq('session_id', currentSession.id);
    await sb.from('sessions').update({ is_active: false, ended_at: new Date().toISOString() }).eq('id', currentSession.id);
    currentSession.is_active = false;
    updateSessionUI(false);
  }

  function updateSessionUI(active) {
    sessionBadge.className    = `session-badge ${active ? 'active' : 'inactive'}`;
    sessionBadgeDot.className = `badge-dot ${active ? 'active' : 'inactive'}`;
    sessionBadgeText.textContent = active ? 'LIVE' : 'Not started';
    startBtn.classList.toggle('hidden', active);
    endBtn.classList.toggle('hidden', !active);
    muteAllBtn.disabled  = !active;
    openCallBtn.disabled = !active;
    startBtn.disabled    = false;
    startBtn.textContent = '▶ Start Training';
    endBtn.disabled      = false;
    endBtn.textContent   = '⏹ End for Everyone';

    if (active && currentSession) {
      if (hostPlaceholder) hostPlaceholder.style.display = 'none';
      if (hostCallCard) hostCallCard.classList.remove('hidden');
      if (hostOpenCallBtn) hostOpenCallBtn.onclick = openVideoCall;
      if (streamUrlSection) streamUrlSection.classList.remove('hidden');
      if (currentSession.stream_url) {
        const { meetA, meetB } = parseMeetUrls(currentSession.stream_url);
        if (meetUrlA) meetUrlA.value = meetA || '';
        if (meetUrlB) meetUrlB.value = meetB || '';
      }
      updateStreamStatusDisplay(currentSession.stream_url);
    } else {
      if (hostPlaceholder) hostPlaceholder.style.display = '';
      if (hostCallCard) hostCallCard.classList.add('hidden');
      if (streamUrlSection) streamUrlSection.classList.add('hidden');
    }
  }

  // Save / update Google Meet links while session is live
  if (setStreamBtn) {
    setStreamBtn.addEventListener('click', async () => {
      if (!currentSession) return;
      setStreamBtn.disabled = true; setStreamBtn.textContent = 'Saving…';
      const streamVal = buildStreamVal();
      await sb.from('sessions').update({ stream_url: streamVal }).eq('id', currentSession.id);
      currentSession.stream_url = streamVal;
      updateStreamStatusDisplay(streamVal);
      setStreamBtn.disabled = false; setStreamBtn.textContent = '✓ Saved';
      setTimeout(() => { setStreamBtn.textContent = 'Save Links'; }, 2500);
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
  if (openCallBtn) openCallBtn.addEventListener('click', openVideoCall);
  muteAllBtn.addEventListener('click', async () => {
    if (!currentSession) return;
    await sb.from('participants').update({ has_speaking_permission: false }).eq('session_id', currentSession.id);
    participants.forEach(p => { p.has_speaking_permission = false; });
    renderParticipants();
  });

  const existingSession = await fetchSession();
  if (existingSession) {
    currentSession = existingSession;
    updateSessionUI(existingSession.is_active);
    if (existingSession.is_active) {
      await loadParticipants(); subscribeParticipants(); await initPresence();
    }
  } else { updateSessionUI(false); }
})();
