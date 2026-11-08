/* 已登入時，把登入用的 email 預先填進表單（2026-09-17）
 *
 * 用在購買頁（#email）與聯絡頁（#contact）。
 *
 * ⚠️ **只是預設值，使用者隨時可以改。** 用公司信箱買、私人 Google 登入的人一定存在
 *    （CLAUDE.md「購買 email ≠ Google email」），所以欄位不鎖、不藏。
 * ⚠️ **不覆蓋使用者或瀏覽器已經填的東西。** /v1/account/me 回來之前使用者可能已經
 *    開始打字，或瀏覽器自動填入了另一個信箱——那時候填進去就是把人家的字蓋掉。
 * ⚠️ 工作階段過期（401）時什麼都不做——那是帳號頁的工作。
 * ⚠️ 登入憑證在 HttpOnly cookie 裡，這支讀不到（2026-10-02 起）。只看「登入過」的提示旗標
 *    決定要不要問伺服器——沒登入過的訪客不多打一次 API。
 * ⚠️ 填完要送一個 input 事件：購買頁的「前往付款」按鈕與升級折抵都掛在這個事件上，
 *    直接改 value 不會觸發，按鈕會停在不能按的狀態（看起來像壞掉）。
 */
(function () {
  'use strict';

  var API = 'https://api.pitlingo.com';
  var HINT_KEY = 'pitlingo.signedIn';

  function signedInHint() { try { return localStorage.getItem(HINT_KEY) === '1'; } catch (e) { return false; } }

  function prefill(id) {
    var input = document.getElementById(id);
    if (!input || !signedInHint()) return;
    var touched = false;
    input.addEventListener('input', function (ev) { if (ev.isTrusted) touched = true; });

    fetch(API + '/v1/account/me', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var email = d && d.profile && d.profile.email;
        if (!email || touched || input.value.trim()) return;
        input.value = email;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        var note = document.createElement('small');
        note.className = 'prefill-note';
        note.textContent = '已帶入你登入的信箱，可以直接修改。';
        input.insertAdjacentElement('afterend', note);
        input.addEventListener('input', function (ev) {
          if (ev.isTrusted && note.parentNode) note.parentNode.removeChild(note);
        });
      })
      .catch(function () { /* 沒網路或後端掛了：維持空白讓使用者自己填 */ });
  }

  prefill('email');
  prefill('contact');
}());
