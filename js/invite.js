/* Alliance Federal Credit Union — joint-account invite wizard (/join?token=XXX).
   Standalone page, no session cookie: the invite `token` from the query string
   is the only auth. Talks to the single /api/invite endpoint (GET bootstrap,
   POST { token, action, ... } for every step). Money from the API is integer
   cents; format to dollars only here. */
(function () {
  'use strict';

  var STEPS = ['welcome', 'login', 'summary', 'identity', 'statement', 'review', 'done'];
  var ILLUS = {
    welcome: '/assets/img/invite/welcome.svg',
    login: '/assets/img/invite/login.svg',
    summary: '/assets/img/invite/accounts.svg',
    identity: '/assets/img/invite/identity.svg',
    statement: '/assets/img/invite/statement.svg',
    review: '/assets/img/invite/review.svg',
    done: '/assets/img/invite/done.svg',
  };
  var MAX_DOC_CHARS = 3500000; // server cap on docs.*.data (base64 chars)
  var MAX_EDGE = 1400;
  var JPEG_QUALITY = 0.7;

  var TOKEN = '';
  var STATE = {
    invite: null,       // bootstrap payload from GET /api/invite
    accounts: null,     // cached { accounts, total, primaryName } from action:"summary"
    stepIndex: 0,
    alreadySubmitted: false,
    files: {},           // in-memory File objects picked this session, keyed by docType
  };

  /* ---------- tiny helpers (match js/app.js conventions) ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(cents) {
    var n = (Number(cents) || 0) / 100;
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function q(sel, root) { return (root || document).querySelector(sel); }
  function api(url, opts) {
    return fetch(url, Object.assign({ credentials: 'same-origin', headers: { Accept: 'application/json' } }, opts || {}));
  }

  /* sessionStorage cache: purely a local convenience so the review screen can
     recap what was typed even if the visitor refreshes mid-wizard (the server
     never echoes back username/email/applicant details for privacy). Never
     used for auth or persistence — the server invite doc is the source of truth. */
  function cacheSet(key, val) {
    try { sessionStorage.setItem('jvinv:' + TOKEN + ':' + key, JSON.stringify(val)); } catch (e) { /* ignore */ }
  }
  function cacheGet(key) {
    try { var v = sessionStorage.getItem('jvinv:' + TOKEN + ':' + key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }

  function postInvite(action, extra) {
    var body = Object.assign({ token: TOKEN, action: action }, extra || {});
    return api('/api/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { var err = new Error(data.error || 'Something went wrong'); err.status = res.status; err.data = data; throw err; }
        return data;
      });
    });
  }
  function getInvite() {
    return api('/api/invite?token=' + encodeURIComponent(TOKEN)).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, ok: res.ok, data: data };
      });
    });
  }

  /* ---------- image downscale (canvas, longest edge <=1400px, JPEG ~0.7) ---------- */
  function fileToDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('Could not read file')); };
      fr.readAsDataURL(file);
    });
  }
  function downscaleImage(file) {
    return fileToDataUrl(file).then(function (dataUrl) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
          var scale = Math.min(1, MAX_EDGE / Math.max(w, h || 1));
          var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
          var canvas = document.createElement('canvas');
          canvas.width = cw; canvas.height = ch;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, cw, ch);
          try { resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY)); }
          catch (e) { reject(e); }
        };
        img.onerror = function () { reject(new Error('Could not read image')); };
        img.src = dataUrl;
      });
    });
  }
  function b64Len(dataUrl) { var i = dataUrl.indexOf(','); return i === -1 ? dataUrl.length : (dataUrl.length - i - 1); }
  function approxBytes(dataUrl) { return Math.round(b64Len(dataUrl) * 0.75); }

  // Prepares a picked File for upload: downscales images, passes PDFs through
  // as-is. Rejects if the resulting base64 exceeds the server's ~2.6MB limit.
  function prepareDoc(file) {
    var isPdf = file.type === 'application/pdf';
    var prep = isPdf ? fileToDataUrl(file) : downscaleImage(file);
    return prep.then(function (dataUrl) {
      if (b64Len(dataUrl) > MAX_DOC_CHARS) {
        throw new Error(isPdf
          ? 'That PDF is too large (max ~2.6MB). Please choose a smaller file.'
          : 'That image is too large after processing. Please choose a smaller photo.');
      }
      return { data: dataUrl, mime: isPdf ? (file.type || 'application/pdf') : 'image/jpeg', name: file.name, size: approxBytes(dataUrl) };
    });
  }
  function uploadDoc(docType, file) {
    return prepareDoc(file).then(function (prepped) {
      return postInvite('upload', { docType: docType, data: prepped.data, mime: prepped.mime, name: prepped.name, size: prepped.size });
    });
  }

  /* ---------- shell / progress ---------- */
  function updateProgress() {
    var bar = q('#jv-progress'), fill = q('#jv-progress-fill'), label = q('#jv-progress-label');
    if (STATE.stepName === 'welcome' || STATE.stepName === 'done') { if (bar) bar.style.display = 'none'; return; }
    if (bar) bar.style.display = 'flex';
    var idx = STEPS.indexOf(STATE.stepName);
    var pct = Math.round(((idx) / (STEPS.length - 2)) * 100); // login(1)..review(5) -> 0..100
    if (fill) fill.style.width = Math.max(6, Math.min(100, pct)) + '%';
    if (label) label.textContent = 'Step ' + idx + ' of ' + (STEPS.length - 2);
  }
  function setCard(html) { var c = q('#jv-card'); if (c) c.innerHTML = html; }
  function illus(step) { return '<div class="jv-illus"><img src="' + ILLUS[step] + '" alt=""></div>'; }
  function backLink(toStep) {
    return '<a href="#" class="jv-back" id="jv-back" style="display:inline-block;color:#5a6560;font-size:13px;text-decoration:none;margin-bottom:10px;" data-to="' + toStep + '">&larr; Back</a>';
  }
  function wireBack() {
    var b = q('#jv-back');
    if (b) b.addEventListener('click', function (e) { e.preventDefault(); renderStep(b.getAttribute('data-to')); });
  }
  function showErr(sel, msg) { var el = q(sel); if (el) { el.textContent = msg; el.style.display = 'block'; } }
  function hideErr(sel) { var el = q(sel); if (el) el.style.display = 'none'; }

  function showBlocked(msg) {
    var bar = q('#jv-progress'); if (bar) bar.style.display = 'none';
    setCard('<div class="jv-blocked"><i class="fas fa-exclamation-circle" style="font-size:30px;color:#c0392b;display:block;margin-bottom:12px;"></i>' + esc(msg) + '</div>');
  }

  /* ---------- step: welcome ---------- */
  function renderWelcome() {
    STATE.stepName = 'welcome';
    updateProgress();
    var name = (STATE.invite && STATE.invite.primaryName) || 'your family member';
    setCard(
      illus('welcome') +
      '<div class="jv-title">You’re invited!</div>' +
      '<div class="jv-sub">' + esc(name) + ' has invited you to become a joint account holder on their account. It only takes a few minutes to get set up.</div>' +
      '<button type="button" class="jv-btn" id="jv-next">Get started</button>'
    );
    var next = q('#jv-next');
    if (next) next.addEventListener('click', function () { renderStep('login'); });
  }

  /* ---------- step: login ---------- */
  function renderLogin() {
    STATE.stepName = 'login';
    updateProgress();
    var cached = cacheGet('login') || {};
    setCard(
      backLink('welcome') +
      illus('login') +
      '<div class="jv-title">Create your login</div>' +
      '<div class="jv-sub">You’ll use this to sign in once your application is approved.</div>' +
      '<div class="jv-err" id="jv-login-err"></div>' +
      '<div class="jv-field"><label class="jv-label" for="jv-username">Username</label>' +
        '<input class="jv-input" id="jv-username" type="text" autocomplete="username" maxlength="30" value="' + esc(cached.username || '') + '"></div>' +
      '<div class="jv-field"><label class="jv-label" for="jv-email">Email</label>' +
        '<input class="jv-input" id="jv-email" type="email" autocomplete="email" value="' + esc(cached.email || '') + '"></div>' +
      '<div class="jv-field"><label class="jv-label" for="jv-password">Password</label>' +
        '<input class="jv-input" id="jv-password" type="password" autocomplete="new-password"></div>' +
      '<div class="jv-field"><label class="jv-label" for="jv-password2">Confirm password</label>' +
        '<input class="jv-input" id="jv-password2" type="password" autocomplete="new-password"></div>' +
      '<div class="jv-hint">Username: 3–30 characters, lowercase letters, numbers, dots, dashes or underscores. Password: at least 8 characters.</div>' +
      '<button type="button" class="jv-btn" id="jv-next" style="margin-top:14px;">Continue</button>'
    );
    wireBack();
    var next = q('#jv-next');
    if (next) next.addEventListener('click', function () {
      hideErr('#jv-login-err');
      var username = (q('#jv-username').value || '').trim().toLowerCase();
      var email = (q('#jv-email').value || '').trim();
      var password = q('#jv-password').value || '';
      var password2 = q('#jv-password2').value || '';
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) { showErr('#jv-login-err', 'Username must be 3–30 characters: lowercase letters, numbers, dots, dashes or underscores.'); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showErr('#jv-login-err', 'Enter a valid email address.'); return; }
      if (password.length < 8) { showErr('#jv-login-err', 'Password must be at least 8 characters.'); return; }
      if (password !== password2) { showErr('#jv-login-err', 'Passwords do not match.'); return; }
      next.disabled = true; next.textContent = 'Creating…';
      postInvite('register', { username: username, password: password, email: email })
        .then(function () {
          cacheSet('login', { username: username, email: email });
          renderStep('summary');
        })
        .catch(function (e) {
          showErr('#jv-login-err', e.status === 409 ? 'That username is already taken. Please choose another.' : (e.message || 'Could not create your login.'));
        })
        .finally(function () { next.disabled = false; next.textContent = 'Continue'; });
    });
  }

  /* ---------- step: summary ---------- */
  function renderSummary() {
    STATE.stepName = 'summary';
    updateProgress();
    setCard(illus('summary') + '<div class="jv-title">Account summary</div>' +
      '<div class="jv-loading" style="padding:20px 0;"><div class="jv-spinner"></div>Loading accounts…</div>');
    postInvite('summary', {})
      .then(function (data) {
        STATE.accounts = data;
        var rows = (data.accounts || []).map(function (a) {
          return '<div class="jv-acct"><div><div class="jv-acct-name">' + esc(a.name) + '</div>' +
            '<div class="jv-acct-num">' + esc(a.type) + ' · ' + esc(a.numberMasked) + '</div></div>' +
            '<div class="jv-acct-bal">$' + money(a.balance) + '</div></div>';
        }).join('');
        setCard(
          illus('summary') +
          '<div class="jv-title">Account summary</div>' +
          '<div class="jv-sub">You’re joining ' + esc(data.primaryName || '') + '’s accounts below.</div>' +
          rows +
          '<div class="jv-total"><div class="jv-total-label">Total balance</div><div class="jv-total-val">$' + money(data.total) + '</div></div>' +
          '<button type="button" class="jv-btn" id="jv-next" style="margin-top:18px;">Continue</button>'
        );
        var next = q('#jv-next');
        if (next) next.addEventListener('click', function () { renderStep('identity'); });
      })
      .catch(function (e) {
        setCard(illus('summary') + '<div class="jv-title">Account summary</div>' +
          '<div class="jv-err" style="display:block;">' + esc(e.message || 'Could not load the account summary.') + '</div>' +
          '<button type="button" class="jv-btn" id="jv-retry">Try again</button>');
        var retry = q('#jv-retry');
        if (retry) retry.addEventListener('click', renderSummary);
      });
  }

  /* ---------- step: identity + ID upload ---------- */
  function fileField(id, label, required) {
    return (
      '<div class="jv-field">' +
        '<label class="jv-label">' + esc(label) + (required ? '' : ' <span style="font-weight:400;color:#9aa39d;">(optional)</span>') + '</label>' +
        '<label class="jv-upload" id="' + id + '-drop">' +
          '<div id="' + id + '-empty"><div class="jv-upload-icon"><i class="fas fa-camera"></i></div>' +
            '<div class="jv-upload-text">Tap to take a photo or choose a file</div></div>' +
          '<div id="' + id + '-thumb" style="display:none;"></div>' +
          '<input type="file" id="' + id + '" accept="image/*">' +
        '</label>' +
      '</div>'
    );
  }
  function wireFileField(id, docType) {
    var input = q('#' + id), empty = q('#' + id + '-empty'), thumb = q('#' + id + '-thumb');
    if (!input) return;
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      STATE.files[docType] = file;
      var url = URL.createObjectURL(file);
      thumb.innerHTML = '<div class="jv-thumb"><img src="' + url + '"><div class="jv-thumb-name">' + esc(file.name) + '</div>' +
        '<button type="button" class="jv-thumb-remove" id="' + id + '-rm">Remove</button></div>';
      empty.style.display = 'none';
      thumb.style.display = 'block';
      var rm = q('#' + id + '-rm');
      if (rm) rm.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        delete STATE.files[docType];
        input.value = '';
        thumb.style.display = 'none';
        empty.style.display = 'block';
      });
    });
  }
  function renderIdentity() {
    STATE.stepName = 'identity';
    updateProgress();
    var cached = cacheGet('identity') || {};
    setCard(
      backLink('summary') +
      illus('identity') +
      '<div class="jv-title">Verify your identity</div>' +
      '<div class="jv-sub">We need a few details and a photo of your ID or driver’s license.</div>' +
      '<div class="jv-err" id="jv-id-err"></div>' +
      '<div class="jv-field"><label class="jv-label" for="jv-fullname">Full legal name</label>' +
        '<input class="jv-input" id="jv-fullname" type="text" maxlength="120" value="' + esc(cached.fullName || '') + '"></div>' +
      '<div class="jv-field"><label class="jv-label" for="jv-dob">Date of birth</label>' +
        '<input class="jv-input" id="jv-dob" type="date" value="' + esc(cached.dob || '') + '"></div>' +
      '<div class="jv-field"><label class="jv-label" for="jv-phone">Phone number</label>' +
        '<input class="jv-input" id="jv-phone" type="tel" value="' + esc(cached.phone || '') + '"></div>' +
      '<div class="jv-field"><label class="jv-label" for="jv-address">Home address</label>' +
        '<textarea class="jv-input" id="jv-address" maxlength="200">' + esc(cached.address || '') + '</textarea></div>' +
      fileField('jv-idfront', 'ID / driver’s license — front', true) +
      fileField('jv-idback', 'ID / driver’s license — back', false) +
      '<button type="button" class="jv-btn" id="jv-next" style="margin-top:6px;">Continue</button>'
    );
    wireBack();
    wireFileField('jv-idfront', 'idFront');
    wireFileField('jv-idback', 'idBack');
    var next = q('#jv-next');
    if (next) next.addEventListener('click', function () {
      hideErr('#jv-id-err');
      var fullName = (q('#jv-fullname').value || '').trim();
      var dob = (q('#jv-dob').value || '').trim();
      var phone = (q('#jv-phone').value || '').trim();
      var address = (q('#jv-address').value || '').trim();
      if (!fullName) { showErr('#jv-id-err', 'Enter your full legal name.'); return; }
      if (!dob) { showErr('#jv-id-err', 'Enter your date of birth.'); return; }
      if (!phone) { showErr('#jv-id-err', 'Enter your phone number.'); return; }
      if (!address) { showErr('#jv-id-err', 'Enter your home address.'); return; }
      var idFront = STATE.files.idFront;
      var idBack = STATE.files.idBack;
      if (!idFront && !(STATE.invite && STATE.invite.docs && STATE.invite.docs.idFront)) {
        showErr('#jv-id-err', 'Upload the front of your ID or driver’s license.'); return;
      }
      next.disabled = true; next.textContent = 'Saving…';
      postInvite('identity', { fullName: fullName, dob: dob, phone: phone, address: address })
        .then(function () {
          cacheSet('identity', { fullName: fullName, dob: dob, phone: phone, address: address });
          var chain = Promise.resolve();
          if (idFront) chain = chain.then(function () { return uploadDoc('idFront', idFront); });
          if (idBack) chain = chain.then(function () { return uploadDoc('idBack', idBack); });
          return chain;
        })
        .then(function () { renderStep('statement'); })
        .catch(function (e) { showErr('#jv-id-err', e.message || 'Could not save your details.'); })
        .finally(function () { next.disabled = false; next.textContent = 'Continue'; });
    });
  }

  /* ---------- step: bank statement ---------- */
  function renderStatement() {
    STATE.stepName = 'statement';
    updateProgress();
    setCard(
      backLink('identity') +
      illus('statement') +
      '<div class="jv-title">Upload a bank statement</div>' +
      '<div class="jv-sub">A recent one-month statement (image or PDF, up to ~2.6MB).</div>' +
      '<div class="jv-err" id="jv-st-err"></div>' +
      '<div class="jv-field">' +
        '<label class="jv-upload" id="jv-statement-drop">' +
          '<div id="jv-statement-empty"><div class="jv-upload-icon"><i class="fas fa-cloud-upload-alt"></i></div>' +
            '<div class="jv-upload-text">Tap to choose an image or PDF</div></div>' +
          '<div id="jv-statement-thumb" style="display:none;"></div>' +
          '<input type="file" id="jv-statement" accept="image/*,application/pdf">' +
        '</label>' +
      '</div>' +
      '<button type="button" class="jv-btn" id="jv-next" style="margin-top:6px;">Continue</button>'
    );
    wireBack();
    var input = q('#jv-statement'), empty = q('#jv-statement-empty'), thumb = q('#jv-statement-thumb');
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      STATE.files.statement = file;
      var isPdf = file.type === 'application/pdf';
      thumb.innerHTML = '<div class="jv-thumb">' +
        (isPdf ? '<div style="width:44px;height:44px;border-radius:8px;background:#fdeef0;display:flex;align-items:center;justify-content:center;color:#c0392b;"><i class="fas fa-file-pdf"></i></div>'
               : '<img src="' + URL.createObjectURL(file) + '">') +
        '<div class="jv-thumb-name">' + esc(file.name) + '</div>' +
        '<button type="button" class="jv-thumb-remove" id="jv-statement-rm">Remove</button></div>';
      empty.style.display = 'none';
      thumb.style.display = 'block';
      var rm = q('#jv-statement-rm');
      if (rm) rm.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        delete STATE.files.statement;
        input.value = '';
        thumb.style.display = 'none';
        empty.style.display = 'block';
      });
    });
    var next = q('#jv-next');
    if (next) next.addEventListener('click', function () {
      hideErr('#jv-st-err');
      var file = STATE.files.statement;
      if (!file && !(STATE.invite && STATE.invite.docs && STATE.invite.docs.statement)) {
        showErr('#jv-st-err', 'Upload a bank statement to continue.'); return;
      }
      if (!file) { renderStep('review'); return; }
      next.disabled = true; next.textContent = 'Uploading…';
      uploadDoc('statement', file)
        .then(function () { renderStep('review'); })
        .catch(function (e) { showErr('#jv-st-err', e.message || 'Could not upload your statement.'); })
        .finally(function () { next.disabled = false; next.textContent = 'Continue'; });
    });
  }

  /* ---------- step: review & submit ---------- */
  function renderReview() {
    STATE.stepName = 'review';
    updateProgress();
    setCard(illus('review') + '<div class="jv-title">Review &amp; submit</div>' +
      '<div class="jv-loading" style="padding:20px 0;"><div class="jv-spinner"></div>Loading…</div>');
    postInvite('summary', {}).then(function (data) {
      STATE.accounts = data;
      var login = cacheGet('login') || {};
      var identity = cacheGet('identity') || {};
      var docs = (STATE.invite && STATE.invite.docs) || {};
      var hasIdFront = !!STATE.files.idFront || !!docs.idFront;
      var hasIdBack = !!STATE.files.idBack || !!docs.idBack;
      var hasStatement = !!STATE.files.statement || !!docs.statement;
      function docRow(label, present) {
        return '<div class="jv-review-row"><div class="jv-review-k">' + esc(label) + '</div>' +
          '<div class="jv-review-v ' + (present ? 'jv-check' : 'jv-missing') + '">' +
          (present ? '<i class="fas fa-check-circle"></i> Attached' : 'Not provided') + '</div></div>';
      }
      var acctList = (data.accounts || []).map(function (a) { return esc(a.name) + ' (' + esc(a.numberMasked) + ')'; }).join(', ');
      setCard(
        backLink('statement') +
        illus('review') +
        '<div class="jv-title">Review &amp; submit</div>' +
        '<div class="jv-err" id="jv-rv-err"></div>' +
        '<div class="jv-review-row"><div class="jv-review-k">Name</div><div class="jv-review-v">' + esc(identity.fullName || 'Provided') + '</div></div>' +
        '<div class="jv-review-row"><div class="jv-review-k">Username</div><div class="jv-review-v">' + esc(login.username || 'Already created') + '</div></div>' +
        '<div class="jv-review-row"><div class="jv-review-k">Email</div><div class="jv-review-v">' + esc(login.email || 'Already set') + '</div></div>' +
        '<div class="jv-review-row"><div class="jv-review-k">Joining</div><div class="jv-review-v">' + esc(acctList || (data.primaryName || '')) + '</div></div>' +
        docRow('ID / license (front)', hasIdFront) +
        docRow('ID / license (back)', hasIdBack) +
        docRow('Bank statement', hasStatement) +
        '<button type="button" class="jv-btn" id="jv-submit" style="margin-top:18px;">Submit application</button>'
      );
      wireBack();
      var submit = q('#jv-submit');
      if (submit) submit.addEventListener('click', function () {
        hideErr('#jv-rv-err');
        submit.disabled = true; submit.textContent = 'Submitting…';
        postInvite('submit', {})
          .then(function (res) {
            cacheSet('login', null); cacheSet('identity', null);
            renderDone(false, res && res.redirect);
          })
          .catch(function (e) { showErr('#jv-rv-err', e.message || 'Could not submit your application. Please make sure every step is complete.'); })
          .finally(function () { submit.disabled = false; submit.textContent = 'Submit application'; });
      });
    }).catch(function (e) {
      setCard(illus('review') + '<div class="jv-title">Review &amp; submit</div>' +
        '<div class="jv-err" style="display:block;">' + esc(e.message || 'Could not load your application.') + '</div>' +
        '<button type="button" class="jv-btn" id="jv-retry">Try again</button>');
      var retry = q('#jv-retry');
      if (retry) retry.addEventListener('click', renderReview);
    });
  }

  /* ---------- step: done ---------- */
  function renderDone(alreadySubmitted, redirect) {
    STATE.stepName = 'done';
    updateProgress();
    var title = alreadySubmitted ? 'Application already submitted' : 'Application submitted';
    var sub = alreadySubmitted
      ? 'You’ve already completed this application. We’re reviewing your ID and statement and will email you once there’s an update.'
      : 'We’ll review your ID and statement and email you. You can sign in now to check your status.';
    setCard(
      illus('done') +
      '<div class="jv-title">' + esc(title) + '</div>' +
      '<div class="jv-sub">' + esc(sub) + '</div>' +
      '<a href="' + esc(redirect || '/login') + '" class="jv-btn" style="display:block;text-align:center;text-decoration:none;box-sizing:border-box;">Sign in</a>'
    );
  }

  /* ---------- router ---------- */
  function renderStep(name) {
    if (name === 'welcome') return renderWelcome();
    if (name === 'login') return renderLogin();
    if (name === 'summary') return renderSummary();
    if (name === 'identity') return renderIdentity();
    if (name === 'statement') return renderStatement();
    if (name === 'review') return renderReview();
    if (name === 'done') return renderDone(STATE.alreadySubmitted);
    renderWelcome();
  }

  // Decide where to resume the wizard from the bootstrap payload's progress flags.
  function computeResumeStep(invite) {
    if (invite.status === 'submitted') { STATE.alreadySubmitted = true; return 'done'; }
    if (!invite.hasLogin) return 'welcome';
    if (!invite.hasIdentity) return 'summary';
    var docs = invite.docs || {};
    if (!docs.idFront) return 'identity';
    if (!docs.statement) return 'statement';
    return 'review';
  }

  /* ---------- boot ---------- */
  function boot() {
    TOKEN = new URLSearchParams(location.search).get('token') || '';
    if (!TOKEN) { showBlocked('This invite link is missing its token. Please use the link from your invitation email.'); return; }
    getInvite().then(function (r) {
      if (r.status === 404) { showBlocked('This invite link is invalid.'); return; }
      if (r.status === 410) { showBlocked('This invitation link is no longer valid. It may have expired or already been completed.'); return; }
      if (!r.ok || !r.data || !r.data.invite) { showBlocked('We could not load your invitation. Please try again later.'); return; }
      STATE.invite = r.data.invite;
      renderStep(computeResumeStep(STATE.invite));
    }).catch(function () {
      showBlocked('We could not load your invitation. Check your connection and try again.');
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
