require('dotenv').config();
const express = require('express');
const path = require('path');
const dns = require('dns');
// Render's outbound network doesn't reliably support IPv6 — without this, Node tries
// Gmail's IPv6 address first and the connection dies with ENETUNREACH before it ever
// reaches Google. Forcing IPv4 first fixes that.
dns.setDefaultResultOrder('ipv4first');
const session = require('express-session');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const { Op } = require('sequelize');
const {
    sequelize, Region, Branch, Staff, StaffBranchAssignment, RegionAdmin,
    Ticket, TicketComment, AuditLog, Notification, InboxMessage
} = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// 1. CONNECT TO MYSQL
sequelize.authenticate()
    .then(() => sequelize.sync()) // creates any tables that don't exist yet — safe to run every startup
    .then(() => {
        console.log('Connected to MySQL and schema is in sync');
        seedInitialStaff();
    })
    .catch(err => console.error('Database connection error:', err));

// --- ID-aliasing helpers ---
// The client-side JS (unchanged from the MongoDB version) expects MongoDB-style field
// names: `_id` on most records, and `ticketNumber` as the ticket's own field (originally
// handed out by a separate Counter model, since Mongo has no native auto-increment).
// In MySQL, ticketNumber is now just the row's own auto-increment `id` — these helpers
// keep every API response shaped exactly the way the frontend already expects, so none
// of the ~2000 lines of embedded HTML/CSS/client-JS needed to change at all.
function withId(instance) {
    const obj = instance && instance.toJSON ? instance.toJSON() : instance;
    if (!obj) return obj;
    return { ...obj, _id: String(obj.id) };
}
function serializeTicket(instance) {
    const t = instance && instance.toJSON ? instance.toJSON() : instance;
    if (!t) return t;
    return { ...t, _id: String(t.id), ticketNumber: t.id };
}

async function logAudit(actor, action, details) {
    try {
        await AuditLog.create({ actor, action, details });
    } catch (err) {
        console.error('Failed to write audit log entry:', err.message);
    }
}

// 2. CONFIGURE CLOUDINARY PERMANENT STORAGE
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'helpdesk_screenshots',
        allowed_formats: ['jpg', 'png', 'jpeg', 'webp', 'gif', 'pdf']
    }
});

// Upload security: explicit allowlist (not a blocklist) so anything not on this list —
// including executables like .exe/.bat/.js/.php — is rejected outright, regardless of
// what extension someone tries to disguise it with. Checks both the extension AND the
// browser-reported mimetype since either alone can be spoofed.
const ALLOWED_UPLOAD_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf'];
const ALLOWED_UPLOAD_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];

function uploadFileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ALLOWED_UPLOAD_EXTENSIONS.includes(ext) && ALLOWED_UPLOAD_MIME_TYPES.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Only PDF, JPG, PNG, WEBP, and GIF files are allowed.'));
    }
}

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: uploadFileFilter
});

// Separate storage/upload for optional attachments on internal work note comments
const commentAttachmentStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'helpdesk_comment_attachments',
        allowed_formats: ['jpg', 'png', 'jpeg', 'webp', 'gif', 'pdf']
    }
});
const commentUpload = multer({
    storage: commentAttachmentStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: uploadFileFilter
});

// One-time seed of the original IT staff accounts, only if the table is empty
async function seedInitialStaff() {
    const existingCount = await Staff.count();
    if (existingCount === 0) {
        const defaults = [
            { staffId: 'IT001', name: 'SADIQ', password: 'sadiq123', email: 'itsarathy@gmail.com' },
            { staffId: 'IT002', name: 'ABHIMANYU', password: 'abhi123', email: 'abhimanyu@gmail.com' },
            { staffId: 'IT003', name: 'ANANDHU', password: 'anandhu123', email: 'anandhu@gmail.com' },
            { staffId: 'IT004', name: 'sabari', password: 'sabari123', email: 'sabari@gmail.com' }
        ];
        for (const s of defaults) {
            s.password = await bcrypt.hash(s.password, 10);
        }
        await Staff.bulkCreate(defaults);
        console.log('Seeded initial IT staff accounts');
    }
}

// Generates the next sequential staff ID, e.g. IT005
async function getNextStaffId() {
    const allStaff = await Staff.findAll();
    let maxNum = 0;
    allStaff.forEach(s => {
        const match = s.staffId.match(/(\d+)$/);
        if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    });
    return 'IT' + String(maxNum + 1).padStart(3, '0');
}

// Returns the branch names that belong to a given region — used to scope tickets,
// staff, and reports for a Region Admin.
async function getBranchNamesForRegion(regionName) {
    const rows = await Branch.findAll({ where: { region: regionName }, attributes: ['name'] });
    return rows.map(r => r.name);
}


// Configure Email Transporter
// Start with a hostname-based transporter as a fallback in case IPv4 resolution below fails.
let transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    family: 4,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

function verifyMailer() {
    transporter.verify((err, success) => {
        if (err) {
            console.error('MAILER NOT WORKING — assignment emails will fail. Reason:', err.message);
        } else {
            console.log('Mailer verified OK — ready to send assignment emails.');
        }
    });
}

// Gmail's hostname can resolve to an IPv6 address that Render's free tier can't route to,
// which breaks the connection (ENETUNREACH / timeout) even with the `family: 4` option above,
// since that option isn't consistently honored by the underlying SMTP connection layer.
// Resolving to a literal IPv4 address ourselves and connecting to that IP directly sidesteps
// the issue completely — there's no hostname left for anything to re-resolve to IPv6.
dns.promises.resolve4('smtp.gmail.com')
    .then(addresses => {
        transporter = nodemailer.createTransport({
            host: addresses[0],
            port: 465,
            secure: true,
            tls: { servername: 'smtp.gmail.com' }, // keeps TLS cert validation matching the real hostname
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });
        console.log('Mailer configured to use Gmail IPv4 address:', addresses[0]);
        verifyMailer();
    })
    .catch(err => {
        console.error('Could not resolve an IPv4 address for smtp.gmail.com, using hostname instead:', err.message);
        verifyMailer();
    });

// Needed so req.ip and secure cookies work correctly behind Render's reverse proxy
app.set('trust proxy', 1);

if (!process.env.SESSION_SECRET) {
    console.warn('WARNING: SESSION_SECRET is not set — using an insecure default. Set SESSION_SECRET in your environment variables.');
}

app.use(session({
    secret: process.env.SESSION_SECRET || 'my-super-secret-key-123',
    resave: false,
    rolling: true, // resets the expiry on every request, so it's truly inactivity-based
    saveUninitialized: true,
    cookie: {
        maxAge: 4 * 60 * 60 * 1000, // 4 hours of inactivity logs the user out
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production'
    }
}));

// Basic brute-force protection on login: max 8 attempts per IP per 15 minutes
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
function loginRateLimiter(req, res, next) {
    const ip = req.ip;
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry || now - entry.firstAttempt > LOGIN_WINDOW_MS) {
        loginAttempts.set(ip, { count: 1, firstAttempt: now });
        return next();
    }
    if (entry.count >= LOGIN_MAX_ATTEMPTS) {
        return res.status(429).json({ error: 'Too many login attempts. Please wait a few minutes and try again.' });
    }
    entry.count++;
    next();
}

function checkUserLogin(req, res, next) {
    if (req.session && (req.session.isAdmin || req.session.isStaff)) {
        next();
    } else {
        res.redirect('/login');
    }
}

function checkAdminLogin(req, res, next) {
    if (req.session && req.session.isAdmin) {
        next();
    } else {
        res.status(403).json({ error: 'Access Denied' });
    }
}

// Super Admin only — Region Admins are blocked with the exact message the UI expects
// so the client can show it verbatim instead of a generic error.
function checkSuperAdminLogin(req, res, next) {
    if (req.session && req.session.isAdmin && req.session.isSuperAdmin) {
        next();
    } else {
        res.status(403).json({ error: 'You are not authorized to access this page.' });
    }
}

