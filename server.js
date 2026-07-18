const express = require('express');
const path = require('path');
const session = require('express-session');
const mongoose = require('mongoose');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const nodemailer = require('nodemailer');

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

// Branch Schema
const branchSchema = new mongoose.Schema({
    name: { type: String, required: true }
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
    branch: { type: String, default: 'N/A' },
    priority: { type: String, default: 'Medium' },
    description: String,
    mobile: { type: String, required: true },
    screenshot: String, 
    status: { type: String, default: 'Open' },
    assignedTo: { type: String, default: 'Unassigned' },
    escalated: { type: Boolean, default: false },
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

async function getNextTicketNumber() {
    const counter = await Counter.findOneAndUpdate(
        { name: 'ticketNumber' },
        { $inc: { value: 1 } },
        { upsert: true, new: true }
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
        await Staff.insertMany([
            { staffId: 'IT001', name: 'SADIQ', password: 'sadiq123', email: 'itsarathy@gmail.com' },
            { staffId: 'IT002', name: 'ABHIMANYU', password: 'abhi123', email: 'abhimanyu@gmail.com' },
            { staffId: 'IT003', name: 'ANANDHU', password: 'anandhu123', email: 'anandhu@gmail.com' },
            { staffId: 'IT004', name: 'sabari', password: 'sabari123', email: 'sabari@gmail.com' }
        ]);
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
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

app.use(session({
    secret: process.env.SESSION_SECRET || 'my-super-secret-key-123',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 1800000 }
}));

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
    res.send(`<!DOCTYPE html><html><head><title>Submit a Ticket | SARATHY IT</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"><style>
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
.ticket-card { width: 100%; max-width: 460px; max-height: 96vh; background: #fdfcfb; border-radius: 14px; box-shadow: 0 24px 70px rgba(0,0,0,0.45); overflow-y: auto; }
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
.form-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 12px; }
.form-field { margin-top: 8px; }
.full-width { grid-column: 1 / -1; }
label { display: block; margin-bottom: 3px; font-weight: 600; font-size: 10.5px; color: #6b7280; text-transform: uppercase; letter-spacing: .4px; }
input, textarea, select { width: 100%; padding: 8px 11px; border: 1.5px solid #e5e1de; border-radius: 7px; font-size: 13px; font-family: 'Inter', sans-serif; background: #faf9f7; color: #1e2229; transition: border-color .18s, box-shadow .18s; }
input:focus, textarea:focus, select:focus { outline: none; border-color: #e53e3e; box-shadow: 0 0 0 3px rgba(229,62,62,.14); background: #fff; }
textarea { resize: none; height: 44px; }
button[type="submit"] { grid-column: 1 / -1; margin-top: 12px; padding: 11px; width: 100%; background: linear-gradient(120deg, #e53e3e, #c53030); color: #fff; border: none; border-radius: 8px; cursor: pointer; font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 14px; letter-spacing: 1px; text-transform: uppercase; box-shadow: 0 8px 20px rgba(197,48,48,.4); transition: transform .15s, box-shadow .15s; }
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
</head><body><div class="ticket-card"><div class="ticket-ribbon"><img src="/logo.png" alt="Company Logo" onerror="this.style.display='none'"><span class="ticket-ribbon-text">Sarathy IT Helpdesk</span></div><div class="tab-switch"><button type="button" class="tab-btn active" id="tabSubmitBtn" onclick="showTab('submit')">Submit Ticket</button><button type="button" class="tab-btn" id="tabStatusBtn" onclick="showTab('status')">Check Status</button></div><div class="ticket-body"><div id="submitPane"><h2 class="form-title">Submit a New Ticket</h2><div class="form-subtitle">We'll route it to the right person and keep you posted.</div><div class="ticket-perforation"></div><form id="ticketForm" enctype="multipart/form-data" class="form-grid"><div class="form-field"><label>Your Name</label><input type="text" id="submitterName" required></div><div class="form-field"><label>Mobile Number</label><input type="tel" id="mobile" placeholder="10-digit mobile number" pattern="[0-9]{10}" required></div><div class="form-field full-width"><label>Issue Title</label><input type="text" id="title" required></div><div class="form-field"><label>Branch Location</label><select id="branch" required><option value="" disabled selected>Loading...</option></select></div><div class="form-field"><label>Priority Level</label><select id="priority"><option value="Low">Low</option><option value="Medium" selected>Medium</option><option value="High">High</option></select></div><div class="form-field full-width"><label>Description</label><textarea id="description" required></textarea></div><div class="form-field full-width"><label>Upload Screenshot (Optional)</label><input type="file" id="screenshot" accept="image/*"></div><button type="submit">Submit Ticket</button></form></div><div id="statusPane" style="display:none;"><h2 class="form-title">Check Ticket Status</h2><div class="form-subtitle">Enter the mobile number you used when submitting.</div><label>Mobile Number</label><input type="tel" id="statusMobile" placeholder="Enter your 10-digit mobile number" pattern="[0-9]{10}"><button type="button" class="check-status-btn" onclick="checkTicketStatus()">Check Status</button><div id="statusResults"></div></div></div></div><script>
    async function loadFormBranches() {
        try {
            const res = await fetch('/public-branches');
            const branches = await res.json();
            const select = document.getElementById('branch');
            if (branches.length === 0) {
                select.innerHTML = '<option value="General">No specific branches configured</option>';
                return;
            }
            select.innerHTML = '<option value="" disabled selected>Choose branch location</option>';
            branches.forEach(b => {
                select.innerHTML += '<option value="' + b.name + '">' + b.name + '</option>';
            });
        } catch(e) {
            document.getElementById('branch').innerHTML = '<option value="General">General/Headquarters</option>';
        }
    }
    loadFormBranches();

    document.getElementById('ticketForm').addEventListener('submit', async (e) => { 
        e.preventDefault(); 
        const formData = new FormData(); 
        formData.append('title', document.getElementById('title').value); 
        formData.append('submittedBy', document.getElementById('submitterName').value);
        formData.append('branch', document.getElementById('branch').value); 
        formData.append('mobile', document.getElementById('mobile').value); 
        formData.append('priority', document.getElementById('priority').value); 
        formData.append('description', document.getElementById('description').value); 
        const fileInput = document.getElementById('screenshot'); 
        if (fileInput.files[0]) formData.append('screenshot', fileInput.files[0]); 
        const response = await fetch('/tickets', { method: 'POST', body: formData }); 
        if (response.ok) { 
            const result = await response.json();
            alert('Ticket #' + String(result.ticketNumber).padStart(4, '0') + ' submitted successfully!'); 
            document.getElementById('ticketForm').reset(); 
            loadFormBranches();
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
            html += '<div class="status-result-card">' +
                '<div class="status-result-top"><span class="status-result-number">#' + String(t.ticketNumber).padStart(4, '0') + '</span>' +
                '<span class="badge ' + statusClass + '">' + t.status + '</span></div>' +
                '<div class="status-result-title">' + t.title + '</div>' +
                '<div class="status-result-meta">' + t.branch + ' &middot; ' + t.priority + ' priority</div>' +
                '</div>';
        });
        container.innerHTML = html;
    }
    </script></body></html>`);
});

// Login Page
app.get('/login', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Login | SARATHY IT</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"><style>
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
button { margin-top: 24px; padding: 13px; width: 100%; background: linear-gradient(120deg, #e53e3e, #c53030); color: #fff; border: none; border-radius: 9px; cursor: pointer; font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 16px; letter-spacing: 1px; text-transform: uppercase; box-shadow: 0 8px 20px rgba(197,48,48,.4); transition: transform .15s, box-shadow .15s; }
button:hover { transform: translateY(-2px); box-shadow: 0 12px 28px rgba(197,48,48,.5); }
button:active { transform: translateY(0); }
</style></head><body><div class="login-card"><div class="badge-hole"></div><div class="login-ribbon"><img src="/logo.png" alt="Company Logo" onerror="this.style.display='none'"><span class="login-ribbon-text">Sarathy IT</span><span class="login-ribbon-sub">Staff &amp; Admin Access</span></div><div class="login-body"><form action="/login" method="POST"><label>Username / Staff Name</label> <input type="text" name="username" required><label>Password</label> <input type="password" name="password" required><button type="submit">Login</button></form></div></div></body></html>`);
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === '123') {
        req.session.isAdmin = true;
        req.session.isStaff = false;
        req.session.username = 'Admin';
        return res.redirect('/admin');
    }
    const allStaff = await Staff.find();
    const staffUser = allStaff.find(s => s.name.toLowerCase() === username.toLowerCase() && s.password === password);
    if (staffUser) {
        req.session.isAdmin = false;
        req.session.isStaff = true;
        req.session.username = staffUser.name;
        return res.redirect('/admin');
    }
    res.send('<h3>Invalid Credentials. <a href="/login">Try Again</a></h3>');
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
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
'    <style>' +
'        * { box-sizing: border-box; margin: 0; padding: 0; font-family: \'Segoe UI\', Tahoma, Geneva, Verdana, sans-serif; }' +
'        body { display: flex; height: 100vh; background-color: #f8f9fa; color: #333; overflow: hidden; }' +
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
'        .branch-input-group { display: flex; gap: 15px; margin-bottom: 25px; }' +
'        .branch-input-group input { flex-grow: 1; padding: 12px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px; }' +
'        .branch-add-btn { background-color: #0056b3; color: white; border: none; padding: 0 30px; font-size: 14px; font-weight: 600; border-radius: 6px; cursor: pointer; }' +
'        .branch-table { width: 100%; border-collapse: collapse; text-align: left; margin-top: 10px; }' +
'        .branch-table th { background-color: #f7fafc; color: #4a5568; font-size: 13px; font-weight: 600; padding: 12px 16px; border-bottom: 1px solid #e2e8f0; }' +
'        .branch-table td { padding: 14px 16px; font-size: 14px; color: #2d3748; border-bottom: 1px solid #edf2f7; }' +
'        .branch-delete-btn { color: #e53e3e; background: none; border: none; cursor: pointer; font-weight: 600; font-size: 13px; }' +
'    </style>' +
'</head>' +
'<body>' +
'    <aside class="sidebar">' +
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
'            <h1 class="page-title" id="panelViewTitle">Helpdesk Operations</h1>' +
'        </header>' +
'        <section class="content-body">' +
'            <div id="viewTickets" class="dashboard-view active">' +
'                <div class="metrics-grid">' +
'                    <div class="metric-card"><div class="metric-label">Open Issues</div><div class="metric-value" id="statOpen">0</div></div>' +
'                    <div class="metric-card resolved"><div class="metric-label">Resolved Issues</div><div class="metric-value" id="statResolved">0</div></div>' +
'                    <div class="metric-card assigned"><div class="metric-label">Active Tickets</div><div class="metric-value" id="statMine">0</div></div>' +
'                </div>' +
'                <div id="ticketList">Loading active queue...</div>' +
'            </div>' +
'            <div id="viewBranches" class="dashboard-view">' +
'                <div class="branch-panel-card">' +
'                    <h2>Create New Branch Location</h2>' +
'                    <div class="branch-input-group">' +
'                        <input type="text" id="newBranchName" placeholder="Enter Branch Details">' +
'                        <button class="branch-add-btn" onclick="addNewBranch()">Add Branch</button>' +
'                    </div>' +
'                    <table class="branch-table">' +
'                        <thead><tr><th>Branch Name</th><th>Action</th></tr></thead>' +
'                        <tbody id="branchTableBody"></tbody>' +
'                    </table>' +
'                    </div>' +
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
'                        <thead><tr><th>Staff ID</th><th>Name Tag</th><th>Operational Route Email</th><th>Assigned Branches</th></tr></thead>' +
'                        <tbody id="staffTableBody"></tbody>' +
'                    </table>' +
'                </div>' +
'            </div>' +
'        </section>' +
'    </main>' +
'    <script>' +
'        const currentUser = "' + dynamicUsername + '";' +
'        const isAdmin = ' + dynamicIsAdmin + ';' +
'        document.getElementById("displayUserLabel").innerText = currentUser;' +
'        function switchView(target) {' +
'            if ((target === "branches" || target === "staff") && !isAdmin) {' +
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
'            } else if (target === "branches") {' +
'                document.getElementById("viewBranches").classList.add("active");' +
'                document.getElementById("tabBranchesLink").classList.add("active");' +
'                document.getElementById("panelViewTitle").innerText = "Company Branches Layout";' +
'                loadBranchesList();' +
'            } else if (target === "staff") {' +
'                document.getElementById("viewStaff").classList.add("active");' +
'                document.getElementById("tabStaffLink").classList.add("active");' +
'                document.getElementById("panelViewTitle").innerText = "Manage IT Staff Profile Queue";' +
'                loadStaffList();' +
'            }' +
'        }' +
'        async function loadTickets() {' +
'            const response = await fetch("/tickets");' +
'            if (response.status === 401) { window.location.href = "/login"; return; }' +
'            let tickets = await response.json();' +
'            if (!isAdmin) { tickets = tickets.filter(t => t.assignedTo === currentUser); }' +
'            document.getElementById("statOpen").innerText = tickets.filter(t => t.status === "Open").length;' +
'            document.getElementById("statResolved").innerText = tickets.filter(t => t.status === "Resolved").length;' +
'            document.getElementById("statMine").innerText = tickets.length;' +
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
'                const imageHtml = ticket.screenshot ? \'<a href="\'+ticket.screenshot+\'" target="_blank"><img src="\'+ticket.screenshot+\'" class="screenshot-preview"></a>\' : "";' +
'                let commentListHtml = "";' +
'                if (ticket.comments) {' +
'                    ticket.comments.forEach(c => {' +
'                        commentListHtml += \'<div class="comment-item"><strong>\'+c.author+\':</strong> \'+c.text+\'</div>\';' +
'                    });' +
'                }' +
'                listDiv.innerHTML += \'<div class="ticket-card"><div class="ticket-header"><div><h3 class="ticket-title">#\'+String(ticket.ticketNumber).padStart(4,"0")+\' \'+ticket.title+\'</h3><div style="margin-top: 8px;"><span class="badge p-\'+ticket.priority+\'">\'+ticket.priority+\'</span><span class="badge status-\'+ticket.status.toLowerCase()+\'">\'+ticket.status+\'</span>\'+escalatedBadge+\'</div></div>\'+actionBtn+escalateBtn+\'</div><p class="ticket-desc">\'+ticket.description+\'</p>\'+imageHtml+\'<div class="assignment-info"><span><strong>Submitted By:</strong> \'+(ticket.submittedBy || "Unknown")+\'</span> | <span><strong>Branch:</strong> \'+ticket.branch+\'</span> | <span><strong>Mobile:</strong> \'+ticket.mobile+\'</span> | <span><strong>Assigned:</strong> \'+ticket.assignedTo+\'</span></div><div class="comments-section"><h4 class="comments-header">Internal Work Notes</h4><div>\'+(commentListHtml || "No updates.")+\'</div><div class="comment-form"><input type="text" id="input-\'+ticket._id+\'" placeholder="Write operational update..."><button onclick="addComment(\\\'\'+ticket._id+\'\\\')">Post</button></div></div></div>\';' +
'            });' +
'        }' +
'        async function loadBranchesList() {' +
'            const response = await fetch("/public-branches");' +
'            const branches = await response.json();' +
'            const tbody = document.getElementById("branchTableBody");' +
'            tbody.innerHTML = "";' +
'            if (branches.length === 0) {' +
'                tbody.innerHTML = \'<tr><td colspan="2" style="text-align: center; color: #a0aec0; padding: 20px;">No branch locations added yet.</td></tr>\';' +
'                return;' +
'            }' +
'            branches.forEach(b => {' +
'                tbody.innerHTML += \'<tr><td>\'+b.name+\'</td><td><button class="branch-delete-btn" onclick="deleteBranch(\\\'\'+b._id+\'\\\')">Delete</button></td></tr>\';' +
'            });' +
'        }' +
'        async function addNewBranch() {' +
'            const input = document.getElementById("newBranchName");' +
'            const name = input.value.trim();' +
'            if (!name) return;' +
'            const response = await fetch("/tickets/branches", {' +
'                method: "POST",' +
'                headers: { "Content-Type": "application/json" },' +
'                body: JSON.stringify({ name })' +
'            });' +
'            if(response.ok) { input.value = ""; loadBranchesList(); }' +
'        }' +
'        async function deleteBranch(id) {' +
'            if(!confirm("Remove this branch option?")) return;' +
'            const response = await fetch("/tickets/branches/" + id, { method: "DELETE" });' +
'            if(response.ok) loadBranchesList();' +
'        }' +
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
'                let checkboxesHtml = branches.map(b => {' +
'                    const checked = assigned.includes(b.name) ? "checked" : "";' +
'                    return \'<label style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-weight:normal;font-size:13px;"><input type="checkbox" value="\'+b.name+\'" \'+checked+\' onchange="updateStaffBranches(\\\'\'+s.id+\'\\\')" class="branch-check-\'+s.id+\'"> \'+b.name+\'</label>\';' +
'                }).join("");' +
'                if (branches.length === 0) checkboxesHtml = \'<span style="color:#a0aec0;">No branches added yet</span>\';' +
'                tbody.innerHTML += \'<tr><td>\'+s.id+\'</td><td>\'+s.name+\'</td><td>\'+s.email+\'</td><td>\'+checkboxesHtml+\'</td></tr>\';' +
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

app.post('/tickets/:id/resolve', checkUserLogin, async (req, res) => {
    await Ticket.findByIdAndUpdate(req.params.id, { status: 'Resolved' });
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
        const branches = await Branch.find().sort({ name: 1 });
        res.json(branches);
    } catch(err) {
        res.status(500).json([]);
    }
});

// Public lookup so ticket submitters can check status without logging in
app.get('/tickets/lookup', async (req, res) => {
    try {
        const mobile = req.query.mobile;
        if (!mobile) return res.status(400).json({ error: 'Mobile number required' });
        const tickets = await Ticket.find({ mobile })
            .sort({ _id: -1 })
            .select('ticketNumber title branch priority status');
        res.json(tickets);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/tickets/branches', checkAdminLogin, async (req, res) => {
    try {
        const newBranch = new Branch({ name: req.body.name });
        await newBranch.save();
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
    }
    res.json({ success: true });
});

app.get('/tickets/staff-list', checkAdminLogin, async (req, res) => {
    const staff = await Staff.find().sort({ staffId: 1 });
    res.json(staff.map(s => ({ id: s.staffId, name: s.name, email: s.email })));
});

// Add a new staff member (auto-generates the next sequential staff ID)
app.post('/tickets/staff', checkAdminLogin, async (req, res) => {
    try {
        const { name, password, email } = req.body;
        if (!name || !password || !email) {
            return res.status(400).json({ error: 'Name, password, and email are all required' });
        }
        const staffId = await getNextStaffId();
        const newStaff = new Staff({ staffId, name, password, email });
        await newStaff.save();
        res.status(201).json({ success: true, staffId });
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
            { upsert: true, new: true }
        );
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
            if (err) console.error(err);
        });

        res.status(201).json(newTicket);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server configuration active on port ${PORT}`);
});