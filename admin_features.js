// Escapes user-supplied text for safe innerHTML rendering.
function escHtml(v) {
    if (v === null || v === undefined) return "";
    return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// admin_features.js - External features for admin panel

// Service worker registration
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
}

// ============ VIEW NEW TICKET HTML ============
(function() {
    const container = document.getElementById('viewNewTicket');
    if (!container) return;
    container.innerHTML = '<div style="width:100%;margin:0;min-height:calc(100vh - 110px);display:flex;flex-direction:column;"><div style="background:#1e2229;border-radius:14px 14px 0 0;padding:12px 24px;display:flex;align-items:center;gap:12px;"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#e53e3e" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg><span style="font-family:Barlow Condensed,sans-serif;font-weight:700;font-size:16px;letter-spacing:1px;color:#fff;text-transform:uppercase;">CREATE NEW TICKET</span></div><div style="background:#fdfcfb;border-radius:0 0 14px 14px;padding:14px 24px;display:flex;flex-direction:column;flex:1 1 auto;min-height:0;box-shadow:0 4px 20px rgba(0,0,0,0.08);"><div style="font-family:Barlow Condensed,sans-serif;font-weight:600;font-size:17px;color:#1e2229;margin-bottom:2px;">Submit a New Ticket</div><div style="font-size:11px;color:#8a8f98;margin-bottom:6px;">Fill in the details below to create a ticket.</div><div style="height:0;border-top:2px dashed #e2ded9;margin:8px -24px;"></div><div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;grid-template-rows:auto auto auto 1fr auto auto;gap:9px;margin-top:8px;flex:1 1 auto;min-height:0;"><div><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Your Name</label><input type="text" id="newTktName" placeholder="Full Name" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;"></div><div><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Designation</label><input type="text" id="newTktDesignation" placeholder="Designation" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;"></div><div><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Mobile Number</label><input type="tel" id="newTktMobile" placeholder="10-digit mobile" maxlength="10" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;"></div><div><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Assign Staff</label><select id="newTktStaff" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;"><option value="" disabled selected>Loading staff...</option></select></div><div style="grid-column:1/-1;"><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Issue Title</label><input type="text" id="newTktTitle" placeholder="Issue title" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;"></div><div><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Region</label><select id="newTktRegion" onchange="updateNewTktBranchOptions()" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;"><option value="" disabled selected>Loading...</option></select></div><div><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Branch Location</label><select id="newTktBranch" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;"><option value="" disabled selected>Select region first</option></select></div><div><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Priority Level</label><select id="newTktPriority" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;"><option value="Low">Low</option><option value="Medium" selected>Medium</option><option value="High">High</option></select></div><div><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Category</label><select id="newTktCategory" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;"><option value="" disabled selected>Select Category</option><option value="Hardware">Hardware</option><option value="Software">Software</option><option value="Network">Network</option><option value="Printer">Printer</option><option value="Other">Other</option></select></div><div style="grid-column:1/-1;display:flex;flex-direction:column;min-height:0;"><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Description</label><textarea id="newTktDescription" rows="2" placeholder="Describe the issue" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;resize:none;flex:1 1 auto;min-height:56px;"></textarea></div><div style="grid-column:1/-1;"><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Upload Screenshot (Optional)</label><input type="file" id="newTktScreenshot" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;"></div><button onclick="submitNewTicket()" style="grid-column:1/-1;margin-top:10px;padding:9px;width:100%;background:linear-gradient(120deg,#e53e3e,#c53030);color:#fff;border:none;border-radius:8px;cursor:pointer;font-family:Barlow Condensed,sans-serif;font-weight:700;font-size:14px;letter-spacing:1px;text-transform:uppercase;box-shadow:0 8px 20px rgba(197,48,48,0.4);">SUBMIT TICKET</button></div></div></div>';
})();

// ============ NEW TICKET FORM FUNCTIONS ============
let newTktBranchesCache = [];

