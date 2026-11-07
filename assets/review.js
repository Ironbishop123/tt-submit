/* TT-SUB v1.7.9-sec (2026-10-30): adds a short-lived page token. On load (and again after each send, and when it is 20 minutes old) the page asks the backend for a token (GET <exec>?action=token) and sends it, with location.origin, in every submission. If the token cannot be fetched the page still submits; the backend decides (log mode accepts, enforce mode refuses). The token is NOT a secret (anyone can read it from this page); see TT-SUB_Security.gs.
   2026-11-07: a token read waits at most 12s. If that read misses, later sends are not stalled on another hung GET. One non-forced read is shared. After a send the cached token is stale, and a slower response cannot overwrite a newer token. No backend change is required.
   TT-SUB v1.7.1-review: REVIEW-ONLY intake client. No account, review only.
   Limits are mirrored in ../../TT-SUB_Review_Intake.gs (a test checks they match). */
(function () {
  'use strict';
  var L = window.TT_REVIEW_LIMITS = { minFiles: 1, maxFiles: 3, maxFileBytes: 7 * 1024 * 1024, maxTotalBytes: 15 * 1024 * 1024,
    types: { 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/webp': ['webp'] }, minSubmitMs: 3000 };
  var URL_ = typeof window.WEB_APP_URL === 'string' ? window.WEB_APP_URL : '';
  var $ = function (id) { return document.getElementById(id); }, files = [], t0 = Date.now(), busy = false;
  function size(b) { return b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toFixed(1).replace(/\.0$/, '') + ' MB'; }
  var hint = 'PNG, JPG or WEBP · ' + L.minFiles + ' to ' + L.maxFiles + ' images · ' + size(L.maxFileBytes) + ' max each, ' + size(L.maxTotalBytes) + ' total';
  $('f-files-hint').textContent = hint; $('limits-line').textContent = L.minFiles + ' to ' + L.maxFiles + ' images · no account needed';
  function ext(n) { var m = /\.([a-z0-9]+)$/i.exec(n || ''); return m ? m[1].toLowerCase() : ''; }
  function total() { return files.reduce(function (a, f) { return a + f.size; }, 0); }
  function err(id, msg) { var e = $(id); e.textContent = msg || ''; var inp = e.parentNode.querySelector('input'); if (inp) inp.setAttribute('aria-invalid', msg ? 'true' : 'false'); return !msg; }
  function render() {
    var ul = $('f-list'); ul.textContent = '';
    files.forEach(function (f, i) { var li = document.createElement('li'); li.className = 'sub-file'; li.textContent = f.name + ' · ' + size(f.size) + ' ';
      var b = document.createElement('button'); b.type = 'button'; b.className = 'tt-btn tt-btn--secondary'; b.textContent = 'Remove'; b.setAttribute('aria-label', 'Remove ' + f.name);
      b.addEventListener('click', function () { files.splice(i, 1); render(); $('f-status').textContent = f.name + ' removed.'; }); li.appendChild(b); ul.appendChild(li); });
  }
  function addFiles(list) {
    var msgs = [];
    Array.prototype.forEach.call(list, function (f) {
      var okType = L.types[f.type] && L.types[f.type].indexOf(ext(f.name)) >= 0;
      if (!okType) return msgs.push('\u201C' + f.name + '\u201D isn\u2019t a PNG, JPG or WEBP image.');
      if (!(f.size > 0)) return msgs.push('\u201C' + f.name + '\u201D is empty.');
      if (f.size > L.maxFileBytes) return msgs.push('\u201C' + f.name + '\u201D is over ' + size(L.maxFileBytes) + '.');
      if (files.length >= L.maxFiles) return msgs.push('You can send up to ' + L.maxFiles + ' images; \u201C' + f.name + '\u201D wasn\u2019t added.');
      if (total() + f.size > L.maxTotalBytes) return msgs.push('Images must total ' + size(L.maxTotalBytes) + ' or less; \u201C' + f.name + '\u201D wasn\u2019t added.');
      files.push(f);
    });
    render(); err('f-files-err', msgs.join(' '));
  }
  $('f-files').addEventListener('change', function () { addFiles(this.files); this.value = ''; });
  var drop = $('f-drop');
  ['dragover', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); if (ev === 'drop') addFiles(e.dataTransfer.files); }); });
  document.querySelectorAll('[data-dlg]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); var d = $(a.getAttribute('data-dlg')); if (d && d.showModal) d.showModal(); }); });
  document.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', function () { b.closest('dialog').close(); }); });
  function validate() {
    var ok = true, v = function (id) { return $(id).value.trim(); };
    ok = err('f-name-err', v('f-name') ? '' : 'Enter your name.') && ok;
    ok = err('f-email-err', !v('f-email') ? 'Enter your email.' : (/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/.test(v('f-email')) ? '' : 'Enter a valid email, like name@example.com.')) && ok;
    ok = err('f-link-err', !v('f-link') ? '' : (/^https?:\/\/[^\s/$.?#][^\s]*\.[^\s]{2,}/i.test(v('f-link')) ? '' : 'Enter a full link starting with https://')) && ok;
    if (files.length < L.minFiles) ok = err('f-files-err', 'Add at least one image of your design.') && ok;
    ok = err('f-age-err', $('f-age').checked ? '' : 'Confirm you are 18 or older.') && ok;
    ok = err('f-orig-err', $('f-orig').checked ? '' : 'Confirm this is your original work with no AI-generated parts.') && ok;
    ok = err('f-terms-err', $('f-terms').checked ? '' : 'Accept the Review Terms to send your design.') && ok;
    return ok;
  }
  // v1.7.9: page token (see header). Never blocks the form: any failure resolves to the last token we had, or ''.
  // A miss (hang past 12s, non-JSON, or no token) is remembered so the next send is not stalled. The read that
  // actually failed still resolves to the last token. A forced refresh drops freshness first and cannot be overwritten by a slower older response.
  var TOKEN_WAIT_MS = 12000;
  var tok = { v: '', t: 0, p: null, gen: 0, gaveUp: false };
  function tokenEndpoint() { return URL_ + (URL_.indexOf('?') >= 0 ? '&' : '?') + 'action=token'; }
  function freshToken() { return (tok.v && (Date.now() - tok.t) < 20 * 60 * 1000) ? tok.v : ''; }
  function getToken(force) {
    if (!URL_) return Promise.resolve('');
    if (force) tok.t = 0;
    if (!force && freshToken()) return Promise.resolve(tok.v);
    if (!force && tok.gaveUp) return Promise.resolve('');
    if (!force && tok.p) return tok.p;
    var gen = ++tok.gen, timer = null, fetched;
    try { fetched = fetch(tokenEndpoint(), { method: 'GET', redirect: 'follow' }); }
    catch (e2) { fetched = Promise.reject(e2); }
    fetched = Promise.resolve(fetched).then(function (r) { return r.json(); }).then(function (j) {
      if (gen !== tok.gen) return freshToken() || tok.v || '';
      if (j && j.ok === true && typeof j.token === 'string' && j.token) { tok.v = j.token; tok.t = Date.now(); tok.gaveUp = false; }
      else tok.gaveUp = true;
      return freshToken() || tok.v || '';
    }).catch(function () { if (gen === tok.gen) tok.gaveUp = true; return tok.v || ''; });
    var timed = new Promise(function (resolve) {
      timer = setTimeout(function () { if (gen === tok.gen && !freshToken()) tok.gaveUp = true; resolve(freshToken() || ''); }, TOKEN_WAIT_MS);
    });
    var p = Promise.race([fetched, timed]).then(function (v) { clearTimeout(timer); if (tok.p === p) tok.p = null; return v; });
    tok.p = p;
    return p;
  }
  function b64(f) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(String(r.result).split(',')[1]); }; r.onerror = rej; r.readAsDataURL(f); }); }
  function show(id) { ['sub', 'ok', 'fail', 'testmode'].forEach(function (x) { $(x).hidden = x !== id; }); var h = $(id + '-h'); if (h) h.focus(); }
  $('sub').addEventListener('submit', function (e) {
    e.preventDefault(); if (busy) return; err('f-form-err', '');
    if (!validate()) { var first = document.querySelector('.sub-err:not(:empty)'); if (first) { var i = first.parentNode.querySelector('input'); if (i) i.focus(); } return; }
    if ($('f-website').value) return err('f-form-err', 'Something went wrong. Refresh and try again.');
    if (Date.now() - t0 < L.minSubmitMs) return err('f-form-err', 'That was fast. Wait a moment and try again.');
    if (!URL_) return err('f-form-err', 'Submissions aren\u2019t open yet. Questions? artists@temperedtees.com');
    busy = true; $('f-submit').disabled = true; $('f-status').textContent = 'Sending\u2026';
    Promise.all([Promise.all(files.map(function (f) { return b64(f).then(function (d) { return { name: f.name, type: f.type, size: f.size, b64: d }; }); })), getToken(false)]).then(function (pair) {
      var fl = pair[0], body = { kind: 'tt-review-intake/1', name: $('f-name').value.trim(), email: $('f-email').value.trim(), portfolio: $('f-link').value.trim(),
        age_18: $('f-age').checked, original_no_ai: $('f-orig').checked, review_terms: $('f-terms').checked, review_terms_text: $('review-terms').textContent, website: $('f-website').value, files: fl, token: pair[1], page: location.origin };
      return fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' }).then(function (r) { return r.json(); });
    }).then(function (j) {
      busy = false; $('f-submit').disabled = false; try { getToken(true); } catch (e1) {}   // v1.7.9: fresh token for the next try / "send another"
      if (j && j.ok === true && j.mail === 'sent') { $('ok-ref').textContent = 'Reference: ' + j.ref; show('ok'); }   // v1.7.1 (Gatekeeper HIGH 2): success ONLY when the server says the mail was sent
      else if (j && (j.mail === 'dry_run' || j.code === 'TEST_MODE_NOT_SENT')) { $('testmode-ref').textContent = j.ref ? 'Test reference (not sent): ' + j.ref : ''; show('testmode'); } else { $('fail-msg').textContent = (j && j.error) || 'Your design wasn\u2019t sent. Try again.'; show('fail'); }
    }).catch(function () { busy = false; $('f-submit').disabled = false; try { getToken(true); } catch (e1) {} show('fail'); });
  });
  $('fail-retry').addEventListener('click', function () { show('sub'); });
  $('testmode-back').addEventListener('click', function () { show('sub'); });
  try { getToken(true); } catch (e0) { /* a token-read failure must not leave the form without its submit handler */ }
})();
