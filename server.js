const express = require('express');
const dns = require('dns');
// Render's outbound network doesn't reliably support IPv6 — without this, Node tries
// Gmail's IPv6 address first and the connection dies with ENETUNREACH before it ever
// reaches Google. Forcing IPv4 first fixes that.
dns.setDefaultResultOrder('ipv4first');
const session = require('express-session');
const mongoose = require('mongoose');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// 1. CONNECT TO MONGOOSE DB
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/helpdesk"; 
mongoose.connect(MONGO_URI)
    .then(() => {
        console.log("Connected permanently to MongoDB Cloud");
        seedInitialStaff();
    })
    .catch(err => console.error("Database connection error:", err));

// Region Schema (e.g. TRIVANDRUM, KOLLAM) — groups branches together
const regionSchema = new mongoose.Schema({
    name: { type: String, required: true }
});
const Region = mongoose.model('Region', regionSchema);

// Branch Schema
const branchSchema = new mongoose.Schema({
    name: { type: String, required: true },
    region: { type: String, default: 'Unassigned' }
});
const Branch = mongoose.model('Branch', branchSchema);

// Staff-Branch Assignment Schema (which branches each staff member covers)
const staffBranchSchema = new mongoose.Schema({
    staffId: { type: String, required: true, unique: true },
    branches: [{ type: String }]
});
const StaffBranch = mongoose.model('StaffBranch', staffBranchSchema);

// Ticket Schema
const ticketSchema = new mongoose.Schema({
    ticketNumber: { type: Number, unique: true, sparse: true },
    title: String,
    submittedBy: { type: String, default: 'Unknown' },
    designation: { type: String, default: '' },
    category: { type: String, default: 'Other' },
    branch: { type: String, default: 'N/A' },
    priority: { type: String, default: 'Medium' },
    description: String,
    mobile: { type: String, required: true },
    screenshot: String, 
    status: { type: String, default: 'Open' },
    assignedTo: { type: String, default: 'Unassigned' },
    escalated: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date },
    comments: [{
        author: String,
        text: String,
        createdAt: { type: Date, default: Date.now }
    }]
});
const Ticket = mongoose.model('Ticket', ticketSchema);

// Counter Schema, used to hand out sequential, human-friendly ticket numbers
const counterSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    value: { type: Number, default: 0 }
});
const Counter = mongoose.model('Counter', counterSchema);

// Audit Log Schema — tracks admin management actions (staff/branch changes)
const auditLogSchema = new mongoose.Schema({
    actor: { type: String, required: true },
    action: { type: String, required: true },
    details: { type: String },
    createdAt: { type: Date, default: Date.now }
});
const AuditLog = mongoose.model('AuditLog', auditLogSchema);

async function logAudit(actor, action, details) {
    try {
        await AuditLog.create({ actor, action, details });
    } catch (err) {
        console.error('Failed to write audit log entry:', err.message);
    }
}

async function getNextTicketNumber() {
    const counter = await Counter.findOneAndUpdate(
        { name: 'ticketNumber' },
        { $inc: { value: 1 } },
        { upsert: true, returnDocument: 'after' }
    );
    return counter.value;
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
        allowed_formats: ['jpg', 'png', 'jpeg', 'webp']
    }
});
const upload = multer({ storage: storage });

// Staff Schema (persisted so staff can be added via the admin panel)
const staffSchema = new mongoose.Schema({
    staffId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    password: { type: String, required: true },
    email: { type: String, required: true }
});
const Staff = mongoose.model('Staff', staffSchema);

// One-time seed of the original IT staff accounts, only if the collection is empty
async function seedInitialStaff() {
    const existingCount = await Staff.countDocuments();
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
        await Staff.insertMany(defaults);
        console.log('Seeded initial IT staff accounts');
    }
}