async function loadNewTicketForm() {
    try {
        const staffRes = await fetch('/tickets/staff-list', { cache: 'no-store' });
        const staffList = await staffRes.json();
        const staffSelect = document.getElementById('newTktStaff');
        if (staffSelect) {
            staffSelect.innerHTML = '<option value="" selected>None (auto-assign via round-robin)</option>';
            staffList.forEach(s => { staffSelect.innerHTML += '<option value="' + escHtml(s.name) + '">' + escHtml(s.name) + '</option>'; });
        }
        const branchRes = await fetch('/public-branches');
        newTktBranchesCache = await branchRes.json();
        const regionSelect = document.getElementById('newTktRegion');
        if (regionSelect && newTktBranchesCache.length > 0) {
            const regions = [...new Set(newTktBranchesCache.map(b => b.region || 'Unassigned'))].sort();
            regionSelect.innerHTML = '<option value="" disabled selected>Choose region</option>';
            regions.forEach(r => { regionSelect.innerHTML += '<option value="' + escHtml(r) + '">' + escHtml(r) + '</option>'; });
        }
    } catch(e) { console.error('Error loading new ticket form:', e); }
}

function updateNewTktBranchOptions() {
    const region = document.getElementById('newTktRegion').value;
    const branchSelect = document.getElementById('newTktBranch');
    const filtered = newTktBranchesCache.filter(b => (b.region || 'Unassigned') === region);
    if (filtered.length === 0) {
        branchSelect.innerHTML = '<option value="" disabled selected>No branches in this region</option>';
        return;
    }
    branchSelect.innerHTML = '<option value="" disabled selected>Choose branch</option>';
    filtered.forEach(b => { branchSelect.innerHTML += '<option value="' + escHtml(b.name) + '">' + escHtml(b.name) + '</option>'; });
}

async function submitNewTicket() {
    const nameEl = document.getElementById('newTktName');
    const titleEl = document.getElementById('newTktTitle');
    const mobileEl = document.getElementById('newTktMobile');
    const branchEl = document.getElementById('newTktBranch');
    if (!nameEl.value.trim() || !titleEl.value.trim() || !mobileEl.value.trim() || !branchEl.value) {
        showAdminToast('Please fill in all required fields.', true);
        return;
    }
    const formData = new FormData();
    formData.append('title', titleEl.value);
    formData.append('submittedBy', nameEl.value);
    formData.append('designation', document.getElementById('newTktDesignation').value);
    formData.append('branch', branchEl.value);
    formData.append('mobile', mobileEl.value);
    formData.append('priority', document.getElementById('newTktPriority').value);
    formData.append('category', document.getElementById('newTktCategory').value);
    formData.append('description', document.getElementById('newTktDescription').value);
    formData.append('assignedTo', document.getElementById('newTktStaff').value);
    const fileInput = document.getElementById('newTktScreenshot');
    if (fileInput && fileInput.files[0]) { formData.append('screenshot', fileInput.files[0]); }
    try {
        const response = await fetch('/tickets', { method: 'POST', body: formData });
        if (response.ok) {
            const result = await response.json();
            showAdminToast('Ticket #' + (result.displayNumber || String(result.ticketNumber).padStart(4, '0')) + ' submitted!');
            nameEl.value = '';
            document.getElementById('newTktDesignation').value = '';
            mobileEl.value = '';
            titleEl.value = '';
            document.getElementById('newTktDescription').value = '';
            loadNewTicketForm();
        } else {
            const err = await response.json();
            showAdminToast(err.error || 'Failed to submit ticket.', true);
        }
    } catch(e) { showAdminToast('Error submitting ticket.', true); }
}

// ============ INBOX DELETE ============
async function deleteInboxMessage(id) {
    showConfirmModal('Delete this inbox message? This cannot be undone.', async function() {
        try {
            const res = await fetch('/inbox/' + id, { method: 'DELETE' });
            if (res.ok) { showAdminToast('Message deleted successfully.'); loadInbox(); }
            else { showAdminToast('Failed to delete message.', true); }
        } catch(e) { showAdminToast('Error deleting message.', true); }
    }, 'Delete');
}

