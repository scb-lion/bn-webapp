/* Alliance Federal Credit Union — front-end behaviour for /user/* pages.
   - Side-menu open/close (replaces the template's obfuscated custom.js)
   - Logout
   - Per-page data binding from /api/me and /api/transactions
   Money values from the API are integer cents. */
(function () {
  'use strict';

  var DEFAULT_AVATAR = '/assets/img/default-avatar.png';
  var ROUTING_NUMBER = '053101121'; // demo routing number for the (fictional) credit union

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(cents) {
    var n = (Number(cents) || 0) / 100;
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function signed(cents) {
    var v = Number(cents) || 0;
    var color = v >= 0 ? '#699e4e' : '#c0392b';
    var text = (v >= 0 ? '+$' : '-$') + money(Math.abs(v));
    return { color: color, text: text };
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  }
  function fmtDateShort(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' · ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  function emptyState(msg, icon) {
    return '<div class="text-center py-4"><i class="fas ' + (icon || 'fa-receipt') +
      '" style="font-size:26px;color:#b9c1bd;"></i>' +
      '<p class="color-theme font-12 mt-2 mb-0">' + esc(msg) + '</p></div>';
  }
  // Pick a category icon + colour from a transaction's text. Icon names are the
  // classic (fa5) set with the `fas` prefix — the loaded Font Awesome build does
  // not alias the newer `fa-solid` prefix.
  function txnIcon(t) {
    var s = ((t.description || '') + ' ' + (t.counterparty || '')).toLowerCase();
    var map = [
      [/payroll|direct deposit|opening deposit|deposit/, 'fa-arrow-down', '#e6f4ea', '#1a7f37'],
      [/interest/, 'fa-coins', '#e6f4ea', '#1a7f37'],
      [/zelle|transfer/, 'fa-exchange-alt', '#eef1fb', '#3b5bdb'],
      [/rent|apartment|mortgage/, 'fa-home', '#fdeef0', '#c0392b'],
      [/grocery|market|whole foods|trader|kroger|aldi|food/, 'fa-shopping-cart', '#fef4e6', '#c47f17'],
      [/coffee|starbucks|restaurant|panera|chipotle|olive garden|dining/, 'fa-mug-hot', '#fbeee6', '#b5651d'],
      [/fuel|shell|chevron|gas/, 'fa-gas-pump', '#eef6f2', '#0b8a45'],
      [/netflix|spotify|streaming|hulu|disney/, 'fa-play', '#f3ebfb', '#7b3fe4'],
      [/electric|energy|internet|spectrum|water|utility|phone|verizon|bill/, 'fa-bolt', '#fff7e0', '#b8860b'],
      [/amazon|online|purchase|store/, 'fa-shopping-bag', '#eef1fb', '#3b5bdb'],
      [/atm|withdrawal/, 'fa-money-bill', '#f0f2f1', '#5a6560'],
      [/gym|fitness/, 'fa-dumbbell', '#eef1fb', '#3b5bdb'],
      [/pharmacy|cvs|walgreens|health/, 'fa-prescription-bottle', '#fdeef0', '#c0392b'],
      [/uber|lyft|ride|transit/, 'fa-car', '#f0f2f1', '#5a6560'],
    ];
    for (var i = 0; i < map.length; i++) if (map[i][0].test(s)) return { icon: map[i][1], bg: map[i][2], fg: map[i][3] };
    return (Number(t.amount) || 0) >= 0
      ? { icon: 'fa-arrow-down', bg: '#e6f4ea', fg: '#1a7f37' }
      : { icon: 'fa-arrow-up', bg: '#f0f2f1', fg: '#5a6560' };
  }
  // Group a date-desc list into day buckets with human labels.
  function dayKey(d) { return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
  function groupLabel(iso) {
    var d = new Date(iso); if (isNaN(d)) return '';
    var now = new Date(), y = new Date(); y.setDate(y.getDate() - 1);
    if (dayKey(d) === dayKey(now)) return 'Today';
    if (dayKey(d) === dayKey(y)) return 'Yesterday';
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  function txnHistory(list, opts) {
    if (!list || !list.length) return emptyState('No transactions yet');
    var out = '<div class="txn-list">', last = null;
    list.forEach(function (t) {
      var lbl = groupLabel(t.date);
      if (lbl !== last) { out += '<div class="txn-group-label">' + esc(lbl) + '</div>'; last = lbl; }
      out += txnRow(t, opts);
    });
    return out + '</div>';
  }
  function q(sel, root) { return (root || document).querySelector(sel); }
  function qa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function api(url, opts) {
    return fetch(url, Object.assign({ credentials: 'same-origin', headers: { Accept: 'application/json' } }, opts || {}));
  }

  /* ---------- side menu (event-delegated, survives DOM regeneration) ---------- */
  function closeMenus() {
    qa('.menu').forEach(function (m) { m.classList.remove('menu-active'); });
    qa('.menu-hider').forEach(function (h) { h.classList.remove('menu-active'); });
  }
  document.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-menu]');
    if (opener) {
      e.preventDefault();
      var id = opener.getAttribute('data-menu');
      var menu = document.getElementById(id);
      if (menu) {
        menu.classList.add('menu-active');
        qa('.menu-hider').forEach(function (h) { h.classList.add('menu-active'); });
      }
      return;
    }
    if (e.target.closest('.close-menu') || e.target.classList.contains('menu-hider')) {
      e.preventDefault();
      closeMenus();
      return;
    }
    // Account & Routing # expandable
    var arToggle = e.target.closest('[data-toggle="acct-routing"]');
    if (arToggle) {
      e.preventDefault();
      var card = arToggle.closest('.acct-routing');
      var body = card && card.querySelector('.ar-body');
      var chev = arToggle.querySelector('.ar-chev');
      if (body) {
        var willOpen = body.hasAttribute('hidden');
        if (willOpen) body.removeAttribute('hidden'); else body.setAttribute('hidden', '');
        if (chev) chev.style.transform = willOpen ? 'rotate(180deg)' : '';
      }
      return;
    }
    // logout links
    var logout = e.target.closest('a[href$="/user/logout"], a[href="/user/logout"], [data-action="logout"]');
    if (logout) {
      e.preventDefault();
      api('/api/auth/logout', { method: 'POST' }).finally(function () { location.href = '/login'; });
    }
  });

  /* ---------- ensure the side menu exists on every user page ---------- */
  var MENU_HTML =
    '<div id="menu-main" class="menu menu-box-left menu-box-detached rounded-m bg-highlight" data-menu-effect="menu-over" style="display:block;width:100%;">' +
      '<div class="content mb-2">' +
        '<div class="menu-logo float-start"><img width="180" src="/assets/img/logo-white.png"></div>' +
        '<a href="#" class="close-menu float-end"><i class="fa font-16 color-white fa-times"></i></a>' +
        '<div class="clearfix"></div>' +
      '</div>' +
      '<div style="border-bottom:solid 3px #77b15d;margin-bottom:1rem;"></div>' +
      '<div class="menu-items mb-4">' +
        '<a href="/user/dashboard"><span>Dashboard</span></a>' +
        '<a href="/user/messages"><span>Messages</span></a>' +
        '<a href="/user/accounts"><span>Accounts</span></a>' +
        '<a href="/user/transfer"><span>Transfer</span></a>' +
        '<a href="/user/deposit"><span>Deposit Checks</span></a>' +
        '<a href="/user/contact-support"><span>Support</span></a>' +
        '<a href="/user/profile"><span>My Profile</span></a>' +
        '<a href="/user/logout"><span>Logout</span></a>' +
      '</div>' +
    '</div>';
  function ensureMenu() {
    if (document.getElementById('menu-main')) return;
    if (!document.querySelector('.menu-hider')) {
      var hider = document.createElement('div');
      hider.className = 'menu-hider';
      document.body.insertBefore(hider, document.body.firstChild);
    }
    var page = document.getElementById('page') || document.body;
    page.insertAdjacentHTML('beforeend', MENU_HTML);
  }

  /* ---------- shared shell for regenerated pages ---------- */
  function headerBar() {
    return (
      '<div class="header header-logo-app">' +
        '<a href="/user/dashboard" class="header-icon header-icon-1 color-white"><i class="fas fa-arrow-left"></i></a>' +
        '<a href="#" data-menu="menu-main" class="header-icon color-white" style="position:absolute;right:10px;top:0;"><i class="fas fa-bars"></i></a>' +
      '</div>'
    );
  }
  function heroCard(height) {
    return '<div class="card header-card" data-card-height="' + height + '" style="height:' + height + 'px;">' +
      '<div class="card-overlay bg-highlight opacity-95"></div>' +
      '<div class="card-overlay dark-mode-tint"></div>' +
    '</div>';
  }
  function shell(title, inner) {
    return (
      headerBar() +
      '<div class="page-title page-title-large"><h2 class="color-white">' + esc(title) + '</h2></div>' +
      heroCard(180) + inner
    );
  }
  function setContent(html) {
    var pc = q('.page-content');
    if (pc) pc.innerHTML = html;
  }
  // Brand + contact card (matches the one on the dashboard).
  function footerCard() {
    return (
      '<div class="card card-style"><div class="content text-center">' +
        '<img src="/assets/img/logo.png" alt="Alliance Credit Union" style="max-width:230px;width:70%;height:auto;display:block;margin:8px auto 18px;">' +
        '<div class="foot-actions">' +
          '<a href="/user/contact-support" class="foot-act"><i class="fas fa-phone-alt"></i><span>Call</span></a>' +
          '<a href="/user/messages" class="foot-act"><i class="fas fa-comment-dots"></i><span>Message</span></a>' +
          '<a href="/user/contact-support" class="foot-act"><i class="fas fa-info-circle"></i><span>Info</span></a>' +
        '</div>' +
      '</div></div>'
    );
  }

  /* ---------- row + card builders ---------- */
  function txnRow(t, opts) {
    var s = signed(t.amount);
    var ic = txnIcon(t);
    var badge = '';
    if (t.status === 'pending') badge = '<div class="txn-badge txn-badge-pending">Pending</div>';
    else if (t.status === 'rejected') badge = '<div class="txn-badge txn-badge-rejected">Rejected</div>';
    else if (opts && opts.badge) badge = '<div class="txn-badge">Completed</div>';
    return (
      '<a href="/user/transaction/detail?id=' + encodeURIComponent(t.id) + '" class="txn-row">' +
        '<div class="d-flex align-items-center">' +
          '<div class="txn-ic" style="background:' + ic.bg + ';color:' + ic.fg + ';"><i class="fas ' + ic.icon + '"></i></div>' +
          '<div class="ps-2" style="min-width:0;flex:1;">' +
            '<h5 class="txn-desc">' + esc(t.description) + '</h5>' +
            '<span class="txn-date">' + esc(fmtDateShort(t.date)) + '</span>' + badge +
          '</div>' +
          '<div class="ms-auto ps-2 text-end">' +
            '<h5 class="txn-amt" style="color:' + s.color + ';">' + s.text + '</h5>' +
            (t.balanceAfter != null ? '<span class="txn-bal">$' + money(t.balanceAfter) + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</a>'
    );
  }
  // Clean white account card (dashboard carousel + accounts list).
  function accountWCard(a) {
    return (
      '<a href="/user/account?num=' + encodeURIComponent(a.number) + '" class="acct-wcard">' +
        '<div><div class="aw-name">' + esc(a.type) + '</div><div class="aw-num">x' + esc(a.number) + '</div></div>' +
        '<div><div class="aw-bal">$' + money(a.balance) + '</div><div class="aw-avail">Available</div></div>' +
      '</a>'
    );
  }
  // Single-card carousel (arrows + dots) for the dashboard accounts.
  function accountsCarousel(accounts) {
    var slides = accounts.map(function (a) { return '<div class="acct-slide">' + accountWCard(a) + '</div>'; }).join('');
    if (accounts.length < 2) return '<div class="acct-track">' + slides + '</div>';
    var dots = accounts.map(function (_, i) { return '<span class="acct-dot' + (i === 0 ? ' active' : '') + '" data-i="' + i + '"></span>'; }).join('');
    return '<div class="acct-track">' + slides + '</div>' +
      '<div class="acct-nav"><button type="button" class="acct-prev" aria-label="Previous">‹</button>' +
      '<div class="acct-dots">' + dots + '</div>' +
      '<button type="button" class="acct-next" aria-label="Next">›</button></div>';
  }
  function wireCarousel(container) {
    var track = container.querySelector('.acct-track');
    if (!track) return;
    var slides = container.querySelectorAll('.acct-slide');
    var dots = Array.prototype.slice.call(container.querySelectorAll('.acct-dot'));
    function current() { return track.clientWidth ? Math.round(track.scrollLeft / track.clientWidth) : 0; }
    function go(i) { i = Math.max(0, Math.min(slides.length - 1, i)); track.scrollTo({ left: i * track.clientWidth, behavior: 'smooth' }); }
    var prev = container.querySelector('.acct-prev'), next = container.querySelector('.acct-next');
    if (prev) prev.addEventListener('click', function () { go(current() - 1); });
    if (next) next.addEventListener('click', function () { go(current() + 1); });
    track.addEventListener('scroll', function () { var c = current(); dots.forEach(function (d, i) { d.classList.toggle('active', i === c); }); });
    dots.forEach(function (d, i) { d.addEventListener('click', function () { go(i); }); });
  }

  /* ---------- dashboard (fill the skeleton slots in dashboard.html) ---------- */
  function renderDashboard(me, txns) {
    var name = me.profile.firstName || me.profile.displayName || me.username;
    var hi = document.getElementById('dash-hi');
    if (hi) hi.textContent = 'Hi, ' + name;

    var total = (me.accounts || []).reduce(function (sum, a) { return sum + (Number(a.balance) || 0); }, 0);
    var totalEl = document.getElementById('dash-total');
    if (totalEl) totalEl.textContent = '$' + money(total);

    var avatar = document.getElementById('dash-avatar');
    if (avatar) {
      avatar.classList.remove('skel');
      avatar.style.backgroundImage = "url('" + (me.profile.photoUrl || DEFAULT_AVATAR) + "')";
    }

    var accEl = document.getElementById('dash-accounts');
    if (accEl) {
      if (me.accounts.length) { accEl.innerHTML = accountsCarousel(me.accounts); wireCarousel(accEl); }
      else accEl.innerHTML = '<div class="acct-wcard"><div class="aw-name" style="font-size:14px;color:#8a8f8c;">No accounts yet</div><div></div></div>';
    }

    var txEl = document.getElementById('dash-txns');
    if (txEl) {
      txEl.innerHTML = (txns && txns.length)
        ? txns.slice(0, 6).map(txnRow).join('')
        : emptyState('No transactions yet');
    }
  }

  /* ---------- accounts list page ---------- */
  function renderAccounts(me) {
    var inner = me.accounts.length
      ? '<div class="acct-list-stack">' + me.accounts.map(accountWCard).join('') + '</div>'
      : '<div class="card card-style"><div class="content">' + emptyState('No accounts', 'fa-wallet') + '</div></div>';
    setContent(shell('Accounts', inner + footerCard()));
  }

  /* ---------- single account page (?num=) ---------- */
  async function renderAccount(me) {
    var num = new URLSearchParams(location.search).get('num');
    if (!num) { var mm = location.pathname.match(/\/user\/account\/checking\/([^/]+)/); if (mm) num = decodeURIComponent(mm[1]); }
    var acct = me.accounts.filter(function (a) { return String(a.number) === String(num); })[0] || me.accounts[0];
    if (!acct) { setContent(shell('Account', '<div class="card card-style"><div class="content">Account not found.</div></div>')); return; }
    var res = await api('/api/transactions?accountId=' + encodeURIComponent(acct.id));
    var data = res.ok ? await res.json() : { transactions: [] };
    setContent(
      headerBar() +
      '<div class="page-title page-title-large">' +
        '<div class="d-flex align-items-start">' +
          '<div style="flex:1;min-width:0;"><h2 class="color-white mb-0">' + esc(acct.type) + '</h2>' +
            '<div class="color-white acct-hero-num">x' + esc(acct.number) + '</div></div>' +
          '<div class="text-end color-white ps-2"><div class="acct-hero-bal">$' + money(acct.balance) + '</div>' +
            '<div class="acct-hero-avail">Available</div></div>' +
        '</div>' +
      '</div>' +
      heroCard(220) +
      '<div class="card card-style acct-routing"><div class="content">' +
        '<a href="#" class="ar-toggle" data-toggle="acct-routing"><span class="ar-title">ACCOUNT &amp; ROUTING #</span><i class="fas fa-chevron-down ar-chev"></i></a>' +
        '<div class="ar-body" hidden>' +
          '<div class="ar-row"><span class="ar-k">Account Number</span><span class="ar-v">' + esc(acct.number) + '</span></div>' +
          '<div class="ar-row"><span class="ar-k">Routing Number</span><span class="ar-v">' + esc(ROUTING_NUMBER) + '</span></div>' +
        '</div>' +
      '</div></div>' +
      '<div class="card card-style"><div class="content">' +
        '<h6 class="font-14 mb-3" style="font-weight:600!important;">Transactions</h6>' + txnHistory(data.transactions) +
      '</div></div>');
  }

  /* ---------- transactions list page ---------- */
  async function renderTransactions() {
    var res = await api('/api/transactions');
    var data = res.ok ? await res.json() : { transactions: [] };
    setContent(shell('Transactions',
      '<div class="card card-style"><div class="content">' + txnHistory(data.transactions) + '</div></div>'));
  }

  /* ---------- single transaction page (?id=) ---------- */
  // Status label + colour class + an explanatory note for the detail page.
  function statusInfo(status) {
    if (status === 'pending') return { label: 'Pending', cls: 'is-pending', note: 'This transfer is awaiting bank approval. The amount posts to your balance once it’s approved.' };
    if (status === 'rejected') return { label: 'Rejected', cls: 'is-rejected', note: 'This transfer was declined — no money moved.' };
    return { label: 'Completed', cls: 'is-completed', note: '' };
  }
  // Human label for a transfer kind (with Zelle send/request nuance).
  function kindLabel(t) {
    var labels = { internal: 'Internal Transfer', domestic: 'Domestic Transfer', wire: 'Wire / ACH Transfer', zelle: 'Zelle®', deposit: 'Mobile Check Deposit' };
    var base = labels[t.kind];
    if (!base) return '';
    if (t.kind === 'zelle') base += ((t.meta && t.meta.mode) === 'request' ? ' Request' : ' Payment');
    return base;
  }
  async function renderTransactionDetail() {
    var id = new URLSearchParams(location.search).get('id');
    if (!id) { var mm = location.pathname.match(/\/user\/transaction\/detail\/([^/]+)/); if (mm) id = decodeURIComponent(mm[1]); }
    var res = await api('/api/transactions?id=' + encodeURIComponent(id || ''));
    if (!res.ok) { setContent(shell('Transaction', '<div class="card card-style"><div class="content">Transaction not found.</div></div>')); return; }
    var t = (await res.json()).transaction;
    var s = signed(t.amount);
    var st = statusInfo(t.status);
    var kind = kindLabel(t);
    var meta = t.meta || {};
    function line(label, val) {
      return '<div class="d-flex py-2"><div class="color-theme font-13">' + esc(label) + '</div>' +
        '<div class="ms-auto font-600 font-13 text-end">' + val + '</div></div><div class="divider"></div>';
    }
    setContent(shell('Transaction',
      '<div class="card card-style"><div class="content text-center">' +
        '<h1 class="font-800 mb-0" style="color:' + s.color + ';">' + s.text + '</h1>' +
        '<span class="color-theme font-12">' + esc(t.type) + '</span><br>' +
        '<span class="txn-detail-badge ' + st.cls + '">' + esc(st.label) + '</span>' +
      '</div></div>' +
      (st.note ? '<div class="card card-style"><div class="content"><div class="txn-note ' + st.cls + '">' +
        '<i class="fas ' + (t.status === 'pending' ? 'fa-clock' : 'fa-ban') + '"></i> ' + esc(st.note) + '</div></div></div>' : '') +
      '<div class="card card-style"><div class="content">' +
        line('Status', esc(st.label)) +
        (kind ? line('Type', esc(kind)) : '') +
        line('Description', esc(t.description)) +
        line('Counterparty', esc(t.counterparty || '—')) +
        (meta.contact ? line('Zelle® contact', esc(meta.contact)) : '') +
        line('Date', esc(fmtDate(t.date))) +
        line('Reference', esc(t.ref || '—')) +
        (t.balanceAfter != null ? line('Balance after', '$' + money(t.balanceAfter)) : line('Balance after', '<span class="color-theme font-500">Pending</span>')) +
      '</div></div>'));
  }

  /* ---------- profile page ---------- */
  function renderProfile(me) {
    function row(label, val) {
      return '<div class="d-flex py-2"><div class="color-theme font-13">' + esc(label) + '</div>' +
        '<div class="ms-auto font-600 font-13 text-end">' + esc(val || '—') + '</div></div><div class="divider"></div>';
    }
    var url = me.profile.photoUrl || DEFAULT_AVATAR;
    setContent(shell('My Profile',
      '<div class="card card-style"><div class="content text-center">' +
        '<div class="mx-auto mb-2" style="width:90px;height:90px;border-radius:50%;background:#e6f2ea center/cover no-repeat;background-image:url(\'' + url + '\');"></div>' +
        '<h4 class="mb-0">' + esc(me.profile.displayName || me.profile.firstName || me.username) + '</h4>' +
        '<span class="color-theme font-12">@' + esc(me.username) + '</span>' +
      '</div></div>' +
      '<div class="card card-style"><div class="content">' +
        row('Name', me.profile.firstName || me.profile.displayName) +
        row('Email', me.email) +
        row('Phone', me.profile.phone) +
        row('Address', me.profile.address) +
        row('Role', me.role) +
      '</div></div>' +
      '<div class="mx-3"><a href="#" data-action="logout" class="btn btn-full btn-m rounded-s font-600 bg-red-dark">Log out</a></div>'));
  }

  /* ---------- Zelle: activity ---------- */
  async function renderZelleActivity(me) {
    var res = await api('/api/transactions');
    var data = res.ok ? await res.json() : { transactions: [] };
    var zelle = (data.transactions || []).filter(function (t) { return t.kind === 'zelle'; });
    var body = zelle.length
      ? txnHistory(zelle)
      : emptyState('No Zelle® activity yet', 'fa-exchange-alt');
    setContent(shell('Zelle® Activity',
      '<div class="card card-style"><div class="content">' + body + '</div></div>'));
  }

  /* ---------- Zelle: saved recipients ---------- */
  function recipientRow(r) {
    var initial = esc((r.name || '?').trim().charAt(0).toUpperCase());
    return (
      '<div class="zl-recip" data-id="' + esc(r.id) + '">' +
        '<div class="zl-recip-av">' + initial + '</div>' +
        '<div class="zl-recip-main"><div class="zl-recip-name">' + esc(r.name) + '</div>' +
          '<div class="zl-recip-contact">' + esc(r.contact) + '</div></div>' +
        '<button type="button" class="zl-recip-del" data-del="' + esc(r.id) + '" aria-label="Remove"><i class="fas fa-trash-alt"></i></button>' +
      '</div>'
    );
  }
  function recipientsListHtml(recipients) {
    if (!recipients.length) return emptyState('No saved recipients yet', 'fa-user-friends');
    return '<div class="zl-recip-list">' + recipients.map(recipientRow).join('') + '</div>';
  }
  async function renderZelleRecipients() {
    var res = await api('/api/zelle');
    var data = res.ok ? await res.json() : { recipients: [] };
    var recipients = data.recipients || [];
    setContent(shell('Recipients',
      '<div class="card card-style"><div class="content">' +
        '<h6 class="font-14 mb-3" style="font-weight:600!important;">Add a recipient</h6>' +
        '<div class="zl-form-err" id="zl-err" style="display:none;color:#c0392b;font-size:13px;margin:0 0 8px;"></div>' +
        '<input id="zl-name" class="ms-input w-input" type="text" placeholder="Recipient name" style="margin-bottom:10px;">' +
        '<input id="zl-contact" class="ms-input w-input" type="text" placeholder="Email or U.S. mobile number" style="margin-bottom:12px;">' +
        '<button type="button" id="zl-add" class="ms-button is-small w-inline-block"><div>Save recipient</div></button>' +
      '</div></div>' +
      '<div class="card card-style"><div class="content">' +
        '<h6 class="font-14 mb-3" style="font-weight:600!important;">Saved recipients</h6>' +
        '<div id="zl-list">' + recipientsListHtml(recipients) + '</div>' +
      '</div></div>'));
    wireRecipients();
  }
  function wireRecipients() {
    var nameEl = q('#zl-name'), contactEl = q('#zl-contact'), addBtn = q('#zl-add'), errEl = q('#zl-err'), listEl = q('#zl-list');
    function showErr(m) { if (errEl) { errEl.textContent = m; errEl.style.display = 'block'; } }
    function hideErr() { if (errEl) errEl.style.display = 'none'; }
    if (addBtn) addBtn.addEventListener('click', function () {
      hideErr();
      var name = (nameEl.value || '').trim(), contact = (contactEl.value || '').trim();
      if (!name || !contact) { showErr('Enter a name and an email or U.S. mobile number'); return; }
      addBtn.disabled = true;
      api('/api/zelle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, contact: contact }) })
        .then(async function (res) {
          var data = await res.json().catch(function () { return {}; });
          if (!res.ok) throw new Error(data.error || 'Could not save recipient');
          if (listEl) listEl.innerHTML = recipientsListHtml(data.recipients || []);
          nameEl.value = ''; contactEl.value = '';
        }).catch(function (e) { showErr(e.message); }).finally(function () { addBtn.disabled = false; });
    });
    if (listEl) listEl.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-del]');
      if (!btn) return;
      var id = btn.getAttribute('data-del');
      btn.disabled = true;
      api('/api/zelle?id=' + encodeURIComponent(id), { method: 'DELETE' })
        .then(async function (res) {
          var data = await res.json().catch(function () { return {}; });
          if (!res.ok) throw new Error(data.error || 'Could not remove recipient');
          listEl.innerHTML = recipientsListHtml(data.recipients || []);
        }).catch(function () { btn.disabled = false; });
    });
  }

  /* ---------- Zelle: my QR code ---------- */
  // Deterministic decorative QR-style matrix from the contact string. Not a
  // scannable code — the readable contact is shown beneath it.
  function qrMatrix(text, n) {
    var cells = [];
    var seed = 0;
    for (var i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
    function rnd() { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 16) & 1; }
    for (var r = 0; r < n; r++) { cells[r] = []; for (var c = 0; c < n; c++) cells[r][c] = rnd(); }
    // finder patterns (top-left, top-right, bottom-left)
    function finder(or, oc) {
      for (var y = 0; y < 7; y++) for (var x = 0; x < 7; x++) {
        var edge = (x === 0 || x === 6 || y === 0 || y === 6);
        var core = (x >= 2 && x <= 4 && y >= 2 && y <= 4);
        cells[or + y][oc + x] = (edge || core) ? 1 : 0;
      }
    }
    finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
    return cells;
  }
  function qrSvg(text) {
    var n = 25, cells = qrMatrix(text, n), sz = 200, cell = sz / n, rects = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
      if (cells[r][c]) rects += '<rect x="' + (c * cell).toFixed(2) + '" y="' + (r * cell).toFixed(2) +
        '" width="' + cell.toFixed(2) + '" height="' + cell.toFixed(2) + '"/>';
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + sz + '" height="' + sz + '" viewBox="0 0 ' + sz + ' ' + sz +
      '" style="background:#fff;border-radius:12px;" fill="#111"><rect width="' + sz + '" height="' + sz + '" fill="#fff"/>' + rects + '</svg>';
  }
  function renderZelleQr(me) {
    var contact = (me.zelle && me.zelle.contact) || '';
    var name = me.profile.displayName || me.profile.firstName || me.username;
    var inner = contact
      ? '<div class="card card-style"><div class="content text-center">' +
          '<div style="display:inline-block;padding:12px;border:1px solid #e6e9e7;border-radius:16px;background:#fff;">' + qrSvg(contact) + '</div>' +
          '<h4 class="mt-3 mb-0">' + esc(name) + '</h4>' +
          '<p class="color-theme font-13 mb-0" style="margin-top:4px;">' + esc(contact) + '</p>' +
          '<p class="color-theme font-12" style="margin-top:12px;line-height:18px;">Show this code or share your Zelle® contact so others can send you money.</p>' +
        '</div></div>'
      : '<div class="card card-style"><div class="content text-center">' +
          emptyState('Enroll a Zelle® contact first to get your QR code', 'fa-qrcode') +
          '<a href="/user/zelle-preferences" class="ms-button is-small w-inline-block" style="text-decoration:none;margin-top:12px;"><div>Set up Zelle®</div></a>' +
        '</div></div>';
    setContent(shell('My Zelle® QR', inner));
  }

  /* ---------- Zelle: preferences ---------- */
  function renderZellePreferences(me) {
    var contact = (me.zelle && me.zelle.contact) || '';
    var def = (me.zelle && me.zelle.defaultAccountId) || '';
    var opts = '<option value="">No default</option>' + (me.accounts || []).map(function (a) {
      var sel = String(a.id) === String(def) ? ' selected' : '';
      return '<option value="' + esc(a.id) + '"' + sel + '>' + esc(a.type) + ' ••' + esc(String(a.number).slice(-4)) + '</option>';
    }).join('');
    setContent(shell('Zelle® Preferences',
      '<div class="card card-style"><div class="content">' +
        '<div class="zl-form-err" id="zl-err" style="display:none;color:#c0392b;font-size:13px;margin:0 0 8px;"></div>' +
        '<div class="zl-form-ok" id="zl-ok" style="display:none;color:#0f6b3b;font-size:13px;margin:0 0 8px;"></div>' +
        '<label class="ms-input-label">Your Zelle® contact (email or U.S. mobile)</label>' +
        '<input id="zl-contact" class="ms-input w-input" type="text" value="' + esc(contact) + '" placeholder="name@email.com or (555) 555-5555" style="margin-bottom:14px;">' +
        '<label class="ms-input-label">Default account for incoming money</label>' +
        '<div class="ms-input-wrap"><select id="zl-default" class="ms-input w-select">' + opts + '</select>' +
          '<div class="ms-select-svg w-embed"><svg xmlns="http://www.w3.org/2000/svg" height="32px" viewBox="0 0 24 24" width="32px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"></path><path d="M8.71 11.71l2.59 2.59c.39.39 1.02.39 1.41 0l2.59-2.59c.63-.63.18-1.71-.71-1.71H9.41c-.89 0-1.33 1.08-.7 1.71z"></path></svg></div>' +
        '</div>' +
        '<button type="button" id="zl-save" class="ms-button is-small w-inline-block" style="margin-top:16px;"><div>Save preferences</div></button>' +
      '</div></div>'));
    var saveBtn = q('#zl-save'), errEl = q('#zl-err'), okEl = q('#zl-ok');
    if (saveBtn) saveBtn.addEventListener('click', function () {
      if (errEl) errEl.style.display = 'none';
      if (okEl) okEl.style.display = 'none';
      saveBtn.disabled = true;
      var payload = { contact: (q('#zl-contact').value || '').trim(), defaultAccountId: q('#zl-default').value || '' };
      api('/api/zelle', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        .then(async function (res) {
          var data = await res.json().catch(function () { return {}; });
          if (!res.ok) throw new Error(data.error || 'Could not save preferences');
          if (me.zelle) { me.zelle.contact = payload.contact; me.zelle.defaultAccountId = payload.defaultAccountId; }
          if (okEl) { okEl.textContent = 'Preferences saved.'; okEl.style.display = 'block'; }
        }).catch(function (e) { if (errEl) { errEl.textContent = e.message; errEl.style.display = 'block'; } })
        .finally(function () { saveBtn.disabled = false; });
    });
  }

  /* ---------- Zelle: help ---------- */
  function renderZelleHelp() {
    function faq(q, a) {
      return '<div class="zl-faq"><div class="zl-faq-q">' + esc(q) + '</div><div class="zl-faq-a">' + esc(a) + '</div></div>';
    }
    setContent(shell('Zelle® Help',
      '<div class="card card-style"><div class="content">' +
        faq('What is Zelle®?', 'Zelle® is a fast, easy way to send and receive money with people you trust — using just their email address or U.S. mobile number.') +
        faq('When will my money arrive?', 'Requests are reviewed for security. Once approved, sends and requests typically settle within minutes and appear in your activity.') +
        faq('Why does my transfer say Pending?', 'For your protection, Zelle® transfers on this account are reviewed before they complete. You will see the status update to Completed once approved.') +
        faq('Is it safe?', 'Only send money to people you know and trust. Neither Alliance nor Zelle® offers a protection program for authorized payments, so treat it like cash.') +
      '</div></div>' +
      '<div class="card card-style"><div class="content text-center">' +
        '<p class="color-theme font-13 mb-2">Still need help?</p>' +
        '<a href="/user/contact-support" class="ms-button is-small w-inline-block" style="text-decoration:none;"><div>Contact support</div></a>' +
      '</div></div>'));
  }

  /* ---------- transfer / deposit forms (any page with a form[data-kind]) ---------- */
  function acctOption(a) {
    return '<option value="' + esc(a.id) + '">' + esc(a.type) + ' ••' + esc(String(a.number).slice(-4)) +
      ' — $' + money(a.balance) + '</option>';
  }
  function transferSuccess(form, kind, cents, mode) {
    var container = form.closest('.w-form') || form.parentNode;
    var labels = { internal: 'transfer', domestic: 'transfer', wire: 'wire transfer', zelle: 'Zelle payment', deposit: 'deposit' };
    var label = (kind === 'zelle' && mode === 'request') ? 'Zelle request' : (labels[kind] || 'transfer');
    container.innerHTML =
      '<div class="card card-style" style="margin-top:24px;"><div class="content text-center" style="padding:26px 18px;">' +
        '<div style="width:66px;height:66px;border-radius:50%;background:#e4f2df;display:flex;align-items:center;justify-content:center;margin:0 auto 14px;">' +
          '<i class="fas fa-clock" style="font-size:28px;color:#0f6b3b;"></i></div>' +
        '<h3 class="font-700 mb-1">Submitted for approval</h3>' +
        '<p class="color-theme font-13" style="line-height:19px;">Your <b>$' + money(cents) + '</b> ' + esc(label) +
          ' is <b>pending review</b>. It will be processed once approved and shows in your activity marked <b>Pending</b>.</p>' +
        '<a href="/user/dashboard" class="ms-button is-small w-inline-block" style="text-decoration:none;margin-top:10px;"><div>Back to dashboard</div></a>' +
      '</div></div>';
  }
  function wireTransferForm(form, me) {
    var kind = form.getAttribute('data-kind');
    var modeInput = form.querySelector('[name="mode"]');
    var mode = modeInput ? String(modeInput.value || '') : '';
    var incoming = kind === 'deposit' || (kind === 'zelle' && mode === 'request');
    var fromSel = form.querySelector('[name="account_id"]');
    var toSel = form.querySelector('[name="to_account_id"]');
    var amountInput = form.querySelector('[name="amount"]');
    var balanceHint = form.querySelector('#tf-balance');
    var errorBox = form.querySelector('#tf-error');
    var accounts = me.accounts || [];

    function showError(msg) { if (errorBox) { errorBox.textContent = msg; errorBox.style.display = 'block'; } }
    function hideError() { if (errorBox) errorBox.style.display = 'none'; }
    function fromAcct() { return accounts.filter(function (a) { return String(a.id) === String(fromSel && fromSel.value); })[0]; }

    var opts = '<option value="">Select Account…</option>' + accounts.map(acctOption).join('');
    if (fromSel) fromSel.innerHTML = opts;
    if (toSel) toSel.innerHTML = opts;
    // Preselect the first account for a smoother flow.
    if (fromSel && accounts.length) fromSel.value = String(accounts[0].id);
    if (toSel && accounts.length > 1) toSel.value = String(accounts[1].id);

    function updateBalance() {
      if (!balanceHint) return;
      var a = fromAcct();
      balanceHint.textContent = a ? ('Available balance: $' + money(a.balance)) : '';
    }
    if (fromSel) fromSel.addEventListener('change', updateBalance);
    updateBalance();

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      hideError();
      if (!form.checkValidity()) { form.reportValidity(); return; }

      var fromId = fromSel ? fromSel.value : '';
      if (!fromId) { showError('Choose an account'); return; }
      var amt = parseFloat(amountInput && amountInput.value);
      if (!(amt > 0)) { showError('Enter an amount greater than $0.00'); return; }
      var cents = Math.round(amt * 100);

      if (!incoming) {
        var a = fromAcct();
        if (a && cents > a.balance) { showError('Amount exceeds your available balance ($' + money(a.balance) + ')'); return; }
      }
      if (kind === 'internal') {
        if (!toSel.value) { showError('Choose a destination account'); return; }
        if (toSel.value === fromId) { showError('Choose two different accounts'); return; }
      }

      var payload = { kind: kind, fromAccountId: fromId };
      if (toSel) payload.toAccountId = toSel.value;
      var fd = new FormData(form);
      fd.forEach(function (v, k) {
        if (k === 'account_id' || k === 'to_account_id') return; // mapped above
        payload[k] = v;
      });

      var btn = form.querySelector('button[type="submit"]');
      if (btn) btn.disabled = true;
      api('/api/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      }).then(async function (res) {
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(data.error || 'Transfer could not be submitted');
        transferSuccess(form, kind, cents, mode);
      }).catch(function (err) {
        showError(err.message || 'Transfer could not be submitted');
        if (btn) btn.disabled = false;
      });
    });
  }

  /* ---------- boot ---------- */
  document.addEventListener('DOMContentLoaded', async function () {
    var payload = window.meReady ? await window.meReady : null;
    if (!payload) return; // guard.js will have redirected on 401
    var me = payload.user;
    var txns = payload.transactions || [];
    var path = location.pathname.replace(/\/$/, '');
    ensureMenu();

    try {
      var tform = document.querySelector('form[data-kind]');
      if (tform) { wireTransferForm(tform, me); return; }
      if (/\/user\/dashboard$/.test(path)) renderDashboard(me, txns);
      else if (/\/user\/accounts$/.test(path)) renderAccounts(me);
      else if (/\/user\/account(\/checking\/[^/]+)?$/.test(path)) await renderAccount(me);
      else if (/\/user\/transactions$/.test(path)) await renderTransactions();
      else if (/\/user\/transaction\/detail(\/[^/]+\/[^/]+)?$/.test(path)) await renderTransactionDetail();
      else if (/\/user\/profile$/.test(path)) renderProfile(me);
      else if (/\/user\/zelle-activity$/.test(path)) await renderZelleActivity(me);
      else if (/\/user\/zelle-recipients$/.test(path)) await renderZelleRecipients();
      else if (/\/user\/zelle-qr$/.test(path)) renderZelleQr(me);
      else if (/\/user\/zelle-preferences$/.test(path)) renderZellePreferences(me);
      else if (/\/user\/zelle-help$/.test(path)) renderZelleHelp();
      // other pages (transfer/deposit/zelle/wire/support/messages): static, just show the name if present
      else {
        var h2 = q('.page-title h2');
        if (h2 && /angeline/i.test(h2.textContent)) h2.textContent = 'Hi, ' + (me.profile.firstName || me.username);
      }
    } catch (err) {
      console.error('[app] render error', err);
    }
  });
})();