// Generates the next sequential staff ID, e.g. IT005
async function getNextStaffId() {
    const allStaff = await Staff.find();
    let maxNum = 0;
    allStaff.forEach(s => {
        const match = s.staffId.match(/(\d+)$/);
        if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    });
    return 'IT' + String(maxNum + 1).padStart(3, '0');
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
    saveUninitialized: true,
    cookie: {
        maxAge: 1800000,
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

// User Ticket Submission Page
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Submit a Ticket | SARATHY IT</title><link rel="icon" type="image/png" href="/logo.png"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: 'Inter', 'Segoe UI', Arial, sans-serif;
    height: 100vh; display: flex; align-items: center; justify-content: center;
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
    overflow: hidden;
}
.ticket-card { width: 100%; max-width: 660px; max-height: 92vh; background: #fdfcfb; border-radius: 14px; box-shadow: 0 24px 70px rgba(0,0,0,0.45); overflow-y: auto; overflow-x: hidden; }
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
.page-footer { position: fixed; bottom: 8px; left: 0; width: 100%; text-align: center; font-size: 11px; color: rgba(255,255,255,0.55); letter-spacing: .3px; }
</style></head><body><div class="ticket-card"><div class="ticket-ribbon"><img src="/logo.png" alt="Company Logo" onerror="this.style.display='none'"><span class="ticket-ribbon-text">Sarathy IT Helpdesk</span></div><div class="tab-switch"><button type="button" class="tab-btn active" id="tabSubmitBtn" onclick="showTab('submit')">Submit Ticket</button><button type="button" class="tab-btn" id="tabStatusBtn" onclick="showTab('status')">Check Status</button></div><div class="ticket-body"><div id="submitPane"><h2 class="form-title">Submit a New Ticket</h2><div class="form-subtitle">We'll route it to the right person and keep you posted.</div><div class="ticket-perforation"></div><form id="ticketForm" enctype="multipart/form-data" class="form-grid"><div class="form-field"><label>Your Name</label><input type="text" id="submitterName" required></div><div class="form-field"><label>Designation</label><input type="text" id="submitterDesignation"></div><div class="form-field"><label>Mobile Number</label><input type="tel" id="mobile" placeholder="10-digit mobile number" pattern="[0-9]{10}" maxlength="10" inputmode="numeric" oninput="this.value=this.value.replace(/[^0-9]/g,'').slice(0,10)" required></div><div class="form-field full-width"><label>Issue Title</label><input type="text" id="title" required></div><div class="form-field"><label>Region</label><select id="region" required onchange="updateBranchOptions()"><option value="" disabled selected>Loading...</option></select></div><div class="form-field"><label>Branch Location</label><select id="branch" required><option value="" disabled selected>Select region first</option></select></div><div class="form-field"><label>Priority Level</label><select id="priority"><option value="Low">Low</option><option value="Medium" selected>Medium</option><option value="High">High</option></select></div><div class="form-field"><label>Category</label><select id="category" required><option value="" disabled selected>Select Category</option><option value="Hardware">Hardware</option><option value="Software">Software</option><option value="Network">Network</option><option value="Printer">Printer</option><option value="Other">Other</option></select></div><div class="form-field full-width"><label>Description</label><textarea id="description" required></textarea></div><div class="form-field full-width"><label>Upload Screenshot (Optional)</label><input type="file" id="screenshot" accept="image/*"></div><button type="submit" id="submitTicketBtn">Submit Ticket</button></form></div><div id="statusPane" style="display:none;"><h2 class="form-title">Check Ticket Status</h2><div class="form-subtitle">Enter the mobile number you used when submitting.</div><label>Mobile Number</label><input type="tel" id="statusMobile" placeholder="Enter your 10-digit mobile number" pattern="[0-9]{10}" maxlength="10" inputmode="numeric" oninput="this.value=this.value.replace(/[^0-9]/g,'').slice(0,10)"><button type="button" class="check-status-btn" onclick="checkTicketStatus()">Check Status</button><div id="statusResults"></div></div></div></div><div class="page-footer">&copy; 2026 Sarathy Pvt Ltd</div><script>
    let allBranchesCache = [];
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
        if (fileInput.files[0]) formData.append('screenshot', fileInput.files[0]); 
        try {
            const response = await fetch('/tickets', { method: 'POST', body: formData }); 
            if (response.ok) { 
                const result = await response.json();
                alert('Ticket #' + String(result.ticketNumber).padStart(4, '0') + ' submitted successfully!'); 
                document.getElementById('ticketForm').reset(); 
                loadFormBranches();
            } else {
                alert('Could not submit the ticket. Please try again.');
            }
        } catch (err) {
            alert('Something went wrong submitting the ticket. Please check your connection and try again.');
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
        req.session.isStaff = false;
        req.session.username = 'Admin';
        return res.json({ success: true, redirect: '/admin' });
    }
    const allStaff = await Staff.find();
    const staffUser = allStaff.find(s => s.name.toLowerCase() === username.toLowerCase());
    if (staffUser && await verifyPassword(password, staffUser.password)) {
        // Lazily upgrade legacy plaintext passwords to a bcrypt hash on successful login
        if (!staffUser.password.startsWith('$2')) {
            staffUser.password = await bcrypt.hash(password, 10);
            await staffUser.save();
        }
        req.session.isAdmin = false;
        req.session.isStaff = true;
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
    const isAdminUser = !!req.session.isAdmin;

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
'        .sidebar { width: 260px; background-color: #1e2229; color: #fff; display: flex; flex-direction: column; justify-content: space-between; }' +
'        .sidebar-brand { padding: 24px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #2d323e; }' +
'        .sidebar-logo { height: 35px; width: auto; object-fit: contain; }' +
'        .sidebar-title { font-size: 18px; font-weight: 700; color: #fff; letter-spacing: 0.5px; }' +
'        .sidebar-menu { list-style: none; padding: 20px 0; flex-grow: 1; }' +
'        .menu-category { font-size: 11px; font-weight: 700; text-transform: uppercase; color: #4a5568; padding: 10px 24px 5px 24px; letter-spacing: 0.5px; }' +
'        .menu-item { padding: 12px 24px; display: flex; align-items: center; gap: 12px; color: #a0aec0; text-decoration: none; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s; border-left: 4px solid transparent; }' +
'        .menu-item:hover, .menu-item.active { background-color: #2d323e; color: #fff; border-left-color: #0056b3; }' +
'        .sidebar-footer { padding: 20px; border-top: 1px solid #2d323e; }' +
'        .user-info { font-size: 12px; color: #a0aec0; margin-bottom: 12px; }' +
'        .user-info strong { color: #fff; display: block; font-size: 14px; margin-bottom: 2px; }' +
'        .logout-btn { display: block; width: 100%; text-align: center; background-color: #e53e3e; color: white; text-decoration: none; padding: 10px; border-radius: 6px; font-size: 14px; font-weight: 600; transition: background 0.2s; }' +
'        .logout-btn:hover { background-color: #c53030; }' +
'        .main-content { flex-grow: 1; display: flex; flex-direction: column; height: 100vh; overflow-y: auto; }' +
'        .top-navbar { height: 70px; background-color: #fff; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between; padding: 0 30px; }' +
'        .page-title { font-size: 20px; font-weight: 600; color: #2d3748; }' +
'        .content-body { padding: 30px; max-width: 1200px; width: 100%; margin: 0 auto; }' +
'        .dashboard-view { display: none; }' +
'        .dashboard-view.active { display: block; }' +
'        .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; margin-bottom: 30px; }' +
'        .metric-card { background: white; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); border: 1px solid #e2e8f0; border-top: 4px solid #3182ce; }' +
'        .metric-card.resolved { border-top-color: #38a169; }' +
'        .metric-card.assigned { border-top-color: #dd6b20; }' +
'        .metric-label { font-size: 13px; font-weight: 600; color: #718096; text-transform: uppercase; letter-spacing: 0.5px; }' +
'        .metric-value { font-size: 28px; font-weight: 700; color: #2d3748; margin-top: 5px; }' +
'        .ticket-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); position: relative; }' +
'        .ticket-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }' +
'        .ticket-title { font-size: 18px; font-weight: 600; color: #2d3748; }' +
'        .ticket-desc { color: #4a5568; font-size: 14px; line-height: 1.5; margin-bottom: 16px; }' +
'        .badge { padding: 4px 10px; border-radius: 50px; font-size: 11px; font-weight: 700; text-transform: uppercase; display: inline-block; margin-right: 8px; }' +
'        .p-Low { background-color: #edf2f7; color: #4a5568; }' +
'        .p-Medium { background-color: #feebc8; color: #c05621; }' +
'        .p-High { background-color: #fed7d7; color: #9b2c2c; }' +
'        .status-open { background-color: #ebf8ff; color: #2b6cb0; }' +
'        .status-resolved { background-color: #c6f6d5; color: #22543d; }' +
'        .resolve-btn { background-color: #38a169; color: white; border: none; padding: 8px 16px; font-size: 13px; font-weight: 600; border-radius: 6px; cursor: pointer; transition: background 0.2s; }' +
'        .resolve-btn:hover { background-color: #2f855a; }' +
'        .escalate-btn { background-color: #dd6b20; color: white; border: none; padding: 8px 16px; font-size: 13px; font-weight: 600; border-radius: 6px; cursor: pointer; transition: background 0.2s; margin-left: 8px; }' +
'        .escalate-btn:hover { background-color: #c05621; }' +
'        .badge-escalated { background-color: #fef3c7; color: #92400e; }' +
'        .badge-category { background-color: #e6fffa; color: #234e52; }' +
'        .screenshot-preview { max-width: 100%; max-height: 180px; border-radius: 6px; border: 1px solid #e2e8f0; margin-top: 12px; display: block; object-fit: cover; }' +
'        .assignment-info { margin-top: 16px; padding-top: 12px; border-top: 1px solid #edf2f7; font-size: 13px; color: #718096; }' +
'        .assignment-info strong { color: #4a5568; }' +
'        .comments-section { margin-top: 20px; background-color: #f7fafc; padding: 16px; border-radius: 8px; border: 1px solid #edf2f7; }' +
'        .comments-header { font-size: 12px; font-weight: 700; color: #718096; text-transform: uppercase; margin-bottom: 10px; letter-spacing: 0.5px; }' +
'        .comment-item { padding: 8px 0; border-bottom: 1px solid #edf2f7; font-size: 13px; color: #4a5568; }' +
'        .comment-item strong { color: #2d3748; }' +
'        .comment-form { display: flex; gap: 10px; margin-top: 12px; }' +
'        .comment-form input { flex-grow: 1; padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 13px; }' +
'        .comment-form button { background-color: #3182ce; color: white; border: none; padding: 8px 16px; font-size: 13px; font-weight: 600; border-radius: 6px; cursor: pointer; }' +
'        .branch-panel-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }' +
'        .branch-panel-card h2 { font-size: 16px; font-weight: 600; color: #2d3748; margin-bottom: 20px; }' +
'        .branch-input-group { display: flex; gap: 15px; margin-bottom: 25px; flex-wrap: wrap; }' +
'        .branch-input-group input { flex-grow: 1; padding: 12px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px; }' +
'        .branch-add-btn { background-color: #0056b3; color: white; border: none; padding: 0 30px; font-size: 14px; font-weight: 600; border-radius: 6px; cursor: pointer; }' +
'        .branch-table { width: 100%; border-collapse: collapse; text-align: left; margin-top: 10px; }' +
'        .branch-table th { background-color: #f7fafc; color: #4a5568; font-size: 13px; font-weight: 600; padding: 12px 16px; border-bottom: 1px solid #e2e8f0; }' +
'        .branch-table td { padding: 14px 16px; font-size: 14px; color: #2d3748; border-bottom: 1px solid #edf2f7; }' +
'        .branch-delete-btn { color: #e53e3e; background: none; border: none; cursor: pointer; font-weight: 600; font-size: 13px; }' +
'        .chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; margin-top: 24px; }' +
'        .chart-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); position: relative; height: 300px; }' +
'        .chart-card.wide { grid-column: 1 / -1; }' +
'        .chart-card h3 { font-size: 14px; font-weight: 600; color: #2d3748; margin: 0 0 14px; }' +
'        .section-heading { font-size: 16px; font-weight: 600; color: #2d3748; margin: 28px 0 0; }' +
'    </style>' +
'</head>' +
'<body>' +
'    <div class="sidebar-backdrop" id="sidebarBackdrop" onclick="closeSidebar()"></div>' +
'    <aside class="sidebar" id="sidebar">' +
'        <div>' +
'            <div class="sidebar-brand">' +
'                <img src="/logo.png" alt="Logo" class="sidebar-logo" onerror="this.style.display=\'none\'">' +
'                <span class="sidebar-title">SARATHY IT</span>' +
'            </div>' +
'            <div class="menu-category">Navigation</div>' +
'            <ul class="sidebar-menu">' +
'                <li class="menu-item active" id="tabTicketsLink" onclick="switchView(\'tickets\')">Tickets System</li>' +
(isAdminUser ? '                <li class="menu-item" id="tabBranchesLink" onclick="switchView(\'branches\')">Manage Branches</li>' : '') +
(isAdminUser ? '                <li class="menu-item" id="tabStaffLink" onclick="switchView(\'staff\')">Manage IT Staff</li>' : '') +
(isAdminUser ? '                <li class="menu-item" id="tabAuditLink" onclick="switchView(\'audit\')">Audit Log</li>' : '') +
'                <li class="menu-item" id="tabReportsLink" onclick="switchView(\'reports\')">Reports</li>' +
'                <li class="menu-item" id="tabPasswordLink" onclick="switchView(\'password\')">Change Password</li>' +
'            </ul>' +
'        </div>' +
'        <div class="sidebar-footer">' +
'            <div class="user-info">' +
'                <span>Logged in as</span>' +
'                <strong id="displayUserLabel">Loading...</strong>' +
'            </div>' +
'            <a href="/logout" class="logout-btn">Logout</a>' +
'        </div>' +
'    </aside>' +
'    <main class="main-content">' +
'        <header class="top-navbar">' +
'            <button class="hamburger-btn" onclick="toggleSidebar()" aria-label="Menu"><span></span><span></span><span></span></button>' +
'            <h1 class="page-title" id="panelViewTitle">Helpdesk Operations</h1>' +
'        </header>' +
'        <section class="content-body">' +
'            <div id="viewTickets" class="dashboard-view active">' +
'                <div class="metrics-grid">' +
'                    <div class="metric-card" style="cursor:pointer;" onclick="filterByStatus(\'Open\')"><div class="metric-label">Open Issues</div><div class="metric-value" id="statOpen">0</div></div>' +
'                    <div class="metric-card resolved" style="cursor:pointer;" onclick="filterByStatus(\'Resolved\')"><div class="metric-label">Resolved Issues</div><div class="metric-value" id="statResolved">0</div></div>' +
'                    <div class="metric-card assigned" style="cursor:pointer;" onclick="filterByStatus(\'all\')"><div class="metric-label">Total Tickets</div><div class="metric-value" id="statMine">0</div></div>' +
'                </div>' +
'                <div class="branch-panel-card" style="margin-bottom: 20px; display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap;">' +
'                    <div><label style="display:block;font-size:12px;font-weight:600;color:#4a5568;margin-bottom:4px;">From Date</label><input type="date" id="filterFromDate" style="padding: 8px 10px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px;"></div>' +
'                    <div><label style="display:block;font-size:12px;font-weight:600;color:#4a5568;margin-bottom:4px;">To Date</label><input type="date" id="filterToDate" style="padding: 8px 10px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px;"></div>' +
'                    <div id="staffFilterWrapper" style="display:none;"><label style="display:block;font-size:12px;font-weight:600;color:#4a5568;margin-bottom:4px;">Staff</label><select id="filterStaff" style="padding: 8px 10px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px;"><option value="">All Staff</option></select></div>' +
'                    <div><label style="display:block;font-size:12px;font-weight:600;color:#4a5568;margin-bottom:4px;">Category</label><select id="filterCategory" style="padding: 8px 10px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px;"><option value="">All Categories</option><option value="Hardware">Hardware</option><option value="Software">Software</option><option value="Network">Network</option><option value="Printer">Printer</option><option value="Other">Other</option></select></div>' +
'                    <button class="branch-add-btn" onclick="applyTicketFilters()">Search</button>' +
'                    <button class="branch-delete-btn" onclick="clearTicketFilters()">Clear</button>' +
'                </div>' +
'                <div id="ticketList">Loading active queue...</div>' +
'            </div>' +
'            <div id="viewReports" class="dashboard-view">' +
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
'            <div id="viewBranches" class="dashboard-view">' +
'                <div class="branch-panel-card" style="margin-bottom: 20px;">' +
'                    <h2>Manage Regions</h2>' +
'                    <div class="branch-input-group">' +
'                        <input type="text" id="newRegionName" placeholder="e.g. TRIVANDRUM">' +
'                        <button class="branch-add-btn" onclick="addNewRegion()">Add Region</button>' +
'                    </div>' +
'                    <table class="branch-table">' +
'                        <thead><tr><th>Region Name</th><th>Edit</th><th>Delete</th></tr></thead>' +
'                        <tbody id="regionTableBody"></tbody>' +
'                    </table>' +
'                </div>' +
'                <div class="branch-panel-card">' +
'                    <h2>Create New Branch Location</h2>' +
'                    <div class="branch-input-group">' +
'                        <input type="text" id="newBranchName" placeholder="Enter Branch Details">' +
'                        <select id="newBranchRegion" style="flex-grow: 1; padding: 12px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px;"><option value="" disabled selected>Select Region</option></select>' +
'                        <button class="branch-add-btn" onclick="addNewBranch()">Add Branch</button>' +
'                    </div>' +
'                    <div id="branchGroupsContainer"></div>' +
'                </div>' +
'            </div>' +
'            <div id="viewStaff" class="dashboard-view">' +
'                <div class="branch-panel-card" style="margin-bottom: 20px;">' +
'                    <h2>Add New Staff Member</h2>' +
'                    <div class="branch-input-group">' +
'                        <input type="text" id="newStaffName" placeholder="Full Name">' +
'                        <input type="text" id="newStaffPassword" placeholder="Password">' +
'                        <input type="email" id="newStaffEmail" placeholder="Email">' +
'                        <button class="branch-add-btn" onclick="addNewStaff()">Add Staff</button>' +
'                    </div>' +
'                </div>' +
'                <div class="branch-panel-card">' +
'                    <h2>Active Helpdesk Personnel</h2>' +
'                    <table class="branch-table">' +
'                        <thead><tr><th>Staff ID</th><th>Name Tag</th><th>Operational Route Email</th><th>Assigned Branches</th><th>Edit</th><th>Delete</th></tr></thead>' +
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
'        </section>' +
'    </main>' +
'    <script>' +
'        const currentUser = "' + dynamicUsername + '";' +
'        const isAdmin = ' + dynamicIsAdmin + ';' +
'        document.getElementById("displayUserLabel").innerText = currentUser;' +
'        function toggleSidebar() {' +
'            document.getElementById("sidebar").classList.toggle("sidebar-open");' +
'            document.getElementById("sidebarBackdrop").classList.toggle("active");' +
'        }' +
'        function closeSidebar() {' +
'            document.getElementById("sidebar").classList.remove("sidebar-open");' +
'            document.getElementById("sidebarBackdrop").classList.remove("active");' +
'        }' +
'        function switchView(target) {' +
'            closeSidebar();' +
'            if ((target === "branches" || target === "staff" || target === "audit") && !isAdmin) {' +
'                alert("Access Denied: Admins only.");' +
'                return;' +
'            }' +
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
'            }' +
'        }' +
'        let currentStatusFilter = "all";' +
'        function filterByStatus(status) {' +
'            currentStatusFilter = status;' +
'            loadTickets();' +
'        }' +
'        function applyTicketFilters() {' +
'            loadTickets();' +
'        }' +
'        function clearTicketFilters() {' +
'            document.getElementById("filterFromDate").value = "";' +
'            document.getElementById("filterToDate").value = "";' +
'            document.getElementById("filterCategory").value = "";' +
'            const sf = document.getElementById("filterStaff");' +
'            if (sf) sf.value = "";' +
'            currentStatusFilter = "all";' +
'            loadTickets();' +
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
'        async function loadTickets() {' +
'            const response = await fetch("/tickets");' +
'            if (response.status === 401) { window.location.href = "/login"; return; }' +
'            let tickets = await response.json();' +
'            if (!isAdmin) { tickets = tickets.filter(t => t.assignedTo === currentUser); }' +
'            const staffFilterEl = document.getElementById("filterStaff");' +
'            const staffFilterValue = staffFilterEl ? staffFilterEl.value : "";' +
'            if (staffFilterValue) { tickets = tickets.filter(t => t.assignedTo === staffFilterValue); }' +
'            const categoryFilterValue = document.getElementById("filterCategory").value;' +
'            if (categoryFilterValue) { tickets = tickets.filter(t => (t.category || "Other") === categoryFilterValue); }' +
'            const fromVal = document.getElementById("filterFromDate").value;' +
'            const toVal = document.getElementById("filterToDate").value;' +
'            if (fromVal) { const fromDate = new Date(fromVal + "T00:00:00"); tickets = tickets.filter(t => t.createdAt && new Date(t.createdAt) >= fromDate); }' +
'            if (toVal) { const toDate = new Date(toVal + "T23:59:59"); tickets = tickets.filter(t => t.createdAt && new Date(t.createdAt) <= toDate); }' +
'            document.getElementById("statOpen").innerText = tickets.filter(t => t.status === "Open").length;' +
'            document.getElementById("statResolved").innerText = tickets.filter(t => t.status === "Resolved").length;' +
'            document.getElementById("statMine").innerText = tickets.length;' +
'            if (currentStatusFilter !== "all") { tickets = tickets.filter(t => t.status === currentStatusFilter); }' +
'            const listDiv = document.getElementById("ticketList");' +
'            if (tickets.length === 0) {' +
'                listDiv.innerHTML = \'<p style="text-align: center; color: #718096; padding: 40px 0;">No support requests logs found.</p>\';' +
'                return;' +
'            }' +
'            listDiv.innerHTML = "";' +
'            tickets.forEach(ticket => {' +
'                const isResolved = ticket.status === "Resolved";' +
'                const actionBtn = isResolved ? "" : \'<button class="resolve-btn" onclick="resolveTicket(\\\'\'+ticket._id+\'\\\')">Resolve Ticket</button>\';' +
'                const escalateBtn = (!isAdmin && !isResolved && !ticket.escalated) ? \' <button class="escalate-btn" onclick="escalateTicket(\\\'\'+ticket._id+\'\\\')">Escalate to Admin</button>\' : "";' +
'                const escalatedBadge = ticket.escalated ? \'<span class="badge badge-escalated">Escalated</span>\' : "";' +
'                const resolvedLine = (ticket.status === "Resolved" && ticket.resolvedAt) ? \' | <span><strong>Resolved:</strong> \'+new Date(ticket.resolvedAt).toLocaleString()+\'</span>\' : "";' +
'                const imageHtml = ticket.screenshot ? \'<a href="\'+ticket.screenshot+\'" target="_blank"><img src="\'+ticket.screenshot+\'" class="screenshot-preview"></a>\' : "";' +
'                let commentListHtml = "";' +
'                if (ticket.comments) {' +
'                    ticket.comments.forEach(c => {' +
'                        commentListHtml += \'<div class="comment-item"><strong>\'+c.author+\':</strong> \'+c.text+\'</div>\';' +
'                    });' +
'                }' +
'                listDiv.innerHTML += \'<div class="ticket-card"><div class="ticket-header"><div><h3 class="ticket-title">#\'+String(ticket.ticketNumber).padStart(4,"0")+\' \'+ticket.title+\'</h3><div style="margin-top: 8px;"><span class="badge p-\'+ticket.priority+\'">\'+ticket.priority+\'</span><span class="badge status-\'+ticket.status.toLowerCase()+\'">\'+ticket.status+\'</span><span class="badge badge-category">\'+(ticket.category || "Other")+\'</span>\'+escalatedBadge+\'</div></div>\'+actionBtn+escalateBtn+\'</div><p class="ticket-desc">\'+ticket.description+\'</p>\'+imageHtml+\'<div class="assignment-info"><span><strong>Submitted By:</strong> \'+(ticket.submittedBy || "Unknown")+(ticket.designation ? " ("+ticket.designation+")" : "")+\'</span> | <span><strong>Branch:</strong> \'+ticket.branch+\'</span> | <span><strong>Mobile:</strong> \'+ticket.mobile+\'</span> | <span><strong>Assigned:</strong> \'+ticket.assignedTo+\'</span> | <span><strong>Submitted:</strong> \'+(ticket.createdAt ? new Date(ticket.createdAt).toLocaleString() : "N/A")+\'</span>\'+resolvedLine+\'</div><div class="comments-section"><h4 class="comments-header">Internal Work Notes</h4><div>\'+(commentListHtml || "No updates.")+\'</div><div class="comment-form"><input type="text" id="input-\'+ticket._id+\'" placeholder="Write operational update..."><button onclick="addComment(\\\'\'+ticket._id+\'\\\')">Post</button></div></div></div>\';' +
'            });' +
'        }' +
'async function loadRegionsList() {' +
'    const response = await fetch("/tickets/regions");' +
'    const regions = await response.json();' +
'    const tbody = document.getElementById("regionTableBody");' +
'    tbody.innerHTML = "";' +
'    if (regions.length === 0) {' +
'        tbody.innerHTML = \'<tr><td colspan="3" style="text-align: center; color: #a0aec0; padding: 20px;">No regions added yet.</td></tr>\';' +
'    } else {' +
'        regions.forEach(r => {' +
'            const safeName = r.name.replace(/\'/g, "\\\\\'");' +
'            tbody.innerHTML += \'<tr><td>\'+r.name+\'</td><td><button class="branch-delete-btn" onclick="editRegion(\\\'\'+r._id+\'\\\', \\\'\'+safeName+\'\\\')">Edit</button></td><td><button class="branch-delete-btn" onclick="deleteRegion(\\\'\'+r._id+\'\\\')">Delete</button></td></tr>\';' +
'        });' +
'    }' +
'    const select = document.getElementById("newBranchRegion");' +
'    select.innerHTML = \'<option value="" disabled selected>Select Region</option>\';' +
'    regions.forEach(r => {' +
'        select.innerHTML += \'<option value="\'+r.name+\'">\'+r.name+\'</option>\';' +
'    });' +
'}' +
'async function addNewRegion() {' +
'    const input = document.getElementById("newRegionName");' +
'    const name = input.value.trim();' +
'    if (!name) return;' +
'    const response = await fetch("/tickets/regions", {' +
'        method: "POST",' +
'        headers: { "Content-Type": "application/json" },' +
'        body: JSON.stringify({ name })' +
'    });' +
'    if (response.ok) { input.value = ""; loadRegionsList(); loadBranchesList(); }' +
'    else { const err = await response.json(); alert(err.error || "Could not add region."); }' +
'}' +
'async function editRegion(id, currentName) {' +
'    const newName = prompt("Edit region name:", currentName);' +
'    if (!newName || !newName.trim() || newName === currentName) return;' +
'    const response = await fetch("/tickets/regions/" + id, {' +
'        method: "PUT",' +
'        headers: { "Content-Type": "application/json" },' +
'        body: JSON.stringify({ name: newName.trim() })' +
'    });' +
'    if (response.ok) { loadRegionsList(); loadBranchesList(); }' +
'    else { const err = await response.json(); alert(err.error || "Could not update region."); }' +
'}' +
'async function deleteRegion(id) {' +
'    if (!confirm("Remove this region?")) return;' +
'    const response = await fetch("/tickets/regions/" + id, { method: "DELETE" });' +
'    if (response.ok) { loadRegionsList(); loadBranchesList(); }' +
'    else { const err = await response.json(); alert(err.error || "Could not delete region."); }' +
'}' +
'async function loadBranchesList() {' +
'    const [branchRes, regionRes] = await Promise.all([fetch("/public-branches"), fetch("/tickets/regions")]);' +
'    const branches = await branchRes.json();' +
'    const regions = await regionRes.json();' +
'    const allRegionNames = regions.map(r => r.name);' +
'    if (allRegionNames.indexOf("Unassigned") === -1) allRegionNames.push("Unassigned");' +
'    const container = document.getElementById("branchGroupsContainer");' +
'    container.innerHTML = "";' +
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
'        container.innerHTML +=' +
'            \'<h3 style="margin: 20px 0 8px; font-size: 14px; font-weight: 700; color: #4a5568; text-transform: uppercase; letter-spacing: 0.5px;">\' + region + \'</h3>\' +' +
'            \'<table class="branch-table"><thead><tr><th>Branch Name</th><th>Region</th><th>Edit</th><th>Delete</th></tr></thead><tbody>\' + rowsHtml + \'</tbody></table>\';' +
'    });' +
'}' +
'async function addNewBranch() {' +
'    const input = document.getElementById("newBranchName");' +
'    const regionSelect = document.getElementById("newBranchRegion");' +
'    const name = input.value.trim();' +
'    const region = regionSelect.value;' +
'    if (!name || !region) { alert("Please enter a branch name and select a region."); return; }' +
'    const response = await fetch("/tickets/branches", {' +
'        method: "POST",' +
'        headers: { "Content-Type": "application/json" },' +
'        body: JSON.stringify({ name, region })' +
'    });' +
'    if (response.ok) { input.value = ""; regionSelect.value = ""; loadBranchesList(); }' +
'    else { const err = await response.json(); alert(err.error || "Could not add branch."); }' +
'}' +
'async function editBranch(id, currentName) {' +
'    const newName = prompt("Edit branch name:", currentName);' +
'    if (!newName || !newName.trim() || newName === currentName) return;' +
'    const response = await fetch("/tickets/branches/" + id, {' +
'        method: "PUT",' +
'        headers: { "Content-Type": "application/json" },' +
'        body: JSON.stringify({ name: newName.trim() })' +
'    });' +
'    if (response.ok) loadBranchesList();' +
'    else alert("Could not update branch.");' +
'}' +
'async function deleteBranch(id) {' +
'    if(!confirm("Remove this branch option?")) return;' +
'    const response = await fetch("/tickets/branches/" + id, { method: "DELETE" });' +
'    if(response.ok) loadBranchesList();' +
'}' +
'async function moveBranchRegion(id, newRegion) {' +
'    const response = await fetch("/tickets/branches/" + id, {' +
'        method: "PUT",' +
'        headers: { "Content-Type": "application/json" },' +
'        body: JSON.stringify({ region: newRegion })' +
'    });' +
'    if (response.ok) loadBranchesList();' +
'    else alert("Could not move branch to that region.");' +
'}' +
'        async function loadStaffList() {' +
'            const [staffRes, branchRes, assignRes] = await Promise.all([' +
'                fetch("/tickets/staff-list"), fetch("/public-branches"), fetch("/tickets/staff-branches")' +
'            ]);' +
'            const staff = await staffRes.json();' +
'            const branches = await branchRes.json();' +
'            const assignments = await assignRes.json();' +
'            const tbody = document.getElementById("staffTableBody");' +
'            tbody.innerHTML = "";' +
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
'                let nameCell, emailCell, editCell, deleteCell;' +
'                if (editingStaffIds.has(s.id)) {' +
'                    nameCell = \'<input type="text" id="editName-\'+s.id+\'" value="\'+s.name+\'" style="width:100%;padding:6px;border:1px solid #cbd5e0;border-radius:4px;">\';' +
'                    emailCell = \'<input type="email" id="editEmail-\'+s.id+\'" value="\'+s.email+\'" style="width:100%;padding:6px;border:1px solid #cbd5e0;border-radius:4px;margin-bottom:4px;"><input type="text" id="editPassword-\'+s.id+\'" placeholder="New password (optional)" style="width:100%;padding:6px;border:1px solid #cbd5e0;border-radius:4px;">\';' +
'                    editCell = \'<button class="resolve-btn" onclick="saveStaffEdit(\\\'\'+s.id+\'\\\')">Save</button>\';' +
'                    deleteCell = \'<button class="branch-delete-btn" onclick="toggleEditStaff(\\\'\'+s.id+\'\\\')">Cancel</button>\';' +
'                } else {' +
'                    nameCell = s.name;' +
'                    emailCell = s.email;' +
'                    editCell = \'<button class="branch-delete-btn" onclick="toggleEditStaff(\\\'\'+s.id+\'\\\')">Edit</button>\';' +
'                    deleteCell = \'<button class="branch-delete-btn" onclick="deleteStaff(\\\'\'+s.id+\'\\\')">Delete</button>\';' +
'                }' +
'                tbody.innerHTML += \'<tr><td>\'+s.id+\'</td><td>\'+nameCell+\'</td><td>\'+emailCell+\'</td><td>\'+checkboxesHtml+\'</td><td>\'+editCell+\'</td><td>\'+deleteCell+\'</td></tr>\';' +
'            });' +
'        }' +
'        let editingStaffIds = new Set();' +
'        function toggleEditStaff(staffId) {' +
'            if (editingStaffIds.has(staffId)) editingStaffIds.delete(staffId);' +
'            else editingStaffIds.add(staffId);' +
'            loadStaffList();' +
'        }' +
'        async function saveStaffEdit(staffId) {' +
'            const name = document.getElementById("editName-" + staffId).value.trim();' +
'            const email = document.getElementById("editEmail-" + staffId).value.trim();' +
'            const password = document.getElementById("editPassword-" + staffId).value.trim();' +
'            if (!name || !email) { alert("Name and email are required."); return; }' +
'            const body = { name, email };' +
'            if (password) body.password = password;' +
'            const response = await fetch("/tickets/staff/" + staffId, {' +
'                method: "PUT",' +
'                headers: { "Content-Type": "application/json" },' +
'                body: JSON.stringify(body)' +
'            });' +
'            if (response.ok) {' +
'                editingStaffIds.delete(staffId);' +
'                loadStaffList();' +
'            } else {' +
'                alert("Could not update staff member.");' +
'            }' +
'        }' +
'        async function deleteStaff(staffId) {' +
'            if (!confirm("Remove this staff member? This cannot be undone.")) return;' +
'            const response = await fetch("/tickets/staff/" + staffId, { method: "DELETE" });' +
'            if (response.ok) loadStaffList();' +
'            else alert("Could not delete staff member.");' +
'        }' +
'        async function loadAuditLog() {' +
'            const response = await fetch("/audit-log");' +
'            const entries = await response.json();' +
'            const tbody = document.getElementById("auditLogTableBody");' +
'            tbody.innerHTML = "";' +
'            if (entries.length === 0) {' +
'                tbody.innerHTML = \'<tr><td colspan="4" style="text-align: center; color: #a0aec0; padding: 20px;">No activity recorded yet.</td></tr>\';' +
'                return;' +
'            }' +
'            entries.forEach(e => {' +
'                tbody.innerHTML += \'<tr><td>\'+new Date(e.createdAt).toLocaleString()+\'</td><td>\'+e.actor+\'</td><td>\'+e.action+\'</td><td>\'+(e.details || "")+\'</td></tr>\';' +
'            });' +
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
'            const password = document.getElementById("newStaffPassword").value.trim();' +
'            const email = document.getElementById("newStaffEmail").value.trim();' +
'            if (!name || !password || !email) { alert("Please fill in name, password, and email."); return; }' +
'            const response = await fetch("/tickets/staff", {' +
'                method: "POST",' +
'                headers: { "Content-Type": "application/json" },' +
'                body: JSON.stringify({ name, password, email })' +
'            });' +
'            if (response.ok) {' +
'                document.getElementById("newStaffName").value = "";' +
'                document.getElementById("newStaffPassword").value = "";' +
'                document.getElementById("newStaffEmail").value = "";' +
'                loadStaffList();' +
'            } else {' +
'                alert("Could not add staff member.");' +
'            }' +
'        }' +
'        async function addComment(id) {' +
'            const textInput = document.getElementById("input-" + id);' +
'            const text = textInput.value.trim();' +
'            if(!text) return;' +
'            await fetch("/tickets/" + id + "/comment", {' +
'                method: "POST",' +
'                headers: { "Content-Type": "application/json" },' +
'                body: JSON.stringify({ text })' +
'            });' +
'            textInput.value = "";' +
'            loadTickets();' +
'        }' +
'        async function resolveTicket(id) {' +
'            const response = await fetch("/tickets/" + id + "/resolve", { method: "POST" });' +
'            if (response.ok) loadTickets();' +
'        }' +
'        async function escalateTicket(id) {' +
'            if (!confirm("Escalate this ticket to Admin (Level 2)?")) return;' +
'            const response = await fetch("/tickets/" + id + "/escalate", { method: "POST" });' +
'            if (response.ok) loadTickets();' +
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
'            if (!isAdmin) { tickets = tickets.filter(t => t.assignedTo === currentUser); }' +
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
'            window.location.href = "/tickets/report?month=" + month;' +
'        }' +
'        function downloadReportByRange() {' +
'            const from = document.getElementById("reportFromDate").value;' +
'            const to = document.getElementById("reportToDate").value;' +
'            if (!from || !to) { alert("Please select both a From and To date."); return; }' +
'            window.location.href = "/tickets/report?from=" + from + "&to=" + to;' +
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
'        loadStaffFilterOptions();' +
'        loadTickets();' +
'    </script>' +
'</body>' +
'</html>';

    res.send(html);
});

// APIs
app.get('/tickets', checkUserLogin, async (req, res) => {
    const tickets = await Ticket.find().sort({ _id: -1 });
    res.json(tickets);
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

        const query = { createdAt: { $gte: startDate, $lte: endDate } };
        if (!req.session.isAdmin) {
            query.assignedTo = req.session.username;
        }
        const tickets = await Ticket.find(query).sort({ ticketNumber: 1 });

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
            { header: 'Submitted At', key: 'createdAt', width: 22 },
            { header: 'Resolved At', key: 'resolvedAt', width: 22 }
        ];
        sheet.getRow(1).font = { bold: true };
        tickets.forEach(t => {
            sheet.addRow({
                ticketNumber: t.ticketNumber,
                title: t.title,
                submittedBy: t.submittedBy,
                designation: t.designation,
                category: t.category,
                branch: t.branch,
                priority: t.priority,
                status: t.status,
                assignedTo: t.assignedTo,
                createdAt: t.createdAt ? t.createdAt.toLocaleString() : '',
                resolvedAt: t.resolvedAt ? t.resolvedAt.toLocaleString() : ''
            });
        });

        const nameLabel = req.session.isAdmin ? 'All-Staff' : req.session.username.replace(/\s+/g, '-');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Ticket-Report-${nameLabel}-${rangeLabel}.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        res.status(500).send('Could not generate report: ' + err.message);
    }
});