// ============ INBOX: admins message staff ============
function inboxBadge(m) {
    if (m.isReceived) return ''; /* a message from an admin carries no ticket-style status */
    if (m.broadcastHeader) return '<span class="badge status-resolved">Sent</span>';
    if (m.status === 'Replied') return '<span class="badge status-resolved">Replied</span>';
    return '<span class="badge status-open">Open</span>';
}

function inboxMetaLine(m, isAdmin, isReceived) {
    var when = new Date(m.createdAt).toLocaleString();
    if (m.broadcastHeader) {
        var names = (m.replierNames || []).join(', ');
        /* With replies, the names open the whole thread right here on the Sent card. */
        var replyBit = names
            ? 'Replied: <span style="cursor:pointer;text-decoration:underline;" title="Show who replied and what they said" onclick="toggleBroadcastReplies(\'' + m._id + '\', this)">' + escHtml(names) + '</span>'
            : 'No replies yet';
        var progress = 'Read by ' + (m.readCount || 0) + ' of ' + (m.recipientCount || 0) + ' \u00b7 ' + replyBit;
        return '<div class="inbox-meta">To: <strong>' + escHtml(m.audience || 'All staff') + '</strong> \u2014 ' + (m.recipientCount || 0) + ' staff \u2014 ' + when + '</div>' +
            '<div class="inbox-meta" style="margin-top:4px;" data-broadcast-id="' + m._id + '">' + progress + '</div>';
    }
    if (isAdmin) {
        return '<div class="inbox-meta">From: <strong>' + escHtml(m.sender) + '</strong>' + (m.senderStaffId ? ' (' + escHtml(m.senderStaffId) + ')' : '') + ' \u2014 ' + when + '</div>';
    }
    return '<div class="inbox-meta">' + (isReceived ? 'From: <strong>' + escHtml(m.sender) + '</strong> \u2014 ' : '') + when + '</div>';
}

function inboxMarkReadBtn(m, isAdmin) {
    var unread = isAdmin ? !m.adminRead : !m.staffRead;
    if (!unread || m.broadcastHeader) return '';
    return '<button class="branch-delete-btn" onclick="markInboxRead(\'' + m._id + '\')">Mark as read</button>';
}

function inboxDeleteBtn(m, isReceived) {
    if (isReceived) return ''; /* a message the admin sent this person is theirs to keep */
    var fn = m.broadcastHeader ? 'deleteInboxBroadcast' : 'deleteInboxMessage';
    return '<button class="branch-delete-btn" style="color:#e53e3e;border-color:#e5e1de;margin-left:6px" onclick="' + fn + '(\'' + m._id + '\')">Delete</button>';
}

function inboxReplySection(m, isAdmin, isReceived) {
    if (m.status === 'Replied') {
        return '<div class="inbox-reply-shown"><strong>Reply from ' + escHtml(m.repliedBy) + ':</strong> ' + escHtml(m.reply) + '<div class="inbox-meta">' + new Date(m.repliedAt).toLocaleString() + '</div></div>';
    }
    if (isAdmin && !m.broadcastHeader) {
        return '<div class="inbox-reply-box"><textarea id="inboxReplyInput-' + m._id + '" rows="2" placeholder="Write a reply..."></textarea><button class="branch-add-btn" style="margin-top:8px;" onclick="replyInboxMessage(\'' + m._id + '\')">Send Reply</button></div>';
    }
    if (isReceived) {
        /* The reply (and the admin's answer to it) lives in this message's thread instead of
           a separate "Re:" card. */
        var threadHtml = '';
        (m.thread || []).forEach(function (entry) {
            threadHtml += '<div class="inbox-reply-shown" style="background:#f7fafc;color:#2d3748;border-left:3px solid #cbd5e0;">' +
                '<strong>Your reply:</strong> ' + escHtml(entry.body) +
                '<div class="inbox-meta">' + new Date(entry.createdAt).toLocaleString() + '</div>' +
                (entry.reply
                    ? '<div style="margin-top:8px;padding-top:8px;border-top:1px solid #e2e8f0;"><strong>Reply from ' + escHtml(entry.repliedBy) + ':</strong> ' + escHtml(entry.reply) +
                      '<div class="inbox-meta">' + new Date(entry.repliedAt).toLocaleString() + '</div></div>'
                    : '') +
                '</div>';
        });
        return threadHtml +
            '<div class="inbox-reply-box"><textarea id="inboxReplyInput-' + m._id + '" rows="2" placeholder="Write a reply to ' + escHtml(m.sender) + '..."></textarea><button class="branch-add-btn" style="margin-top:8px;" onclick="replyToAdminMessage(\'' + m._id + '\')">Send Reply</button></div>';
    }
    return '';
}

