/* Public OAuth client ID; no client secret belongs in this browser application. */
(() => {
  'use strict';
  const CLIENT_ID = '277661051128-vt2qbiqu6j1r2u4rjvd328fprtj4tvnn.apps.googleusercontent.com';
  const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
  const EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';
  const requestId = location.hash.slice(1);
  const login = document.getElementById('login'), status = document.getElementById('status');
  const channel = document.getElementById('owa-google-auth-channel');
  let ready = false, delivered = false, waiting = false, client;
  const show = (message, style = '') => { status.textContent = message; status.className = style; };
  if (location.origin !== 'https://mainiken.github.io' || !/^[a-f0-9-]{36}$/i.test(requestId)) {
    show('Открой подключение кнопкой «Войти через Google» в настройках OWA. На этой странице нет активного запроса входа.', 'error'); return;
  }
  const send = data => {
    channel.setAttribute('data-command', JSON.stringify({ ...data, requestId }));
    channel.dispatchEvent(new Event('owa-google-oauth:request', { bubbles: true }));
    // If the userscript is absent, do not leave an access token in the DOM.
    channel.removeAttribute('data-command');
  };
  document.addEventListener('owa-google-oauth:response', () => {
    let response;
    try { response = JSON.parse(channel.getAttribute('data-response') || 'null'); } catch { return; }
    channel.removeAttribute('data-response');
    if (response?.requestId !== requestId) return;
    if (response.type === 'owa-google-oauth:expired') {
      clearInterval(timer); login.disabled = true;
      show('Userscript запущен, но запрос входа истёк или открыт из другой копии скрипта. Закрой эту вкладку и начни вход заново кнопкой в OWA. Оставь включённой одну копию userscript.', 'error'); return;
    }
    if (response.type === 'owa-google-oauth:ready' && !delivered && !waiting) {
      ready = true; login.disabled = !window.google?.accounts?.oauth2;
      if (!login.disabled) { clearInterval(timer); show('Всё готово. Нажми «Войти через Google».'); }
    }
    if (response.type === 'owa-google-oauth:saved' && waiting) {
      delivered = true; waiting = false; login.disabled = true;
      show('Доступ передан userscript. Вернись в OWA, дождись сообщения о подключении, затем нажми «Синхронизировать».', 'success');
      // The nonce is no longer needed and never contains a token.
      history.replaceState(null, '', location.pathname);
    }
  });
  let checks = 0;
  const timer = setInterval(() => {
    if (delivered || checks++ >= 1200) {
      clearInterval(timer);
      if (!delivered) show('Время подключения истекло. Закрой эту вкладку и начни вход заново из OWA.', 'error');
      return;
    }
    if (checks === 40) {
      if (!ready) show('На этой странице userscript не запустился. Обнови его до версии 1.3.1, разреши Tampermonkey доступ к mainiken.github.io и запуск пользовательских скриптов в браузере. Проверка продолжится автоматически. Если менял настройки расширения, закрой эту вкладку и начни вход заново из OWA.', 'error');
      else if (!window.google?.accounts?.oauth2) show('Не загрузилось окно Google. Проверь доступ к accounts.google.com и блокировщики, затем обнови страницу.', 'error');
    }
    send({ type: 'owa-google-oauth:hello' });
  }, 250);
  login.addEventListener('click', () => {
    if (!ready || delivered || waiting || !window.google?.accounts?.oauth2) return;
    client ||= google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID, scope: `openid ${EMAIL_SCOPE} ${CALENDAR_SCOPE}`, include_granted_scopes: false,
      callback(response) {
        if (response.error || !response.access_token) { login.disabled = false; show('Google не выдал доступ. Повтори вход и подтверди разрешения.', 'error'); return; }
        if (!google.accounts.oauth2.hasGrantedAllScopes(response, CALENDAR_SCOPE, EMAIL_SCOPE)) {
          login.disabled = false; show('Нужны разрешения на календарь приложения и адрес аккаунта. Повтори вход и отметь оба разрешения.', 'error'); return;
        }
        waiting = true; show('Передаю подключение в OWA…');
        send({ type: 'owa-google-oauth:token', accessToken: response.access_token,
          expiresIn: Number(response.expires_in), scope: response.scope });
        setTimeout(() => { if (waiting) { waiting = false; login.disabled = false; show('Не удалось передать подключение в userscript. Проверь доступ Tampermonkey к этой странице и повтори вход из OWA.', 'error'); } }, 5000);
      },
      error_callback(error) {
        login.disabled = false;
        show(error.type === 'popup_closed' ? 'Окно Google закрыто. Можно повторить вход.' : 'Не удалось открыть окно Google. Разреши всплывающие окна для этого сайта и повтори.', 'error');
      }
    });
    login.disabled = true; show('Выбери аккаунт и разреши доступ в окне Google.');
    client.requestAccessToken({ prompt: 'select_account' });
  });
})();