app.post('/tickets/:id/resolve', checkUserLogin, async (req, res) => {
    await Ticket.findByIdAndUpdate(req.params.id, { status: 'Resolved', resolvedAt: new Date() });
    res.json({ success: true });
});

// Escalate a ticket to Level 2 (Admin) — reassigns it and flags it as escalated
app.post('/tickets/:id/escalate', checkUserLogin, async (req, res) => {
    await Ticket.findByIdAndUpdate(req.params.id, { escalated: true, assignedTo: 'Admin' });
    res.json({ success: true });
});

app.post('/tickets/:id/comment', checkUserLogin, async (req, res) => {
    const { text } = req.body;
    const author = req.session.username;
    await Ticket.findByIdAndUpdate(req.params.id, {
        $push: { comments: { author, text } }
    });
    res.json({ success: true });
});

app.get('/public-branches', async (req, res) => {
    try {
        const branches = await Branch.find().sort({ region: 1, name: 1 });
        res.json(branches);
    } catch(err) {
        res.status(500).json([]);
    }
});

// Regions (admin only — used to organize the branch list into groups)
app.get('/tickets/regions', checkAdminLogin, async (req, res) => {
    const regions = await Region.find().sort({ name: 1 });
    res.json(regions);
});

app.post('/tickets/regions', checkAdminLogin, async (req, res) => {
    try {
        const name = (req.body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Region name is required' });
        const newRegion = new Region({ name });
        await newRegion.save();
        await logAudit(req.session.username, 'Add Region', `Added region "${newRegion.name}"`);
        res.status(201).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/tickets/regions/:id', checkAdminLogin, async (req, res) => {
    try {
        const name = (req.body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Region name is required' });
        const region = await Region.findById(req.params.id);
        if (!region) return res.status(404).json({ error: 'Region not found' });
        const oldName = region.name;
        region.name = name;
        await region.save();
        if (oldName !== name) {
            await Branch.updateMany({ region: oldName }, { $set: { region: name } });
        }
        await logAudit(req.session.username, 'Edit Region', `Renamed region "${oldName}" to "${name}"`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/tickets/regions/:id', checkAdminLogin, async (req, res) => {
    try {
        const region = await Region.findById(req.params.id);
        if (!region) return res.status(404).json({ error: 'Region not found' });
        const branchCount = await Branch.countDocuments({ region: region.name });
        if (branchCount > 0) {
            return res.status(400).json({ error: `Cannot delete — ${branchCount} branch(es) still belong to this region. Reassign or remove them first.` });
        }
        await Region.findByIdAndDelete(req.params.id);
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
        const tickets = await Ticket.find({ mobile })
            .sort({ _id: -1 })
            .select('ticketNumber title branch priority status createdAt resolvedAt assignedTo');
        res.json(tickets);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/tickets/branches', checkAdminLogin, async (req, res) => {
    try {
        const name = (req.body.name || '').trim();
        const region = (req.body.region || '').trim();
        if (!name || !region) {
            return res.status(400).json({ error: 'Branch name and region are both required' });
        }
        const newBranch = new Branch({ name, region });
        await newBranch.save();
        await logAudit(req.session.username, 'Add Branch', `Added branch "${newBranch.name}" under region "${region}"`);
        res.status(201).json({ success: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/tickets/branches/:id', checkAdminLogin, async (req, res) => {
    const branch = await Branch.findById(req.params.id);
    await Branch.findByIdAndDelete(req.params.id);
    if (branch) {
        await StaffBranch.updateMany({}, { $pull: { branches: branch.name } });
        await logAudit(req.session.username, 'Delete Branch', `Removed branch "${branch.name}"`);
    }
    res.json({ success: true });
});

// Update a branch's name and/or region, keeping staff assignments in sync
app.put('/tickets/branches/:id', checkAdminLogin, async (req, res) => {
    try {
        const branch = await Branch.findById(req.params.id);
        if (!branch) return res.status(404).json({ error: 'Branch not found' });
        const oldName = branch.name;
        const oldRegion = branch.region;

        if (req.body.name !== undefined) {
            if (!req.body.name.trim()) return res.status(400).json({ error: 'Branch name cannot be empty' });
            branch.name = req.body.name.trim();
        }
        if (req.body.region !== undefined && req.body.region.trim()) {
            branch.region = req.body.region.trim();
        }
        await branch.save();

        if (oldName !== branch.name) {
            await StaffBranch.updateMany(
                { branches: oldName },
                { $set: { 'branches.$[elem]': branch.name } },
                { arrayFilters: [{ elem: oldName }] }
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
    const staff = await Staff.find().sort({ staffId: 1 });
    res.json(staff.map(s => ({ id: s.staffId, name: s.name, email: s.email })));
});

// Recent admin activity — staff/branch changes
app.get('/audit-log', checkAdminLogin, async (req, res) => {
    const entries = await AuditLog.find().sort({ createdAt: -1 }).limit(200);
    res.json(entries);
});

// Add a new staff member (auto-generates the next sequential staff ID)
app.post('/tickets/staff', checkAdminLogin, async (req, res) => {
    try {
        const { name, password, email } = req.body;
        if (!name || !password || !email) {
            return res.status(400).json({ error: 'Name, password, and email are all required' });
        }
        const staffId = await getNextStaffId();
        const hashedPassword = await bcrypt.hash(password, 10);
        const newStaff = new Staff({ staffId, name, password: hashedPassword, email });
        await newStaff.save();
        await logAudit(req.session.username, 'Add Staff', `Added staff ${name} (${staffId})`);
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
        const update = { name, email };
        if (password) {
            update.password = await bcrypt.hash(password, 10);
        }
        await Staff.findOneAndUpdate({ staffId: req.params.staffId }, update);
        await logAudit(req.session.username, 'Edit Staff', `Updated staff ${req.params.staffId}${password ? ' (password reset)' : ''}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Remove a staff member (their existing tickets keep their historical assignedTo name)
app.delete('/tickets/staff/:staffId', checkAdminLogin, async (req, res) => {
    try {
        await Staff.findOneAndDelete({ staffId: req.params.staffId });
        await StaffBranch.findOneAndDelete({ staffId: req.params.staffId });
        await logAudit(req.session.username, 'Delete Staff', `Removed staff ${req.params.staffId}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get branch coverage for all staff, as a { staffId: [branchNames] } map
app.get('/tickets/staff-branches', checkAdminLogin, async (req, res) => {
    try {
        const assignments = await StaffBranch.find();
        const map = {};
        assignments.forEach(a => { map[a.staffId] = a.branches; });
        res.json(map);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Set which branches one staff member covers
app.post('/tickets/staff-branches', checkAdminLogin, async (req, res) => {
    try {
        const { staffId, branches } = req.body;
        await StaffBranch.findOneAndUpdate(
            { staffId },
            { staffId, branches },
            { upsert: true, returnDocument: 'after' }
        );
        await logAudit(req.session.username, 'Update Branch Assignment', `Set branches for staff ${staffId}: ${branches && branches.length ? branches.join(', ') : 'none'}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/tickets', upload.single('screenshot'), async (req, res) => {
    try {
        const branchName = req.body.branch || 'N/A';
        const allStaff = await Staff.find();

        // Find which staff explicitly cover this branch
        const coveringAssignments = await StaffBranch.find({ branches: branchName });
        let eligibleStaff = coveringAssignments
            .map(a => allStaff.find(s => s.staffId === a.staffId))
            .filter(Boolean);

        // Nobody assigned to this branch yet -> fall back to round-robin across everyone
        if (eligibleStaff.length === 0) {
            eligibleStaff = allStaff;
        }

        // Round-robin among eligible staff, based on tickets already logged for this branch
        const branchTicketCount = await Ticket.countDocuments({ branch: branchName });
        const staffIndex = branchTicketCount % eligibleStaff.length;
        const assignedStaff = eligibleStaff[staffIndex];
        const ticketNumber = await getNextTicketNumber();

        const newTicket = new Ticket({
            ticketNumber,
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

        await newTicket.save();

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

        res.status(201).json(newTicket);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server configuration active on port ${PORT}`);
});