async function replyToAdminMessage(id) {
    var box = document.getElementById('inboxReplyInput-' + id);
    var text = box ? box.value.trim() : '';
    if (!text) { showAdminToast('Please write a reply first.', true); return; }
    var original = (window.inboxMessagesById || {})[id] || {};
    try {
        var res = await fetch('/inbox', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subject: 'Re: ' + (original.subject || 'Your message'), body: text, replyTo: id })
        });
        if (res.ok) {
            await fetch('/inbox/' + id + '/read', { method: 'POST' });
            showAdminToast('Reply sent to Admin.');
            loadInbox();
        } else {
            var err = await res.json();
            showAdminToast(err.error || 'Could not send reply.', true);
        }
    } catch (e) { showAdminToast('Something went wrong. Please try again.', true); }
}

// The regions this admin may address (Super Admin: every region).
async function loadBroadcastAudience() {
    var sel = document.getElementById('broadcastAudience');
    if (!sel || sel.dataset.loaded) return;
    try {
        var res = await fetch('/tickets/regions');
        if (!res.ok) return;
        var regions = await res.json();
        regions.forEach(function (r) {
            var opt = document.createElement('option');
            opt.value = 'region:' + r.name;
            opt.textContent = r.name;
            sel.appendChild(opt);
        });
        sel.dataset.loaded = '1';
    } catch (e) { /* keep the all-staff option */ }
}

async function sendStaffBroadcast() {
    var subjectEl = document.getElementById('broadcastSubject');
    var bodyEl = document.getElementById('broadcastBody');
    var audienceEl = document.getElementById('broadcastAudience');
    if (!subjectEl || !bodyEl) return;
    var subject = subjectEl.value.trim();
    var body = bodyEl.value.trim();
    var audience = audienceEl ? audienceEl.value : 'all';
    if (!subject || !body) { showAdminToast('Please fill in both subject and message.', true); return; }
    var btn = document.getElementById('sendBroadcastBtn');
    var defaultHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="admin-spinner"></span>Sending...';
    try {
        var res = await fetch('/inbox/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subject: subject, body: body, audience: audience })
        });
        if (res.ok) {
            var data = await res.json();
            subjectEl.value = '';
            bodyEl.value = '';
            if (audienceEl) audienceEl.value = 'all';
            showAdminToast('Message sent to ' + data.recipients + ' staff member' + (data.recipients === 1 ? '' : 's') + '.');
            loadInbox();
        } else {
            var err = await res.json();
            showAdminToast(err.error || 'Could not send message.', true);
        }
    } catch (e) { showAdminToast('Something went wrong. Please try again.', true); }
    finally { btn.disabled = false; btn.innerHTML = defaultHTML; }
}

async function deleteInboxBroadcast(id) {
    showConfirmModal('Delete this message? It is removed from every staff inbox that received it, and this cannot be undone.', async function () {
        try {
            var res = await fetch('/inbox/' + id, { method: 'DELETE' });
            if (res.ok) { showAdminToast('Message deleted for all recipients.'); loadInbox(); }
            else { showAdminToast('Failed to delete message.', true); }
        } catch (e) { showAdminToast('Error deleting message.', true); }
    }, 'Delete');
}

