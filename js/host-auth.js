// ─── Host password gate ───────────────────────────────────
// The password is checked by the server (Supabase Edge Function secret
// HOST_PASSWORD); nothing secret lives in the browser.
import { api } from './live/api.js?v=6773c834';

const form      = document.getElementById('auth-form');
const passInput = document.getElementById('password-input');
const errorEl   = document.getElementById('auth-error');
const submitBtn = document.getElementById('auth-submit');

if (sessionStorage.getItem('eem26_host_pw')) {
  window.location.href = 'host-room.html';
}
if (new URLSearchParams(location.search).get('e')) {
  showError('Your session expired or the password changed — please sign in again.');
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.classList.add('hidden');
  submitBtn.disabled    = true;
  submitBtn.textContent = 'Checking…';
  try {
    await api('host-login', { password: passInput.value });
    sessionStorage.setItem('eem26_host_pw', passInput.value);
    window.location.href = 'host-room.html';
  } catch (err) {
    showError(err.status === 401 ? 'Incorrect password — please try again.' : `Could not sign in: ${err.message}`);
    passInput.value = '';
    passInput.focus();
    passInput.classList.add('shake');
    setTimeout(() => passInput.classList.remove('shake'), 500);
    submitBtn.disabled    = false;
    submitBtn.textContent = 'Enter Presenter Studio';
  }
});
