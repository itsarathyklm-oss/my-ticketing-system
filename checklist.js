// checklist.js - Resolution Checklist UI for ticket cards (fully additive).
// Mounts a compact box into every ticket card's Internal Work Notes section;
// clicking it opens a popup with a progress bar. It never modifies existing
// page code - it only inserts its own elements and styles.

(function () {
    if (window.__chkActive) return;
    window.__chkActive = true;

    var modal = null;
    var currentTicket = null;

    var css = [
        '.chk-box{display:flex;align-items:center;gap:10px;margin:12px 0 4px;padding:10px 14px;border:1.5px dashed #d9d5d0;border-radius:8px;background:#faf9f7;cursor:pointer;transition:border-color .15s, background .15s;}',
        '.chk-box:hover{border-color:#e53e3e;background:#fff;}',
        '.chk-box.chok{border-style:solid;border-color:#2f9e5f;background:#f0faf4;}',
        '.chk-box .cb-t{font-weight:700;color:#1e2229;font-size:12.5px;letter-spacing:.3px;text-transform:uppercase;}',
        '.chk-box .cb-sub{color:#8a8f98;font-size:11.5px;font-weight:500;text-transform:none;letter-spacing:0;}',
        '.chk-box .cb-pill{margin-left:auto;font-weight:700;font-size:12px;padding:3px 10px;border-radius:50px;background:#fde8e8;color:#c53030;}',
        '.chk-box.chok .cb-pill{background:#d9f4e5;color:#22543d;}',
        '.chk-hb{margin-left:8px;background:#fde8e8;color:#c53030;cursor:help;}',
        '.chk-hb.chok{background:#d9f4e5;color:#22543d;}',
        '.chk-ov{position:fixed;inset:0;background:rgba(15,17,21,.55);z-index:3000;display:flex;align-items:center;justify-content:center;padding:20px;}',
        '.chk-m{background:#fff;border-radius:14px;width:100%;max-width:640px;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 24px 70px rgba(0,0,0,.4);overflow:hidden;}',
        '.chk-h{background:#1e2229;color:#fff;padding:16px 44px 16px 22px;position:relative;}',
        '.chk-h h3{margin:0;font-family:"Barlow Condensed",sans-serif;font-size:17px;letter-spacing:.6px;text-transform:uppercase;}',
        '.chk-h p{margin:4px 0 0;font-size:11.5px;color:#a0aec0;}',
        '.chk-close{position:absolute;top:10px;right:14px;background:none;border:none;color:#a0aec0;font-size:24px;cursor:pointer;line-height:1;}',
        '.chk-close:hover{color:#fff;}',
        '.chk-prog{padding:14px 22px 0;}',
        '.chk-prog-top{display:flex;justify-content:space-between;font-size:11px;font-weight:700;letter-spacing:.5px;color:#8a8f98;text-transform:uppercase;margin-bottom:6px;}',
        '.chk-prog-pct{color:#2f9e5f;}',
        '.chk-bar{height:9px;border-radius:50px;background:#eee9e4;overflow:hidden;}',
        '.chk-bar-in{height:100%;width:0;background:linear-gradient(90deg,#48bb78,#2f9e5f);border-radius:50px;transition:width .3s;}',
        '.chk-list{padding:14px 22px 6px;overflow-y:auto;}',
        '.chk-item{border:1.5px solid #e5e1de;border-radius:10px;padding:11px 14px;margin-bottom:10px;background:#fdfcfb;}',
        '.chk-item.done{border-color:#8ee0b0;background:#f4fcf7;}',
        '.chk-item.na{opacity:.65;background:#f4f3f1;}',
        '.chk-row{display:flex;align-items:flex-start;gap:11px;}',
        '.chk-cb{width:18px;height:18px;margin-top:2px;accent-color:#2f9e5f;cursor:pointer;flex-shrink:0;}',
        '.chk-lab{font-size:13.5px;font-weight:600;color:#1e2229;line-height:1.35;}',
        '.chk-req{color:#e53e3e;margin-left:3px;}',
        '.chk-hint{font-size:11.5px;color:#8a8f98;font-weight:400;margin-top:2px;}',
        '.chk-na{margin-left:auto;flex-shrink:0;background:#fff;border:1.5px solid #dcd8d3;color:#8a8f98;font-size:10.5px;font-weight:700;padding:4px 9px;border-radius:6px;cursor:pointer;letter-spacing:.4px;}',
        '.chk-na:hover{border-color:#1e2229;color:#1e2229;}',
        '.chk-item.na .chk-na{background:#1e2229;color:#fff;border-color:#1e2229;}',
        '.chk-ta{width:100%;margin-top:9px;border:1.5px solid #e5e1de;border-radius:7px;padding:8px 11px;font-size:13px;font-family:"Inter",sans-serif;background:#fff;resize:vertical;min-height:38px;box-sizing:border-box;display:block;}',
        '.chk-ta:focus{outline:none;border-color:#e53e3e;box-shadow:0 0 0 3px rgba(229,62,62,.12);background:#fff;}',
        '.chk-err{display:none;color:#c53030;font-size:11.5px;font-weight:600;margin-top:5px;}',
        '.chk-item.bad .chk-err{display:block;}',
        '.chk-item.bad .chk-ta{border-color:#e53e3e;}',
        '.chk-na-note{display:none;font-size:12px;color:#8a8f98;font-style:italic;margin-top:7px;}',
        '.chk-item.na .chk-na-note{display:block;}',
        '.chk-item.na .chk-ta{display:none;}',
        '.chk-f{padding:12px 22px 16px;border-top:1px solid #f0ece7;display:flex;align-items:center;gap:10px;}',
        '.chk-f-note{font-size:11.5px;color:#8a8f98;flex:1;}',
        '.chk-f-btn{background:#1e2229;color:#fff;border:none;border-radius:8px;padding:9px 18px;font-family:"Barlow Condensed",sans-serif;font-weight:700;font-size:13px;letter-spacing:.6px;cursor:pointer;}',
        '.chk-f-btn:hover{background:#2d323e;}',
        '.chk-saving{font-size:11px;color:#8a8f98;min-width:60px;text-align:right;}'
    ].join('\n');
    var style = document.createElement('style');
    style.id = 'chk-style';
    style.textContent = css;
    document.head.appendChild(style);

    function toast(msg, isErr) {
        if (typeof showAdminToast === 'function') showAdminToast(msg, isErr);
        else alert(msg);
    }
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
    function api(url, body) {
        var opts = { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' } };
        if (body) opts.body = JSON.stringify(body);
        return fetch(url, opts).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, data: j }; });
        });
    }
    function markSaving(ov, txt) {
        var el = ov.querySelector('.chk-saving');
        if (el) el.textContent = txt;
    }

    // ---------- compact box inside Internal Work Notes ----------
    function mountBox(sec, ticketId) {
        var box = document.createElement('div');
        box.className = 'chk-box';
        box.dataset.ticket = ticketId;
        box.innerHTML = '<span class="cb-t">Resolution Checklist<span class="cb-sub"> - click to open</span></span><span class="cb-pill">...</span>';
        var form = sec.querySelector('.comment-form');
        if (form) sec.insertBefore(box, form); else sec.appendChild(box);
        box.addEventListener('click', function () { openModal(ticketId); });
    }

    function paintBox(box, ok, d) {
        if (!box.parentNode) return;
        if (!ok) { box.querySelector('.cb-pill').textContent = '-'; return; }
        var pill = box.querySelector('.cb-pill');
        pill.textContent = d.done + '/' + d.total;
        box.classList.toggle('chok', !!d.complete);
        box.querySelector('.cb-sub').textContent = d.complete ? ' - all items completed' : ' - click to open';
    }
    function paintHeader(hb, ok, d) {
        if (!hb.parentNode) return;
        if (!ok) { hb.textContent = '-'; hb.setAttribute('title', 'Checklist unavailable'); return; }
        hb.textContent = (d.complete ? '\u2713 ' : '') + d.done + '/' + d.total;
        hb.classList.toggle('chok', !!d.complete);
        hb.setAttribute('title', 'Resolution checklist: ' + d.done + ' of ' + d.total + ' completed' + (d.complete ? ' - ready to resolve' : ''));
    }
    function refreshTicket(ticketId) {
        api('/tickets/' + ticketId + '/checklist').then(function (res) {
            var ok = res.ok, d = res.data;
            document.querySelectorAll('.chk-box[data-ticket="' + ticketId + '"]').forEach(function (b) { paintBox(b, ok, d); });
            document.querySelectorAll('.chk-hb[data-ticket="' + ticketId + '"]').forEach(function (h) { paintHeader(h, ok, d); });
        });
    }
    function mountHeader(header, ticketId) {
        var first = header.querySelector('.badge');
        if (!first || !first.parentNode) return false;
        var hb = document.createElement('span');
        hb.className = 'badge chk-hb';
        hb.setAttribute('data-ticket', ticketId);
        hb.textContent = '...';
        hb.setAttribute('title', 'Resolution checklist progress');
        first.parentNode.appendChild(hb);
        return true;
    }

    // ---------- modal ----------
    function openModal(ticketId) {
        closeModal();
        currentTicket = ticketId;
        var ov = document.createElement('div');
        ov.className = 'chk-ov';
        ov.innerHTML =
            '<div class="chk-m" style="position:relative;">' +
            '<div class="chk-h"><h3>Resolution Checklist</h3><p class="chk-sub-txt">Loading...</p><button class="chk-close" title="Close">&times;</button></div>' +
            '<div class="chk-prog"><div class="chk-prog-top"><span>Progress</span><span class="chk-prog-pct">0%</span></div><div class="chk-bar"><div class="chk-bar-in"></div></div></div>' +
            '<div class="chk-list"></div>' +
            '<div class="chk-f"><span class="chk-f-note"></span><span class="chk-saving"></span><button class="chk-f-btn">Close</button></div>' +
            '</div>';
        document.body.appendChild(ov);
        modal = ov;
        ov.querySelector('.chk-close').addEventListener('click', closeModal);
        ov.querySelector('.chk-f-btn').addEventListener('click', closeModal);
        ov.addEventListener('mousedown', function (e) { if (e.target === ov) closeModal(); });
        document.addEventListener('keydown', escClose);

        api('/tickets/' + ticketId + '/checklist').then(function (res) {
            if (modal !== ov) return;
            if (!res.ok) { toast(res.data.error || 'Could not load checklist.', true); closeModal(); return; }
            renderModal(ov, ticketId, res.data);
        });
    }
    function escClose(e) { if (e.key === 'Escape') closeModal(); }
    function closeModal() {
        document.removeEventListener('keydown', escClose);
        if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
        modal = null;
        currentTicket = null;
    }

    function renderModal(ov, ticketId, data) {
        ov._chkData = data;
        var locked = !data.canEdit || data.status === 'Resolved';
        ov.querySelector('.chk-sub-txt').textContent = data.status === 'Resolved'
            ? 'This ticket is already resolved - checklist is view only.'
            : (data.isAdmin
                ? 'Admins may resolve without completing this checklist.'
                : 'All items must be completed before this ticket can be resolved.');

        var list = ov.querySelector('.chk-list');
        list.innerHTML = '';
        data.items.forEach(function (it) {
            var s = data.saved[it.key] || { state: 'pending', answer: '' };
            var item = document.createElement('div');
            item.className = 'chk-item' + (s.state === 'done' ? ' done' : (s.state === 'na' ? ' na' : ''));
            item.dataset.key = it.key;
            var html =
                '<div class="chk-row">' +
                '<input type="checkbox" class="chk-cb"' + (s.state === 'done' ? ' checked' : '') + '>' +
                '<div class="chk-lab">' + esc(it.label) + (it.needsAnswer ? '<span class="chk-req">*</span>' : '') +
                (it.hint ? '<div class="chk-hint">' + esc(it.hint) + '</div>' : '') + '</div>' +
                '<button type="button" class="chk-na">N/A</button>' +
                '</div>';
            if (it.needsAnswer) {
                html += '<textarea class="chk-ta" placeholder="Type the required description...">' + esc(s.answer || '') + '</textarea>';
                html += '<div class="chk-err">A description is required for this item (or mark it N/A).</div>';
            }
            html += '<div class="chk-na-note">Skipped - marked not applicable.</div>';
            item.innerHTML = html;
            list.appendChild(item);
            if (locked) {
                var c = item.querySelector('.chk-cb'); if (c) c.disabled = true;
                var n = item.querySelector('.chk-na'); if (n) n.disabled = true;
                var t = item.querySelector('.chk-ta'); if (t) t.disabled = true;
            } else {
                wireItem(ov, ticketId, item, it);
            }
        });
        updateProgress(ov, data.done, data.total);
    }

    function wireItem(ov, ticketId, item, it) {
        var cb = item.querySelector('.chk-cb');
        var na = item.querySelector('.chk-na');
        var ta = item.querySelector('.chk-ta');
        var timer = null;

        cb.addEventListener('change', function () {
            if (cb.checked) {
                var ans = ta ? ta.value : '';
                if (it.needsAnswer && !ans.trim()) {
                    item.classList.add('bad');
                    if (ta) ta.focus();
                    markSaving(ov, 'description needed');
                    return;
                }
                send(ov, ticketId, it.key, 'done', ans);
            } else {
                item.classList.remove('bad');
                send(ov, ticketId, it.key, 'pending', ta ? ta.value : '');
            }
        });

        na.addEventListener('click', function () {
            var toNa = !item.classList.contains('na');
            item.classList.toggle('na', toNa);
            if (toNa) { cb.checked = false; item.classList.remove('bad'); send(ov, ticketId, it.key, 'na', ''); }
            else { send(ov, ticketId, it.key, 'pending', ''); }
        });

        if (ta) {
            ta.addEventListener('input', function () {
                item.classList.remove('bad');
                if (cb.checked && !item.classList.contains('na')) {
                    clearTimeout(timer);
                    markSaving(ov, 'saving...');
                    timer = setTimeout(function () {
                        var ans = ta.value.trim();
                        if (!ans) { item.classList.add('bad'); return; }
                        send(ov, ticketId, it.key, 'done', ans);
                    }, 700);
                }
            });
        }
    }

    function send(ov, ticketId, key, state, answer) {
        markSaving(ov, 'saving...');
        api('/tickets/' + ticketId + '/checklist', { key: key, state: state, answer: answer }).then(function (res) {
            var el = ov.querySelector('.chk-item[data-key="' + key + '"]');
            if (!res.ok) {
                toast(res.data.error || 'Could not save checklist item.', true);
                if (el) {
                    el.classList.remove('done');
                    var c = el.querySelector('.chk-cb'); if (c) c.checked = false;
                    if (res.data && res.data.error && String(res.data.error).indexOf('description') !== -1) el.classList.add('bad');
                }
                markSaving(ov, 'error');
                return;
            }
            if (el) {
                el.classList.toggle('done', state === 'done');
                if (state === 'done') el.classList.remove('bad');
            }
            updateProgress(ov, res.data.done, res.data.total);
            markSaving(ov, res.data.complete ? 'all done' : 'saved');
            refreshTicket(ticketId);
        });
    }

    function updateProgress(ov, done, total) {
        var pct = total ? Math.round((done / total) * 100) : 0;
        ov.querySelector('.chk-prog-pct').textContent = pct + '%';
        ov.querySelector('.chk-bar-in').setAttribute('style', 'width:' + pct + '%');
        var note = ov.querySelector('.chk-f-note');
        if (total && done >= total) {
            note.textContent = 'Checklist complete - this ticket can be resolved now.';
            note.setAttribute('style', 'color:#2f9e5f');
        } else {
            note.textContent = done + ' of ' + total + ' items completed.';
            note.setAttribute('style', 'color:#8a8f98');
        }
    }

    // auto-mount the box into every ticket card
    function scan() {
        var fresh = {};
        var secs = document.querySelectorAll('.comments-section');
        for (var i = 0; i < secs.length; i++) {
            var sec = secs[i];
            if (sec.getAttribute('data-chk-mounted')) continue;
            var inp = sec.querySelector('input[id^="input-"]');
            if (!inp) continue;
            var id = inp.id.slice(6);
            if (!id) continue;
            sec.setAttribute('data-chk-mounted', '1');
            mountBox(sec, id);
            fresh[id] = 1;
        }
        var heads = document.querySelectorAll('.ticket-header');
        for (var j = 0; j < heads.length; j++) {
            var hd = heads[j];
            if (hd.getAttribute('data-chk-hb-mounted')) continue;
            var card = hd.closest ? hd.closest('.ticket-card') : hd.parentNode;
            if (!card) continue;
            var hinp = card.querySelector('input[id^="input-"]');
            if (!hinp) continue;
            var hid = hinp.id.slice(6);
            if (!hid) continue;
            if (!mountHeader(hd, hid)) continue;
            hd.setAttribute('data-chk-hb-mounted', '1');
            fresh[hid] = 1;
        }
        Object.keys(fresh).forEach(function (k) { refreshTicket(k); });
    }
    scan();
    var scanQueued = false;
    var obs = new MutationObserver(function () {
        if (scanQueued) return;
        scanQueued = true;
        requestAnimationFrame(function () { scanQueued = false; scan(); });
    });
    obs.observe(document.body, { childList: true, subtree: true });
})();