// Open the replies to one send inline on its Sent card, so the admin does not have to hunt
// down each "Re:" message. Clicking the names again closes it.
async function toggleBroadcastReplies(id, trigger) {
    var existing = document.getElementById('inboxReplies-' + id);
    if (existing) { existing.remove(); return; }
    var card = trigger && trigger.closest ? trigger.closest('.inbox-card') : null;
    var anchor = trigger && trigger.closest ? trigger.closest('.inbox-meta') : null;
    if (!card) return;
    var box = document.createElement('div');
    box.id = 'inboxReplies-' + id;
    box.style.cssText = 'margin-top:10px;padding:10px 12px;background:#f7fafc;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;color:#2d3748;';
    box.textContent = 'Loading replies...';
    if (anchor) anchor.insertAdjacentElement('afterend', box); else card.appendChild(box);
    try {
        var res = await fetch('/inbox/' + id + '/replies');
        if (!res.ok) { box.textContent = 'Could not load replies.'; return; }
        var replies = await res.json();
        if (!replies.length) { box.textContent = 'No replies yet.'; return; }
        var html = '';
        replies.forEach(function (r, i) {
            html += '<div style="padding:8px 0;' + (i ? 'border-top:1px solid #e2e8f0;' : '') + '">' +
                '<div style="font-weight:600;">' + escHtml(r.name) + (r.staffId ? ' <span style="font-weight:400;color:#a0aec0;">(' + escHtml(r.staffId) + ')</span>' : '') +
                ' <span style="font-weight:400;color:#a0aec0;">' + new Date(r.createdAt).toLocaleString() + '</span></div>' +
                '<div style="margin-top:4px;white-space:pre-wrap;">' + escHtml(r.body) + '</div>' +
                (r.reply
                    ? '<div style="margin-top:6px;padding:8px 10px;background:#f0fff4;border-radius:6px;"><strong>Your reply:</strong> ' + escHtml(r.reply) + '</div>'
                    : '<div style="margin-top:6px;"><textarea id="threadReplyInput-' + r._id + '" rows="2" style="width:100%;padding:8px 10px;border:1px solid #cbd5e0;border-radius:6px;font-size:13px;resize:vertical;" placeholder="Reply to ' + escHtml(r.name) + '..."></textarea>' +
                      '<button class="branch-add-btn" id="threadReplyBtn-' + r._id + '" style="margin-top:6px;" onclick="replyFromBroadcastThread(\'' + r._id + '\', \'' + id + '\')">Send Reply</button></div>') +
                '</div>';
        });
        box.innerHTML = html;
    } catch (e) { box.textContent = 'Could not load replies.'; }
}

// Answer a staff reply straight from the thread panel on the Sent card. It posts to the same
// reply route the "Re:" message uses, then reopens the panel so the answer is visible there.
async function replyFromBroadcastThread(replyId, broadcastId) {
    var box = document.getElementById('threadReplyInput-' + replyId);
    var text = box ? box.value.trim() : '';
    if (!text) { showAdminToast('Please write a reply first.', true); return; }
    var btn = document.getElementById('threadReplyBtn-' + replyId);
    var defaultHTML = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="admin-spinner"></span>Sending...'; }
    try {
        var res = await fetch('/inbox/' + replyId + '/reply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reply: text })
        });
        if (res.ok) {
            showAdminToast('Reply sent.');
            await loadInbox();
            var anchor = document.querySelector('#inboxList [data-broadcast-id="' + broadcastId + '"]');
            if (anchor) toggleBroadcastReplies(broadcastId, anchor);
        } else {
            var err = await res.json();
            showAdminToast(err.error || 'Could not send reply.', true);
        }
    } catch (e) {
        showAdminToast('Something went wrong. Please try again.', true);
    } finally {
        if (btn && document.body.contains(btn)) { btn.disabled = false; btn.innerHTML = defaultHTML; }
    }
}

// Load the resolution checklist UI (fully additive)
(function(){var s=document.createElement("script");s.src="/checklist.js";document.head.appendChild(s);})();