// User Ticket Submission Page
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Submit a Ticket | SARATHY IT</title><link rel="icon" type="image/png" href="/logo.png"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: 'Inter', 'Segoe UI', Arial, sans-serif;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background-image:
        radial-gradient(circle at 18% 20%, rgba(229,62,62,0.32), transparent 42%),
        radial-gradient(circle at 85% 18%, rgba(229,62,62,0.14), transparent 40%),
        radial-gradient(circle at 60% 92%, rgba(229,62,62,0.2), transparent 45%),
        linear-gradient(160deg, rgba(18,20,26,0.72) 0%, rgba(30,34,41,0.72) 55%, rgba(42,21,24,0.72) 100%),
        url('/background.png');
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
    background-attachment: fixed;
    padding: 16px;
}
.ticket-card { width: 100%; max-width: 760px; background: #fdfcfb; border-radius: 14px; box-shadow: 0 24px 70px rgba(0,0,0,0.45); overflow: visible; }
.ticket-ribbon { background: #1e2229; padding: 12px 26px; display: flex; align-items: center; gap: 12px; }
.ticket-ribbon img { height: 28px; width: auto; object-fit: contain; }
.ticket-ribbon-text { font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 16px; letter-spacing: 1px; color: #fff; text-transform: uppercase; }
.ticket-body { padding: 16px 26px 20px; }
h2.form-title { font-family: 'Barlow Condensed', sans-serif; font-weight: 600; font-size: 19px; letter-spacing: .3px; color: #1e2229; }
.form-subtitle { font-size: 11px; color: #8a8f98; margin-top: 2px; }
.ticket-perforation { position: relative; height: 0; border-top: 2px dashed #e2ded9; margin: 12px -26px 10px -26px; }
.ticket-perforation::before, .ticket-perforation::after { content: ''; position: absolute; top: -8px; width: 16px; height: 16px; border-radius: 50%; background: #f1f0ee; box-shadow: inset 0 1px 3px rgba(0,0,0,0.15); }
.ticket-perforation::before { left: -8px; }
.ticket-perforation::after { right: -8px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; column-gap: 12px; }
@media (max-width: 600px) { .form-grid { grid-template-columns: 1fr 1fr; } }
@media (max-width: 400px) { .form-grid { grid-template-columns: 1fr; } }
.form-field { margin-top: 8px; min-width: 0; }
.full-width { grid-column: 1 / -1; }
label { display: block; margin-bottom: 3px; font-weight: 600; font-size: 10.5px; color: #6b7280; text-transform: uppercase; letter-spacing: .4px; }
input, textarea, select { width: 100%; padding: 8px 11px; border: 1.5px solid #e5e1de; border-radius: 7px; font-size: 13px; font-family: 'Inter', sans-serif; background: #faf9f7; color: #1e2229; transition: border-color .18s, box-shadow .18s; }
input:focus, textarea:focus, select:focus { outline: none; border-color: #e53e3e; box-shadow: 0 0 0 3px rgba(229,62,62,.14); background: #fff; }
textarea { resize: none; height: 44px; }
button[type="submit"] { grid-column: 1 / -1; margin-top: 12px; padding: 11px; width: 100%; background: linear-gradient(120deg, #e53e3e, #c53030); color: #fff; border: none; border-radius: 8px; cursor: pointer; font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 14px; letter-spacing: 1px; text-transform: uppercase; box-shadow: 0 8px 20px rgba(197,48,48,.4); transition: transform .15s, box-shadow .15s; display: flex; align-items: center; justify-content: center; gap: 8px; }
button[type="submit"]:disabled { opacity: .7; cursor: not-allowed; transform: none; }
.spinner { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.45); border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
button[type="submit"]:hover { transform: translateY(-2px); box-shadow: 0 12px 28px rgba(197,48,48,.5); }
button[type="submit"]:active { transform: translateY(0); }
.tab-switch { display: flex; background: #f1f0ee; }
.tab-btn { flex: 1; padding: 10px; border: none; background: transparent; cursor: pointer; font-family: 'Barlow Condensed', sans-serif; font-weight: 600; font-size: 12px; letter-spacing: .5px; text-transform: uppercase; color: #8a8f98; transition: all .2s; }
.tab-btn.active { background: #fdfcfb; color: #e53e3e; box-shadow: inset 0 -2px 0 #e53e3e; }
.check-status-btn { margin-top: 12px; padding: 11px; width: 100%; background: #1e2229; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 13px; letter-spacing: 1px; text-transform: uppercase; transition: background .2s; }
.check-status-btn:hover { background: #2d323e; }
.badge { padding: 4px 10px; border-radius: 50px; font-size: 11px; font-weight: 700; text-transform: uppercase; display: inline-block; }
.status-open { background-color: #ebf8ff; color: #2b6cb0; }
.status-resolved { background-color: #c6f6d5; color: #22543d; }
.status-result-card { border: 1px solid #e5e1de; border-radius: 10px; padding: 12px 14px; margin-top: 10px; background: #faf9f7; }
.status-result-top { display: flex; justify-content: space-between; align-items: center; }
.status-result-number { font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 15px; color: #1e2229; letter-spacing: .5px; }
.status-result-title { font-size: 13px; color: #1e2229; font-weight: 600; margin-top: 5px; }
.status-result-meta { font-size: 11px; color: #8a8f98; margin-top: 3px; }
.toast { position: fixed; top: 16px; left: 50%; transform: translateX(-50%) translateY(-16px); background: #22543d; color: #fff; padding: 12px 22px; border-radius: 9px; font-size: 13px; font-weight: 600; box-shadow: 0 8px 24px rgba(0,0,0,0.3); z-index: 2000; opacity: 0; transition: opacity .25s, transform .25s; pointer-events: none; max-width: 90vw; text-align: center; }
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.toast.error { background: #9b2c2c; }
.page-footer { position: fixed; bottom: 8px; left: 0; width: 100%; text-align: center; font-size: 11px; color: rgba(255,255,255,0.55); letter-spacing: .3px; }
</style></head><body><div id="formToast" class="toast"></div><div class="ticket-card"><div class="ticket-ribbon"><img src="/logo.png" alt="Company Logo" onerror="this.style.display='none'"><span class="ticket-ribbon-text">Sarathy IT Helpdesk</span></div><div class="tab-switch"><button type="button" class="tab-btn active" id="tabSubmitBtn" onclick="showTab('submit')">Submit Ticket</button><button type="button" class="tab-btn" id="tabStatusBtn" onclick="showTab('status')">Check Status</button></div><div class="ticket-body"><div id="submitPane"><h2 class="form-title">Submit a New Ticket</h2><div class="form-subtitle">We'll route it to the right person and keep you posted.</div><div class="ticket-perforation"></div><form id="ticketForm" enctype="multipart/form-data" class="form-grid"><div class="form-field"><label>Your Name</label><input type="text" id="submitterName" required></div><div class="form-field"><label>Designation</label><input type="text" id="submitterDesignation"></div><div class="form-field"><label>Mobile Number</label><input type="tel" id="mobile" placeholder="10-digit mobile number" pattern="[0-9]{10}" maxlength="10" inputmode="numeric" oninput="this.value=this.value.replace(/[^0-9]/g,'').slice(0,10)" required></div><div class="form-field full-width"><label>Issue Title</label><input type="text" id="title" required></div><div class="form-field"><label>Region</label><select id="region" required onchange="updateBranchOptions()"><option value="" disabled selected>Loading...</option></select></div><div class="form-field"><label>Branch Location</label><select id="branch" required><option value="" disabled selected>Select region first</option></select></div><div class="form-field"><label>Priority Level</label><select id="priority"><option value="Low">Low</option><option value="Medium" selected>Medium</option><option value="High">High</option></select></div><div class="form-field"><label>Category</label><select id="category" required><option value="" disabled selected>Select Category</option><option value="Hardware">Hardware</option><option value="Software">Software</option><option value="Network">Network</option><option value="Printer">Printer</option><option value="Other">Other</option></select></div><div class="form-field full-width"><label>Description</label><textarea id="description" required></textarea></div><div class="form-field full-width"><label>Upload Screenshot (Optional, PDF/JPG/PNG/WEBP/GIF, max 5MB)</label><input type="file" id="screenshot" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,.jpg,.jpeg,.png,.webp,.gif,.pdf"></div><button type="submit" id="submitTicketBtn">Submit Ticket</button></form></div><div id="statusPane" style="display:none;"><h2 class="form-title">Check Ticket Status</h2><div class="form-subtitle">Enter the mobile number you used when submitting.</div><label>Mobile Number</label><input type="tel" id="statusMobile" placeholder="Enter your 10-digit mobile number" pattern="[0-9]{10}" maxlength="10" inputmode="numeric" oninput="this.value=this.value.replace(/[^0-9]/g,'').slice(0,10)"><button type="button" class="check-status-btn" onclick="checkTicketStatus()">Check Status</button><div id="statusResults"></div></div></div></div><div class="page-footer">&copy; 2026 Sarathy Pvt Ltd</div><script>
    let allBranchesCache = [];
    let toastTimer = null;
    function showToast(message, isError) {
        const toast = document.getElementById('formToast');
        toast.textContent = message;
        toast.className = 'toast show' + (isError ? ' error' : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toast.classList.remove('show'); }, 4500);
    }

    async function loadFormBranches() {
        try {
            const res = await fetch('/public-branches');
            allBranchesCache = await res.json();
            const regionSelect = document.getElementById('region');
            const branchSelect = document.getElementById('branch');
            if (allBranchesCache.length === 0) {
                regionSelect.innerHTML = '<option value="">No branches configured</option>';
                branchSelect.innerHTML = '<option value="General">No specific branches configured</option>';
                return;
            }
            const regions = [...new Set(allBranchesCache.map(b => b.region || 'Unassigned'))].sort();
            regionSelect.innerHTML = '<option value="" disabled selected>Choose region</option>';
            regions.forEach(r => {
                regionSelect.innerHTML += '<option value="' + r + '">' + r + '</option>';
            });
            branchSelect.innerHTML = '<option value="" disabled selected>Select region first</option>';
        } catch(e) {
            document.getElementById('region').innerHTML = '<option value="">Error loading regions</option>';
            document.getElementById('branch').innerHTML = '<option value="General">General/Headquarters</option>';
        }
    }
    function updateBranchOptions() {
        const region = document.getElementById('region').value;
        const branchSelect = document.getElementById('branch');
        const filtered = allBranchesCache.filter(b => (b.region || 'Unassigned') === region);
        if (filtered.length === 0) {
            branchSelect.innerHTML = '<option value="" disabled selected>No branches in this region</option>';
            return;
        }
        branchSelect.innerHTML = '<option value="" disabled selected>Choose branch location</option>';
        filtered.forEach(b => {
            branchSelect.innerHTML += '<option value="' + b.name + '">' + b.name + '</option>';
        });
    }
    loadFormBranches();

    document.getElementById('ticketForm').addEventListener('submit', async (e) => { 
        e.preventDefault(); 
        const submitBtn = document.getElementById('submitTicketBtn');
        const submitBtnDefaultHTML = submitBtn.innerHTML;
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="spinner"></span>Submitting...';
        const formData = new FormData(); 
        formData.append('title', document.getElementById('title').value); 
        formData.append('submittedBy', document.getElementById('submitterName').value);
        formData.append('designation', document.getElementById('submitterDesignation').value);
        formData.append('branch', document.getElementById('branch').value); 
        formData.append('mobile', document.getElementById('mobile').value); 
        formData.append('priority', document.getElementById('priority').value); 
        formData.append('category', document.getElementById('category').value);
        formData.append('description', document.getElementById('description').value); 
        const fileInput = document.getElementById('screenshot'); 
        if (fileInput.files[0]) {
            const file = fileInput.files[0];
            const allowedExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf'];
            const nameParts = file.name.split('.');
            const ext = nameParts.length > 1 ? '.' + nameParts.pop().toLowerCase() : '';
            if (!allowedExts.includes(ext)) {
                showToast('Only PDF, JPG, PNG, WEBP, and GIF files are allowed.', true);
                submitBtn.disabled = false;
                submitBtn.innerHTML = submitBtnDefaultHTML;
                return;
            }
            if (file.size > 5 * 1024 * 1024) {
                showToast('File is too large. Maximum allowed size is 5MB.', true);
                submitBtn.disabled = false;
                submitBtn.innerHTML = submitBtnDefaultHTML;
                return;
            }
            formData.append('screenshot', file);
        }
        try {
            const response = await fetch('/tickets', { method: 'POST', body: formData }); 
            if (response.ok) { 
                const result = await response.json();
                localStorage.setItem('sarathyTicketMobile', document.getElementById('mobile').value);
                showToast('Ticket #' + String(result.ticketNumber).padStart(4, '0') + ' submitted successfully!'); 
                document.getElementById('ticketForm').reset(); 
                loadFormBranches();
            } else {
                let errorMsg = 'Could not submit the ticket. Please try again.';
                try {
                    const errData = await response.json();
                    if (errData && errData.error) errorMsg = errData.error;
                } catch (parseErr) {}
                showToast(errorMsg, true);
            }
        } catch (err) {
            showToast('Something went wrong submitting the ticket. Please check your connection and try again.', true);
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = submitBtnDefaultHTML;
        }
    });

    function showTab(tab) {
        document.getElementById('submitPane').style.display = tab === 'submit' ? 'block' : 'none';
        document.getElementById('statusPane').style.display = tab === 'status' ? 'block' : 'none';
        document.getElementById('tabSubmitBtn').classList.toggle('active', tab === 'submit');
        document.getElementById('tabStatusBtn').classList.toggle('active', tab === 'status');
        if (tab === 'status') {
            const savedMobile = localStorage.getItem('sarathyTicketMobile');
            if (savedMobile) {
                document.getElementById('statusMobile').value = savedMobile;
                checkTicketStatus();
            }
        }
    }

    async function checkTicketStatus() {
        const mobile = document.getElementById('statusMobile').value.trim();
        if (!mobile) { alert('Please enter your mobile number.'); return; }
        const res = await fetch('/tickets/lookup?mobile=' + encodeURIComponent(mobile));
        const tickets = await res.json();
        renderStatusResults(tickets);
    }

    function renderStatusResults(tickets) {
        const container = document.getElementById('statusResults');
        if (tickets.length === 0) {
            container.innerHTML = '<p style="text-align:center;color:#8a8f98;padding:16px 0;font-size:13px;">No tickets found for that mobile number.</p>';
            return;
        }
        let html = '';
        tickets.forEach(t => {
            const statusClass = t.status === 'Resolved' ? 'status-resolved' : 'status-open';
            const resolvedLine = (t.status === 'Resolved' && t.resolvedAt)
                ? '<div class="status-result-meta">Resolved by ' + (t.assignedTo || 'staff') + ' on ' + new Date(t.resolvedAt).toLocaleString() + '</div>'
                : '<div class="status-result-meta">Being handled by: ' + (t.assignedTo || 'Unassigned') + '</div>';
            html += '<div class="status-result-card">' +
                '<div class="status-result-top"><span class="status-result-number">#' + String(t.ticketNumber).padStart(4, '0') + '</span>' +
                '<span class="badge ' + statusClass + '">' + t.status + '</span></div>' +
                '<div class="status-result-title">' + t.title + '</div>' +
                '<div class="status-result-meta">' + t.branch + ' &middot; ' + t.priority + ' priority</div>' +
                '<div class="status-result-meta">Submitted: ' + (t.createdAt ? new Date(t.createdAt).toLocaleString() : '') + '</div>' +
                resolvedLine +
                '</div>';
        });
        container.innerHTML = html;
    }
    </script></body></html>`);
});

// Login Page
app.get('/login', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Login | SARATHY IT</title><link rel="icon" type="image/png" href="/logo.png"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: 'Inter', 'Segoe UI', Arial, sans-serif;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background-image:
        radial-gradient(circle at 20% 20%, rgba(229,62,62,0.32), transparent 42%),
        radial-gradient(circle at 82% 78%, rgba(229,62,62,0.18), transparent 45%),
        linear-gradient(160deg, rgba(18,20,26,0.72) 0%, rgba(30,34,41,0.72) 55%, rgba(42,21,24,0.72) 100%),
        url('/background.png');
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
    background-attachment: fixed;
    padding: 20px;
}
.login-card { position: relative; width: 100%; max-width: 380px; background: #ffffff; border-radius: 14px; box-shadow: 0 24px 70px rgba(0,0,0,.45); margin-top: 14px; }
.badge-hole { width: 26px; height: 26px; border-radius: 50%; background: #e9edf1; box-shadow: inset 0 2px 5px rgba(0,0,0,.2); position: absolute; top: -13px; left: 50%; transform: translateX(-50%); }
.login-ribbon { background: #1e2229; border-radius: 14px 14px 0 0; padding: 26px 32px 20px; text-align: center; }
.login-ribbon img { height: 38px; width: auto; object-fit: contain; margin-bottom: 8px; }
.login-ribbon-text { display: block; font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 20px; letter-spacing: 1px; color: #fff; text-transform: uppercase; }
.login-ribbon-sub { display: block; font-size: 11px; color: #a0aec0; letter-spacing: .6px; text-transform: uppercase; margin-top: 3px; }
.login-body { padding: 30px 32px 34px; }
label { display: block; margin-top: 16px; font-weight: 600; font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: .5px; }
input { width: 100%; padding: 12px 14px; margin-top: 7px; border: 1.5px solid #e2e8f0; border-radius: 9px; font-size: 14px; font-family: 'Inter', sans-serif; background: #f8f9fa; color: #1e2229; transition: border-color .18s, box-shadow .18s; }
input:focus { outline: none; border-color: #e53e3e; box-shadow: 0 0 0 3px rgba(229,62,62,.14); background: #fff; }
.password-wrapper { position: relative; }
.password-wrapper input { padding-right: 44px; }
.toggle-password { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); background: none; border: none; padding: 6px; margin: 0; width: auto; box-shadow: none; cursor: pointer; color: #8a8f98; display: flex; align-items: center; }
.toggle-password:hover { transform: translateY(-50%); box-shadow: none; color: #4a5568; }
.caps-warning { display: none; margin-top: 6px; font-size: 11.5px; color: #c05621; font-weight: 600; }
.login-error { display: none; margin-top: 14px; padding: 10px 12px; background: #fed7d7; color: #9b2c2c; border-radius: 8px; font-size: 13px; font-weight: 500; }
button[type="submit"] { margin-top: 24px; padding: 13px; width: 100%; background: linear-gradient(120deg, #e53e3e, #c53030); color: #fff; border: none; border-radius: 9px; cursor: pointer; font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 16px; letter-spacing: 1px; text-transform: uppercase; box-shadow: 0 8px 20px rgba(197,48,48,.4); transition: transform .15s, box-shadow .15s; display: flex; align-items: center; justify-content: center; gap: 8px; }
button[type="submit"]:hover { transform: translateY(-2px); box-shadow: 0 12px 28px rgba(197,48,48,.5); }
button[type="submit"]:active { transform: translateY(0); }
button[type="submit"]:disabled { opacity: .7; cursor: not-allowed; transform: none; box-shadow: 0 8px 20px rgba(197,48,48,.4); }
.spinner { width: 15px; height: 15px; border: 2px solid rgba(255,255,255,.45); border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.page-footer { position: fixed; bottom: 8px; left: 0; width: 100%; text-align: center; font-size: 11px; color: rgba(255,255,255,0.55); letter-spacing: .3px; }
@media (max-width: 400px) { .login-ribbon { padding: 20px 22px 16px; } .login-body { padding: 22px 22px 26px; } }
</style></head><body><div class="login-card"><div class="badge-hole"></div><div class="login-ribbon"><img src="/logo.png" alt="Company Logo" onerror="this.style.display='none'"><span class="login-ribbon-text">Sarathy IT</span><span class="login-ribbon-sub">Staff &amp; Admin Access</span></div><div class="login-body"><form id="loginForm"><label>Username / Staff Name</label><input type="text" id="username" required><label>Password</label><div class="password-wrapper"><input type="password" id="password" required><button type="button" class="toggle-password" id="togglePassword" aria-label="Show password"><svg id="eyeIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></div><div class="caps-warning" id="capsWarning">Caps Lock is on</div><div class="login-error" id="loginError"></div><button type="submit" id="loginBtn">Login</button></form></div></div><div class="page-footer">&copy; 2026 Sarathy Pvt Ltd</div><script>
    const loginForm = document.getElementById('loginForm');
    const loginBtn = document.getElementById('loginBtn');
    const loginError = document.getElementById('loginError');
    const passwordInput = document.getElementById('password');
    const capsWarning = document.getElementById('capsWarning');
    const toggleBtn = document.getElementById('togglePassword');
    const eyeIcon = document.getElementById('eyeIcon');
    const loginBtnDefaultHTML = loginBtn.innerHTML;

    const EYE_OPEN = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
    const EYE_CLOSED = '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
    let passwordVisible = false;
    toggleBtn.addEventListener('click', () => {
        passwordVisible = !passwordVisible;
        passwordInput.type = passwordVisible ? 'text' : 'password';
        eyeIcon.innerHTML = passwordVisible ? EYE_CLOSED : EYE_OPEN;
        toggleBtn.setAttribute('aria-label', passwordVisible ? 'Hide password' : 'Show password');
    });

    function checkCapsLock(e) {
        if (e.getModifierState && e.getModifierState('CapsLock')) {
            capsWarning.style.display = 'block';
        } else {
            capsWarning.style.display = 'none';
        }
    }
    passwordInput.addEventListener('keydown', checkCapsLock);
    passwordInput.addEventListener('keyup', checkCapsLock);

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        loginError.style.display = 'none';
        loginBtn.disabled = true;
        loginBtn.innerHTML = '<span class="spinner"></span>Logging in...';
        try {
            const response = await fetch('/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: document.getElementById('username').value,
                    password: passwordInput.value
                })
            });
            const data = await response.json();
            if (response.ok && data.success) {
                window.location.href = data.redirect || '/admin';
                return;
            }
            loginError.textContent = data.error || 'Invalid username or password.';
            loginError.style.display = 'block';
            loginBtn.disabled = false;
            loginBtn.innerHTML = loginBtnDefaultHTML;
        } catch (err) {
            loginError.textContent = 'Something went wrong. Please try again.';
            loginError.style.display = 'block';
            loginBtn.disabled = false;
            loginBtn.innerHTML = loginBtnDefaultHTML;
        }
    });
    </script></body></html>`);
});

// Compares a submitted password against a stored one. Handles both bcrypt-hashed
// passwords and legacy plaintext ones (so existing accounts keep working).
async function verifyPassword(plainInput, storedValue) {
    if (storedValue && storedValue.startsWith('$2')) {
        return bcrypt.compare(plainInput, storedValue);
    }
    return plainInput === storedValue;
}

app.post('/login', loginRateLimiter, async (req, res) => {
    const { username, password } = req.body;
        const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || '123';
    if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
        console.warn('WARNING: ADMIN_USERNAME/ADMIN_PASSWORD not set — using insecure defaults. Set these in your environment variables.');
    }
    if (username === adminUser && password === adminPass) {
        req.session.isAdmin = true;
        req.session.isSuperAdmin = true;
        req.session.isStaff = false;
        req.session.region = null;
        req.session.username = 'Admin';
        return res.json({ success: true, redirect: '/admin' });
    }

    const regionAdmin = await RegionAdmin.findOne({ where: { username: username.trim() } });
    if (regionAdmin && regionAdmin.enabled && await verifyPassword(password, regionAdmin.password)) {
        if (!regionAdmin.password.startsWith('$2')) {
            regionAdmin.password = await bcrypt.hash(password, 10);
            await regionAdmin.save();
        }
        req.session.isAdmin = true;
        req.session.isSuperAdmin = false;
        req.session.isStaff = false;
        req.session.region = regionAdmin.region;
        req.session.username = regionAdmin.name;
        return res.json({ success: true, redirect: '/admin' });
    }
    if (regionAdmin && !regionAdmin.enabled) {
        return res.status(401).json({ error: 'This admin account has been disabled. Contact your Super Admin.' });
    }

    const allStaff = await Staff.findAll();
    const staffUser = allStaff.find(s => s.name.toLowerCase() === username.toLowerCase());
    if (staffUser && await verifyPassword(password, staffUser.password)) {
        // Lazily upgrade legacy plaintext passwords to a bcrypt hash on successful login
        if (!staffUser.password.startsWith('$2')) {
            staffUser.password = await bcrypt.hash(password, 10);
            await staffUser.save();
        }
        req.session.isAdmin = false;
        req.session.isSuperAdmin = false;
        req.session.isStaff = true;
        req.session.region = null;
        req.session.username = staffUser.name;
        return res.json({ success: true, redirect: '/admin' });
    }
    res.status(401).json({ error: 'Invalid username or password.' });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Staff can change their own password. Admin's password is set via an environment
// variable (ADMIN_PASSWORD), so it can't be changed here — only from the hosting dashboard.
app.post('/change-password', checkUserLogin, async (req, res) => {
    try {
        if (req.session.isAdmin) {
            return res.status(400).json({ error: 'Admin password is set via the ADMIN_PASSWORD environment variable in your hosting dashboard — it can\'t be changed here.' });
        }
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new password are both required' });
        }
        if (newPassword.length < 4) {
            return res.status(400).json({ error: 'New password is too short' });
        }
        const staffUser = await Staff.findOne({ name: req.session.username });
        if (!staffUser) return res.status(404).json({ error: 'Account not found' });
        const isValid = await verifyPassword(currentPassword, staffUser.password);
        if (!isValid) return res.status(401).json({ error: 'Current password is incorrect' });
        staffUser.password = await bcrypt.hash(newPassword, 10);
        await staffUser.save();
        await logAudit(req.session.username, 'Change Password', `${req.session.username} changed their own password`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin Panel
app.get('/admin', checkUserLogin, (req, res) => {
    const dynamicUsername = req.session.username || 'User';
    const dynamicIsAdmin = req.session.isAdmin ? 'true' : 'false';
    const dynamicIsSuperAdmin = req.session.isSuperAdmin ? 'true' : 'false';
    const isAdminUser = !!req.session.isAdmin;
    const isSuperAdminUser = !!req.session.isSuperAdmin;

    let html = '<!DOCTYPE html>' +
'<html lang="en">' +
'<head>' +
'    <meta charset="UTF-8">' +
'    <meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'    <title>IT Helpdesk | Dashboard</title>' +
'    <link rel="icon" type="image/png" href="/logo.png">' +
'    <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"></script>' +
'    <style>' +
'        * { box-sizing: border-box; margin: 0; padding: 0; font-family: \'Segoe UI\', Tahoma, Geneva, Verdana, sans-serif; }' +
'        body { display: flex; height: 100vh; background-color: #f8f9fa; color: #333; overflow: hidden; }' +
'        .hamburger-btn { display: none; background: none; border: none; cursor: pointer; padding: 6px; flex-direction: column; gap: 4px; }' +
'        .hamburger-btn span { display: block; width: 22px; height: 2px; background: #2d3748; border-radius: 2px; }' +
'        .sidebar-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 998; }' +
'        .sidebar-backdrop.active { display: block; }' +
'        @media (max-width: 768px) {' +
'            .sidebar { position: fixed; top: 0; bottom: 0; left: -270px; z-index: 999; transition: left 0.25s ease; width: 260px; }' +
'            .sidebar.sidebar-open { left: 0; }' +
'            .hamburger-btn { display: flex; }' +
'            .top-navbar { padding: 0 16px; }' +
'            .content-body { padding: 16px; }' +
'            .metrics-grid { gap: 12px; }' +
'            .branch-table { display: block; overflow-x: auto; white-space: nowrap; }' +
'            .ticket-header { flex-direction: column; align-items: flex-start; gap: 10px; }' +
'        }' +
'        .sidebar { width: 260px; height: 100vh; background-color: #1e2229; color: #fff; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; }' +
'        .sidebar-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #3a4150 transparent; }' +
'        .sidebar-scroll::-webkit-scrollbar { width: 6px; }' +
'        .sidebar-scroll::-webkit-scrollbar-track { background: transparent; }' +
'        .sidebar-scroll::-webkit-scrollbar-thumb { background: #3a4150; border-radius: 10px; }' +
'        .sidebar-scroll::-webkit-scrollbar-thumb:hover { background: #4a5568; }' +
'        .sidebar-brand { padding: 24px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #2d323e; }' +
'        .sidebar-logo { height: 35px; width: auto; object-fit: contain; }' +
'        .sidebar-title { font-size: 18px; font-weight: 700; color: #fff; letter-spacing: 0.5px; }' +
'        .sidebar-menu { list-style: none; padding: 20px 0; }' +
'        .menu-category { font-size: 11px; font-weight: 700; text-transform: uppercase; color: #4a5568; padding: 10px 24px 5px 24px; letter-spacing: 0.5px; }' +
'        .menu-item { padding: 12px 24px; display: flex; align-items: center; gap: 12px; color: #a0aec0; text-decoration: none; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s; border-left: 4px solid transparent; }' +
'        .menu-icon { width: 17px; height: 17px; flex-shrink: 0; }' +
'        .menu-item:hover, .menu-item.active { background-color: #2d323e; color: #fff; border-left-color: #0056b3; }' +
'        .sidebar-footer { padding: 20px; border-top: 1px solid #2d323e; flex-shrink: 0; }' +
'        .user-info { font-size: 12px; color: #a0aec0; margin-bottom: 12px; }' +
'        .user-info strong { color: #fff; display: block; font-size: 14px; margin-bottom: 2px; }' +
'        .logout-btn { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; background-color: #e53e3e; color: white; text-decoration: none; padding: 10px; border-radius: 6px; font-size: 14px; font-weight: 600; transition: background 0.2s; }' +
'        .logout-btn:hover { background-color: #c53030; }' +
'        .main-content { flex-grow: 1; display: flex; flex-direction: column; height: 100vh; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #cbd5e0 #f8f9fa; }' +
'        .main-content::-webkit-scrollbar { width: 8px; }' +
'        .main-content::-webkit-scrollbar-track { background: #f8f9fa; }' +
'        .main-content::-webkit-scrollbar-thumb { background: #cbd5e0; border-radius: 10px; }' +
'        .main-content::-webkit-scrollbar-thumb:hover { background: #a0aec0; }' +
'        .top-navbar { height: 70px; background-color: #fff; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between; padding: 0 30px; }' +
'        .page-title { font-size: 20px; font-weight: 600; color: #2d3748; }' +
'        .notification-wrap { position: relative; }' +
'        .notification-btn { position: relative; width: 40px; height: 40px; border: 1px solid #e2e8f0; border-radius: 50%; background: #fff; color: #2d3748; cursor: pointer; display: flex; align-items: center; justify-content: center; }' +
'        .notification-btn:hover { background: #f7fafc; }' +
'        .notification-btn svg { width: 20px; height: 20px; }' +
'        .notification-count { position: absolute; top: -5px; right: -5px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 10px; background: #e53e3e; color: #fff; font-size: 10px; font-weight: 700; display: none; align-items: center; justify-content: center; }' +
'        .notification-menu { display: none; position: absolute; top: 48px; right: 0; width: 330px; max-height: 360px; overflow-y: auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; box-shadow: 0 14px 34px rgba(0,0,0,.16); z-index: 3000; scrollbar-width: thin; scrollbar-color: #cbd5e0 #fff; }' +
'        .notification-menu::-webkit-scrollbar { width: 6px; }' +
'        .notification-menu::-webkit-scrollbar-track { background: #fff; }' +
'        .notification-menu::-webkit-scrollbar-thumb { background: #cbd5e0; border-radius: 10px; }' +
'        .notification-menu.show { display: block; }' +
'        .notification-head { padding: 12px 14px; font-size: 14px; font-weight: 700; border-bottom: 1px solid #edf2f7; }' +
'        .notification-item { padding: 12px 14px; border-bottom: 1px solid #edf2f7; font-size: 12px; color: #4a5568; }' +
'        .notification-item.unread { background: #ebf8ff; }' +
'        .notification-item strong { display: block; color: #2d3748; margin-bottom: 3px; }' +
'        .notification-empty { padding: 20px; text-align: center; color: #718096; font-size: 13px; }' +
'        .content-body { padding: 30px; max-width: 1200px; width: 100%; margin: 0 auto; }' +
'        .dashboard-view { display: none; }' +
'        .dashboard-view.active { display: block; }' +
'        .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 16px; }' +
'        .metric-card { background: white; border-radius: 10px; padding: 9px 14px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); border: 1px solid #edf1f5; border-top: 3px solid #3182ce; cursor: pointer; transition: box-shadow .2s, transform .2s; }' +
'        .metric-card:hover { box-shadow: 0 10px 26px rgba(0,0,0,0.09); transform: translateY(-2px); }' +
'        .metric-icon-badge { width: 26px; height: 26px; border-radius: 7px; display: flex; align-items: center; justify-content: center; margin-bottom: 4px; }' +
'        .metric-icon-badge svg { width: 14px; height: 14px; }' +
'        .metric-icon-blue { background: #ebf8ff; color: #3182ce; }' +
'        .metric-icon-green { background: #f0fff4; color: #38a169; }' +
'        .metric-icon-red { background: #fff5f5; color: #e53e3e; }' +
'        .metric-icon-amber { background: #fef3c7; color: #d97706; }' +
'        .metric-subtitle { font-size: 10px; color: #a0aec0; margin-top: 1px; font-weight: 500; }' +
'        .metric-card.resolved { border-top-color: #38a169; }' +
'        .metric-card.assigned { border-top-color: #e53e3e; }' +
'        .metric-card.escalated { border-top-color: #d97706; }' +
'        .metric-label { font-size: 11px; font-weight: 600; color: #718096; text-transform: uppercase; letter-spacing: 0.5px; }' +
'        .metric-value { font-size: 20px; font-weight: 700; color: #2d3748; margin-top: 1px; }' +
'        .ticket-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); position: relative; border-top: 4px solid #3182ce; }' +
'        .ticket-card.ticket-resolved { border-top-color: #38a169; }' +
'        .ticket-card.ticket-escalated { border-top-color: #dd6b20; background: #fffaf0; }' +
'        .ticket-card.ticket-high-priority { background: #fff5f5; border: 2px solid #e53e3e; border-top: 4px solid #e53e3e; }' +
'        .ticket-card.ticket-high-priority .ticket-title { color: #c53030; }' +
'        .ticket-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }' +
'        .ticket-title { font-size: 18px; font-weight: 600; color: #2d3748; }' +
'        .ticket-desc { color: #4a5568; font-size: 14px; line-height: 1.5; margin-bottom: 16px; }' +
'        .badge { padding: 4px 10px; border-radius: 50px; font-size: 11px; font-weight: 700; text-transform: uppercase; display: inline-block; margin-right: 8px; }' +
'        .p-Low { background-color: #edf2f7; color: #4a5568; }' +
'        .p-Medium { background-color: #feebc8; color: #c05621; }' +
'        .p-High { background-color: #fed7d7; color: #9b2c2c; }' +
'        .status-open { background-color: #ebf8ff; color: #2b6cb0; }' +
'        .status-resolved { background-color: #c6f6d5; color: #22543d; }' +
'        .ticket-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }' +
'        .resolve-btn { background-color: #38a169; color: white; border: none; padding: 8px 16px; font-size: 13px; font-weight: 600; border-radius: 6px; cursor: pointer; transition: background 0.2s; }' +
'        .resolve-btn:hover { background-color: #2f855a; }' +
'        .reallocate-btn { background-color: #805ad5; color: white; border: none; padding: 8px 16px; font-size: 13px; font-weight: 600; border-radius: 6px; cursor: pointer; transition: background 0.2s; }' +
'        .reallocate-btn:hover { background-color: #6b46c1; }' +
'        .escalate-btn { background-color: #dd6b20; color: white; border: none; padding: 8px 16px; font-size: 13px; font-weight: 600; border-radius: 6px; cursor: pointer; transition: background 0.2s; }' +
'        .escalate-btn:hover { background-color: #c05621; }' +
'        .badge-escalated { background-color: #fef3c7; color: #92400e; }' +
'        .badge-category { background-color: #e6fffa; color: #234e52; }' +
'        .screenshot-preview { max-width: 100%; max-height: 180px; border-radius: 6px; border: 1px solid #e2e8f0; margin-top: 12px; display: block; object-fit: cover; }' +
'        .assignment-info { margin-top: 16px; padding: 14px 16px; background: #f9fafb; border-radius: 8px; border: 1px solid #edf2f7; }' +
'        .assignment-row { display: flex; gap: 10px; padding: 5px 0; font-size: 13.5px; }' +
'        .assignment-row + .assignment-row { border-top: 1px solid #eef1f4; }' +
'        .assignment-label { flex: 0 0 120px; font-weight: 700; color: #4a5568; text-transform: uppercase; font-size: 11px; letter-spacing: .4px; padding-top: 2px; }' +
'        .assignment-value { color: #2d3748; font-size: 14px; flex: 1; }' +
'        .comments-section { margin-top: 20px; background-color: #f7fafc; padding: 16px; border-radius: 8px; border: 1px solid #edf2f7; }' +
'        .comments-header { font-size: 12px; font-weight: 700; color: #718096; text-transform: uppercase; margin-bottom: 10px; letter-spacing: 0.5px; }' +
'        .comment-item { padding: 8px 0; border-bottom: 1px solid #edf2f7; font-size: 13px; color: #4a5568; }' +
'        .comment-item strong { color: #2d3748; }' +
'        .comment-form { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; align-items: center; }' +
'        .comment-form input { flex-grow: 1; padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 13px; }' +
'        .comment-form button { background-color: #3182ce; color: white; border: none; padding: 8px 16px; font-size: 13px; font-weight: 600; border-radius: 6px; cursor: pointer; }' +
'        .comment-attach-btn { display: flex; align-items: center; justify-content: center; padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 6px; background: #f7fafc; cursor: pointer; font-size: 14px; flex-shrink: 0; }' +
'        .comment-attach-btn:hover { background: #edf2f7; }' +
'        .attachment-name-tag { font-size: 11px; color: #718096; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; align-self: center; }' +
'        .inbox-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); border-left: 4px solid #cbd5e0; }' +
'        .inbox-card.inbox-unread { border-left-color: #e53e3e; background: #fffafa; }' +
'        .inbox-subject { font-size: 16px; font-weight: 700; color: #2d3748; }' +
'        .inbox-meta { font-size: 12px; color: #a0aec0; margin-top: 2px; }' +
'        .inbox-body { font-size: 14px; color: #4a5568; margin-top: 10px; line-height: 1.5; white-space: pre-wrap; }' +
'        .inbox-reply-box { margin-top: 14px; padding-top: 14px; border-top: 1px solid #edf2f7; }' +
'        .inbox-reply-box textarea { width: 100%; padding: 10px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 13px; resize: vertical; }' +
'        .inbox-reply-shown { margin-top: 14px; padding: 12px 14px; background: #f0fff4; border-radius: 6px; font-size: 13px; color: #234e52; }' +
'        .branch-panel-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }' +
'        .branch-panel-card h2 { font-size: 16px; font-weight: 600; color: #2d3748; margin-bottom: 20px; }' +
'        .branch-input-group { display: flex; gap: 15px; margin-bottom: 25px; flex-wrap: wrap; }' +
'        .branch-input-group input { flex-grow: 1; padding: 12px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px; }' +
'        .branch-add-btn { background-color: #0056b3; color: white; border: none; padding: 0 30px; font-size: 14px; font-weight: 600; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 4px; }' +
'        .search-btn { padding: 9px 22px; font-size: 13.5px; }' +
'        .branch-add-btn:disabled { opacity: .7; cursor: not-allowed; }' +
'        .branch-table { width: 100%; border-collapse: collapse; text-align: left; margin-top: 10px; }' +
'        .branch-table th { background-color: #f7fafc; color: #4a5568; font-size: 13px; font-weight: 600; padding: 12px 16px; border-bottom: 1px solid #e2e8f0; }' +
'        .branch-table td { padding: 14px 16px; font-size: 14px; color: #2d3748; border-bottom: 1px solid #edf2f7; }' +
'        .branch-delete-btn { color: #e53e3e; background: none; border: none; cursor: pointer; font-weight: 600; font-size: 13px; }' +
'        .chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; margin-top: 24px; }' +
'        .chart-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); position: relative; height: 300px; }' +
'        .chart-card.wide { grid-column: 1 / -1; }' +
'        .chart-card h3 { font-size: 14px; font-weight: 600; color: #2d3748; margin: 0 0 14px; }' +
'        .section-heading { font-size: 16px; font-weight: 600; color: #2d3748; margin: 28px 0 0; }' +
'        .confirm-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 3000; align-items: center; justify-content: center; padding: 20px; }' +
'        .confirm-overlay.show { display: flex; }' +
'        .confirm-box { background: #fff; border-radius: 10px; padding: 24px; max-width: 380px; width: 100%; box-shadow: 0 20px 50px rgba(0,0,0,0.3); }' +
'        .confirm-box p { font-size: 14px; color: #2d3748; line-height: 1.5; margin-bottom: 20px; }' +
'        .confirm-actions { display: flex; gap: 12px; justify-content: flex-end; }' +
'        .confirm-actions button { padding: 9px 18px; border-radius: 7px; font-size: 13px; font-weight: 600; cursor: pointer; border: none; }' +
'        .confirm-cancel-btn { background: #edf2f7; color: #4a5568; }' +
'        .confirm-ok-btn { background: #e53e3e; color: #fff; }' +
'        .admin-toast { position: fixed; top: 20px; right: 20px; background: #fff; color: #1a202c; padding: 16px 20px; border-radius: 12px; font-size: 13px; box-shadow: 0 16px 40px rgba(0,0,0,0.16); z-index: 4000; opacity: 0; transform: translateX(24px); transition: opacity .25s, transform .25s; pointer-events: none; max-width: 340px; text-align: left; border-left: 4px solid #38a169; display: flex; align-items: flex-start; gap: 12px; overflow: hidden; }' +
'        .admin-toast.show { opacity: 1; transform: translateX(0); }' +
'        .admin-toast.error { border-left-color: #e53e3e; }' +
'        .admin-toast-icon { width: 32px; height: 32px; border-radius: 8px; background: #f0fff4; color: #38a169; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }' +
'        .admin-toast.error .admin-toast-icon { background: #fff5f5; color: #e53e3e; }' +
'        .admin-toast-icon svg { width: 18px; height: 18px; }' +
'        .admin-toast-title { font-weight: 700; font-size: 13px; color: #1a202c; margin-bottom: 2px; }' +
'        .admin-toast-message { font-size: 12px; color: #718096; line-height: 1.4; }' +
'        .admin-toast-progress { position: absolute; bottom: 0; left: 0; height: 3px; background: #38a169; animation: toastshrink 4s linear forwards; }' +
'        .admin-toast.error .admin-toast-progress { background: #e53e3e; }' +
'        @keyframes toastshrink { from { width: 100%; } to { width: 0%; } }' +
'        .admin-spinner { width: 13px; height: 13px; border: 2px solid rgba(255,255,255,.4); border-top-color: #fff; border-radius: 50%; display: inline-block; animation: adminspin .7s linear infinite; margin-right: 6px; vertical-align: middle; }' +
'        @keyframes adminspin { to { transform: rotate(360deg); } }' +
'        .pagination-bar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 14px 4px 4px; }' +
'        .pagination-info { font-size: 13px; color: #718096; }' +
'        .pagination-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }' +
'        .page-btn { min-width: 34px; height: 34px; padding: 0 10px; border: 1px solid #e2e8f0; background: #fff; color: #4a5568; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }' +
'        .page-btn:hover:not(:disabled) { background: #f7fafc; }' +
'        .page-btn.active { background: #0056b3; border-color: #0056b3; color: #fff; }' +
'        .page-btn:disabled { opacity: .5; cursor: not-allowed; }' +
'        .page-ellipsis { padding: 0 4px; color: #a0aec0; font-size: 13px; }' +
'    </style>' +
'</head>' +
'<body>' +
'    <div class="confirm-overlay" id="confirmOverlay">' +
'        <div class="confirm-box">' +
'            <p id="confirmMessage"></p>' +
'            <input type="text" id="confirmInput" style="display:none;width:100%;padding:10px;border:1px solid #cbd5e0;border-radius:6px;font-size:14px;margin-bottom:16px;">' +
'            <select id="confirmStaffSelect" style="display:none;width:100%;padding:10px;border:1px solid #cbd5e0;border-radius:6px;font-size:14px;margin-bottom:16px;"></select>' +
'            <div class="confirm-actions">' +
'                <button class="confirm-cancel-btn" onclick="closeConfirmModal(false)">Cancel</button>' +
'                <button class="confirm-ok-btn" id="confirmOkBtn" onclick="closeConfirmModal(true)">Confirm</button>' +
'            </div>' +
'        </div>' +
'    </div>' +
'    <div id="adminToast" class="admin-toast"></div>' +
'    <div class="sidebar-backdrop" id="sidebarBackdrop" onclick="closeSidebar()"></div>' +
'    <aside class="sidebar" id="sidebar">' +
'        <div class="sidebar-scroll">' +
'            <div class="sidebar-brand" style="cursor:pointer;" onclick="window.location.href=\'/admin\'" title="Refresh dashboard">' +
'                <img src="/logo.png" alt="Logo" class="sidebar-logo" onerror="this.style.display=\'none\'">' +
'                <span class="sidebar-title">SARATHY IT</span>' +
'            </div>' +
'            <div class="menu-category">Navigation</div>' +
'            <ul class="sidebar-menu">' +
'                <li class="menu-item active" id="tabTicketsLink" onclick="refreshTicketsDashboard()"><svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v2z"></path><line x1="13" y1="5" x2="13" y2="19"></line></svg>Tickets System</li>' +
(isSuperAdminUser ? '                <li class="menu-item" id="tabAdminsLink" onclick="switchView(\'admins\')"><svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3 6 6.5 1-5 4.5 1.5 6.5-6-3.5-6 3.5 1.5-6.5-5-4.5 6.5-1z"></path></svg>Manage Admins</li>' : '') +
(isAdminUser ? '                <li class="menu-item" id="tabBranchesLink" onclick="switchView(\'branches\')"><svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>Manage Branches</li>' : '') +
(isAdminUser ? '                <li class="menu-item" id="tabStaffLink" onclick="switchView(\'staff\')"><svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>Manage IT Staff</li>' : '') +
(isAdminUser ? '                <li class="menu-item" id="tabAuditLink" onclick="switchView(\'audit\')"><svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>Audit Log</li>' : '') +
'                <li class="menu-item" id="tabReportsLink" onclick="switchView(\'reports\')"><svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>Reports</li>' +
'                <li class="menu-item" id="tabInboxLink" onclick="switchView(\'inbox\')"><svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"></path><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path></svg>Inbox<span id="inboxUnreadBadge" style="display:none;margin-left:auto;background:#e53e3e;color:#fff;font-size:10px;font-weight:700;border-radius:10px;min-width:16px;height:16px;padding:0 5px;align-items:center;justify-content:center;"></span></li>' +
'                <li class="menu-item" id="tabPasswordLink" onclick="switchView(\'password\')"><svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>Change Password</li>' +
'            </ul>' +
'        </div>' +
'        <div class="sidebar-footer">' +
'            <div class="user-info">' +
'                <span>Logged in as</span>' +
'                <strong id="displayUserLabel">Loading...</strong>' +
'            </div>' +
'            <a href="/logout" class="logout-btn" id="logoutBtn" onclick="handleLogoutClick()">Logout</a>' +
'        </div>' +
'    </aside>' +
'    <main class="main-content">' +
'        <header class="top-navbar">' +
'            <button class="hamburger-btn" onclick="toggleSidebar()" aria-label="Menu"><span></span><span></span><span></span></button>' +
'            <h1 class="page-title" id="panelViewTitle">Helpdesk Operations</h1>' +
'            <div class="notification-wrap"><button type="button" class="notification-btn" onclick="toggleNotifications(event)" aria-label="Notifications"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg><span id="notificationCount" class="notification-count">0</span></button><div id="notificationMenu" class="notification-menu"><div class="notification-head" style="display:flex;align-items:center;justify-content:space-between;">Notifications <button type="button" onclick="clearAllNotifications()" style="background:none;border:none;color:#e53e3e;font-size:12px;font-weight:600;cursor:pointer;padding:0;">Clear</button></div><div id="notificationList" class="notification-empty">No notifications.</div></div></div>' +
'        </header>' +
'        <section class="content-body">' +
'            <div id="viewTickets" class="dashboard-view active">' +
'                <div class="metrics-grid">' +
'                    <div class="metric-card" onclick="filterByStatus(\'Open\')"><div class="metric-icon-badge metric-icon-blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg></div><div class="metric-label">Open Issues</div><div class="metric-value" id="statOpen">0</div><div class="metric-subtitle">Needs attention</div></div>' +
'                    <div class="metric-card resolved" onclick="filterByStatus(\'Resolved\')"><div class="metric-icon-badge metric-icon-green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg></div><div class="metric-label">Resolved Issues</div><div class="metric-value" id="statResolved">0</div><div class="metric-subtitle">Completed successfully</div></div>' +
'                    <div class="metric-card escalated" onclick="filterByStatus(\'Escalated\')"><div class="metric-icon-badge metric-icon-amber"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg></div><div class="metric-label">Escalated Tickets</div><div class="metric-value" id="statEscalated">0</div><div class="metric-subtitle">Needs admin action</div></div>' +
'                    <div class="metric-card assigned" onclick="filterByStatus(\'all\')"><div class="metric-icon-badge metric-icon-red"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v2z"></path><line x1="13" y1="5" x2="13" y2="19"></line></svg></div><div class="metric-label">Total Tickets</div><div class="metric-value" id="statMine">0</div><div class="metric-subtitle">All requests in scope</div></div>' +
'                </div>' +
'                <div style="margin-bottom: 12px;">' +
'                    <button type="button" id="toggleFilterBtn" class="branch-add-btn" onclick="toggleFilterPanel()" style="display:inline-flex; align-items:center; gap:8px; padding: 9px 18px;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>Filters</button>' +
'                </div>' +
'                <div class="branch-panel-card" id="ticketFilterPanel" style="display:none; margin-bottom: 20px; align-items: flex-end; gap: 14px; flex-wrap: wrap;">' +
'                    <div style="flex-grow: 1; min-width: 220px;"><label style="display:block;font-size:12px;font-weight:600;color:#4a5568;margin-bottom:4px;">Search</label><input type="text" id="filterSearchText" placeholder="Ticket #, Submitted By, Branch, Mobile..." style="width:100%; padding: 8px 10px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px;" onkeydown="if(event.key===\'Enter\') applyTicketFilters();"></div>' +
'                    <div><label style="display:block;font-size:12px;font-weight:600;color:#4a5568;margin-bottom:4px;">From Date</label><input type="date" id="filterFromDate" style="padding: 8px 10px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px;"></div>' +
'                    <div><label style="display:block;font-size:12px;font-weight:600;color:#4a5568;margin-bottom:4px;">To Date</label><input type="date" id="filterToDate" style="padding: 8px 10px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px;"></div>' +
'                    <div id="staffFilterWrapper" style="display:none;"><label style="display:block;font-size:12px;font-weight:600;color:#4a5568;margin-bottom:4px;">Staff</label><select id="filterStaff" style="padding: 8px 10px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px;"><option value="">All Staff</option></select></div>' +
'                    <div id="regionFilterWrapper" style="display:none;"><label style="display:block;font-size:12px;font-weight:600;color:#4a5568;margin-bottom:4px;">Region</label><select id="filterRegion" style="padding: 8px 10px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px;"><option value="">All Regions</option></select></div>' +
'                    <div><label style="display:block;font-size:12px;font-weight:600;color:#4a5568;margin-bottom:4px;">Category</label><select id="filterCategory" style="padding: 8px 10px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px;"><option value="">All Categories</option><option value="Hardware">Hardware</option><option value="Software">Software</option><option value="Network">Network</option><option value="Printer">Printer</option><option value="Other">Other</option></select></div>' +
'                    <button class="branch-add-btn search-btn" id="searchTicketsBtn" onclick="applyTicketFilters()">Search</button>' +
'                    <button class="branch-delete-btn" onclick="clearTicketFilters()">Clear</button>' +
'                </div>' +
'                <div id="ticketList">Loading active queue...</div>' +
'                <div id="ticketPagination" class="pagination-bar" style="display:none;"></div>' +
'            </div>' +
'            <div id="viewReports" class="dashboard-view">' +
'                <div class="branch-panel-card" style="display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 20px;">' +
'                    <strong style="font-size: 14px; color: #2d3748;">Region:</strong>' +
'                    <select id="reportRegion" style="padding: 8px 10px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px;"><option value="">All Regions</option></select>' +
'                    <span style="font-size: 12px; color: #a0aec0;">Applies to both reports below</span>' +
'                </div>' +
'                <div class="branch-panel-card" style="display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 20px;">' +
'                    <strong style="font-size: 14px; color: #2d3748;">Monthly Report:</strong>' +
'                    <input type="month" id="reportMonth" style="padding: 8px 10px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px;">' +
'                    <button class="branch-add-btn" onclick="downloadReport()">Download Excel Report</button>' +
'                </div>' +
'                <div class="branch-panel-card" style="display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap;">' +
'                    <div><strong style="font-size: 14px; color: #2d3748; display:block; margin-bottom: 8px;">Date Range Report:</strong></div>' +
'                    <div><label style="display:block;font-size:12px;font-weight:600;color:#4a5568;margin-bottom:4px;">From Date</label><input type="date" id="reportFromDate" style="padding: 8px 10px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px;"></div>' +
'                    <div><label style="display:block;font-size:12px;font-weight:600;color:#4a5568;margin-bottom:4px;">To Date</label><input type="date" id="reportToDate" style="padding: 8px 10px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px;"></div>' +
'                    <button class="branch-add-btn" onclick="downloadReportByRange()">Download Excel Report</button>' +
'                </div>' +
'                <h3 class="section-heading">Performance Overview</h3>' +
'                <div class="chart-grid">' +
'                    <div class="chart-card"><h3>Tickets by Status</h3><canvas id="chartStatus"></canvas></div>' +
'                    <div class="chart-card"><h3>Tickets by Priority</h3><canvas id="chartPriority"></canvas></div>' +
'                    <div class="chart-card"><h3>Tickets by Category</h3><canvas id="chartCategory"></canvas></div>' +
'                    <div class="chart-card wide"><h3>Ticket Volume \u2014 Last 30 Days</h3><canvas id="chartTrend"></canvas></div>' +
(isAdminUser ? '                    <div class="chart-card"><h3>Tickets by Staff</h3><canvas id="chartStaff"></canvas></div>' : '') +
(isAdminUser ? '                    <div class="chart-card"><h3>Tickets by Branch</h3><canvas id="chartBranch"></canvas></div>' : '') +
'                </div>' +
'            </div>' +
'            <div id="viewChangePassword" class="dashboard-view">' +
'                <div class="branch-panel-card">' +
'                    <h2>Change Password</h2>' +
(isAdminUser ?
'                    <p style="color:#718096;font-size:14px;line-height:1.6;max-width:480px;">Admin password is set via the <code>ADMIN_PASSWORD</code> environment variable in your hosting dashboard (e.g. Render). Update it there and redeploy \u2014 it can\'t be changed from this page.</p>'
:
'                    <div style="max-width:360px;">' +
'                        <label style="display:block;font-size:12px;font-weight:600;color:#4a5568;margin-top:14px;margin-bottom:4px;">Current Password</label>' +
'                        <input type="password" id="currentPassword" style="width:100%;padding:10px;border:1px solid #cbd5e0;border-radius:6px;font-size:14px;">' +
'                        <label style="display:block;font-size:12px;font-weight:600;color:#4a5568;margin-top:14px;margin-bottom:4px;">New Password</label>' +
'                        <input type="password" id="newPassword" style="width:100%;padding:10px;border:1px solid #cbd5e0;border-radius:6px;font-size:14px;">' +
'                        <label style="display:block;font-size:12px;font-weight:600;color:#4a5568;margin-top:14px;margin-bottom:4px;">Confirm New Password</label>' +
'                        <input type="password" id="confirmPassword" style="width:100%;padding:10px;border:1px solid #cbd5e0;border-radius:6px;font-size:14px;">' +
'                        <button class="branch-add-btn" onclick="changePassword()" style="margin-top:16px;">Update Password</button>' +
'                    </div>'
) +
'                </div>' +
'            </div>' +
(isSuperAdminUser ?
'            <div id="viewAdmins" class="dashboard-view">' +
'                <div class="branch-panel-card" style="margin-bottom: 20px;">' +
'                    <h2>Add Region Admin</h2>' +
'                    <div class="branch-input-group">' +
'                        <input type="text" id="newAdminName" placeholder="Full Name">' +
'                        <input type="text" id="newAdminUsername" placeholder="Username">' +
'                        <input type="text" id="newAdminPassword" placeholder="Password">' +
'                        <select id="newAdminRegion" style="flex-grow: 1; padding: 12px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px;"><option value="" disabled selected>Select Region</option></select>' +
'                        <button class="branch-add-btn" id="addAdminBtn" onclick="addNewRegionAdmin()">Add Admin</button>' +
'                    </div>' +
'                </div>' +
'                <div class="branch-panel-card">' +
'                    <h2>Region Admins</h2>' +
'                    <table class="branch-table">' +
'                        <thead><tr><th>Name</th><th>Username</th><th>Region</th><th>Status</th><th>Edit</th><th>Delete</th></tr></thead>' +
'                        <tbody id="regionAdminsTableBody"></tbody>' +
'                    </table>' +
'                </div>' +
'            </div>'
: '') +
'            <div id="viewBranches" class="dashboard-view">' +
(isSuperAdminUser ?
'                <div class="branch-panel-card" style="margin-bottom: 20px;">' +
'                    <h2>Manage Regions</h2>' +
'                    <div class="branch-input-group">' +
'                        <input type="text" id="newRegionName" placeholder="Enter Region Name">' +
'                        <button class="branch-add-btn" id="addRegionBtn" onclick="addNewRegion()">Add Region</button>' +
'                    </div>' +
'                    <table class="branch-table">' +
'                        <thead><tr><th>Region Name</th><th>Edit</th><th>Delete</th></tr></thead>' +
'                        <tbody id="regionTableBody"></tbody>' +
'                    </table>' +
'                </div>'
: '') +
'                <div class="branch-panel-card">' +
'                    <h2>Create New Branch Location</h2>' +
'                    <div class="branch-input-group">' +
'                        <input type="text" id="newBranchName" placeholder="Enter Branch Name">' +
(isSuperAdminUser ?
'                        <select id="newBranchRegion" style="flex-grow: 1; padding: 12px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px;"><option value="" disabled selected>Select Region</option></select>'
:
'                        <input type="text" value="' + (req.session.region || '') + '" disabled style="flex-grow: 1; padding: 12px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px; background:#f1f0ee; color:#718096;">'
) +
'                        <button class="branch-add-btn" id="addBranchBtn" onclick="addNewBranch()">Add Branch</button>' +
'                    </div>' +
'                    <div id="branchGroupsContainer"></div>' +
'                </div>' +
'            </div>' +
'            <div id="viewStaff" class="dashboard-view">' +
'                <div class="branch-panel-card" style="margin-bottom: 20px;">' +
'                    <h2>Add New Staff Member</h2>' +
'                    <div class="branch-input-group">' +
'                        <input type="text" id="newStaffName" placeholder="Full Name">' +
'                        <input type="text" id="newStaffId" placeholder="Staff ID (optional)">' +
'                        <input type="text" id="newStaffPassword" placeholder="Password">' +
'                        <input type="email" id="newStaffEmail" placeholder="Email">' +
(isSuperAdminUser ?
'                        <select id="newStaffRegion" style="flex-grow: 1; padding: 12px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px;"><option value="">Unassigned (global)</option></select>'
: '') +
'                        <button class="branch-add-btn" id="addStaffBtn" onclick="addNewStaff()">Add Staff</button>' +
'                    </div>' +
'                </div>' +
'                <div class="branch-panel-card">' +
'                    <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:20px;">' +
'                        <h2 style="margin-bottom:0;">Active Helpdesk Personnel</h2>' +
'                        <input type="text" id="staffSearchInput" placeholder="Search by name, staff ID, email, or region..." oninput="renderStaffTable()" style="padding: 8px 12px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 13px; width: 300px; max-width: 100%;">' +
'                    </div>' +
'                    <table class="branch-table">' +
'                        <thead><tr><th>Staff ID</th><th>Name Tag</th><th>Operational Route Email</th>' + (isSuperAdminUser ? '<th>Region</th>' : '') + '<th>Assigned Branches</th><th>Edit</th><th>Delete</th></tr></thead>' +
'                        <tbody id="staffTableBody"></tbody>' +
'                    </table>' +
'                </div>' +
'            </div>' +
'            <div id="viewAuditLog" class="dashboard-view">' +
'                <div class="branch-panel-card">' +
'                    <h2>Recent Admin Activity</h2>' +
'                    <table class="branch-table">' +
'                        <thead><tr><th>Timestamp</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead>' +
'                        <tbody id="auditLogTableBody"></tbody>' +
'                    </table>' +
'                </div>' +
'            </div>' +
'            <div id="viewInbox" class="dashboard-view">' +
(isAdminUser ? '' :
'                <div class="branch-panel-card" style="margin-bottom: 20px;">' +
'                    <h2>Send a Message to Admin</h2>' +
'                    <div style="max-width:520px;">' +
'                        <label style="display:block;font-size:12px;font-weight:600;color:#4a5568;margin-bottom:4px;">Subject</label>' +
'                        <input type="text" id="inboxSubject" style="width:100%;padding:10px;border:1px solid #cbd5e0;border-radius:6px;font-size:14px;margin-bottom:12px;">' +
'                        <label style="display:block;font-size:12px;font-weight:600;color:#4a5568;margin-bottom:4px;">Message</label>' +
'                        <textarea id="inboxBody" rows="4" style="width:100%;padding:10px;border:1px solid #cbd5e0;border-radius:6px;font-size:14px;resize:vertical;"></textarea>' +
'                        <button class="branch-add-btn" id="sendInboxBtn" onclick="sendInboxMessage()" style="margin-top:12px;">Send Message</button>' +
'                    </div>' +
'                </div>'
) +
'                <div id="inboxList">Loading messages...</div>' +
'            </div>' +
'        </section>' +
'    </main>' +
'    <script>' +
'        const currentUser = "' + dynamicUsername + '";' +
'        const isAdmin = ' + dynamicIsAdmin + ';' +
'        const isSuperAdmin = ' + dynamicIsSuperAdmin + ';' +
'        document.getElementById("displayUserLabel").innerText = currentUser;' +
'        let knownNotificationIds = new Set();' +
'        let notificationsInitialized = false;' +
'        let notifAudioCtx = null;' +
'        function playNotificationSound() {' +
'            try {' +
'                if (!notifAudioCtx) notifAudioCtx = new (window.AudioContext || window.webkitAudioContext)();' +
'                const ctx = notifAudioCtx;' +
'                const now = ctx.currentTime;' +
'                [880, 1175].forEach((freq, i) => {' +
'                    const osc = ctx.createOscillator();' +
'                    const gain = ctx.createGain();' +
'                    osc.type = "square";' +
'                    osc.frequency.value = freq;' +
'                    const start = now + i * 0.15;' +
'                    gain.gain.setValueAtTime(0.0001, start);' +
'                    gain.gain.exponentialRampToValueAtTime(0.5, start + 0.02);' +
'                    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);' +
'                    osc.connect(gain);' +
'                    gain.connect(ctx.destination);' +
'                    osc.start(start);' +
'                    osc.stop(start + 0.25);' +
'                });' +
'            } catch (err) { console.warn("Notification sound could not play."); }' +
'        }' +
'        function toggleNotifications(event) {' +
'            if (event) event.stopPropagation();' +
'            const menu = document.getElementById("notificationMenu");' +
'            menu.classList.toggle("show");' +
'        }' +
'        document.addEventListener("click", (e) => {' +
'            const wrap = document.querySelector(".notification-wrap");' +
'            const menu = document.getElementById("notificationMenu");' +
'            if (menu && menu.classList.contains("show") && wrap && !wrap.contains(e.target)) {' +
'                menu.classList.remove("show");' +
'            }' +
'        });' +
'        async function markNotificationRead(id) {' +
'            await fetch("/notifications/" + id + "/read", { method: "POST" });' +
'            loadNotifications();' +
'        }' +
'        async function clearAllNotifications() {' +
'            await fetch("/notifications", { method: "DELETE" });' +
'            loadNotifications();' +
'        }' +
'        async function loadNotifications() {' +
'            try {' +
'                const response = await fetch("/notifications");' +
'                if (!response.ok) return;' +
'                const notifications = await response.json();' +
'                const unread = notifications.filter(n => !n.read);' +
'                const count = document.getElementById("notificationCount");' +
'                count.innerText = unread.length > 99 ? "99+" : unread.length;' +
'                count.style.display = unread.length ? "flex" : "none";' +
'                const list = document.getElementById("notificationList");' +
'                list.innerHTML = notifications.length ? notifications.map(n => \'<div class="notification-item \'+(!n.read ? "unread" : "")+\'"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;"><div><strong>Ticket #\'+String(n.ticketNumber).padStart(4,"0")+\' assigned</strong>\'+n.message+\'<br><small>\'+new Date(n.createdAt).toLocaleString()+\'</small></div>\'+(!n.read ? \'<button onclick="markNotificationRead(\\\'\'+n._id+\'\\\')" style="flex-shrink:0;background:none;border:1px solid #cbd5e0;border-radius:5px;padding:3px 8px;font-size:10px;font-weight:600;color:#4a5568;cursor:pointer;">Mark as read</button>\' : "")+\'</div></div>\').join("") : \'<div class="notification-empty">No notifications.</div>\';' +
'                const newUnread = unread.filter(n => !knownNotificationIds.has(n._id));' +
'                if (newUnread.length && notificationsInitialized) { playNotificationSound(); showAdminToast(newUnread[0].message); }' +
'                notifications.forEach(n => knownNotificationIds.add(n._id));' +
'                notificationsInitialized = true;' +
'            } catch (err) { console.warn("Could not load notifications."); }' +
'        }' +
'        let inactivityTimer = null;' +
'        function resetInactivityTimer() {' +
'            clearTimeout(inactivityTimer);' +
'            inactivityTimer = setTimeout(() => { window.location.href = "/logout"; }, 4 * 60 * 60 * 1000);' +
'        }' +
'        function handleLogoutClick() {' +
'            document.getElementById("logoutBtn").innerHTML = \'<span class="admin-spinner"></span>Logging out...\';' +
'        }' +
'        ["mousemove", "keydown", "click", "scroll", "touchstart"].forEach(evt => {' +
'            document.addEventListener(evt, resetInactivityTimer);' +
'        });' +
'        resetInactivityTimer();' +
'        function toggleSidebar() {' +
'            document.getElementById("sidebar").classList.toggle("sidebar-open");' +
'            document.getElementById("sidebarBackdrop").classList.toggle("active");' +
'        }' +
'        function closeSidebar() {' +
'            document.getElementById("sidebar").classList.remove("sidebar-open");' +
'            document.getElementById("sidebarBackdrop").classList.remove("active");' +
'        }' +
'        let confirmCallback = null;' +
'        let confirmHasInput = false;' +
'        let confirmHasSelect = false;' +
'        function showConfirmModal(message, callback, okLabel) {' +
'            document.getElementById("confirmMessage").innerText = message;' +
'            document.getElementById("confirmOkBtn").innerText = okLabel || "Confirm";' +
'            document.getElementById("confirmInput").style.display = "none";' +
'            document.getElementById("confirmStaffSelect").style.display = "none";' +
'            confirmHasInput = false;' +
'            confirmHasSelect = false;' +
'            confirmCallback = callback;' +
'            document.getElementById("confirmOverlay").classList.add("show");' +
'        }' +
'        function showPromptModal(message, defaultValue, callback, okLabel) {' +
'            document.getElementById("confirmMessage").innerText = message;' +
'            document.getElementById("confirmOkBtn").innerText = okLabel || "Save";' +
'            const input = document.getElementById("confirmInput");' +
'            input.style.display = "block";' +
'            document.getElementById("confirmStaffSelect").style.display = "none";' +
'            input.value = defaultValue || "";' +
'            confirmHasInput = true;' +
'            confirmHasSelect = false;' +
'            confirmCallback = callback;' +
'            document.getElementById("confirmOverlay").classList.add("show");' +
'            setTimeout(() => input.focus(), 50);' +
'        }' +
'        function showStaffSelectModal(message, staffList, callback, okLabel) {' +
'            document.getElementById("confirmMessage").innerText = message;' +
'            document.getElementById("confirmOkBtn").innerText = okLabel || "Reallocate";' +
'            document.getElementById("confirmInput").style.display = "none";' +
'            const select = document.getElementById("confirmStaffSelect");' +
'            select.style.display = "block";' +
'            select.innerHTML = \'<option value="" disabled selected>Select staff member</option>\';' +
'            staffList.forEach(s => { select.innerHTML += \'<option value="\'+s.name+\'">\'+s.name+\'</option>\'; });' +
'            confirmHasInput = false;' +
'            confirmHasSelect = true;' +
'            confirmCallback = callback;' +
'            document.getElementById("confirmOverlay").classList.add("show");' +
'        }' +
'        function closeConfirmModal(confirmed) {' +
'            const inputValue = document.getElementById("confirmInput").value;' +
'            const selectValue = document.getElementById("confirmStaffSelect").value;' +
'            const hadInput = confirmHasInput;' +
'            const hadSelect = confirmHasSelect;' +
'            document.getElementById("confirmOverlay").classList.remove("show");' +
'            const cb = confirmCallback;' +
'            confirmCallback = null;' +
'            if (confirmed && cb) {' +
'                if (hadSelect) { if (selectValue) cb(selectValue); }' +
'                else if (hadInput) { cb(inputValue); }' +
'                else { cb(); }' +
'            }' +
'        }' +
'        let adminToastTimer = null;' +
'        function showAdminToast(message, isError) {' +
'            const toast = document.getElementById("adminToast");' +
'            const iconSvg = isError' +
'                ? \'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>\'' +
'                : \'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>\';' +
'            toast.innerHTML =' +
'                \'<div class="admin-toast-icon">\' + iconSvg + \'</div>\' +' +
'                \'<div class="admin-toast-text"><div class="admin-toast-title">\' + (isError ? "Error" : "Success") + \'</div><div class="admin-toast-message">\' + message + \'</div></div>\' +' +
'                \'<div class="admin-toast-progress"></div>\';' +
'            toast.className = "admin-toast show" + (isError ? " error" : "");' +
'            clearTimeout(adminToastTimer);' +
'            adminToastTimer = setTimeout(() => { toast.classList.remove("show"); }, 4000);' +
'        }' +
'        function toggleFilterPanel() {' +
'            const panel = document.getElementById("ticketFilterPanel");' +
'            const btn = document.getElementById("toggleFilterBtn");' +
'            const isOpen = panel.style.display !== "none";' +
'            panel.style.display = isOpen ? "none" : "flex";' +
'            if (btn) btn.innerHTML = (isOpen ? \'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>Filters\' : \'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>Hide Filters\');' +
'        }' +
'        function refreshTicketsDashboard() {' +
'            currentStatusFilter = "default-view";' +
'            currentPage = 1;' +
'            const fromEl = document.getElementById("filterFromDate"); if (fromEl) fromEl.value = "";' +
'            const toEl = document.getElementById("filterToDate"); if (toEl) toEl.value = "";' +
'            const catEl = document.getElementById("filterCategory"); if (catEl) catEl.value = "";' +
'            const sfEl = document.getElementById("filterStaff"); if (sfEl) sfEl.value = "";' +
'            const rfEl = document.getElementById("filterRegion"); if (rfEl) rfEl.value = "";' +
'            const searchEl = document.getElementById("filterSearchText"); if (searchEl) searchEl.value = "";' +
'            switchView("tickets");' +
'        }' +
'        function switchView(target) {' +
'            closeSidebar();' +
'            if ((target === "branches" || target === "staff" || target === "audit") && !isAdmin) {' +
'                alert("Access Denied: Admins only.");' +
'                return;' +
'            }' +
'            if (target === "admins" && !isSuperAdmin) {' +
'                alert("You are not authorized to access this page.");' +
'                return;' +
'            }' +
'            const mainContentEl = document.querySelector(".main-content");' +
'            if (mainContentEl) mainContentEl.scrollTop = 0;' +
'            document.querySelectorAll(".dashboard-view").forEach(el => el.classList.remove("active"));' +
'            document.querySelectorAll(".menu-item").forEach(el => el.classList.remove("active"));' +
'            if (target === "tickets") {' +
'                document.getElementById("viewTickets").classList.add("active");' +
'                document.getElementById("tabTicketsLink").classList.add("active");' +
'                document.getElementById("panelViewTitle").innerText = "Helpdesk Operations";' +
'                loadTickets();' +
'            } else if (target === "reports") {' +
'                document.getElementById("viewReports").classList.add("active");' +
'                document.getElementById("tabReportsLink").classList.add("active");' +
'                document.getElementById("panelViewTitle").innerText = "Monthly Reports";' +
'                loadReportCharts();' +
'            } else if (target === "password") {' +
'                document.getElementById("viewChangePassword").classList.add("active");' +
'                document.getElementById("tabPasswordLink").classList.add("active");' +
'                document.getElementById("panelViewTitle").innerText = "Change Password";' +
'            } else if (target === "branches") {' +
'                document.getElementById("viewBranches").classList.add("active");' +
'                document.getElementById("tabBranchesLink").classList.add("active");' +
'                document.getElementById("panelViewTitle").innerText = "Company Branches Layout";' +
'                loadRegionsList();' +
'                loadBranchesList();' +
'            } else if (target === "staff") {' +
'                document.getElementById("viewStaff").classList.add("active");' +
'                document.getElementById("tabStaffLink").classList.add("active");' +
'                document.getElementById("panelViewTitle").innerText = "Manage IT Staff Profile Queue";' +
'                loadStaffList();' +
'            } else if (target === "audit") {' +
'                document.getElementById("viewAuditLog").classList.add("active");' +
'                document.getElementById("tabAuditLink").classList.add("active");' +
'                document.getElementById("panelViewTitle").innerText = "Recent Admin Activity";' +
'                loadAuditLog();' +
'            } else if (target === "admins") {' +
'                document.getElementById("viewAdmins").classList.add("active");' +
'                document.getElementById("tabAdminsLink").classList.add("active");' +
'                document.getElementById("panelViewTitle").innerText = "Manage Region Admins";' +
'                loadRegionAdminsList();' +
'            } else if (target === "inbox") {' +
'                document.getElementById("viewInbox").classList.add("active");' +
'                document.getElementById("tabInboxLink").classList.add("active");' +
'                document.getElementById("panelViewTitle").innerText = "Inbox";' +
'                loadInbox();' +
'            }' +
'        }' +
'        let currentStatusFilter = "default-view";' +
'        let currentPage = 1;' +
'        const PAGE_SIZE = 10;' +
'        function filterByStatus(status) {' +
'            currentStatusFilter = status;' +
'            currentPage = 1;' +
'            loadTickets();' +
'        }' +
'        async function applyTicketFilters() {' +
'            const btn = document.getElementById("searchTicketsBtn");' +
'            const defaultHTML = btn.innerHTML;' +
'            btn.disabled = true;' +
'            btn.innerHTML = \'<span class="admin-spinner"></span>Searching...\';' +
'            currentPage = 1;' +
'            await loadTickets();' +
'            btn.disabled = false;' +
'            btn.innerHTML = defaultHTML;' +
'        }' +
'        function clearTicketFilters() {' +
'            document.getElementById("filterFromDate").value = "";' +
'            document.getElementById("filterToDate").value = "";' +
'            document.getElementById("filterCategory").value = "";' +
'            const sf = document.getElementById("filterStaff");' +
'            if (sf) sf.value = "";' +
'            const rf = document.getElementById("filterRegion");' +
'            if (rf) rf.value = "";' +
'            const searchEl = document.getElementById("filterSearchText");' +
'            if (searchEl) searchEl.value = "";' +
'            currentStatusFilter = "default-view";' +
'            currentPage = 1;' +
'            loadTickets();' +
'        }' +
'        function goToPage(page) {' +
'            currentPage = page;' +
'            loadTickets();' +
'            const mainContentEl = document.querySelector(".main-content");' +
'            if (mainContentEl) mainContentEl.scrollTop = 0;' +
'        }' +
'        function renderPagination(totalItems) {' +
'            const bar = document.getElementById("ticketPagination");' +
'            const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));' +
'            if (currentPage > totalPages) currentPage = totalPages;' +
'            if (totalItems === 0) { bar.style.display = "none"; bar.innerHTML = ""; return; }' +
'            bar.style.display = "flex";' +
'            const startItem = (currentPage - 1) * PAGE_SIZE + 1;' +
'            const endItem = Math.min(currentPage * PAGE_SIZE, totalItems);' +
'            let pageButtonsHtml = \'<button class="page-btn" \'+(currentPage === 1 ? "disabled" : "")+\' onclick="goToPage(\'+(currentPage - 1)+\')">\u2190 Prev</button>\';' +
'            const addPageBtn = (p) => { pageButtonsHtml += \'<button class="page-btn \'+(p === currentPage ? "active" : "")+\'" onclick="goToPage(\'+p+\')">\'+p+\'</button>\'; };' +
'            const addEllipsis = () => { pageButtonsHtml += \'<span class="page-ellipsis">\u2026</span>\'; };' +
'            const windowSize = 1;' +
'            let lastPrinted = 0;' +
'            for (let p = 1; p <= totalPages; p++) {' +
'                const nearCurrent = Math.abs(p - currentPage) <= windowSize;' +
'                const isEdge = p === 1 || p === totalPages;' +
'                if (nearCurrent || isEdge) {' +
'                    if (p - lastPrinted > 1) addEllipsis();' +
'                    addPageBtn(p);' +
'                    lastPrinted = p;' +
'                }' +
'            }' +
'            pageButtonsHtml += \'<button class="page-btn" \'+(currentPage === totalPages ? "disabled" : "")+\' onclick="goToPage(\'+(currentPage + 1)+\')">Next \u2192</button>\';' +
'            bar.innerHTML = \'<div class="pagination-info">Showing \'+startItem+\' \u2013 \'+endItem+\' of \'+totalItems+\' entries</div><div class="pagination-controls">\'+pageButtonsHtml+\'</div>\';' +
'        }' +
'        async function loadStaffFilterOptions() {' +
'            if (!isAdmin) return;' +
'            document.getElementById("staffFilterWrapper").style.display = "block";' +
'            const res = await fetch("/tickets/staff-list");' +
'            const staff = await res.json();' +
'            const select = document.getElementById("filterStaff");' +
'            select.innerHTML = \'<option value="">All Staff</option>\';' +
'            staff.forEach(s => {' +
'                select.innerHTML += \'<option value="\'+s.name+\'">\'+s.name+\'</option>\';' +
'            });' +
'        }' +
'        async function loadRegionFilterOptions() {' +
'            if (!isAdmin) return;' +
'            const res = await fetch("/tickets/regions");' +
'            const regions = await res.json();' +
'            const filterWrapper = document.getElementById("regionFilterWrapper");' +
'            if (filterWrapper) filterWrapper.style.display = "block";' +
'            const filterSelect = document.getElementById("filterRegion");' +
'            if (filterSelect) {' +
'                filterSelect.innerHTML = \'<option value="">All Regions</option>\';' +
'                regions.forEach(r => { filterSelect.innerHTML += \'<option value="\'+r.name+\'">\'+r.name+\'</option>\'; });' +
'            }' +
'            const reportSelect = document.getElementById("reportRegion");' +
'            if (reportSelect) {' +
'                reportSelect.innerHTML = \'<option value="">All Regions</option>\';' +
'                regions.forEach(r => { reportSelect.innerHTML += \'<option value="\'+r.name+\'">\'+r.name+\'</option>\'; });' +
'            }' +
'        }' +
'        function sortOpenFirstThenResolvedByRecency(list) {' +
'            const openTickets = list.filter(t => t.status !== "Resolved");' +
'            const resolvedTickets = list.filter(t => t.status === "Resolved");' +
'            resolvedTickets.sort((a, b) => new Date(b.resolvedAt || 0) - new Date(a.resolvedAt || 0));' +
'            return openTickets.concat(resolvedTickets);' +
'        }' +
'        async function loadTickets() {' +
'            try {' +
'            const controller = new AbortController();' +
'            const timeout = setTimeout(() => controller.abort(), 15000);' +
'            const response = await fetch("/tickets", { signal: controller.signal });' +
'            clearTimeout(timeout);' +
'            if (response.status === 401) { window.location.href = "/login"; return; }' +
'            if (!response.ok) { throw new Error("Ticket request failed (" + response.status + ")"); }' +
'            let tickets = await response.json();' +
'            const staffFilterEl = document.getElementById("filterStaff");' +
'            const staffFilterValue = staffFilterEl ? staffFilterEl.value : "";' +
'            if (staffFilterValue) { tickets = tickets.filter(t => t.assignedTo === staffFilterValue); }' +
'            const regionFilterEl = document.getElementById("filterRegion");' +
'            const regionFilterValue = regionFilterEl ? regionFilterEl.value : "";' +
'            if (regionFilterValue) {' +
'                const branchRes = await fetch("/public-branches");' +
'                const allBranches = await branchRes.json();' +
'                const branchNamesInRegion = allBranches.filter(b => (b.region || "Unassigned") === regionFilterValue).map(b => b.name);' +
'                tickets = tickets.filter(t => branchNamesInRegion.includes(t.branch));' +
'            }' +
'            const categoryFilterValue = document.getElementById("filterCategory").value;' +
'            if (categoryFilterValue) { tickets = tickets.filter(t => (t.category || "Other") === categoryFilterValue); }' +
'            const searchTextValue = document.getElementById("filterSearchText").value.trim().toLowerCase();' +
'            if (searchTextValue) {' +
'                tickets = tickets.filter(t => {' +
'                    const ticketNumStr = String(t.ticketNumber || "").toLowerCase();' +
'                    const ticketNumPadded = String(t.ticketNumber || "").padStart(4, "0").toLowerCase();' +
'                    const submittedBy = (t.submittedBy || "").toLowerCase();' +
'                    const branch = (t.branch || "").toLowerCase();' +
'                    const mobile = (t.mobile || "").toLowerCase();' +
'                    return ticketNumStr.includes(searchTextValue) || ticketNumPadded.includes(searchTextValue) || submittedBy.includes(searchTextValue) || branch.includes(searchTextValue) || mobile.includes(searchTextValue);' +
'                });' +
'            }' +
'            const fromVal = document.getElementById("filterFromDate").value;' +
'            const toVal = document.getElementById("filterToDate").value;' +
'            if (fromVal) { const fromDate = new Date(fromVal + "T00:00:00"); tickets = tickets.filter(t => t.createdAt && new Date(t.createdAt) >= fromDate); }' +
'            if (toVal) { const toDate = new Date(toVal + "T23:59:59"); tickets = tickets.filter(t => t.createdAt && new Date(t.createdAt) <= toDate); }' +
'            document.getElementById("statOpen").innerText = tickets.filter(t => t.status === "Open").length;' +
'            document.getElementById("statResolved").innerText = tickets.filter(t => t.status === "Resolved").length;' +
'            document.getElementById("statEscalated").innerText = tickets.filter(t => t.escalated && t.status !== "Resolved").length;' +
'            document.getElementById("statMine").innerText = tickets.length;' +
'            if (currentStatusFilter === "default-view") { tickets = tickets.filter(t => t.status === "Open"); }' +
'            else if (currentStatusFilter === "Escalated") { tickets = tickets.filter(t => t.escalated); tickets = sortOpenFirstThenResolvedByRecency(tickets); }' +
'            else if (currentStatusFilter === "Resolved") { tickets = tickets.filter(t => t.status === "Resolved"); tickets.sort((a, b) => new Date(b.resolvedAt || 0) - new Date(a.resolvedAt || 0)); }' +
'            else if (currentStatusFilter === "all") { tickets = sortOpenFirstThenResolvedByRecency(tickets); }' +
'            else if (currentStatusFilter !== "all") { tickets = tickets.filter(t => t.status === currentStatusFilter); }' +
'            const totalFilteredCount = tickets.length;' +
'            const totalPages = Math.max(1, Math.ceil(totalFilteredCount / PAGE_SIZE));' +
'            if (currentPage > totalPages) currentPage = totalPages;' +
'            if (currentPage < 1) currentPage = 1;' +
'            const pageStart = (currentPage - 1) * PAGE_SIZE;' +
'            const pagedTickets = tickets.slice(pageStart, pageStart + PAGE_SIZE);' +
'            const listDiv = document.getElementById("ticketList");' +
'            if (pagedTickets.length === 0) {' +
'                listDiv.innerHTML = \'<p style="text-align: center; color: #718096; padding: 40px 0;">No support requests logs found.</p>\';' +
'                renderPagination(totalFilteredCount);' +
'                return;' +
'            }' +
'            let ticketCardsHtml = "";' +
'            pagedTickets.forEach(ticket => {' +
'                const isResolved = ticket.status === "Resolved";' +
'                const isMineOrAdmin = isAdmin || ticket.assignedTo === currentUser;' +
'                const reallocateBtn = (isAdmin && !isResolved && ticket.escalated) ? \'<button class="reallocate-btn" onclick="reallocateTicket(\\\'\'+ticket._id+\'\\\')">Reallocate</button>\' : "";' +
'                const actionBtn = (!isResolved && isMineOrAdmin) ? \'<button class="resolve-btn" onclick="resolveTicket(\\\'\'+ticket._id+\'\\\')">Resolve Ticket</button>\' : "";' +
'                const escalateBtn = (!isAdmin && !isResolved && !ticket.escalated && ticket.assignedTo === currentUser) ? \'<button class="escalate-btn" onclick="escalateTicket(\\\'\'+ticket._id+\'\\\')">Escalate to Admin</button>\' : "";' +
'                const waitingNote = (!isAdmin && !isResolved && !isMineOrAdmin) ? \'<span class="badge" style="background:#fef3c7;color:#92400e;">Waiting on Admin</span>\' : "";' +
'                const actionsHtml = (reallocateBtn || actionBtn || escalateBtn || waitingNote) ? \'<div class="ticket-actions">\'+reallocateBtn+actionBtn+escalateBtn+waitingNote+\'</div>\' : "";' +
'                const escalatedBadge = ticket.escalated ? \'<span class="badge badge-escalated">Escalated</span>\' : "";' +
'                const resolvedLine = (ticket.status === "Resolved" && ticket.resolvedAt) ? \'<div class="assignment-row"><span class="assignment-label">Resolved</span><span class="assignment-value">\'+new Date(ticket.resolvedAt).toLocaleString()+(ticket.resolvedBy ? \' by \'+ticket.resolvedBy : "")+\'</span></div>\' : "";' +
'                const escalationLine = ticket.escalated ? \'<div class="assignment-row"><span class="assignment-label">Escalation</span><span class="assignment-value">\'+ticket.status+\' (\'+(ticket.escalatedBy || "Staff")+\' escalated\'+(ticket.escalatedAt ? " on "+new Date(ticket.escalatedAt).toLocaleString() : "")+\')</span></div>\'+(ticket.escalationReason ? \'<div class="assignment-row"><span class="assignment-label">Reason</span><span class="assignment-value">\'+ticket.escalationReason+\'</span></div>\' : "") : "";' +
'                const cardStateClass = isResolved ? "ticket-resolved" : (ticket.priority === "High" ? "ticket-high-priority" : (ticket.escalated ? "ticket-escalated" : ""));' +
'                const imageHtml = ticket.screenshot ? \'<a href="\'+ticket.screenshot+\'" target="_blank"><img src="\'+ticket.screenshot+\'" class="screenshot-preview"></a>\' : "";' +
'                let commentListHtml = "";' +
'                if (ticket.comments) {' +
'                    ticket.comments.forEach(c => {' +
'                        commentListHtml += \'<div class="comment-item"><strong>\'+c.author+\':</strong> \'+c.text+(c.attachment ? \' <a href="\'+c.attachment+\'" target="_blank">\uD83D\uDCCE Attachment</a>\' : "")+\'</div>\';' +
'                    });' +
'                }' +
'                ticketCardsHtml += \'<div class="ticket-card \'+cardStateClass+\'"><div class="ticket-header"><div><h3 class="ticket-title">#\'+String(ticket.ticketNumber).padStart(4,"0")+\' \'+ticket.title+\'</h3><div style="margin-top: 8px;"><span class="badge p-\'+ticket.priority+\'">\'+ticket.priority+\'</span><span class="badge status-\'+ticket.status.toLowerCase()+\'">\'+ticket.status+\'</span><span class="badge badge-category">\'+(ticket.category || "Other")+\'</span>\'+escalatedBadge+\'</div></div>\'+actionsHtml+\'</div><p class="ticket-desc">\'+ticket.description+\'</p>\'+imageHtml+\'<div class="assignment-info"><div class="assignment-row"><span class="assignment-label">Submitted By</span><span class="assignment-value">\'+(ticket.submittedBy || "Unknown")+(ticket.designation ? " ("+ticket.designation+")" : "")+\'</span></div><div class="assignment-row"><span class="assignment-label">Branch</span><span class="assignment-value">\'+ticket.branch+\'</span></div><div class="assignment-row"><span class="assignment-label">Mobile</span><span class="assignment-value">\'+ticket.mobile+\'</span></div><div class="assignment-row"><span class="assignment-label">Assigned</span><span class="assignment-value">\'+ticket.assignedTo+\'</span></div><div class="assignment-row"><span class="assignment-label">Submitted</span><span class="assignment-value">\'+(ticket.createdAt ? new Date(ticket.createdAt).toLocaleString() : "N/A")+\'</span></div>\'+escalationLine+resolvedLine+\'</div><div class="comments-section"><h4 class="comments-header">Internal Work Notes</h4><div>\'+(commentListHtml || "No updates.")+\'</div><div class="comment-form"><input type="text" id="input-\'+ticket._id+\'" placeholder="Write operational update..."><label class="comment-attach-btn" title="Attach a file (optional)">📎<input type="file" id="attachment-\'+ticket._id+\'" style="display:none;" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,.jpg,.jpeg,.png,.webp,.gif,.pdf" onchange="updateAttachmentLabel(\\\'\'+ticket._id+\'\\\')"></label><span id="attachmentName-\'+ticket._id+\'" class="attachment-name-tag"></span><button onclick="addComment(\\\'\'+ticket._id+\'\\\')">Post</button></div></div></div>\';' +
'            });' +
'            listDiv.innerHTML = ticketCardsHtml;' +
'            renderPagination(totalFilteredCount);' +
'            } catch (err) {' +
'                console.error("Could not load tickets:", err);' +
'                const message = err.name === "AbortError" ? "Ticket loading timed out. Check that the MongoDB connection is available." : "Could not load tickets. Please refresh the page. If this continues, check the server connection.";' +
'                document.getElementById("ticketList").innerHTML = \'<p style="text-align:center;color:#c53030;padding:40px 0;">\'+message+\'</p>\';' +
'                document.getElementById("ticketPagination").style.display = "none";' +
'            }' +
'        }' +
'async function loadRegionsList() {' +
'    const response = await fetch("/tickets/regions");' +
'    const regions = await response.json();' +
'    const tbody = document.getElementById("regionTableBody");' +
'    if (tbody) {' +
'        if (regions.length === 0) {' +
'            tbody.innerHTML = \'<tr><td colspan="3" style="text-align: center; color: #a0aec0; padding: 20px;">No regions added yet.</td></tr>\';' +
'        } else {' +
'            let regionRowsHtml = "";' +
'            regions.forEach(r => {' +
'                const safeName = r.name.replace(/\'/g, "\\\\\'");' +
'                regionRowsHtml += \'<tr><td>\'+r.name+\'</td><td><button class="branch-delete-btn" onclick="editRegion(\\\'\'+r._id+\'\\\', \\\'\'+safeName+\'\\\')">Edit</button></td><td><button class="branch-delete-btn" onclick="deleteRegion(\\\'\'+r._id+\'\\\')">Delete</button></td></tr>\';' +
'            });' +
'            tbody.innerHTML = regionRowsHtml;' +
'        }' +
'    }' +
'    const select = document.getElementById("newBranchRegion");' +
'    if (select) {' +
'        let optionsHtml = \'<option value="" disabled selected>Select Region</option>\';' +
'        regions.forEach(r => {' +
'            optionsHtml += \'<option value="\'+r.name+\'">\'+r.name+\'</option>\';' +
'        });' +
'        select.innerHTML = optionsHtml;' +
'    }' +
'}' +
'async function addNewRegion() {' +
'    const input = document.getElementById("newRegionName");' +
'    const name = input.value.trim();' +
'    if (!name) return;' +
'    const btn = document.getElementById("addRegionBtn");' +
'    const defaultHTML = btn.innerHTML;' +
'    btn.disabled = true;' +
'    btn.innerHTML = \'<span class="admin-spinner"></span>Adding...\';' +
'    try {' +
'        const response = await fetch("/tickets/regions", {' +
'            method: "POST",' +
'            headers: { "Content-Type": "application/json" },' +
'            body: JSON.stringify({ name })' +
'        });' +
'        if (response.ok) {' +
'            input.value = "";' +
'            showAdminToast("Region added successfully.");' +
'            loadRegionsList();' +
'            loadBranchesList();' +
'        } else {' +
'            const err = await response.json();' +
'            showAdminToast(err.error || "Could not add region.", true);' +
'        }' +
'    } catch (err) {' +
'        showAdminToast("Something went wrong. Please try again.", true);' +
'    } finally {' +
'        btn.disabled = false;' +
'        btn.innerHTML = defaultHTML;' +
'    }' +
'}' +
'async function editRegion(id, currentName) {' +
'    showPromptModal("Edit region name:", currentName, async (newName) => {' +
'        if (!newName || !newName.trim() || newName === currentName) return;' +
'        const response = await fetch("/tickets/regions/" + id, {' +
'            method: "PUT",' +
'            headers: { "Content-Type": "application/json" },' +
'            body: JSON.stringify({ name: newName.trim() })' +
'        });' +
'        if (response.ok) { showAdminToast("Region updated successfully."); loadRegionsList(); loadBranchesList(); }' +
'        else { const err = await response.json(); showAdminToast(err.error || "Could not update region.", true); }' +
'    }, "Save");' +
'}' +
'async function deleteRegion(id) {' +
'    showConfirmModal("Remove this region?", async () => {' +
'        const response = await fetch("/tickets/regions/" + id, { method: "DELETE" });' +
'        if (response.ok) { showAdminToast("Region removed."); loadRegionsList(); loadBranchesList(); }' +
'        else { const err = await response.json(); showAdminToast(err.error || "Could not delete region.", true); }' +
'    }, "Delete");' +
'}' +
'async function loadBranchesList() {' +
'    const [branchRes, regionRes] = await Promise.all([fetch("/public-branches"), fetch("/tickets/regions")]);' +
'    const branches = await branchRes.json();' +
'    const regions = await regionRes.json();' +
'    const allRegionNames = regions.map(r => r.name);' +
'    if (allRegionNames.indexOf("Unassigned") === -1) allRegionNames.push("Unassigned");' +
'    const container = document.getElementById("branchGroupsContainer");' +
'    if (branches.length === 0) {' +
'        container.innerHTML = \'<p style="text-align: center; color: #a0aec0; padding: 20px;">No branch locations added yet.</p>\';' +
'        return;' +
'    }' +
'    const groups = {};' +
'    branches.forEach(b => {' +
'        const region = b.region || "Unassigned";' +
'        if (!groups[region]) groups[region] = [];' +
'        groups[region].push(b);' +
'    });' +
'    let groupsHtml = "";' +
'    Object.keys(groups).sort().forEach(region => {' +
'        let rowsHtml = "";' +
'        groups[region].forEach(b => {' +
'            const safeName = b.name.replace(/\'/g, "\\\\\'");' +
'            let regionOptionsHtml = "";' +
'            allRegionNames.forEach(rn => {' +
'                regionOptionsHtml += \'<option value="\'+rn+\'"\'+(rn === region ? \' selected\' : \'\')+\'>\'+rn+\'</option>\';' +
'            });' +
'            rowsHtml += \'<tr><td>\'+b.name+\'</td><td><select onchange="moveBranchRegion(\\\'\'+b._id+\'\\\', this.value)" style="padding:6px;border:1px solid #cbd5e0;border-radius:4px;font-size:13px;">\'+regionOptionsHtml+\'</select></td><td><button class="branch-delete-btn" onclick="editBranch(\\\'\'+b._id+\'\\\', \\\'\'+safeName+\'\\\')">Edit</button></td><td><button class="branch-delete-btn" onclick="deleteBranch(\\\'\'+b._id+\'\\\')">Delete</button></td></tr>\';' +
'        });' +
'        groupsHtml +=' +
'            \'<h3 style="margin: 20px 0 8px; font-size: 14px; font-weight: 700; color: #4a5568; text-transform: uppercase; letter-spacing: 0.5px;">\' + region + \'</h3>\' +' +
'            \'<table class="branch-table"><thead><tr><th>Branch Name</th><th>Region</th><th>Edit</th><th>Delete</th></tr></thead><tbody>\' + rowsHtml + \'</tbody></table>\';' +
'    });' +
'    container.innerHTML = groupsHtml;' +
'}' +
'async function addNewBranch() {' +
'    const input = document.getElementById("newBranchName");' +
'    const regionSelect = document.getElementById("newBranchRegion");' +
'    const name = input.value.trim();' +
'    const region = regionSelect ? regionSelect.value : "";' +
'    if (!name || (isSuperAdmin && !region)) { showAdminToast("Please enter a branch name and select a region.", true); return; }' +
'    const btn = document.getElementById("addBranchBtn");' +
'    const defaultHTML = btn.innerHTML;' +
'    btn.disabled = true;' +
'    btn.innerHTML = \'<span class="admin-spinner"></span>Adding...\';' +
'    try {' +
'        const response = await fetch("/tickets/branches", {' +
'            method: "POST",' +
'            headers: { "Content-Type": "application/json" },' +
'            body: JSON.stringify({ name, region })' +
'        });' +
'        if (response.ok) {' +
'            input.value = "";' +
'            if (regionSelect) regionSelect.value = "";' +
'            showAdminToast("Branch added successfully.");' +
'            loadBranchesList();' +
'        } else {' +
'            const err = await response.json();' +
'            showAdminToast(err.error || "Could not add branch.", true);' +
'        }' +
'    } catch (err) {' +
'        showAdminToast("Something went wrong. Please try again.", true);' +
'    } finally {' +
'        btn.disabled = false;' +
'        btn.innerHTML = defaultHTML;' +
'    }' +
'}' +
'async function editBranch(id, currentName) {' +
'    showPromptModal("Edit branch name:", currentName, async (newName) => {' +
'        if (!newName || !newName.trim() || newName === currentName) return;' +
'        const response = await fetch("/tickets/branches/" + id, {' +
'            method: "PUT",' +
'            headers: { "Content-Type": "application/json" },' +
'            body: JSON.stringify({ name: newName.trim() })' +
'        });' +
'        if (response.ok) { showAdminToast("Branch updated successfully."); loadBranchesList(); }' +
'        else { showAdminToast("Could not update branch.", true); }' +
'    }, "Save");' +
'}' +
'async function deleteBranch(id) {' +
'    showConfirmModal("Remove this branch option?", async () => {' +
'        const response = await fetch("/tickets/branches/" + id, { method: "DELETE" });' +
'        if(response.ok) { showAdminToast("Branch removed."); loadBranchesList(); }' +
'        else { showAdminToast("Could not delete branch.", true); }' +
'    }, "Delete");' +
'}' +
'async function moveBranchRegion(id, newRegion) {' +
'    const response = await fetch("/tickets/branches/" + id, {' +
'        method: "PUT",' +
'        headers: { "Content-Type": "application/json" },' +
'        body: JSON.stringify({ region: newRegion })' +
'    });' +
'    if (response.ok) { showAdminToast("Branch moved to " + newRegion + "."); loadBranchesList(); }' +
'    else { showAdminToast("Could not move branch to that region.", true); }' +
'}' +
'        let cachedStaffList = [];' +
'        let cachedStaffBranches = [];' +
'        let cachedStaffAssignments = {};' +
'        let cachedRegionsForStaff = [];' +
'        async function loadStaffList() {' +
'            const requests = [fetch("/tickets/staff-list"), fetch("/public-branches"), fetch("/tickets/staff-branches")];' +
'            if (isSuperAdmin) requests.push(fetch("/tickets/regions"));' +
'            const responses = await Promise.all(requests);' +
'            cachedStaffList = await responses[0].json();' +
'            cachedStaffBranches = await responses[1].json();' +
'            cachedStaffAssignments = await responses[2].json();' +
'            if (isSuperAdmin) {' +
'                cachedRegionsForStaff = await responses[3].json();' +
'                const regionSelectEl = document.getElementById("newStaffRegion");' +
'                if (regionSelectEl && !regionSelectEl.dataset.loaded) {' +
'                    cachedRegionsForStaff.forEach(r => { regionSelectEl.innerHTML += \'<option value="\'+r.name+\'">\'+r.name+\'</option>\'; });' +
'                    regionSelectEl.dataset.loaded = "1";' +
'                }' +
'            }' +
'            renderStaffTable();' +
'        }' +
'        function renderStaffTable() {' +
'            const searchInput = document.getElementById("staffSearchInput");' +
'            const searchValue = searchInput ? searchInput.value.trim().toLowerCase() : "";' +
'            const staff = searchValue' +
'                ? cachedStaffList.filter(s => (s.name||"").toLowerCase().includes(searchValue) || (s.id||"").toLowerCase().includes(searchValue) || (s.email||"").toLowerCase().includes(searchValue) || (s.region||"").toLowerCase().includes(searchValue))' +
'                : cachedStaffList;' +
'            const branches = cachedStaffBranches;' +
'            const assignments = cachedStaffAssignments;' +
'            const tbody = document.getElementById("staffTableBody");' +
'            if (staff.length === 0) {' +
'                const colspan = isSuperAdmin ? 7 : 6;' +
'                tbody.innerHTML = \'<tr><td colspan="\'+colspan+\'" style="text-align:center;color:#a0aec0;padding:20px;">No staff match your search.</td></tr>\';' +
'                return;' +
'            }' +
'            let rowsHtml = "";' +
'            staff.forEach(s => {' +
'                const assigned = assignments[s.id] || [];' +
'                let checkboxesHtml = "";' +
'                if (branches.length === 0) {' +
'                    checkboxesHtml = \'<span style="color:#a0aec0;">No branches added yet</span>\';' +
'                } else {' +
'                    const regionGroups = {};' +
'                    branches.forEach(b => {' +
'                        const region = b.region || "Unassigned";' +
'                        if (!regionGroups[region]) regionGroups[region] = [];' +
'                        regionGroups[region].push(b);' +
'                    });' +
'                    Object.keys(regionGroups).sort().forEach(region => {' +
'                        checkboxesHtml += \'<div style="font-size:11px;font-weight:700;color:#718096;text-transform:uppercase;margin:6px 0 3px;">\' + region + \'</div>\';' +
'                        regionGroups[region].forEach(b => {' +
'                            const checked = assigned.includes(b.name) ? "checked" : "";' +
'                            checkboxesHtml += \'<label style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-weight:normal;font-size:13px;"><input type="checkbox" value="\'+b.name+\'" \'+checked+\' onchange="updateStaffBranches(\\\'\'+s.id+\'\\\')" class="branch-check-\'+s.id+\'"> \'+b.name+\'</label>\';' +
'                        });' +
'                    });' +
'                }' +
'                let idCell, nameCell, emailCell, editCell, deleteCell;' +
'                if (editingStaffIds.has(s.id)) {' +
'                    idCell = isSuperAdmin ? \'<input type="text" id="editStaffId-\'+s.id+\'" value="\'+s.id+\'" style="width:100%;padding:6px;border:1px solid #cbd5e0;border-radius:4px;">\' : s.id;' +
'                    nameCell = \'<input type="text" id="editName-\'+s.id+\'" value="\'+s.name+\'" style="width:100%;padding:6px;border:1px solid #cbd5e0;border-radius:4px;">\';' +
'                    emailCell = \'<input type="email" id="editEmail-\'+s.id+\'" value="\'+s.email+\'" style="width:100%;padding:6px;border:1px solid #cbd5e0;border-radius:4px;margin-bottom:4px;"><input type="text" id="editPassword-\'+s.id+\'" placeholder="New password (optional)" style="width:100%;padding:6px;border:1px solid #cbd5e0;border-radius:4px;">\';' +
'                    editCell = \'<button type="button" class="resolve-btn" onclick="saveStaffEdit(\\\'\'+s.id+\'\\\')">Save</button>\';' +
'                    deleteCell = \'<button type="button" class="branch-delete-btn" onclick="toggleEditStaff(\\\'\'+s.id+\'\\\')">Cancel</button>\';' +
'                } else {' +
'                    idCell = s.id;' +
'                    nameCell = s.name;' +
'                    emailCell = s.email;' +
'                    editCell = \'<button type="button" class="branch-delete-btn" onclick="toggleEditStaff(\\\'\'+s.id+\'\\\')">Edit</button>\';' +
'                    deleteCell = \'<button type="button" class="branch-delete-btn" onclick="deleteStaff(\\\'\'+s.id+\'\\\')">Delete</button>\';' +
'                }' +
'                let regionCell = "";' +
'                if (isSuperAdmin) {' +
'                    if (editingStaffIds.has(s.id)) {' +
'                        let regionOptionsHtml = \'<option value="">Unassigned</option>\';' +
'                        cachedRegionsForStaff.forEach(r => { regionOptionsHtml += \'<option value="\'+r.name+\'"\'+(r.name === s.region ? \' selected\' : \'\')+\'>\'+r.name+\'</option>\'; });' +
'                        regionCell = \'<td><select id="editStaffRegion-\'+s.id+\'" style="padding:6px;border:1px solid #cbd5e0;border-radius:4px;">\'+regionOptionsHtml+\'</select></td>\';' +
'                    } else {' +
'                        regionCell = \'<td>\'+(s.region || "Unassigned")+\'</td>\';' +
'                    }' +
'                }' +
'                rowsHtml += \'<tr><td>\'+idCell+\'</td><td>\'+nameCell+\'</td><td>\'+emailCell+\'</td>\'+regionCell+\'<td>\'+checkboxesHtml+\'</td><td>\'+editCell+\'</td><td>\'+deleteCell+\'</td></tr>\';' +
'            });' +
'            tbody.innerHTML = rowsHtml;' +
'        }' +
'        let editingStaffIds = new Set();' +
'        function getMainScroll() {' +
'            const mainEl = document.querySelector(".main-content");' +
'            return { main: mainEl ? mainEl.scrollTop : 0, win: window.scrollY || document.documentElement.scrollTop || 0 };' +
'        }' +
'        function setMainScroll(pos) {' +
'            const mainEl = document.querySelector(".main-content");' +
'            const apply = () => {' +
'                if (mainEl) mainEl.scrollTop = pos.main;' +
'                window.scrollTo(0, pos.win);' +
'            };' +
'            apply();' +
'            requestAnimationFrame(() => { apply(); requestAnimationFrame(apply); });' +
'            setTimeout(apply, 50);' +
'        }' +
'        function toggleEditStaff(staffId) {' +
'            const scrollPos = getMainScroll();' +
'            if (document.activeElement && document.activeElement.blur) document.activeElement.blur();' +
'            if (editingStaffIds.has(staffId)) editingStaffIds.delete(staffId);' +
'            else editingStaffIds.add(staffId);' +
'            renderStaffTable();' +
'            setMainScroll(scrollPos);' +
'        }' +
'        async function saveStaffEdit(staffId) {' +
'            const scrollPos = getMainScroll();' +
'            if (document.activeElement && document.activeElement.blur) document.activeElement.blur();' +
'            const name = document.getElementById("editName-" + staffId).value.trim();' +
'            const email = document.getElementById("editEmail-" + staffId).value.trim();' +
'            const password = document.getElementById("editPassword-" + staffId).value.trim();' +
'            if (!name || !email) { showAdminToast("Name and email are required.", true); return; }' +
'            const body = { name, email };' +
'            if (password) body.password = password;' +
'            if (isSuperAdmin) {' +
'                const regionEl = document.getElementById("editStaffRegion-" + staffId);' +
'                if (regionEl) body.region = regionEl.value;' +
'                const idEl = document.getElementById("editStaffId-" + staffId);' +
'                if (idEl) {' +
'                    const newId = idEl.value.trim();' +
'                    if (!newId) { showAdminToast("Staff ID cannot be empty.", true); return; }' +
'                    body.newStaffId = newId;' +
'                }' +
'            }' +
'            const response = await fetch("/tickets/staff/" + staffId, {' +
'                method: "PUT",' +
'                headers: { "Content-Type": "application/json" },' +
'                body: JSON.stringify(body)' +
'            });' +
'            if (response.ok) {' +
'                editingStaffIds.delete(staffId);' +
'                showAdminToast("Staff member updated.");' +
'                await loadStaffList();' +
'                setMainScroll(scrollPos);' +
'            } else {' +
'                const err = await response.json().catch(() => ({}));' +
'                showAdminToast(err.error || "Could not update staff member.", true);' +
'                setMainScroll(scrollPos);' +
'            }' +
'        }' +
'        async function deleteStaff(staffId) {' +
'            showConfirmModal("Remove this staff member? This cannot be undone.", async () => {' +
'                const scrollPos = getMainScroll();' +
'                const response = await fetch("/tickets/staff/" + staffId, { method: "DELETE" });' +
'                if (response.ok) { await loadStaffList(); setMainScroll(scrollPos); }' +
'                else showAdminToast("Could not delete staff member.", true);' +
'            }, "Delete");' +
'        }' +
'        let editingAdminIds = new Set();' +
'        async function loadRegionAdminsList() {' +
'            const [adminsRes, regionsRes] = await Promise.all([fetch("/region-admins"), fetch("/tickets/regions")]);' +
'            const admins = await adminsRes.json();' +
'            const regions = await regionsRes.json();' +
'            const regionSelectEl = document.getElementById("newAdminRegion");' +
'            if (regionSelectEl && !regionSelectEl.dataset.loaded) {' +
'                regions.forEach(r => { regionSelectEl.innerHTML += \'<option value="\'+r.name+\'">\'+r.name+\'</option>\'; });' +
'                regionSelectEl.dataset.loaded = "1";' +
'            }' +
'            const tbody = document.getElementById("regionAdminsTableBody");' +
'            if (admins.length === 0) {' +
'                tbody.innerHTML = \'<tr><td colspan="6" style="text-align: center; color: #a0aec0; padding: 20px;">No region admins added yet.</td></tr>\';' +
'                return;' +
'            }' +
'            let rowsHtml = "";' +
'            admins.forEach(a => {' +
'                let nameCell, regionCell, editCell;' +
'                if (editingAdminIds.has(a.id)) {' +
'                    nameCell = \'<input type="text" id="editAdminName-\'+a.id+\'" value="\'+a.name+\'" style="width:100%;padding:6px;border:1px solid #cbd5e0;border-radius:4px;">\';' +
'                    let regionOptionsHtml = "";' +
'                    regions.forEach(r => { regionOptionsHtml += \'<option value="\'+r.name+\'"\'+(r.name === a.region ? \' selected\' : \'\')+\'>\'+r.name+\'</option>\'; });' +
'                    regionCell = \'<select id="editAdminRegion-\'+a.id+\'" style="padding:6px;border:1px solid #cbd5e0;border-radius:4px;">\'+regionOptionsHtml+\'</select>\';' +
'                    editCell = \'<input type="text" id="editAdminPassword-\'+a.id+\'" placeholder="New password (optional)" style="width:100%;padding:6px;border:1px solid #cbd5e0;border-radius:4px;margin-bottom:4px;"><button type="button" class="resolve-btn" onclick="saveRegionAdminEdit(\\\'\'+a.id+\'\\\')">Save</button> <button type="button" class="branch-delete-btn" onclick="toggleEditRegionAdmin(\\\'\'+a.id+\'\\\')">Cancel</button>\';' +
'                } else {' +
'                    nameCell = a.name;' +
'                    regionCell = a.region;' +
'                    editCell = \'<button type="button" class="branch-delete-btn" onclick="toggleEditRegionAdmin(\\\'\'+a.id+\'\\\')">Edit</button>\';' +
'                }' +
'                const statusBadge = a.enabled ? \'<span class="badge status-resolved">Enabled</span>\' : \'<span class="badge p-High">Disabled</span>\';' +
'                const toggleBtn = \'<button type="button" class="branch-delete-btn" onclick="toggleRegionAdminEnabled(\\\'\'+a.id+\'\\\', \'+(!a.enabled)+\')">\'+ (a.enabled ? "Disable" : "Enable") +\'</button>\';' +
'                rowsHtml += \'<tr><td>\'+nameCell+\'</td><td>\'+a.username+\'</td><td>\'+regionCell+\'</td><td>\'+statusBadge+\' \'+toggleBtn+\'</td><td>\'+editCell+\'</td><td><button type="button" class="branch-delete-btn" onclick="deleteRegionAdmin(\\\'\'+a.id+\'\\\')">Delete</button></td></tr>\';' +
'            });' +
'            tbody.innerHTML = rowsHtml;' +
'        }' +
'        function toggleEditRegionAdmin(id) {' +
'            const scrollPos = getMainScroll();' +
'            if (editingAdminIds.has(id)) editingAdminIds.delete(id);' +
'            else editingAdminIds.add(id);' +
'            loadRegionAdminsList().then(() => setMainScroll(scrollPos));' +
'        }' +
'        async function saveRegionAdminEdit(id) {' +
'            const scrollPos = getMainScroll();' +
'            const name = document.getElementById("editAdminName-" + id).value.trim();' +
'            const region = document.getElementById("editAdminRegion-" + id).value;' +
'            const password = document.getElementById("editAdminPassword-" + id).value.trim();' +
'            if (!name || !region) { showAdminToast("Name and region are required.", true); return; }' +
'            const body = { name, region };' +
'            if (password) body.password = password;' +
'            const response = await fetch("/region-admins/" + id, {' +
'                method: "PUT",' +
'                headers: { "Content-Type": "application/json" },' +
'                body: JSON.stringify(body)' +
'            });' +
'            if (response.ok) { editingAdminIds.delete(id); showAdminToast("Region admin updated."); await loadRegionAdminsList(); }' +
'            else { const err = await response.json(); showAdminToast(err.error || "Could not update region admin.", true); }' +
'            setMainScroll(scrollPos);' +
'        }' +
'        async function toggleRegionAdminEnabled(id, enabled) {' +
'            const scrollPos = getMainScroll();' +
'            const response = await fetch("/region-admins/" + id, {' +
'                method: "PUT",' +
'                headers: { "Content-Type": "application/json" },' +
'                body: JSON.stringify({ enabled })' +
'            });' +
'            if (response.ok) { showAdminToast(enabled ? "Admin enabled." : "Admin disabled."); await loadRegionAdminsList(); }' +
'            else { showAdminToast("Could not update region admin.", true); }' +
'            setMainScroll(scrollPos);' +
'        }' +
'        async function deleteRegionAdmin(id) {' +
'            showConfirmModal("Remove this region admin? This cannot be undone.", async () => {' +
'                const scrollPos = getMainScroll();' +
'                const response = await fetch("/region-admins/" + id, { method: "DELETE" });' +
'                if (response.ok) { showAdminToast("Region admin removed."); await loadRegionAdminsList(); }' +
'                else showAdminToast("Could not delete region admin.", true);' +
'                setMainScroll(scrollPos);' +
'            }, "Delete");' +
'        }' +
'        async function addNewRegionAdmin() {' +
'            const name = document.getElementById("newAdminName").value.trim();' +
'            const username = document.getElementById("newAdminUsername").value.trim();' +
'            const password = document.getElementById("newAdminPassword").value.trim();' +
'            const region = document.getElementById("newAdminRegion").value;' +
'            if (!name || !username || !password || !region) { showAdminToast("Please fill in name, username, password, and region.", true); return; }' +
'            const btn = document.getElementById("addAdminBtn");' +
'            const defaultHTML = btn.innerHTML;' +
'            btn.disabled = true;' +
'            btn.innerHTML = \'<span class="admin-spinner"></span>Adding...\';' +
'            try {' +
'                const response = await fetch("/region-admins", {' +
'                    method: "POST",' +
'                    headers: { "Content-Type": "application/json" },' +
'                    body: JSON.stringify({ name, username, password, region })' +
'                });' +
'                if (response.ok) {' +
'                    document.getElementById("newAdminName").value = "";' +
'                    document.getElementById("newAdminUsername").value = "";' +
'                    document.getElementById("newAdminPassword").value = "";' +
'                    document.getElementById("newAdminRegion").value = "";' +
'                    showAdminToast("Region admin added successfully.");' +
'                    loadRegionAdminsList();' +
'                } else {' +
'                    const err = await response.json();' +
'                    showAdminToast(err.error || "Could not add region admin.", true);' +
'                }' +
'            } catch (err) {' +
'                showAdminToast("Something went wrong. Please try again.", true);' +
'            } finally {' +
'                btn.disabled = false;' +
'                btn.innerHTML = defaultHTML;' +
'            }' +
'        }' +
'        async function loadAuditLog() {' +
'            const tbody = document.getElementById("auditLogTableBody");' +
'            if (!isSuperAdmin) {' +
'                tbody.innerHTML = \'<tr><td colspan="4" style="text-align: center; color: #c53030; padding: 30px; font-weight: 600;">You are not authorized to access this page.</td></tr>\';' +
'                return;' +
'            }' +
'            const response = await fetch("/audit-log");' +
'            if (!response.ok) {' +
'                const err = await response.json().catch(() => ({}));' +
'                tbody.innerHTML = \'<tr><td colspan="4" style="text-align: center; color: #c53030; padding: 30px; font-weight: 600;">\'+(err.error || "You are not authorized to access this page.")+\'</td></tr>\';' +
'                return;' +
'            }' +
'            const entries = await response.json();' +
'            if (entries.length === 0) {' +
'                tbody.innerHTML = \'<tr><td colspan="4" style="text-align: center; color: #a0aec0; padding: 20px;">No activity recorded yet.</td></tr>\';' +
'                return;' +
'            }' +
'            let auditRowsHtml = "";' +
'            entries.forEach(e => {' +
'                auditRowsHtml += \'<tr><td>\'+new Date(e.createdAt).toLocaleString()+\'</td><td>\'+e.actor+\'</td><td>\'+e.action+\'</td><td>\'+(e.details || "")+\'</td></tr>\';' +
'            });' +
'            tbody.innerHTML = auditRowsHtml;' +
'        }' +
'        async function sendInboxMessage() {' +
'            const subject = document.getElementById("inboxSubject").value.trim();' +
'            const body = document.getElementById("inboxBody").value.trim();' +
'            if (!subject || !body) { showAdminToast("Please fill in both subject and message.", true); return; }' +
'            const btn = document.getElementById("sendInboxBtn");' +
'            const defaultHTML = btn.innerHTML;' +
'            btn.disabled = true;' +
'            btn.innerHTML = \'<span class="admin-spinner"></span>Sending...\';' +
'            try {' +
'                const response = await fetch("/inbox", {' +
'                    method: "POST",' +
'                    headers: { "Content-Type": "application/json" },' +
'                    body: JSON.stringify({ subject, body })' +
'                });' +
'                if (response.ok) {' +
'                    document.getElementById("inboxSubject").value = "";' +
'                    document.getElementById("inboxBody").value = "";' +
'                    showAdminToast("Message sent to Admin.");' +
'                    loadInbox();' +
'                } else {' +
'                    const err = await response.json();' +
'                    showAdminToast(err.error || "Could not send message.", true);' +
'                }' +
'            } catch (err) {' +
'                showAdminToast("Something went wrong. Please try again.", true);' +
'            } finally {' +
'                btn.disabled = false;' +
'                btn.innerHTML = defaultHTML;' +
'            }' +
'        }' +
'        async function markInboxRead(id) {' +
'            await fetch("/inbox/" + id + "/read", { method: "POST" });' +
'            loadInbox();' +
'        }' +
'        async function replyInboxMessage(id) {' +
'            const reply = document.getElementById("inboxReplyInput-" + id).value.trim();' +
'            if (!reply) { showAdminToast("Please write a reply first.", true); return; }' +
'            const response = await fetch("/inbox/" + id + "/reply", {' +
'                method: "POST",' +
'                headers: { "Content-Type": "application/json" },' +
'                body: JSON.stringify({ reply })' +
'            });' +
'            if (response.ok) { showAdminToast("Reply sent."); loadInbox(); }' +
'            else { const err = await response.json(); showAdminToast(err.error || "Could not send reply.", true); }' +
'        }' +
'        async function loadInbox() {' +
'            const listDiv = document.getElementById("inboxList");' +
'            try {' +
'                const response = await fetch("/inbox");' +
'                if (!response.ok) { listDiv.innerHTML = \'<p style="text-align:center;color:#c53030;padding:30px 0;">Could not load messages.</p>\'; return; }' +
'                const messages = await response.json();' +
'                if (messages.length === 0) {' +
'                    listDiv.innerHTML = \'<p style="text-align: center; color: #718096; padding: 40px 0;">\'+(isAdmin ? "No messages from staff yet." : "You have not sent any messages yet.")+\'</p>\';' +
'                    updateInboxBadge(messages);' +
'                    return;' +
'                }' +
'                let inboxCardsHtml = "";' +
'                messages.forEach(m => {' +
'                    const isUnread = isAdmin ? !m.adminRead : !m.staffRead;' +
'                    const statusBadge = m.status === "Replied" ? \'<span class="badge status-resolved">Replied</span>\' : \'<span class="badge status-open">Open</span>\';' +
'                    const senderLine = isAdmin ? \'<div class="inbox-meta">From: <strong>\'+m.sender+\'</strong>\'+(m.senderStaffId ? \' (\'+m.senderStaffId+\')\' : "")+\' \u2014 \'+new Date(m.createdAt).toLocaleString()+\'</div>\' : \'<div class="inbox-meta">\'+new Date(m.createdAt).toLocaleString()+\'</div>\';' +
'                    const markReadBtn = isUnread ? \'<button class="branch-delete-btn" onclick="markInboxRead(\\\'\'+m._id+\'\\\')">Mark as read</button>\' : "";' +
'                    let replySection = "";' +
'                    if (m.status === "Replied") {' +
'                        replySection = \'<div class="inbox-reply-shown"><strong>Reply from \'+m.repliedBy+\':</strong> \'+m.reply+\'<div class="inbox-meta">\'+new Date(m.repliedAt).toLocaleString()+\'</div></div>\';' +
'                    } else if (isAdmin) {' +
'                        replySection = \'<div class="inbox-reply-box"><textarea id="inboxReplyInput-\'+m._id+\'" rows="2" placeholder="Write a reply..."></textarea><button class="branch-add-btn" style="margin-top:8px;" onclick="replyInboxMessage(\\\'\'+m._id+\'\\\')">Send Reply</button></div>\';' +
'                    }' +
'                    inboxCardsHtml += \'<div class="inbox-card \'+(isUnread ? "inbox-unread" : "")+\'"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;"><div><div class="inbox-subject">\'+m.subject+\'</div>\'+senderLine+\'</div><div style="display:flex;align-items:center;gap:8px;">\'+statusBadge+\' \'+markReadBtn+\'</div></div><div class="inbox-body">\'+m.body+\'</div>\'+replySection+\'</div>\';' +
'                });' +
'                listDiv.innerHTML = inboxCardsHtml;' +
'                updateInboxBadge(messages);' +
'            } catch (err) {' +
'                listDiv.innerHTML = \'<p style="text-align:center;color:#c53030;padding:30px 0;">Could not load messages.</p>\';' +
'            }' +
'        }' +
'        function updateInboxBadge(messages) {' +
'            const badge = document.getElementById("inboxUnreadBadge");' +
'            if (!badge) return;' +
'            const unreadCount = messages.filter(m => isAdmin ? !m.adminRead : !m.staffRead).length;' +
'            badge.innerText = unreadCount > 99 ? "99+" : unreadCount;' +
'            badge.style.display = unreadCount ? "flex" : "none";' +
'        }' +
'        async function pollInboxBadge() {' +
'            try {' +
'                const response = await fetch("/inbox");' +
'                if (response.ok) { const messages = await response.json(); updateInboxBadge(messages); }' +
'            } catch (err) { /* ignore */ }' +
'        }' +
'        async function updateStaffBranches(staffId) {' +
'            const checks = document.querySelectorAll(".branch-check-" + staffId);' +
'            const branches = Array.from(checks).filter(c => c.checked).map(c => c.value);' +
'            await fetch("/tickets/staff-branches", {' +
'                method: "POST",' +
'                headers: { "Content-Type": "application/json" },' +
'                body: JSON.stringify({ staffId, branches })' +
'            });' +
'        }' +
'        async function addNewStaff() {' +
'            const name = document.getElementById("newStaffName").value.trim();' +
'            const staffId = document.getElementById("newStaffId").value.trim();' +
'            const password = document.getElementById("newStaffPassword").value.trim();' +
'            const email = document.getElementById("newStaffEmail").value.trim();' +
'            const regionEl = document.getElementById("newStaffRegion");' +
'            const region = regionEl ? regionEl.value : undefined;' +
'            if (!name || !password || !email) { showAdminToast("Please fill in name, password, and email.", true); return; }' +
'            const btn = document.getElementById("addStaffBtn");' +
'            const defaultHTML = btn.innerHTML;' +
'            btn.disabled = true;' +
'            btn.innerHTML = \'<span class="admin-spinner"></span>Adding...\';' +
'            try {' +
'                const response = await fetch("/tickets/staff", {' +
'                    method: "POST",' +
'                    headers: { "Content-Type": "application/json" },' +
'                    body: JSON.stringify({ name, staffId, password, email, region })' +
'                });' +
'                if (response.ok) {' +
'                    const result = await response.json();' +
'                    document.getElementById("newStaffName").value = "";' +
'                    document.getElementById("newStaffId").value = "";' +
'                    document.getElementById("newStaffPassword").value = "";' +
'                    document.getElementById("newStaffEmail").value = "";' +
'                    if (regionEl) regionEl.value = "";' +
'                    showAdminToast("Staff member added successfully (" + result.staffId + ").");' +
'                    loadStaffList();' +
'                } else {' +
'                    const err = await response.json();' +
'                    showAdminToast(err.error || "Could not add staff member.", true);' +
'                }' +
'            } catch (err) {' +
'                showAdminToast("Something went wrong. Please try again.", true);' +
'            } finally {' +
'                btn.disabled = false;' +
'                btn.innerHTML = defaultHTML;' +
'            }' +
'        }' +
'        function updateAttachmentLabel(id) {' +
'            const fileInput = document.getElementById("attachment-" + id);' +
'            const nameTag = document.getElementById("attachmentName-" + id);' +
'            if (!fileInput || !nameTag) return;' +
'            nameTag.innerText = (fileInput.files && fileInput.files[0]) ? fileInput.files[0].name : "";' +
'        }' +
'        async function addComment(id) {' +
'            const textInput = document.getElementById("input-" + id);' +
'            const fileInput = document.getElementById("attachment-" + id);' +
'            const nameTag = document.getElementById("attachmentName-" + id);' +
'            const text = textInput.value.trim();' +
'            const file = fileInput && fileInput.files && fileInput.files[0];' +
'            if (!text && !file) return;' +
'            const formData = new FormData();' +
'            formData.append("text", text);' +
'            if (file) formData.append("attachment", file);' +
'            const response = await fetch("/tickets/" + id + "/comment", {' +
'                method: "POST",' +
'                body: formData' +
'            });' +
'            if (response.ok) {' +
'                textInput.value = "";' +
'                if (fileInput) fileInput.value = "";' +
'                if (nameTag) nameTag.innerText = "";' +
'                loadTickets();' +
'            } else {' +
'                const err = await response.json().catch(() => ({}));' +
'                showAdminToast(err.error || "Could not post update.", true);' +
'            }' +
'        }' +
'        async function resolveTicket(id) {' +
'            showConfirmModal("Mark this ticket as resolved? This action can\'t be undone.", async () => {' +
'                const response = await fetch("/tickets/" + id + "/resolve", { method: "POST" });' +
'                if (response.ok) { loadTickets(); }' +
'                else { const err = await response.json(); showAdminToast(err.error || "Could not resolve ticket.", true); }' +
'            }, "Mark Resolved");' +
'        }' +
'        async function escalateTicket(id) {' +
'            showPromptModal("Enter the reason for escalating this ticket to Admin:", "", async (reason) => {' +
'                if (!reason || !reason.trim()) { showAdminToast("Please provide a reason for escalation.", true); return; }' +
'                const response = await fetch("/tickets/" + id + "/escalate", {' +
'                    method: "POST",' +
'                    headers: { "Content-Type": "application/json" },' +
'                    body: JSON.stringify({ reason: reason.trim() })' +
'                });' +
'                if (response.ok) { showAdminToast("Ticket escalated to Admin."); loadTickets(); }' +
'                else { const err = await response.json(); showAdminToast(err.error || "Could not escalate ticket.", true); }' +
'            }, "Escalate");' +
'        }' +
'        async function reallocateTicket(id) {' +
'            const res = await fetch("/tickets/staff-list");' +
'            const staff = await res.json();' +
'            if (!staff.length) { showAdminToast("No staff members available to reallocate to.", true); return; }' +
'            showStaffSelectModal("Select a staff member to reassign this ticket:", staff, async (staffName) => {' +
'                const response = await fetch("/tickets/" + id + "/reallocate", {' +
'                    method: "POST",' +
'                    headers: { "Content-Type": "application/json" },' +
'                    body: JSON.stringify({ assignTo: staffName })' +
'                });' +
'                if (response.ok) { showAdminToast("Ticket reallocated to " + staffName + "."); loadTickets(); }' +
'                else { const err = await response.json(); showAdminToast(err.error || "Could not reallocate ticket.", true); }' +
'            }, "Reallocate");' +
'        }' +
'        let chartInstances = {};' +
'        function renderChart(canvasId, config) {' +
'            const el = document.getElementById(canvasId);' +
'            if (!el) return;' +
'            if (chartInstances[canvasId]) chartInstances[canvasId].destroy();' +
'            chartInstances[canvasId] = new Chart(el, config);' +
'        }' +
'        async function loadReportCharts() {' +
'            const response = await fetch("/tickets");' +
'            if (response.status === 401) { window.location.href = "/login"; return; }' +
'            let tickets = await response.json();' +
'' +
'            const openCount = tickets.filter(t => t.status === "Open").length;' +
'            const resolvedCount = tickets.filter(t => t.status === "Resolved").length;' +
'            renderChart("chartStatus", {' +
'                type: "doughnut",' +
'                data: { labels: ["Open", "Resolved"], datasets: [{ data: [openCount, resolvedCount], backgroundColor: ["#3182ce", "#38a169"] }] },' +
'                options: { maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } }' +
'            });' +
'' +
'            const lowCount = tickets.filter(t => t.priority === "Low").length;' +
'            const medCount = tickets.filter(t => t.priority === "Medium").length;' +
'            const highCount = tickets.filter(t => t.priority === "High").length;' +
'            renderChart("chartPriority", {' +
'                type: "doughnut",' +
'                data: { labels: ["Low", "Medium", "High"], datasets: [{ data: [lowCount, medCount, highCount], backgroundColor: ["#718096", "#dd6b20", "#e53e3e"] }] },' +
'                options: { maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } }' +
'            });' +
'' +
'            const categoryTotals = {};' +
'            tickets.forEach(t => { const key = t.category || "Other"; categoryTotals[key] = (categoryTotals[key] || 0) + 1; });' +
'            renderChart("chartCategory", {' +
'                type: "doughnut",' +
'                data: { labels: Object.keys(categoryTotals), datasets: [{ data: Object.values(categoryTotals), backgroundColor: ["#319795", "#805ad5", "#3182ce", "#dd6b20", "#718096"] }] },' +
'                options: { maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } }' +
'            });' +
'' +
'            const dayLabels = [];' +
'            const dayCounts = [];' +
'            const today = new Date();' +
'            for (let i = 29; i >= 0; i--) {' +
'                const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);' +
'                dayLabels.push((d.getMonth() + 1) + "/" + d.getDate());' +
'                const count = tickets.filter(t => {' +
'                    if (!t.createdAt) return false;' +
'                    const td = new Date(t.createdAt);' +
'                    return td.getFullYear() === d.getFullYear() && td.getMonth() === d.getMonth() && td.getDate() === d.getDate();' +
'                }).length;' +
'                dayCounts.push(count);' +
'            }' +
'            renderChart("chartTrend", {' +
'                type: "line",' +
'                data: { labels: dayLabels, datasets: [{ label: "Tickets Submitted", data: dayCounts, borderColor: "#e53e3e", backgroundColor: "rgba(229,62,62,0.12)", tension: 0.3, fill: true }] },' +
'                options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }' +
'            });' +
'' +
'            if (isAdmin) {' +
'                const staffTotals = {};' +
'                tickets.forEach(t => { const key = t.assignedTo || "Unassigned"; staffTotals[key] = (staffTotals[key] || 0) + 1; });' +
'                renderChart("chartStaff", {' +
'                    type: "bar",' +
'                    data: { labels: Object.keys(staffTotals), datasets: [{ label: "Tickets Handled", data: Object.values(staffTotals), backgroundColor: "#0056b3" }] },' +
'                    options: { indexAxis: "y", maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } } } }' +
'                });' +
'' +
'                const branchTotals = {};' +
'                tickets.forEach(t => { const key = t.branch || "N/A"; branchTotals[key] = (branchTotals[key] || 0) + 1; });' +
'                renderChart("chartBranch", {' +
'                    type: "bar",' +
'                    data: { labels: Object.keys(branchTotals), datasets: [{ label: "Tickets", data: Object.values(branchTotals), backgroundColor: "#319795" }] },' +
'                    options: { indexAxis: "y", maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } } } }' +
'                });' +
'            }' +
'        }' +
'        function downloadReport() {' +
'            const month = document.getElementById("reportMonth").value;' +
'            if (!month) { alert("Please select a month."); return; }' +
'            const region = document.getElementById("reportRegion").value;' +
'            let url = "/tickets/report?month=" + month;' +
'            if (region) url += "&region=" + encodeURIComponent(region);' +
'            window.location.href = url;' +
'        }' +
'        function downloadReportByRange() {' +
'            const from = document.getElementById("reportFromDate").value;' +
'            const to = document.getElementById("reportToDate").value;' +
'            if (!from || !to) { alert("Please select both a From and To date."); return; }' +
'            const region = document.getElementById("reportRegion").value;' +
'            let url = "/tickets/report?from=" + from + "&to=" + to;' +
'            if (region) url += "&region=" + encodeURIComponent(region);' +
'            window.location.href = url;' +
'        }' +
'        async function changePassword() {' +
'            const current = document.getElementById("currentPassword").value;' +
'            const next = document.getElementById("newPassword").value;' +
'            const confirmVal = document.getElementById("confirmPassword").value;' +
'            if (!current || !next || !confirmVal) { alert("Please fill in all fields."); return; }' +
'            if (next !== confirmVal) { alert("New password and confirmation do not match."); return; }' +
'            const response = await fetch("/change-password", {' +
'                method: "POST",' +
'                headers: { "Content-Type": "application/json" },' +
'                body: JSON.stringify({ currentPassword: current, newPassword: next })' +
'            });' +
'            const data = await response.json();' +
'            if (response.ok) {' +
'                alert("Password updated successfully.");' +
'                document.getElementById("currentPassword").value = "";' +
'                document.getElementById("newPassword").value = "";' +
'                document.getElementById("confirmPassword").value = "";' +
'            } else {' +
'                alert(data.error || "Could not update password.");' +
'            }' +
'        }' +
'        document.getElementById("reportMonth").value = new Date().toISOString().slice(0, 7);' +
'        loadNotifications();' +
'        setInterval(loadNotifications, 30000);' +
'        pollInboxBadge();' +
'        setInterval(pollInboxBadge, 30000);' +
'        loadStaffFilterOptions();' +
'        loadRegionFilterOptions();' +
'        loadTickets();' +
'    </script>' +
'</body>' +
'</html>';

    res.send(html);
});

// APIs
app.get('/tickets', checkUserLogin, async (req, res) => {
    try {
        let where;
        if (req.session.isSuperAdmin) {
            where = {};
        } else if (req.session.isAdmin) {
            const regionBranchNames = await getBranchNamesForRegion(req.session.region);
            where = { branch: { [Op.in]: regionBranchNames } };
        } else {
            where = { [Op.or]: [{ assignedTo: req.session.username }, { escalatedBy: req.session.username }] };
        }
        const tickets = await Ticket.findAll({
            where,
            order: [['id', 'DESC']],
            include: [{ model: TicketComment, as: 'comments', separate: true, order: [['createdAt', 'ASC']] }]
        });
        res.json(tickets.map(serializeTicket));
    } catch (err) {
        console.error('Could not load tickets:', err.message);
        res.status(500).json({ error: 'Could not load tickets.' });
    }
});

app.get('/notifications', checkUserLogin, async (req, res) => {
    try {
        const notifications = await Notification.findAll({
            where: { recipient: req.session.username },
            order: [['createdAt', 'DESC']],
            limit: 50
        });
        res.json(notifications.map(withId));
    } catch (err) {
        res.status(500).json({ error: 'Could not load notifications.' });
    }
});

app.post('/notifications/:id/read', checkUserLogin, async (req, res) => {
    try {
        await Notification.update(
            { read: true },
            { where: { id: req.params.id, recipient: req.session.username } }
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Could not update notification.' });
    }
});

app.delete('/notifications', checkUserLogin, async (req, res) => {
    try {
        await Notification.destroy({ where: { recipient: req.session.username } });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Could not clear notifications.' });
    }
});

// Download a monthly Excel report — staff get only their own tickets, admin gets everyone's
app.get('/tickets/report', checkUserLogin, async (req, res) => {
    try {
        let startDate, endDate, rangeLabel;
        if (req.query.month) {
            const monthParam = req.query.month; // expected format: YYYY-MM
            if (!/^\d{4}-\d{2}$/.test(monthParam)) {
                return res.status(400).send('Please provide a valid month in YYYY-MM format.');
            }
            const [year, month] = monthParam.split('-').map(Number);
            startDate = new Date(year, month - 1, 1, 0, 0, 0);
            endDate = new Date(year, month, 0, 23, 59, 59);
            rangeLabel = monthParam;
        } else if (req.query.from && req.query.to) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.from) || !/^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) {
                return res.status(400).send('Please provide valid From/To dates in YYYY-MM-DD format.');
            }
            startDate = new Date(req.query.from + 'T00:00:00');
            endDate = new Date(req.query.to + 'T23:59:59');
            rangeLabel = req.query.from + '_to_' + req.query.to;
        } else {
            return res.status(400).send('Please provide either a month, or both a From and To date.');
        }

        const where = { createdAt: { [Op.gte]: startDate, [Op.lte]: endDate } };
        if (!req.session.isAdmin) {
            where[Op.or] = [{ assignedTo: req.session.username }, { escalatedBy: req.session.username }];
        } else if (!req.session.isSuperAdmin) {
            // Region Admin: always scoped to their own region, regardless of any ?region= param
            const ownRegionBranches = await getBranchNamesForRegion(req.session.region);
            where.branch = { [Op.in]: ownRegionBranches };
        }
        let regionLabel = '';
        if (req.query.region && (req.session.isSuperAdmin || !req.session.isAdmin)) {
            const branchRows = await Branch.findAll({ where: { region: req.query.region }, attributes: ['name'] });
            where.branch = { [Op.in]: branchRows.map(b => b.name) };
            regionLabel = '-' + req.query.region.replace(/\s+/g, '-');
        } else if (!req.session.isSuperAdmin && req.session.isAdmin) {
            regionLabel = '-' + req.session.region.replace(/\s+/g, '-');
        }
        const tickets = await Ticket.findAll({ where, order: [['id', 'ASC']] });
        const allStaffForReport = await Staff.findAll();
        const staffIdByName = {};
        allStaffForReport.forEach(s => { staffIdByName[s.name] = s.staffId; });

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Report');
        sheet.columns = [
            { header: 'Ticket #', key: 'ticketNumber', width: 12 },
            { header: 'Title', key: 'title', width: 30 },
            { header: 'Submitted By', key: 'submittedBy', width: 20 },
            { header: 'Designation', key: 'designation', width: 18 },
            { header: 'Category', key: 'category', width: 14 },
            { header: 'Branch', key: 'branch', width: 25 },
            { header: 'Priority', key: 'priority', width: 12 },
            { header: 'Status', key: 'status', width: 12 },
            { header: 'Assigned To', key: 'assignedTo', width: 16 },
            { header: 'Assigned Staff ID', key: 'assignedStaffId', width: 16 },
            { header: 'Submitted At', key: 'createdAt', width: 22 },
            { header: 'Resolved At', key: 'resolvedAt', width: 22 }
        ];
        sheet.getRow(1).font = { bold: true };
        tickets.forEach(t => {
            sheet.addRow({
                ticketNumber: t.id,
                title: t.title,
                submittedBy: t.submittedBy,
                designation: t.designation,
                category: t.category,
                branch: t.branch,
                priority: t.priority,
                status: t.status,
                assignedTo: t.assignedTo,
                assignedStaffId: staffIdByName[t.assignedTo] || (t.assignedTo === 'Admin' ? 'Admin' : ''),
                createdAt: t.createdAt ? t.createdAt.toLocaleString() : '',
                resolvedAt: t.resolvedAt ? t.resolvedAt.toLocaleString() : ''
            });
        });

        const nameLabel = req.session.isAdmin ? 'All-Staff' : req.session.username.replace(/\s+/g, '-');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Ticket-Report-${nameLabel}${regionLabel}-${rangeLabel}.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        res.status(500).send('Could not generate report: ' + err.message);
    }
});

app.post('/tickets/:id/resolve', checkUserLogin, async (req, res) => {
    try {
        const ticket = await Ticket.findByPk(req.params.id);
        if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
        if (!req.session.isAdmin && ticket.assignedTo !== req.session.username) {
            return res.status(403).json({ error: 'This ticket is no longer assigned to you, so you cannot resolve it.' });
        }
        if (req.session.isAdmin && !req.session.isSuperAdmin) {
            const ownRegionBranches = await getBranchNamesForRegion(req.session.region);
            if (!ownRegionBranches.includes(ticket.branch)) {
                return res.status(403).json({ error: 'This ticket is outside your region.' });
            }
        }
        ticket.status = 'Resolved';
        ticket.resolvedAt = new Date();
        ticket.resolvedBy = req.session.username;
        await ticket.save();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Escalate a ticket to Level 2 (Admin) — reassigns it, flags it as escalated, and
// notifies Admin (the notification bell + sound already picks this up automatically).
app.post('/tickets/:id/escalate', checkUserLogin, async (req, res) => {
    try {
        const reason = (req.body.reason || '').trim();
        if (!reason) {
            return res.status(400).json({ error: 'Please provide a reason for escalation.' });
        }
        const ticket = await Ticket.findByPk(req.params.id);
        if (!ticket) {
            return res.status(404).json({ error: 'Ticket not found.' });
        }
        if (ticket.status === 'Resolved') {
            return res.status(400).json({ error: 'Resolved tickets cannot be escalated.' });
        }
        if (!req.session.isAdmin && ticket.assignedTo !== req.session.username) {
            return res.status(403).json({ error: 'This ticket is not assigned to you.' });
        }

        // Route to the Region Admin who owns this ticket's branch, if one exists —
        // otherwise fall back to the Super Admin (single-admin / unassigned-region setups).
        let recipientName = 'Admin';
        const branchDoc = await Branch.findOne({ where: { name: ticket.branch } });
        if (branchDoc && branchDoc.region) {
            const regionAdmin = await RegionAdmin.findOne({ where: { region: branchDoc.region, enabled: true } });
            if (regionAdmin) {
                recipientName = regionAdmin.name;
            }
        }

        ticket.escalated = true;
        ticket.escalatedBy = req.session.username;
        ticket.escalatedAt = new Date();
        ticket.escalationReason = reason;
        ticket.assignedTo = recipientName;
        await ticket.save();

        await Notification.create({
            recipient: recipientName,
            ticketId: ticket.id,
            ticketNumber: ticket.id,
            title: ticket.title,
            message: `Ticket #${String(ticket.id).padStart(4, '0')} - ${ticket.title} was escalated to you by ${req.session.username}. Reason: ${reason}`
        });
        await logAudit(req.session.username, 'Escalate Ticket', `Escalated ticket #${ticket.id} to ${recipientName}. Reason: ${reason}`);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Only an admin can reassign an escalated ticket. The escalation flag remains set
// so it is still included in the Escalated Tickets filter for follow-up.
app.post('/tickets/:id/reallocate', checkAdminLogin, async (req, res) => {
    try {
        const assignTo = (req.body.assignTo || '').trim();
        if (!assignTo) {
            return res.status(400).json({ error: 'Please select a staff member.' });
        }

        const ticket = await Ticket.findByPk(req.params.id);
        if (!ticket) {
            return res.status(404).json({ error: 'Ticket not found.' });
        }
        if (ticket.status === 'Resolved') {
            return res.status(400).json({ error: 'Resolved tickets cannot be reallocated.' });
        }
        if (!ticket.escalated) {
            return res.status(400).json({ error: 'Only escalated tickets can be reallocated.' });
        }

        const staff = await Staff.findOne({ where: { name: assignTo } });
        if (!staff) {
            return res.status(400).json({ error: 'The selected staff member no longer exists.' });
        }

        if (!req.session.isSuperAdmin) {
            const ownRegionBranches = await getBranchNamesForRegion(req.session.region);
            if (!ownRegionBranches.includes(ticket.branch)) {
                return res.status(403).json({ error: 'This ticket is outside your region.' });
            }
            if (staff.region !== req.session.region) {
                return res.status(403).json({ error: 'That staff member is not in your region.' });
            }
        }

        ticket.assignedTo = staff.name;
        await ticket.save();
        await Notification.create({
            recipient: staff.name,
            ticketId: ticket.id,
            ticketNumber: ticket.id,
            title: ticket.title,
            message: `Ticket #${String(ticket.id).padStart(4, '0')} - ${ticket.title} was reallocated to you.`
        });
        await logAudit(req.session.username, 'Reallocate Escalated Ticket', `Reallocated ticket #${ticket.id} to ${staff.name}`);
        res.json({ success: true, assignedTo: staff.name });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/tickets/:id/comment', checkUserLogin, (req, res, next) => {
    commentUpload.single('attachment')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'Attachment is too large. Maximum allowed size is 5MB.' });
            }
            return res.status(400).json({ error: err.message || 'Invalid file upload.' });
        }
        next();
    });
}, async (req, res) => {
    try {
        const text = (req.body.text || '').trim();
        const attachment = req.file ? req.file.path : null;
        if (!text && !attachment) {
            return res.status(400).json({ error: 'Please write an update or attach a file.' });
        }
        const author = req.session.username;
        await TicketComment.create({ ticketId: req.params.id, author, text, attachment });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/public-branches', async (req, res) => {
    try {
        let where = {};
        if (req.session && req.session.isAdmin && !req.session.isSuperAdmin && req.session.region) {
            where = { region: req.session.region };
        }
        const branches = await Branch.findAll({ where, order: [['region', 'ASC'], ['name', 'ASC']] });
        res.json(branches.map(withId));
    } catch(err) {
        res.status(500).json([]);
    }
});

// Regions (admin only — used to organize the branch list into groups). Region Admins only
// see their own region here; only the Super Admin can create/rename/delete whole regions.
app.get('/tickets/regions', checkAdminLogin, async (req, res) => {
    const where = req.session.isSuperAdmin ? {} : { name: req.session.region };
    const regions = await Region.findAll({ where, order: [['name', 'ASC']] });
    res.json(regions.map(withId));
});

app.post('/tickets/regions', checkSuperAdminLogin, async (req, res) => {
    try {
        const name = (req.body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Region name is required' });
        const newRegion = await Region.create({ name });
        await logAudit(req.session.username, 'Add Region', `Added region "${newRegion.name}"`);
        res.status(201).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/tickets/regions/:id', checkSuperAdminLogin, async (req, res) => {
    try {
        const name = (req.body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Region name is required' });
        const region = await Region.findByPk(req.params.id);
        if (!region) return res.status(404).json({ error: 'Region not found' });
        const oldName = region.name;
        region.name = name;
        await region.save();
        if (oldName !== name) {
            await Branch.update({ region: name }, { where: { region: oldName } });
            await RegionAdmin.update({ region: name }, { where: { region: oldName } });
            await Staff.update({ region: name }, { where: { region: oldName } });
        }
        await logAudit(req.session.username, 'Edit Region', `Renamed region "${oldName}" to "${name}"`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/tickets/regions/:id', checkSuperAdminLogin, async (req, res) => {
    try {
        const region = await Region.findByPk(req.params.id);
        if (!region) return res.status(404).json({ error: 'Region not found' });
        const branchCount = await Branch.count({ where: { region: region.name } });
        if (branchCount > 0) {
            return res.status(400).json({ error: `Cannot delete — ${branchCount} branch(es) still belong to this region. Reassign or remove them first.` });
        }
        const adminCount = await RegionAdmin.count({ where: { region: region.name } });
        if (adminCount > 0) {
            return res.status(400).json({ error: `Cannot delete — ${adminCount} region admin(s) are assigned to this region. Reassign or remove them first.` });
        }
        await region.destroy();
        await logAudit(req.session.username, 'Delete Region', `Removed region "${region.name}"`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Public lookup so ticket submitters can check status without logging in
app.get('/tickets/lookup', async (req, res) => {
    try {
        const mobile = req.query.mobile;
        if (!mobile) return res.status(400).json({ error: 'Mobile number required' });
        const tickets = await Ticket.findAll({
            where: { mobile },
            order: [['id', 'DESC']],
            attributes: ['id', 'title', 'branch', 'priority', 'status', 'createdAt', 'resolvedAt', 'assignedTo']
        });
        res.json(tickets.map(serializeTicket));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/tickets/branches', checkAdminLogin, async (req, res) => {
    try {
        const name = (req.body.name || '').trim();
        let region = (req.body.region || '').trim();
        if (!req.session.isSuperAdmin) {
            region = req.session.region; // Region Admins can only add branches to their own region
        }
        if (!name || !region) {
            return res.status(400).json({ error: 'Branch name and region are both required' });
        }
        const newBranch = await Branch.create({ name, region });
        await logAudit(req.session.username, 'Add Branch', `Added branch "${newBranch.name}" under region "${region}"`);
        res.status(201).json({ success: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/tickets/branches/:id', checkAdminLogin, async (req, res) => {
    const branch = await Branch.findByPk(req.params.id);
    if (branch && !req.session.isSuperAdmin && branch.region !== req.session.region) {
        return res.status(403).json({ error: 'You can only manage branches in your own region.' });
    }
    if (branch) {
        await branch.destroy();
        await StaffBranchAssignment.destroy({ where: { branchName: branch.name } });
        await logAudit(req.session.username, 'Delete Branch', `Removed branch "${branch.name}"`);
    }
    res.json({ success: true });
});

// Update a branch's name and/or region, keeping staff assignments in sync
app.put('/tickets/branches/:id', checkAdminLogin, async (req, res) => {
    try {
        const branch = await Branch.findByPk(req.params.id);
        if (!branch) return res.status(404).json({ error: 'Branch not found' });
        if (!req.session.isSuperAdmin && branch.region !== req.session.region) {
            return res.status(403).json({ error: 'You can only manage branches in your own region.' });
        }
        const oldName = branch.name;
        const oldRegion = branch.region;

        if (req.body.name !== undefined) {
            if (!req.body.name.trim()) return res.status(400).json({ error: 'Branch name cannot be empty' });
            branch.name = req.body.name.trim();
        }
        // Only the Super Admin can move a branch to a different region
        if (req.session.isSuperAdmin && req.body.region !== undefined && req.body.region.trim()) {
            branch.region = req.body.region.trim();
        }
        await branch.save();

        if (oldName !== branch.name) {
            await StaffBranchAssignment.update(
                { branchName: branch.name },
                { where: { branchName: oldName } }
            );
            await logAudit(req.session.username, 'Edit Branch', `Renamed branch "${oldName}" to "${branch.name}"`);
        }
        if (oldRegion !== branch.region) {
            await logAudit(req.session.username, 'Edit Branch', `Moved branch "${branch.name}" from region "${oldRegion}" to "${branch.region}"`);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/tickets/staff-list', checkAdminLogin, async (req, res) => {
    const where = req.session.isSuperAdmin ? {} : { region: req.session.region };
    const staff = await Staff.findAll({ where, order: [['staffId', 'ASC']] });
    res.json(staff.map(s => ({ id: s.staffId, name: s.name, email: s.email, region: s.region })));
});

// Recent admin activity — staff/branch changes
app.get('/audit-log', checkSuperAdminLogin, async (req, res) => {
    const entries = await AuditLog.findAll({ order: [['createdAt', 'DESC']], limit: 200 });
    res.json(entries.map(withId));
});

// Add a new staff member (auto-generates the next sequential staff ID)
app.post('/tickets/staff', checkAdminLogin, async (req, res) => {
    try {
        const { name, password, email } = req.body;
        if (!name || !password || !email) {
            return res.status(400).json({ error: 'Name, password, and email are all required' });
        }
        let staffId = (req.body.staffId || '').trim();
        if (staffId) {
            const existing = await Staff.findOne({ where: { staffId } });
            if (existing) {
                return res.status(400).json({ error: `Staff ID "${staffId}" is already in use.` });
            }
        } else {
            staffId = await getNextStaffId();
        }
        // Region Admins can only add staff to their own region; Super Admin can optionally set one
        const region = req.session.isSuperAdmin ? (req.body.region || '').trim() : req.session.region;
        const hashedPassword = await bcrypt.hash(password, 10);
        await Staff.create({ staffId, name, password: hashedPassword, email, region });
        await logAudit(req.session.username, 'Add Staff', `Added staff ${name} (${staffId})${region ? ' — region: ' + region : ''}`);
        res.status(201).json({ success: true, staffId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Edit an existing staff member's name/email, and optionally reset their password
app.put('/tickets/staff/:staffId', checkAdminLogin, async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email) {
            return res.status(400).json({ error: 'Name and email are required' });
        }
        const existingStaff = await Staff.findOne({ where: { staffId: req.params.staffId } });
        if (!existingStaff) return res.status(404).json({ error: 'Staff member not found' });
        if (!req.session.isSuperAdmin && existingStaff.region !== req.session.region) {
            return res.status(403).json({ error: 'You can only manage staff in your own region.' });
        }
        const update = { name, email };
        if (password) {
            update.password = await bcrypt.hash(password, 10);
        }
        // Only the Super Admin can move a staff member to a different region
        if (req.session.isSuperAdmin && req.body.region !== undefined) {
            update.region = (req.body.region || '').trim();
        }
        // Only the Super Admin can change the Staff ID itself
        let newStaffId = null;
        if (req.session.isSuperAdmin && req.body.newStaffId !== undefined) {
            const trimmedNewId = (req.body.newStaffId || '').trim();
            if (trimmedNewId && trimmedNewId !== existingStaff.staffId) {
                const idTaken = await Staff.findOne({ where: { staffId: trimmedNewId } });
                if (idTaken) {
                    return res.status(400).json({ error: `Staff ID "${trimmedNewId}" is already in use.` });
                }
                newStaffId = trimmedNewId;
                update.staffId = newStaffId;
            }
        }
        await Staff.update(update, { where: { staffId: req.params.staffId } });
        if (newStaffId) {
            // Keep branch coverage assignments pointing at the same staff member under their new ID
            await StaffBranchAssignment.update({ staffId: newStaffId }, { where: { staffId: req.params.staffId } });
        }
        await logAudit(req.session.username, 'Edit Staff', `Updated staff ${req.params.staffId}${newStaffId ? ' (ID changed to ' + newStaffId + ')' : ''}${password ? ' (password reset)' : ''}`);
        res.json({ success: true, staffId: newStaffId || req.params.staffId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Remove a staff member (their existing tickets keep their historical assignedTo name)
app.delete('/tickets/staff/:staffId', checkAdminLogin, async (req, res) => {
    try {
        const existingStaff = await Staff.findOne({ where: { staffId: req.params.staffId } });
        if (!existingStaff) return res.status(404).json({ error: 'Staff member not found' });
        if (!req.session.isSuperAdmin && existingStaff.region !== req.session.region) {
            return res.status(403).json({ error: 'You can only manage staff in your own region.' });
        }
        await Staff.destroy({ where: { staffId: req.params.staffId } });
        await StaffBranchAssignment.destroy({ where: { staffId: req.params.staffId } });
        await logAudit(req.session.username, 'Delete Staff', `Removed staff ${req.params.staffId}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get branch coverage for all staff, as a { staffId: [branchNames] } map
app.get('/tickets/staff-branches', checkAdminLogin, async (req, res) => {
    try {
        const assignments = await StaffBranchAssignment.findAll();
        let map = {};
        assignments.forEach(a => {
            if (!map[a.staffId]) map[a.staffId] = [];
            map[a.staffId].push(a.branchName);
        });
        if (!req.session.isSuperAdmin) {
            const regionStaff = await Staff.findAll({ where: { region: req.session.region }, attributes: ['staffId'] });
            const regionStaffIds = regionStaff.map(s => s.staffId);
            const scopedMap = {};
            regionStaffIds.forEach(id => { if (map[id]) scopedMap[id] = map[id]; });
            map = scopedMap;
        }
        res.json(map);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Set which branches one staff member covers — replaces their whole assignment set,
// matching the old Mongo upsert-the-whole-array behavior
app.post('/tickets/staff-branches', checkAdminLogin, async (req, res) => {
    try {
        const { staffId, branches } = req.body;
        if (!req.session.isSuperAdmin) {
            const targetStaff = await Staff.findOne({ where: { staffId } });
            if (!targetStaff || targetStaff.region !== req.session.region) {
                return res.status(403).json({ error: 'You can only manage staff in your own region.' });
            }
            const ownRegionBranches = await getBranchNamesForRegion(req.session.region);
            const invalidBranch = (branches || []).find(b => !ownRegionBranches.includes(b));
            if (invalidBranch) {
                return res.status(403).json({ error: `"${invalidBranch}" is outside your region.` });
            }
        }
        await StaffBranchAssignment.destroy({ where: { staffId } });
        if (branches && branches.length) {
            await StaffBranchAssignment.bulkCreate(branches.map(branchName => ({ staffId, branchName })));
        }
        await logAudit(req.session.username, 'Update Branch Assignment', `Set branches for staff ${staffId}: ${branches && branches.length ? branches.join(', ') : 'none'}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Region Admin management (Super Admin only) ---
app.get('/region-admins', checkSuperAdminLogin, async (req, res) => {
    try {
        const admins = await RegionAdmin.findAll({ order: [['region', 'ASC'], ['name', 'ASC']] });
        res.json(admins.map(a => ({ id: a.id, name: a.name, username: a.username, region: a.region, enabled: a.enabled })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/region-admins', checkSuperAdminLogin, async (req, res) => {
    try {
        const name = (req.body.name || '').trim();
        const username = (req.body.username || '').trim();
        const password = req.body.password || '';
        const region = (req.body.region || '').trim();
        if (!name || !username || !password || !region) {
            return res.status(400).json({ error: 'Name, username, password, and region are all required.' });
        }
        const existing = await RegionAdmin.findOne({ where: { username } });
        if (existing) {
            return res.status(400).json({ error: `Username "${username}" is already in use.` });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        await RegionAdmin.create({ name, username, password: hashedPassword, region, enabled: true });
        await logAudit(req.session.username, 'Add Region Admin', `Added region admin ${name} (${username}) for region "${region}"`);
        res.status(201).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/region-admins/:id', checkSuperAdminLogin, async (req, res) => {
    try {
        const admin = await RegionAdmin.findByPk(req.params.id);
        if (!admin) return res.status(404).json({ error: 'Region admin not found.' });
        if (req.body.name !== undefined && req.body.name.trim()) admin.name = req.body.name.trim();
        if (req.body.region !== undefined && req.body.region.trim()) admin.region = req.body.region.trim();
        if (req.body.password) admin.password = await bcrypt.hash(req.body.password, 10);
        if (req.body.enabled !== undefined) admin.enabled = !!req.body.enabled;
        await admin.save();
        await logAudit(req.session.username, 'Edit Region Admin', `Updated region admin ${admin.username}${req.body.password ? ' (password reset)' : ''}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/region-admins/:id', checkSuperAdminLogin, async (req, res) => {
    try {
        const admin = await RegionAdmin.findByPk(req.params.id);
        if (admin) {
            await admin.destroy();
            await logAudit(req.session.username, 'Delete Region Admin', `Removed region admin ${admin.username}`);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Inbox: staff can message any admin; any admin (Super or Region) can reply ---
app.get('/inbox', checkUserLogin, async (req, res) => {
    try {
        const where = req.session.isAdmin ? {} : { sender: req.session.username };
        const messages = await InboxMessage.findAll({ where, order: [['createdAt', 'DESC']] });
        res.json(messages.map(withId));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/inbox', checkUserLogin, async (req, res) => {
    try {
        const subject = (req.body.subject || '').trim();
        const body = (req.body.body || '').trim();
        if (!subject || !body) {
            return res.status(400).json({ error: 'Subject and message are both required.' });
        }
        let senderStaffId = '';
        if (!req.session.isAdmin) {
            const senderStaff = await Staff.findOne({ where: { name: req.session.username } });
            if (senderStaff) senderStaffId = senderStaff.staffId;
        }
        const message = await InboxMessage.create({
            sender: req.session.username,
            senderStaffId,
            subject,
            body,
            adminRead: false,
            staffRead: true
        });
        res.status(201).json({ success: true, id: message.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/inbox/:id/reply', checkAdminLogin, async (req, res) => {
    try {
        const reply = (req.body.reply || '').trim();
        if (!reply) return res.status(400).json({ error: 'Reply message is required.' });
        const message = await InboxMessage.findByPk(req.params.id);
        if (!message) return res.status(404).json({ error: 'Message not found.' });
        message.reply = reply;
        message.repliedBy = req.session.username;
        message.repliedAt = new Date();
        message.status = 'Replied';
        message.adminRead = true;
        message.staffRead = false;
        await message.save();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/inbox/:id/read', checkUserLogin, async (req, res) => {
    try {
        const message = await InboxMessage.findByPk(req.params.id);
        if (!message) return res.status(404).json({ error: 'Message not found.' });
        if (req.session.isAdmin) {
            message.adminRead = true;
        } else if (message.sender === req.session.username) {
            message.staffRead = true;
        } else {
            return res.status(403).json({ error: 'Access Denied' });
        }
        await message.save();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/tickets', (req, res, next) => {
    upload.single('screenshot')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'File is too large. Maximum allowed size is 5MB.' });
            }
            return res.status(400).json({ error: err.message || 'Invalid file upload.' });
        }
        next();
    });
}, async (req, res) => {
    try {
        const branchName = req.body.branch || 'N/A';
        const allStaff = await Staff.findAll();

        // Find which staff explicitly cover this branch
        const coveringAssignments = await StaffBranchAssignment.findAll({ where: { branchName } });
        let eligibleStaff = coveringAssignments
            .map(a => allStaff.find(s => s.staffId === a.staffId))
            .filter(Boolean);

        // Nobody assigned to this branch yet -> fall back to round-robin across everyone
        if (eligibleStaff.length === 0) {
            eligibleStaff = allStaff;
        }

        // Round-robin among eligible staff, based on tickets already logged for this branch
        const branchTicketCount = await Ticket.count({ where: { branch: branchName } });
        const staffIndex = branchTicketCount % eligibleStaff.length;
        const assignedStaff = eligibleStaff[staffIndex];

        // ticketNumber is just this row's own auto-increment id — no separate counter needed
        const newTicket = await Ticket.create({
            title: req.body.title,
            submittedBy: req.body.submittedBy || 'Unknown',
            designation: req.body.designation || '',
            category: req.body.category || 'Other',
            branch: branchName,
            mobile: req.body.mobile,
            priority: req.body.priority,
            description: req.body.description,
            screenshot: req.file ? req.file.path : null,
            assignedTo: assignedStaff.name
        });
        const ticketNumber = newTicket.id;

        await Notification.create({
            recipient: assignedStaff.name,
            ticketId: newTicket.id,
            ticketNumber,
            title: newTicket.title,
            message: `Ticket #${String(ticketNumber).padStart(4, '0')} - ${newTicket.title} has been assigned to you.`
        });

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: assignedStaff.email,
            subject: `[Ticket #${String(ticketNumber).padStart(4, '0')}] - ${newTicket.title}`,
            text: `Hello ${assignedStaff.name},\n\nTicket Assigned:\nTicket #: ${String(ticketNumber).padStart(4, '0')}\nTitle: ${newTicket.title}\nSubmitted By: ${newTicket.submittedBy}\nBranch: ${newTicket.branch}\nMobile: ${newTicket.mobile}`
        };

        transporter.sendMail(mailOptions, (err, info) => {
            if (err) {
                console.error(`Assignment email FAILED for ticket #${String(ticketNumber).padStart(4, '0')} (to ${assignedStaff.email}):`, err.message);
            } else {
                console.log(`Assignment email sent for ticket #${String(ticketNumber).padStart(4, '0')} (to ${assignedStaff.email}):`, info.response);
            }
        });

        res.status(201).json(serializeTicket(newTicket));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server configuration active on port ${PORT}`);
});