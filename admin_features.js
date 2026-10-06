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
    container.innerHTML = '<div style="max-width:820px;margin:-20px auto -20px;min-height:calc(100vh - 90px);display:flex;flex-direction:column;"><div style="background:#1e2229;border-radius:14px 14px 0 0;padding:12px 24px;display:flex;align-items:center;gap:12px;"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#e53e3e" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg><span style="font-family:Barlow Condensed,sans-serif;font-weight:700;font-size:16px;letter-spacing:1px;color:#fff;text-transform:uppercase;">CREATE NEW TICKET</span></div><div style="background:#fdfcfb;border-radius:0 0 14px 14px;padding:14px 24px;display:flex;flex-direction:column;flex:1 1 auto;min-height:0;box-shadow:0 4px 20px rgba(0,0,0,0.08);"><div style="font-family:Barlow Condensed,sans-serif;font-weight:600;font-size:17px;color:#1e2229;margin-bottom:2px;">Submit a New Ticket</div><div style="font-size:11px;color:#8a8f98;margin-bottom:6px;">Fill in the details below to create a ticket.</div><div style="height:0;border-top:2px dashed #e2ded9;margin:8px -24px;"></div><div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;grid-template-rows:auto auto auto 1fr auto auto;gap:9px;margin-top:8px;flex:1 1 auto;min-height:0;"><div><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Your Name</label><input type="text" id="newTktName" placeholder="Full Name" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;"></div><div><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Designation</label><input type="text" id="newTktDesignation" placeholder="Designation" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;"></div><div><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Mobile Number</label><input type="tel" id="newTktMobile" placeholder="10-digit mobile" maxlength="10" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;"></div><div><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Assign Staff</label><select id="newTktStaff" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;"><option value="" disabled selected>Loading staff...</option></select></div><div style="grid-column:1/-1;"><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Issue Title</label><input type="text" id="newTktTitle" placeholder="Issue title" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;"></div><div><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Region</label><select id="newTktRegion" onchange="updateNewTktBranchOptions()" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;"><option value="" disabled selected>Loading...</option></select></div><div><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Branch Location</label><select id="newTktBranch" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;"><option value="" disabled selected>Select region first</option></select></div><div><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Priority Level</label><select id="newTktPriority" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;"><option value="Low">Low</option><option value="Medium" selected>Medium</option><option value="High">High</option></select></div><div><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Category</label><select id="newTktCategory" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;"><option value="" disabled selected>Select Category</option><option value="Hardware">Hardware</option><option value="Software">Software</option><option value="Network">Network</option><option value="Printer">Printer</option><option value="Other">Other</option></select></div><div style="grid-column:1/-1;display:flex;flex-direction:column;min-height:0;"><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Description</label><textarea id="newTktDescription" rows="2" placeholder="Describe the issue" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;resize:none;flex:1 1 auto;min-height:56px;"></textarea></div><div style="grid-column:1/-1;"><label style="display:block;margin-bottom:2px;font-weight:600;font-size:10.5px;color:#6b7280;text-transform:uppercase;">Upload Screenshot (Optional)</label><input type="file" id="newTktScreenshot" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" style="width:100%;padding:6px 11px;border:1.5px solid #e5e1de;border-radius:7px;font-size:13px;background:#faf9f7;"></div><button onclick="submitNewTicket()" style="grid-column:1/-1;margin-top:10px;padding:9px;width:100%;background:linear-gradient(120deg,#e53e3e,#c53030);color:#fff;border:none;border-radius:8px;cursor:pointer;font-family:Barlow Condensed,sans-serif;font-weight:700;font-size:14px;letter-spacing:1px;text-transform:uppercase;box-shadow:0 8px 20px rgba(197,48,48,0.4);">SUBMIT TICKET</button></div></div></div>';
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

// Load the resolution checklist UI (fully additive)
(function(){var s=document.createElement("script");s.src="/checklist.js";document.head.appendChild(s);})();
