/* Alliance Federal Credit Union — front-end behaviour for /user/* pages.
   - Side-menu open/close (replaces the template's obfuscated custom.js)
   - Logout
   - Per-page data binding from /api/me and /api/transactions
   Money values from the API are integer cents. */
(function () {
  'use strict';

  var DEFAULT_AVATAR = '/assets/img/default-avatar.png';

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
  function acctKind(a) { return /sav/i.test(a.type || '') ? 'save' : 'check'; }
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
  function txnHistory(list) {
    if (!list || !list.length) return emptyState('No transactions yet');
    var out = '<div class="txn-list">', last = null;
    list.forEach(function (t) {
      var lbl = groupLabel(t.date);
      if (lbl !== last) { out += '<div class="txn-group-label">' + esc(lbl) + '</div>'; last = lbl; }
      out += txnRow(t);
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
  function shell(title, inner) {
    return (
      '<div class="header header-logo-app">' +
        '<a href="/user/dashboard" class="header-icon header-icon-1 color-white"><i class="fas fa-arrow-left"></i></a>' +
        '<a href="#" data-menu="menu-main" class="header-icon color-white" style="position:absolute;right:10px;top:0;"><i class="fas fa-bars"></i></a>' +
      '</div>' +
      '<div class="page-title page-title-large"><h2 class="color-white">' + esc(title) + '</h2></div>' +
      '<div class="card header-card" data-card-height="180" style="height:180px;">' +
        '<div class="card-overlay bg-highlight opacity-95"></div>' +
        '<div class="card-overlay dark-mode-tint"></div>' +
      '</div>' + inner
    );
  }
  function setContent(html) {
    var pc = q('.page-content');
    if (pc) pc.innerHTML = html;
  }

  /* ---------- row + card builders ---------- */
  function txnRow(t) {
    var s = signed(t.amount);
    var ic = txnIcon(t);
    return (
      '<a href="/user/transaction/detail?id=' + encodeURIComponent(t.id) + '" class="txn-row">' +
        '<div class="d-flex align-items-center">' +
          '<div class="txn-ic" style="background:' + ic.bg + ';color:' + ic.fg + ';"><i class="fas ' + ic.icon + '"></i></div>' +
          '<div class="ps-2" style="min-width:0;flex:1;">' +
            '<h5 class="txn-desc">' + esc(t.description) + '</h5>' +
            '<span class="txn-date">' + esc(fmtDateShort(t.date)) + '</span>' +
          '</div>' +
          '<div class="ms-auto ps-2 text-end">' +
            '<h5 class="txn-amt" style="color:' + s.color + ';">' + s.text + '</h5>' +
            (t.balanceAfter != null ? '<span class="txn-bal">$' + money(t.balanceAfter) + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</a>'
    );
  }
  // Full-width account card (accounts list page) — same look as the dashboard carousel.
  function accountCard(a) {
    var masked = '•••• ' + String(a.number || '').slice(-4);
    return (
      '<a href="/user/account?num=' + encodeURIComponent(a.number) + '" class="acct-card acct-' + acctKind(a) + '">' +
        '<div class="ac-top"><span>' + esc(a.type) + '</span><i class="fas fa-university"></i></div>' +
        '<div><div class="ac-bal">$' + money(a.balance) + '</div>' +
        '<div class="ac-sub"><span>' + esc(a.name || a.type) + '</span><span class="ac-num">' + esc(masked) + '</span></div></div>' +
      '</a>'
    );
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
      accEl.innerHTML = me.accounts.length
        ? me.accounts.map(accountCard).join('')
        : '<div class="acct-card acct-check" style="justify-content:center;align-items:center;font-size:13px;">No accounts yet</div>';
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
      ? '<div class="acct-stack">' + me.accounts.map(accountCard).join('') + '</div>'
      : '<div class="card card-style"><div class="content">' + emptyState('No accounts', 'fa-wallet') + '</div></div>';
    setContent(shell('Accounts', inner));
  }

  /* ---------- single account page (?num=) ---------- */
  async function renderAccount(me) {
    var num = new URLSearchParams(location.search).get('num');
    if (!num) { var mm = location.pathname.match(/\/user\/account\/checking\/([^/]+)/); if (mm) num = decodeURIComponent(mm[1]); }
    var acct = me.accounts.filter(function (a) { return String(a.number) === String(num); })[0] || me.accounts[0];
    if (!acct) { setContent(shell('Account', '<div class="card card-style"><div class="content">Account not found.</div></div>')); return; }
    var res = await api('/api/transactions?accountId=' + encodeURIComponent(acct.id));
    var data = res.ok ? await res.json() : { transactions: [] };
    var masked = '•••• ' + String(acct.number || '').slice(-4);
    setContent(shell(acct.name || 'Account',
      '<div class="acct-stack"><div class="acct-card acct-' + acctKind(acct) + '" style="min-height:132px;">' +
        '<div class="ac-top"><span>' + esc(acct.type) + '</span><i class="fas fa-university"></i></div>' +
        '<div><div class="ac-bal" style="font-size:30px;">$' + money(acct.balance) + '</div>' +
        '<div class="ac-sub"><span>Available balance</span><span class="ac-num">' + esc(masked) + '</span></div></div>' +
      '</div></div>' +
      '<div class="card card-style"><div class="content">' +
        '<h6 class="font-14 mb-3" style="font-weight:600!important;">Transactions</h6>' + txnHistory(data.transactions) +
      '</div></div>'));
  }

  /* ---------- transactions list page ---------- */
  async function renderTransactions() {
    var res = await api('/api/transactions');
    var data = res.ok ? await res.json() : { transactions: [] };
    setContent(shell('Transactions',
      '<div class="card card-style"><div class="content">' + txnHistory(data.transactions) + '</div></div>'));
  }

  /* ---------- single transaction page (?id=) ---------- */
  async function renderTransactionDetail() {
    var id = new URLSearchParams(location.search).get('id');
    if (!id) { var mm = location.pathname.match(/\/user\/transaction\/detail\/([^/]+)/); if (mm) id = decodeURIComponent(mm[1]); }
    var res = await api('/api/transactions?id=' + encodeURIComponent(id || ''));
    if (!res.ok) { setContent(shell('Transaction', '<div class="card card-style"><div class="content">Transaction not found.</div></div>')); return; }
    var t = (await res.json()).transaction;
    var s = signed(t.amount);
    function line(label, val) {
      return '<div class="d-flex py-2"><div class="color-theme font-13">' + esc(label) + '</div>' +
        '<div class="ms-auto font-600 font-13 text-end">' + val + '</div></div><div class="divider"></div>';
    }
    setContent(shell('Transaction',
      '<div class="card card-style"><div class="content text-center">' +
        '<h1 class="font-800 mb-0" style="color:' + s.color + ';">' + s.text + '</h1>' +
        '<span class="color-theme font-12">' + esc(t.type) + '</span>' +
      '</div></div>' +
      '<div class="card card-style"><div class="content">' +
        line('Description', esc(t.description)) +
        line('Counterparty', esc(t.counterparty || '—')) +
        line('Date', esc(fmtDate(t.date))) +
        line('Reference', esc(t.ref || '—')) +
        (t.balanceAfter != null ? line('Balance after', '$' + money(t.balanceAfter)) : '') +
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

  /* ---------- boot ---------- */
  document.addEventListener('DOMContentLoaded', async function () {
    var payload = window.meReady ? await window.meReady : null;
    if (!payload) return; // guard.js will have redirected on 401
    var me = payload.user;
    var txns = payload.transactions || [];
    var path = location.pathname.replace(/\/$/, '');
    ensureMenu();

    try {
      if (/\/user\/dashboard$/.test(path)) renderDashboard(me, txns);
      else if (/\/user\/accounts$/.test(path)) renderAccounts(me);
      else if (/\/user\/account(\/checking\/[^/]+)?$/.test(path)) await renderAccount(me);
      else if (/\/user\/transactions$/.test(path)) await renderTransactions();
      else if (/\/user\/transaction\/detail(\/[^/]+\/[^/]+)?$/.test(path)) await renderTransactionDetail();
      else if (/\/user\/profile$/.test(path)) renderProfile(me);
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
