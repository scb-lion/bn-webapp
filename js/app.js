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
    return (
      '<a href="/user/transaction/detail?id=' + encodeURIComponent(t.id) + '">' +
        '<div class="d-flex">' +
          '<div class="align-self-center ps-3">' +
            '<h5 class="font-500 font-14 mb-n2" style="font-weight:500!important;color:#13120f!important;">' + esc(t.description) + '</h5>' +
            '<span class="color-theme font-11" style="font-weight:500!important;color:#727272!important;">' + esc(fmtDate(t.date)) + '</span>' +
          '</div>' +
          '<div class="align-self-center ms-auto">' +
            '<h5 class="mb-n1 text-end font-14" style="font-weight:600!important;color:' + s.color + '!important;">' + s.text + '</h5>' +
          '</div>' +
        '</div>' +
      '</a><div class="divider mt-3 mb-3"></div>'
    );
  }
  function accountRow(a) {
    return (
      '<a href="/user/account?num=' + encodeURIComponent(a.number) + '">' +
        '<div class="content">' +
          '<div class="d-flex">' +
            '<div class="align-self-center">' +
              '<h5 class="font-500 font-14 mb-n2">' + esc(a.name || a.type) + '</h5>' +
              '<span class="color-theme font-11">x' + esc(a.number) + '</span>' +
            '</div>' +
            '<div class="align-self-center ms-auto">' +
              '<h6 class="color-theme mb-n1 text-end font-600 font-14">$' + money(a.balance) + '</h6>' +
              '<span class="color-theme d-block font-11 text-end">Available</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</a><div class="divider mt-3 mb-3"></div>'
    );
  }

  /* ---------- dashboard (fill the skeleton slots in dashboard.html) ---------- */
  function dashAccountCard(a) {
    return (
      '<div class="card card-style d-inline-block me-2" style="width:290px;white-space:normal;vertical-align:top;">' +
        '<a href="/user/account?num=' + encodeURIComponent(a.number) + '"><div class="content">' +
          '<div class="d-flex"><div class="align-self-center">' +
            '<h5 class="font-600 font-14 mb-n2">' + esc(a.name || a.type) + '</h5>' +
            '<span class="color-theme font-11">x' + esc(a.number) + '</span>' +
          '</div><div class="align-self-center ms-auto">' +
            '<h5 class="color-theme mb-n1 text-end">$' + money(a.balance) + '</h5>' +
            '<span class="color-theme d-block font-11 text-end">Available</span>' +
          '</div></div>' +
        '</div></a>' +
      '</div>'
    );
  }
  function renderDashboard(me, txns) {
    var name = me.profile.firstName || me.profile.displayName || me.username;
    var hi = document.getElementById('dash-hi');
    if (hi) hi.textContent = 'Hi, ' + name;

    var avatar = document.getElementById('dash-avatar');
    if (avatar) {
      var url = me.profile.photoUrl || DEFAULT_AVATAR;
      avatar.classList.remove('skel');
      avatar.style.backgroundImage = "url('" + url + "')";
    }

    var accEl = document.getElementById('dash-accounts');
    if (accEl) {
      accEl.innerHTML = me.accounts.length
        ? me.accounts.map(dashAccountCard).join('')
        : '<div class="card card-style d-inline-block" style="width:290px;"><div class="content color-theme font-12">No accounts yet.</div></div>';
    }

    var txEl = document.getElementById('dash-txns');
    if (txEl) {
      txEl.innerHTML = (txns && txns.length)
        ? txns.slice(0, 5).map(txnRow).join('')
        : '<p class="text-center color-theme font-12 py-3">No transactions yet.</p>';
    }
  }

  /* ---------- accounts list page ---------- */
  function renderAccounts(me) {
    var rows = me.accounts.map(accountRow).join('') || '<p class="text-center color-theme py-3">No accounts.</p>';
    setContent(shell('Accounts',
      '<div class="card card-style"><div class="content">' +
        '<h6 class="float-start font-14" style="font-weight:500!important;">Your accounts</h6><div class="clearfix mb-3"></div>' +
        rows +
      '</div></div>'));
  }

  /* ---------- single account page (?num=) ---------- */
  async function renderAccount(me) {
    var num = new URLSearchParams(location.search).get('num');
    if (!num) { var mm = location.pathname.match(/\/user\/account\/checking\/([^/]+)/); if (mm) num = decodeURIComponent(mm[1]); }
    var acct = me.accounts.filter(function (a) { return String(a.number) === String(num); })[0] || me.accounts[0];
    if (!acct) { setContent(shell('Account', '<div class="card card-style"><div class="content">Account not found.</div></div>')); return; }
    var res = await api('/api/transactions?accountId=' + encodeURIComponent(acct.id));
    var data = res.ok ? await res.json() : { transactions: [] };
    var rows = (data.transactions || []).map(txnRow).join('') || '<p class="text-center color-theme py-3">No transactions.</p>';
    setContent(shell(acct.name || 'Account',
      '<div class="card card-style"><div class="content text-center">' +
        '<span class="color-theme font-12 d-block">' + esc(acct.type) + ' ·  x' + esc(acct.number) + '</span>' +
        '<h1 class="font-800 mt-2 mb-0">$' + money(acct.balance) + '</h1>' +
        '<span class="color-theme font-12">Available balance</span>' +
      '</div></div>' +
      '<div class="card card-style"><div class="content">' +
        '<h6 class="float-start font-14" style="font-weight:500!important;">Transactions</h6><div class="clearfix mb-3"></div>' + rows +
      '</div></div>'));
  }

  /* ---------- transactions list page ---------- */
  async function renderTransactions() {
    var res = await api('/api/transactions');
    var data = res.ok ? await res.json() : { transactions: [] };
    var rows = (data.transactions || []).map(txnRow).join('') || '<p class="text-center color-theme py-3">No transactions yet.</p>';
    setContent(shell('Transactions',
      '<div class="card card-style"><div class="content">' + rows + '</div></div>'));
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
