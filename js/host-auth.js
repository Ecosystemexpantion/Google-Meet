// ─── Host password gate ───────────────────────────────────
(function () {
  'use strict';
  if (sessionStorage.getItem('eem26_host') === 'ok') { window.location.href = 'host-room.html'; return; }

  const form      = document.getElementById('auth-form');
  const passInput = document.getElementById('password-input');
  const errorEl   = document.getElementById('auth-error');
  const submitBtn = document.getElementById('auth-submit');

  async function sha256(str) {
    const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.add('hidden');
    submitBtn.disabled    = true;
    submitBtn.textContent = 'Checking…';
    try {
      if (!window.EEM26_CONFIG) throw new Error('Config not loaded');
      const hash = await sha256(passInput.value);
      if (hash === window.EEM26_CONFIG.HOST_PASSWORD_HASH) {
        sessionStorage.setItem('eem26_host', 'ok');
        window.location.href = 'host-room.html';
        return;
      }
      errorEl.textContent = 'Incorrect password — please try again.';
    } catch (err) {
      errorEl.textContent = 'Error: ' + err.message + '. Please reload the page.';
    }
    errorEl.classList.remove('hidden');
    passInput.value = '';
    passInput.focus();
    passInput.classList.add('shake');
    setTimeout(() => passInput.classList.remove('shake'), 500);
    submitBtn.disabled    = false;
    submitBtn.textContent = 'Enter Host Room';
  });
})();
