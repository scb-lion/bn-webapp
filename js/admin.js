/* Alliance Federal Credit Union — admin dashboard logic. Admin-only user + balance + transaction
   management. Talks to /api/admin/*. Money is cents in the API; dollars in the UI. */
(function () {
  'use strict';

  var state = { users: [], selectedId: null };
  var DEFAULT_AVATAR = '/assets/img/default-avatar.png';

  /* ---------- helpers ---------- */
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function dollars(cents) { return ((Number(cents) || 0) / 100).toFixed(2); }
  function money(cents) { return '$' + ((Number(cents) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function api(url, method, body) {
    return fetch(url, {
      method: method || 'GET',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async function (r) {
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(data.error || ('Request failed (' + r.status + ')'));
      return data;
    });
  }
  var toastTimer;
  function toast(msg, isErr) {
    var t = el('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 2600);
  }

  /* ---------- users list ---------- */
  function renderList() {
    var ul = el('user-list');
    if (!state.users.length) { ul.innerHTML = '<li class="muted">No users yet.</li>'; return; }
    ul.innerHTML = state.users.map(function (u) {
      var total = (u.accounts || []).reduce(function (s, a) { return s + (a.balance || 0); }, 0);
      return '<li data-id="' + u.id + '" class="' + (u.id === state.selectedId ? 'active' : '') + '">' +
        '<div style="flex:1;min-width:0;">' +
          '<div class="nm">' + esc(u.profile.displayName || u.profile.firstName || u.username) +
            (u.role === 'admin' ? ' <span class="badge admin">admin</span>' : '') +
            (u.active === false ? ' <span class="badge off">disabled</span>' : '') + '</div>' +
          '<div class="un">@' + esc(u.username) + ' · ' + money(total) + '</div>' +
        '</div></li>';
    }).join('');
    Array.prototype.forEach.call(ul.querySelectorAll('li[data-id]'), function (li) {
      li.addEventListener('click', function () { selectUser(li.getAttribute('data-id')); });
    });
  }

  async function loadUsers() {
    try {
      var data = await api('/api/admin/users');
      state.users = data.users || [];
      renderList();
    } catch (e) { toast(e.message, true); }
  }

  /* ---------- account editor rows ---------- */
  function acctRowHTML(a) {
    a = a || { type: 'Checking', name: 'Checking', number: '', balance: 0 };
    // Preserve the account id so editing a user never re-keys the account and
    // orphans its transactions (which reference this id via accountId).
    return '<div class="acct-row" data-id="' + esc(a.id || '') + '">' +
      '<input class="a-name" placeholder="Name" value="' + esc(a.name || a.type || '') + '">' +
      '<input class="a-type" placeholder="Type" value="' + esc(a.type || 'Checking') + '">' +
      '<input class="a-number" placeholder="Number" value="' + esc(a.number || '') + '">' +
      '<input class="a-balance" type="number" step="0.01" placeholder="0.00" value="' + dollars(a.balance) + '">' +
      '<button type="button" class="btn btn-danger a-remove">✕</button>' +
    '</div>';
  }
  function wireAcctRemovers(container) {
    Array.prototype.forEach.call(container.querySelectorAll('.a-remove'), function (b) {
      b.addEventListener('click', function () { b.closest('.acct-row').remove(); });
    });
  }
  function collectAccounts(container) {
    return Array.prototype.map.call(container.querySelectorAll('.acct-row'), function (row) {
      return {
        id: row.getAttribute('data-id') || '', // preserved; server generates one when empty
        name: row.querySelector('.a-name').value.trim(),
        type: row.querySelector('.a-type').value.trim() || 'Checking',
        number: row.querySelector('.a-number').value.trim(),
        balance: row.querySelector('.a-balance').value, // dollars -> server converts
      };
    }).filter(function (a) { return a.number || a.name; });
  }

  /* ---------- Zelle recipient editor rows ---------- */
  function recipRowHTML(r) {
    r = r || { id: '', name: '', contact: '' };
    return '<div class="acct-row recip-row" data-id="' + esc(r.id || '') + '" style="grid-template-columns:1fr 1fr auto;">' +
      '<input class="r-name" placeholder="Recipient name" value="' + esc(r.name || '') + '">' +
      '<input class="r-contact" placeholder="Email or U.S. mobile" value="' + esc(r.contact || '') + '">' +
      '<button type="button" class="btn btn-danger r-remove">✕</button>' +
    '</div>';
  }
  function wireRecipRemovers(container) {
    Array.prototype.forEach.call(container.querySelectorAll('.r-remove'), function (b) {
      b.addEventListener('click', function () { b.closest('.recip-row').remove(); });
    });
  }
  function collectRecipients(container) {
    return Array.prototype.map.call(container.querySelectorAll('.recip-row'), function (row) {
      return {
        id: row.getAttribute('data-id') || '',
        name: row.querySelector('.r-name').value.trim(),
        contact: row.querySelector('.r-contact').value.trim(),
      };
    }).filter(function (r) { return r.name && r.contact; });
  }
  // Build the Zelle enrollment + recipients block for a user editor.
  function zelleSectionHTML(u) {
    var z = u.zelle || { contact: '', defaultAccountId: '' };
    var opts = '<option value="">No default</option>' + (u.accounts || []).map(function (a) {
      var sel = String(a.id) === String(z.defaultAccountId) ? ' selected' : '';
      return '<option value="' + esc(a.id) + '"' + sel + '>' + esc(a.name || a.type) + ' · x' + esc(a.number) + '</option>';
    }).join('');
    return '<div class="section-title">Zelle®</div>' +
      '<div class="grid2">' +
        '<div class="field"><label for="e-zelle-contact">Enrolled contact</label>' +
          '<input id="e-zelle-contact" type="text" placeholder="email or U.S. mobile" value="' + esc(z.contact || '') + '"></div>' +
        '<div class="field"><label for="e-zelle-default">Default account</label>' +
          '<select id="e-zelle-default">' + opts + '</select></div>' +
      '</div>' +
      '<div class="muted" style="margin:2px 0 6px;">Saved recipients</div>' +
      '<div id="e-recipients">' + (u.zelleRecipients || []).map(recipRowHTML).join('') + '</div>' +
      '<button type="button" class="btn btn-light" id="e-add-recip">+ Add recipient</button>';
  }

  /* ---------- editor: create ---------- */
  function renderNewUser() {
    state.selectedId = null;
    renderList();
    el('editor').innerHTML =
      '<h3>Create user</h3>' +
      '<div class="grid2">' +
        field('n-username', 'Username *', 'text') +
        field('n-password', 'Password *', 'password') +
      '</div>' +
      '<div class="grid2">' +
        field('n-firstName', 'First / display name', 'text') +
        field('n-email', 'Email', 'email') +
      '</div>' +
      '<div class="grid2">' +
        field('n-phone', 'Phone', 'text') +
        selectField('n-role', 'Role', [['user', 'User'], ['admin', 'Admin']]) +
      '</div>' +
      field('n-address', 'Address', 'text') +
      avatarField('n', '') +
      '<div class="section-title">Accounts</div>' +
      '<div id="n-accounts">' + acctRowHTML() + '</div>' +
      '<button type="button" class="btn btn-light" id="n-add-acct">+ Add account</button>' +
      '<hr>' +
      '<div class="row-flex" style="gap:10px;"><button class="btn btn-primary" id="n-save">Create user</button>' +
      '<button class="btn btn-light" id="n-cancel">Cancel</button></div>';

    var accts = el('n-accounts');
    wireAcctRemovers(accts);
    wireAvatar('n');
    el('n-add-acct').addEventListener('click', function () {
      accts.insertAdjacentHTML('beforeend', acctRowHTML());
      wireAcctRemovers(accts);
    });
    el('n-cancel').addEventListener('click', function () { clearEditor(); });
    el('n-save').addEventListener('click', saveNewUser);
  }

  async function saveNewUser() {
    var btn = el('n-save'); btn.disabled = true;
    try {
      var body = {
        username: el('n-username').value.trim(),
        password: el('n-password').value,
        firstName: el('n-firstName').value.trim(),
        displayName: el('n-firstName').value.trim(),
        email: el('n-email').value.trim(),
        phone: el('n-phone').value.trim(),
        address: el('n-address').value.trim(),
        photoUrl: el('n-photoUrl').value.trim(),
        role: el('n-role').value,
        accounts: collectAccounts(el('n-accounts')),
      };
      var data = await api('/api/admin/users', 'POST', body);
      toast('User created');
      await loadUsers();
      selectUser(data.user.id);
    } catch (e) { toast(e.message, true); btn.disabled = false; }
  }

  /* ---------- editor: edit existing ---------- */
  async function selectUser(id) {
    state.selectedId = id;
    renderList();
    try {
      var data = await api('/api/admin/user?id=' + encodeURIComponent(id));
      renderEditor(data.user, data.transactions || []);
    } catch (e) { toast(e.message, true); }
  }

  function renderEditor(u, txns) {
    var acctOptions = (u.accounts || []).map(function (a) {
      return '<option value="' + esc(a.id) + '">' + esc(a.name || a.type) + ' · x' + esc(a.number) + '</option>';
    }).join('');

    el('editor').innerHTML =
      '<div class="row-flex" style="justify-content:space-between;">' +
        '<h3>' + esc(u.profile.displayName || u.username) + ' <span class="muted">@' + esc(u.username) + '</span></h3>' +
        '<button class="btn btn-danger" id="e-delete">Delete</button>' +
      '</div>' +
      '<div class="grid2">' +
        field('e-firstName', 'First / display name', 'text', u.profile.firstName || u.profile.displayName) +
        field('e-email', 'Email', 'email', u.email) +
      '</div>' +
      '<div class="grid2">' +
        field('e-phone', 'Phone', 'text', u.profile.phone) +
        field('e-address', 'Address', 'text', u.profile.address) +
      '</div>' +
      avatarField('e', u.profile.photoUrl) +
      '<div class="grid2">' +
        selectField('e-role', 'Role', [['user', 'User'], ['admin', 'Admin']], u.role) +
        selectField('e-active', 'Status', [['true', 'Active'], ['false', 'Disabled']], String(u.active !== false)) +
      '</div>' +
      field('e-password', 'Reset password (leave blank to keep)', 'password') +
      '<div class="section-title">Accounts &amp; balances</div>' +
      '<div id="e-accounts">' + (u.accounts || []).map(acctRowHTML).join('') + '</div>' +
      '<button type="button" class="btn btn-light" id="e-add-acct">+ Add account</button>' +
      zelleSectionHTML(u) +
      '<hr>' +
      '<div class="row-flex" style="gap:10px;"><button class="btn btn-primary" id="e-save">Save changes</button></div>' +

      '<div class="section-title">Transactions</div>' +
      '<div class="txn-row" style="grid-template-columns:1fr 1fr 1fr .8fr .8fr auto;">' +
        '<select id="t-account">' + acctOptions + '</select>' +
        '<input id="t-desc" placeholder="Description">' +
        '<input id="t-counter" placeholder="Counterparty">' +
        '<input id="t-amount" type="number" step="0.01" placeholder="Amount">' +
        '<select id="t-type"><option value="credit">Credit (+)</option><option value="debit">Debit (−)</option></select>' +
        '<button class="btn btn-primary" id="t-add">Add</button>' +
      '</div>' +
      '<div id="txn-list"></div>';

    var accts = el('e-accounts');
    wireAcctRemovers(accts);
    wireAvatar('e');
    el('e-add-acct').addEventListener('click', function () {
      accts.insertAdjacentHTML('beforeend', acctRowHTML());
      wireAcctRemovers(accts);
    });
    var recips = el('e-recipients');
    wireRecipRemovers(recips);
    el('e-add-recip').addEventListener('click', function () {
      recips.insertAdjacentHTML('beforeend', recipRowHTML());
      wireRecipRemovers(recips);
    });
    el('e-save').addEventListener('click', function () { saveUser(u.id); });
    el('e-delete').addEventListener('click', function () { deleteUser(u.id, u.username); });
    el('t-add').addEventListener('click', function () { addTxn(u.id); });
    renderTxns(txns);
  }

  function renderTxns(txns) {
    var box = el('txn-list');
    if (!box) return;
    if (!txns.length) { box.innerHTML = '<div class="muted" style="padding:10px 0;">No transactions.</div>'; return; }
    box.innerHTML = txns.map(function (t) {
      var pos = t.amount >= 0;
      var amt = (pos ? '+' : '−') + '$' + ((Math.abs(t.amount) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
      var date = t.date ? new Date(t.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      return '<div class="txn-item">' +
        '<div style="flex:1;"><div>' + esc(t.description) + '</div><div class="muted">' + esc(date) + (t.counterparty ? ' · ' + esc(t.counterparty) : '') + '</div></div>' +
        '<div class="amt ' + (pos ? 'pos' : 'neg') + '">' + amt + '</div>' +
        '<button class="btn btn-danger t-del" data-id="' + t.id + '">✕</button>' +
      '</div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.t-del'), function (b) {
      b.addEventListener('click', function () { deleteTxn(b.getAttribute('data-id')); });
    });
  }

  async function saveUser(id) {
    var btn = el('e-save'); btn.disabled = true;
    try {
      var body = {
        firstName: el('e-firstName').value.trim(),
        displayName: el('e-firstName').value.trim(),
        email: el('e-email').value.trim(),
        phone: el('e-phone').value.trim(),
        photoUrl: el('e-photoUrl').value.trim(),
        address: el('e-address').value.trim(),
        role: el('e-role').value,
        active: el('e-active').value === 'true',
        accounts: collectAccounts(el('e-accounts')),
        zelle: { contact: el('e-zelle-contact').value.trim(), defaultAccountId: el('e-zelle-default').value },
        zelleRecipients: collectRecipients(el('e-recipients')),
      };
      var pw = el('e-password').value;
      if (pw) body.password = pw;
      await api('/api/admin/user?id=' + encodeURIComponent(id), 'PATCH', body);
      toast('Saved');
      await loadUsers();
      await selectUser(id);
    } catch (e) { toast(e.message, true); btn.disabled = false; }
  }

  async function deleteUser(id, username) {
    if (!confirm('Delete user @' + username + ' and all their transactions? This cannot be undone.')) return;
    try {
      await api('/api/admin/user?id=' + encodeURIComponent(id), 'DELETE');
      toast('User deleted');
      clearEditor();
      await loadUsers();
    } catch (e) { toast(e.message, true); }
  }

  async function addTxn(userId) {
    var btn = el('t-add'); btn.disabled = true;
    try {
      var body = {
        userId: userId,
        accountId: el('t-account').value,
        description: el('t-desc').value.trim(),
        counterparty: el('t-counter').value.trim(),
        amount: el('t-amount').value,
        type: el('t-type').value,
      };
      if (!body.amount) throw new Error('Enter an amount');
      await api('/api/admin/transactions', 'POST', body);
      toast('Transaction added');
      await loadUsers();
      await selectUser(userId);
    } catch (e) { toast(e.message, true); btn.disabled = false; }
  }

  async function deleteTxn(id) {
    try {
      await api('/api/admin/transactions?id=' + encodeURIComponent(id), 'DELETE');
      toast('Transaction removed');
      await loadUsers();
      if (state.selectedId) await selectUser(state.selectedId);
    } catch (e) { toast(e.message, true); }
  }

  function clearEditor() {
    state.selectedId = null;
    renderList();
    el('editor').innerHTML = '<div class="empty">Select a user to edit, or create a new one.</div>';
  }

  /* ---------- pending transfer approvals ---------- */
  function fmtWhen(iso) {
    return iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  }
  function approvalDest(t) {
    var m = t.meta || {};
    if (t.kind === 'internal' || t.kind === 'deposit') return t.toAccount ? ('to ' + t.toAccount.name) : '';
    if (t.kind === 'domestic') return 'to ' + (m.accountname || '') + (m.bankname ? (' · ' + m.bankname) : '');
    if (t.kind === 'wire') return 'to ' + [m.r_fname, m.r_lname].filter(Boolean).join(' ') + (m.r_bankname ? (' · ' + m.r_bankname) : '');
    if (t.kind === 'zelle') return (m.mode === 'request' ? 'from ' : 'to ') + (m.contact || '');
    return '';
  }
  function renderApprovals(list) {
    var box = el('approvals-list'), cnt = el('approvals-count');
    if (cnt) cnt.textContent = list.length ? String(list.length) : '';
    if (!list.length) { box.innerHTML = '<div class="approvals-empty">No pending transfers.</div>'; return; }
    box.innerHTML = list.map(function (t) {
      var dir = t.direction === 'in' ? 'in' : 'out';
      var sign = dir === 'in' ? '+' : '−';
      var src = t.fromAccount ? ('from ' + t.fromAccount.name + ' ') : '';
      return '<div class="appr-item">' +
        '<div class="appr-main">' +
          '<div><span class="appr-kind">' + esc(t.kind) + '</span> ' +
            '<b>' + esc((t.user && t.user.displayName) || '') + '</b> <span class="muted">@' + esc((t.user && t.user.username) || '') + '</span></div>' +
          '<div class="appr-meta">' + esc(src) + esc(approvalDest(t)) + ' · ' + esc(fmtWhen(t.date)) +
            (t.description ? (' · ' + esc(t.description)) : '') + '</div>' +
        '</div>' +
        '<div class="appr-amt ' + dir + '">' + sign + money(t.amount) + '</div>' +
        '<div class="appr-actions">' +
          '<button class="btn btn-primary appr-approve" data-id="' + esc(t.transferId) + '">Approve</button>' +
          '<button class="btn btn-danger appr-reject" data-id="' + esc(t.transferId) + '">Reject</button>' +
        '</div>' +
      '</div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.appr-approve'), function (b) {
      b.addEventListener('click', function () { actOnTransfer(b.getAttribute('data-id'), 'approve', b); });
    });
    Array.prototype.forEach.call(box.querySelectorAll('.appr-reject'), function (b) {
      b.addEventListener('click', function () { actOnTransfer(b.getAttribute('data-id'), 'reject', b); });
    });
  }
  async function loadApprovals() {
    try {
      var data = await api('/api/admin/transfers?status=pending');
      renderApprovals(data.transfers || []);
    } catch (e) { el('approvals-list').innerHTML = '<div class="approvals-empty">Could not load approvals.</div>'; }
  }
  async function actOnTransfer(transferId, action, btn) {
    if (btn) btn.disabled = true;
    try {
      await api('/api/admin/transfers', 'POST', { transferId: transferId, action: action });
      toast(action === 'approve' ? 'Transfer approved' : 'Transfer rejected');
      await loadApprovals();
      await loadUsers();
      if (state.selectedId) await selectUser(state.selectedId);
    } catch (e) { toast(e.message, true); if (btn) btn.disabled = false; }
  }

  /* ---------- small field builders ---------- */
  function field(id, label, type, value) {
    return '<div class="field"><label for="' + id + '">' + esc(label) + '</label>' +
      '<input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(value || '') + '"></div>';
  }
  function selectField(id, label, opts, selected) {
    return '<div class="field"><label for="' + id + '">' + esc(label) + '</label><select id="' + id + '">' +
      opts.map(function (o) {
        return '<option value="' + esc(o[0]) + '"' + (String(selected) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select></div>';
  }

  /* ---------- profile image: upload (downscaled to a data URL) or leave default ---------- */
  // A stored photoUrl equal to the default asset is treated as "no custom image".
  function avatarField(prefix, currentUrl) {
    var custom = currentUrl && currentUrl !== DEFAULT_AVATAR ? currentUrl : '';
    return '<div class="field"><label>Profile image</label>' +
      '<div class="avatar-edit">' +
        '<img id="' + prefix + '-photo-preview" class="avatar-preview" src="' + esc(custom || DEFAULT_AVATAR) + '" alt="">' +
        '<div class="avatar-actions">' +
          '<input type="file" accept="image/*" id="' + prefix + '-photo-file" class="hidden-file">' +
          '<label for="' + prefix + '-photo-file" class="btn btn-light">Upload image</label>' +
          '<button type="button" class="btn btn-light" id="' + prefix + '-photo-clear">Use default</button>' +
        '</div>' +
        '<input type="hidden" id="' + prefix + '-photoUrl" value="' + esc(custom) + '">' +
      '</div>' +
      '<div class="muted avatar-hint" id="' + prefix + '-photo-hint">PNG/JPG, auto-resized to 256px. Leave default to use the coin badge.</div>' +
    '</div>';
  }

  // Read an image file and return a square, center-cropped 256px JPEG data URL.
  function fileToAvatarDataUrl(file, cb) {
    var reader = new FileReader();
    reader.onerror = function () { cb(null); };
    reader.onload = function () {
      var img = new Image();
      img.onerror = function () { cb(null); };
      img.onload = function () {
        var size = 256;
        var canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        var ctx = canvas.getContext('2d');
        var scale = Math.max(size / img.width, size / img.height); // cover
        var w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        try { cb(canvas.toDataURL('image/jpeg', 0.85)); } catch (e) { cb(null); }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function wireAvatar(prefix) {
    var fileInput = el(prefix + '-photo-file');
    var preview = el(prefix + '-photo-preview');
    var hidden = el(prefix + '-photoUrl');
    var clearBtn = el(prefix + '-photo-clear');
    var hint = el(prefix + '-photo-hint');
    if (!fileInput || !hidden) return;
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) { toast('Image too large (max 8MB)', true); fileInput.value = ''; return; }
      if (hint) hint.textContent = 'Processing image…';
      fileToAvatarDataUrl(f, function (dataUrl) {
        if (!dataUrl) { toast('Could not read that image', true); if (hint) hint.textContent = ''; return; }
        hidden.value = dataUrl;
        preview.src = dataUrl;
        if (hint) hint.textContent = 'New image ready — click Save to apply.';
      });
    });
    if (clearBtn) clearBtn.addEventListener('click', function () {
      hidden.value = '';
      preview.src = DEFAULT_AVATAR;
      fileInput.value = '';
      if (hint) hint.textContent = 'Using the default coin badge.';
    });
  }

  /* ---------- boot / guard ---------- */
  (async function () {
    try {
      var me = await api('/api/me');
      if (!me.user || me.user.role !== 'admin') { location.replace('/login'); return; }
      el('admin-name').textContent = me.user.profile.displayName || me.user.username;
    } catch (e) {
      location.replace('/login'); return;
    }
    el('logout-btn').addEventListener('click', function () {
      fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).finally(function () { location.href = '/login'; });
    });
    el('new-user-btn').addEventListener('click', renderNewUser);
    var refresh = el('approvals-refresh');
    if (refresh) refresh.addEventListener('click', loadApprovals);
    loadUsers();
    loadApprovals();
  })();
})();
