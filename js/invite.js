/* Alliance Federal Credit Union — joint-account invite wizard (/join?token=XXX).
   Standalone page, no session cookie: the invite `token` from the query string
   is the only auth. Talks to the single /api/invite endpoint (GET bootstrap,
   POST { token, action, ... } for every step). Money from the API is integer
   cents; format to dollars only here. */
(function () {
  'use strict';

  var STEPS = ['welcome', 'login', 'summary', 'identity', 'review', 'done'];
  var ILLUS = {
    welcome: '/assets/img/invite/welcome.svg',
    login: '/assets/img/invite/login.svg',
    summary: '/assets/img/invite/accounts.svg',
    identity: '/assets/img/invite/identity.svg',
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
  function q(sel, root) { return (root || document).querySelector(sel); }
  function money(cents) {
    var n = (Number(cents) || 0) / 100;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
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
      '<div class="jv-sub">' + esc(name) + ' has invited you to be added to their account. It only takes a couple of minutes to set up.</div>' +
      '<button type="button" class="jv-btn" id="jv-next">Get started</button>'
    );
    var next = q('#jv-next');
    if (next) next.addEventListener('click', function () { renderStep('login'); });
  }

  /* ---------- step: sign-in setup (no password — a one-time email code) ---------- */
  function renderLogin() {
    STATE.stepName = 'login';
    updateProgress();
    var cached = cacheGet('login') || {};
    setCard(
      backLink('welcome') +
      illus('login') +
      '<div class="jv-title">Set up your sign-in</div>' +
      '<div class="jv-sub">Pick a username and give us your email. You’ll sign in with a one-time code we email you — there’s no password to create or remember.</div>' +
      '<div class="jv-err" id="jv-login-err"></div>' +
      '<div class="jv-field"><label class="jv-label" for="jv-username">Username</label>' +
        '<input class="jv-input" id="jv-username" type="text" autocomplete="username" maxlength="30" value="' + esc(cached.username || '') + '"></div>' +
      '<div class="jv-field"><label class="jv-label" for="jv-email">Email</label>' +
        '<input class="jv-input" id="jv-email" type="email" autocomplete="email" value="' + esc(cached.email || '') + '"></div>' +
      '<div class="jv-hint">Username: 3–30 characters — lowercase letters, numbers, dots, dashes or underscores.</div>' +
      '<button type="button" class="jv-btn" id="jv-next" style="margin-top:14px;">Continue</button>'
    );
    wireBack();
    var next = q('#jv-next');
    if (next) next.addEventListener('click', function () {
      hideErr('#jv-login-err');
      var username = (q('#jv-username').value || '').trim().toLowerCase();
      var email = (q('#jv-email').value || '').trim();
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) { showErr('#jv-login-err', 'Username must be 3–30 characters: lowercase letters, numbers, dots, dashes or underscores.'); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showErr('#jv-login-err', 'Enter a valid email address.'); return; }
      next.disabled = true; next.textContent = 'Saving…';
      postInvite('register', { username: username, email: email })
        .then(function () {
          cacheSet('login', { username: username, email: email });
          renderStep('summary');
        })
        .catch(function (e) {
          showErr('#jv-login-err', e.status === 409 ? 'That username is already taken. Please choose another.' : (e.message || 'Could not set up your sign-in.'));
        })
        .finally(function () { next.disabled = false; next.textContent = 'Continue'; });
    });
  }

  /* ---------- step: account summary you're joining ---------- */
  function accountsHtml(data) {
    var accts = (data && data.accounts) || [];
    if (!accts.length) return '';
    var rows = accts.map(function (a) {
      return '<div class="jv-acct"><div><div class="jv-acct-name">' + esc(a.name || 'Account') + '</div>' +
        '<div class="jv-acct-num">' + esc(a.number || '') + '</div></div>' +
        '<div class="jv-acct-bal">' + money(a.balance) + '</div></div>';
    }).join('');
    var total = '<div class="jv-total"><div class="jv-total-label">Total balance</div>' +
      '<div class="jv-total-val">' + money(data.total) + '</div></div>';
    return rows + total;
  }
  function renderSummary() {
    STATE.stepName = 'summary';
    updateProgress();
    setCard(illus('summary') + '<div class="jv-title">Account summary</div>' +
      '<div class="jv-loading" style="padding:20px 0;"><div class="jv-spinner"></div>Loading…</div>');
    postInvite('summary', {})
      .then(function (data) {
        STATE.accounts = data;
        var who = esc(data.primaryName || 'the primary member');
        setCard(
          illus('summary') +
          '<div class="jv-title">Account summary</div>' +
          '<div class="jv-sub">Here’s the account you’ll share with ' + who + ' once your details are approved.</div>' +
          accountsHtml(data) +
          '<button type="button" class="jv-btn" id="jv-next" style="margin-top:16px;">Continue</button>'
        );
        var next = q('#jv-next');
        if (next) next.addEventListener('click', function () { renderStep('identity'); });
      })
      .catch(function (e) {
        setCard(illus('summary') + '<div class="jv-title">Account summary</div>' +
          '<div class="jv-err" style="display:block;">' + esc(e.message || 'Could not load. Please try again.') + '</div>' +
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
      '<div class="jv-title">Confirm your identity</div>' +
      '<div class="jv-sub">Enter your name and date of birth, and add a photo of your ID or driver’s license.</div>' +
      '<div class="jv-err" id="jv-id-err"></div>' +
      '<div class="jv-field"><label class="jv-label" for="jv-fullname">Full legal name</label>' +
        '<input class="jv-input" id="jv-fullname" type="text" maxlength="120" value="' + esc(cached.fullName || '') + '"></div>' +
      '<div class="jv-field"><label class="jv-label" for="jv-dob">Date of birth</label>' +
        '<input class="jv-input" id="jv-dob" type="date" value="' + esc(cached.dob || '') + '"></div>' +
      fileField('jv-idfront', 'Photo of your ID or driver’s license', true) +
      '<button type="button" class="jv-btn" id="jv-next" style="margin-top:6px;">Continue</button>'
    );
    wireBack();
    wireFileField('jv-idfront', 'idFront');
    var next = q('#jv-next');
    if (next) next.addEventListener('click', function () {
      hideErr('#jv-id-err');
      var fullName = (q('#jv-fullname').value || '').trim();
      var dob = (q('#jv-dob').value || '').trim();
      if (!fullName) { showErr('#jv-id-err', 'Enter your full legal name.'); return; }
      if (!dob) { showErr('#jv-id-err', 'Enter your date of birth.'); return; }
      var idFront = STATE.files.idFront;
      if (!idFront && !(STATE.invite && STATE.invite.docs && STATE.invite.docs.idFront)) {
        showErr('#jv-id-err', 'Add a photo of your ID or driver’s license.'); return;
      }
      next.disabled = true; next.textContent = 'Saving…';
      postInvite('identity', { fullName: fullName, dob: dob })
        .then(function () {
          cacheSet('identity', { fullName: fullName, dob: dob });
          if (idFront) return uploadDoc('idFront', idFront);
        })
        .then(function () { renderStep('review'); })
        .catch(function (e) { showErr('#jv-id-err', e.message || 'Could not save your details.'); })
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
      function docRow(label, present) {
        return '<div class="jv-review-row"><div class="jv-review-k">' + esc(label) + '</div>' +
          '<div class="jv-review-v ' + (present ? 'jv-check' : 'jv-missing') + '">' +
          (present ? '<i class="fas fa-check-circle"></i> Attached' : 'Not provided') + '</div></div>';
      }
      setCard(
        backLink('identity') +
        illus('review') +
        '<div class="jv-title">Review &amp; submit</div>' +
        '<div class="jv-err" id="jv-rv-err"></div>' +
        '<div class="jv-review-row"><div class="jv-review-k">Name</div><div class="jv-review-v">' + esc(identity.fullName || 'Provided') + '</div></div>' +
        '<div class="jv-review-row"><div class="jv-review-k">Username</div><div class="jv-review-v">' + esc(login.username || 'Already set') + '</div></div>' +
        '<div class="jv-review-row"><div class="jv-review-k">Email</div><div class="jv-review-v">' + esc(login.email || 'Already set') + '</div></div>' +
        '<div class="jv-review-row"><div class="jv-review-k">Joining</div><div class="jv-review-v">' + esc(data.primaryName || 'the primary member') + '’s account</div></div>' +
        docRow('Photo ID', hasIdFront) +
        '<button type="button" class="jv-btn" id="jv-submit" style="margin-top:18px;">Submit</button>'
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
          .catch(function (e) { showErr('#jv-rv-err', e.message || 'Could not submit. Please make sure every step is complete.'); })
          .finally(function () { submit.disabled = false; submit.textContent = 'Submit'; });
      });
    }).catch(function (e) {
      setCard(illus('review') + '<div class="jv-title">Review &amp; submit</div>' +
        '<div class="jv-err" style="display:block;">' + esc(e.message || 'Could not load your request.') + '</div>' +
        '<button type="button" class="jv-btn" id="jv-retry">Try again</button>');
      var retry = q('#jv-retry');
      if (retry) retry.addEventListener('click', renderReview);
    });
  }

  /* ---------- step: done ---------- */
  function renderDone(alreadySubmitted, redirect) {
    STATE.stepName = 'done';
    updateProgress();
    // Fresh submit auto-signs them in → go straight to the dashboard. A later
    // revisit of an already-submitted link isn't signed in → send them to log in.
    var to = redirect || (alreadySubmitted ? '/login' : '/user/dashboard');
    var title = alreadySubmitted ? 'All set' : 'You’re all set';
    var sub = alreadySubmitted
      ? 'You’ve already completed this. We’re reviewing your details and will let you know once there’s an update.'
      : 'You’re signed in. We’ll review your details shortly. On the next screen you can set a password to secure your account.';
    setCard(
      illus('done') +
      '<div class="jv-title">' + esc(title) + '</div>' +
      '<div class="jv-sub">' + esc(sub) + '</div>' +
      '<a href="' + esc(to) + '" class="jv-btn" style="display:block;text-align:center;text-decoration:none;box-sizing:border-box;">' + (alreadySubmitted ? 'Sign in' : 'Continue to your account') + '</a>'
    );
  }

  /* ---------- router ---------- */
  function renderStep(name) {
    if (name === 'welcome') return renderWelcome();
    if (name === 'login') return renderLogin();
    if (name === 'summary') return renderSummary();
    if (name === 'identity') return renderIdentity();
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
