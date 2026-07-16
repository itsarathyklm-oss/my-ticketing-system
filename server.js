const express = require('express');
const path = require('path');
const session = require('express-session');
const mongoose = require('mongoose');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// 1. CONNECT TO MONGOOSE DB
const MONGO_URI = process.env.MONGO_URI; 
mongoose.connect(MONGO_URI)
    .then(() => console.log("Connected permanently to MongoDB Cloud"))
    .catch(err => console.error("Database connection error:", err));

// Define Mongoose Ticket Layout Template
const ticketSchema = new mongoose.Schema({
    title: String,
    priority: { type: String, default: 'Medium' },
    description: String,
    screenshot: String, 
    status: { type: String, default: 'Open' },
    assignedTo: { type: String, default: 'Unassigned' }
});
const Ticket = mongoose.model('Ticket', ticketSchema);

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

const IT_STAFF = [
    { id: 'IT001', name: 'SADIQ' },
    { id: 'IT002', name: 'ABHIMANYU' },
    { id: 'IT003', name: 'ANANDHU' }
];

app.use(session({
    secret: process.env.SESSION_SECRET || 'my-super-secret-key-123',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 600000 }
}));

function checkAdminLogin(req, res, next) {
    if (req.session && req.session.isAdmin) {
        next();
    } else {
        res.redirect('/login');
    }
}

// ROUTERS
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>IT Helpdesk Support Ticket</title><style>body { font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; }.company-header { display: flex; align-items: center; gap: 15px; margin-bottom: 30px; padding-bottom: 15px; border-bottom: 2px solid #eee; }.company-logo { height: 50px; width: auto; object-fit: contain; }.company-name { font-size: 24px; font-weight: bold; color: #333; }label { display: block; margin-top: 12px; font-weight: bold; }input, textarea, select { width: 100%; padding: 10px; margin-top: 5px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px; }button { margin-top: 20px; padding: 12px; background: #007bff; color: white; border: none; cursor: pointer; width: 100%; font-size: 16px; border-radius: 4px; }button:hover { background: #0056b3; }</style></head><body><div class="company-header"><img src="/logo.png" alt="Company Logo" class="company-logo" onerror="this.style.display='none'"><span class="company-name">IT HELPDESK</span></div><h2>Submit a New Ticket</h2><form id="ticketForm" enctype="multipart/form-data"><label>Issue Title:</label><input type="text" id="title" required><label>Priority Level:</label><select id="priority"><option value="Low">Low</option><option value="Medium" selected>Medium</option><option value="High">High</option></select><label>Description:</label><textarea id="description" rows="4" required></textarea><label>Upload Screenshot (Optional):</label><input type="file" id="screenshot" accept="image/*"><button type="submit">Submit Ticket</button></form><script>document.getElementById('ticketForm').addEventListener('submit', async (e) => { e.preventDefault(); const formData = new FormData(); formData.append('title', document.getElementById('title').value); formData.append('priority', document.getElementById('priority').value); formData.append('description', document.getElementById('description').value); const fileInput = document.getElementById('screenshot'); if (fileInput.files[0]) formData.append('screenshot', fileInput.files[0]); const response = await fetch('/tickets', { method: 'POST', body: formData }); if (response.ok) { alert('Ticket submitted to IT cloud database!'); document.getElementById('ticketForm').reset(); } });</script></body></html>`);
});

app.get('/login', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Admin Login</title><style>body { font-family: Arial, sans-serif; max-width: 350px; margin: 80px auto; padding: 25px; border: 1px solid #ddd; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }.company-brand { text-align: center; margin-bottom: 25px; padding-bottom: 15px; border-bottom: 1px solid #eee; }.company-logo { height: 50px; width: auto; object-fit: contain; margin-bottom: 10px; }.company-name { font-size: 20px; font-weight: bold; color: #333; display: block; }label { display: block; margin-top: 12px; font-weight: bold; }input { width: 100%; padding: 10px; margin-top: 5px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px; }button { margin-top: 25px; padding: 12px; background: #28a745; color: white; border: none; cursor: pointer; width: 100%; font-size: 16px; border-radius: 4px; }</style></head><body><div class="company-brand"><img src="/logo.png" alt="Company Logo" class="company-logo" onerror="this.style.display='none'"><span class="company-name">IT HELPDESK</span></div><form action="/login" method="POST"><label>Username:</label> <input type="text" name="username" required><label>Password:</label> <input type="password" name="password" required><button type="submit">Login</button></form></body></html>`);
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === '123') {
        req.session.isAdmin = true;
        res.redirect('/admin');
    } else {
        res.send('<h3>Invalid Credentials. <a href="/login">Try Again</a></h3>');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.get('/admin', checkAdminLogin, (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Admin Dashboard</title><style>body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background-color: #f4f6f9; }.company-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 30px; padding-bottom: 15px; border-bottom: 2px solid #ddd; }.brand-side { display: flex; align-items: center; gap: 15px; }.company-logo { height: 40px; width: auto; object-fit: contain; }.company-name { font-size: 20px; font-weight: bold; color: #333; }.logout-btn { background: #dc3545; color: white; text-decoration: none; padding: 6px 12px; border-radius: 4px; font-size: 14px; }.ticket-card { border: 1px solid #ddd; padding: 15px; margin-top: 15px; border-radius: 6px; background: white; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }.badge { padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; display: inline-block; margin-right: 5px; }.p-Low { background: #e2e3e5; color: #383d41; }.p-Medium { background: #fff3cd; color: #856404; }.p-High { background: #f8d7da; color: #721c24; }.status-open { background: #cce5ff; color: #004085; }.status-resolved { background: #d4edda; color: #155724; }.resolve-btn { background: #28a745; color: white; border: none; padding: 6px 12px; font-size: 13px; border-radius: 4px; cursor: pointer; float: right; }.screenshot-preview { max-width: 100%; max-height: 200px; margin-top: 10px; display: block; border: 1px solid #ddd; border-radius: 4px; }.assignment-box { margin-top: 15px; padding-top: 10px; border-top: 1px dashed #eee; font-size: 14px; color: #555; }</style></head><body><div class="company-header"><div class="brand-side"><img src="/logo.png" alt="Company Logo" class="company-logo" onerror="this.style.display='none'"><span class="company-name">IT HELPDESK</span></div><a href="/logout" class="logout-btn">Logout</a></div><div id="ticketList">Loading system tickets...</div><script>let itStaffList = []; async function loadStaff() { const response = await fetch('/admin/staff'); itStaffList = await response.json(); } async function loadTickets() { const response = await fetch('/tickets'); if (response.status === 401) { window.location.href = '/login'; return; } const tickets = await response.json(); const listDiv = document.getElementById('ticketList'); if (tickets.length === 0) { listDiv.innerHTML = '<p>No tickets logged.</p>'; return; } listDiv.innerHTML = ''; tickets.forEach(ticket => { const isResolved = ticket.status === 'Resolved'; const actionBtn = isResolved ? '' : \`<button class="resolve-btn" onclick="resolveTicket('\${ticket._id}')">Resolve</button>\`; const statusClass = isResolved ? 'status-resolved' : 'status-open'; let imageHtml = ticket.screenshot ? \`<a href="\${ticket.screenshot}" target="_blank"><img src="\${ticket.screenshot}" class="screenshot-preview"></a>\` : ''; const matchedStaff = itStaffList.find(staff => String(staff.id) === String(ticket.assignedTo)); const staffName = matchedStaff ? matchedStaff.name : 'Unassigned'; listDiv.innerHTML += \`<div class="ticket-card">\${actionBtn}<h3>\${ticket.title}</h3><p>\${ticket.description}</p>\${imageHtml}<div style="margin-top:15px;"><span class="badge p-\${ticket.priority}">\${ticket.priority} Priority</span><span class="badge \${statusClass}">\${ticket.status}</span></div><div class="assignment-box"><strong>Assigned Staff Member:</strong> \${staffName}</div></div>\`; }); } async function resolveTicket(id) { const response = await fetch(\`/tickets/\${id}/resolve\`, { method: 'POST' }); if (response.ok) loadTickets(); } async function init() { await loadStaff(); await loadTickets(); } init();</script></body></html>`);
});

app.get('/admin/staff', (req, res) => res.json(IT_STAFF));

// DATABASE API ACTIONS
app.post('/tickets', upload.single('screenshot'), async (req, res) => {
    try {
        const newTicket = new Ticket({
            title: req.body.title,
            priority: req.body.priority,
            description: req.body.description,
            screenshot: req.file ? req.file.path : null
        });
        await newTicket.save();
        res.status(201).json(newTicket);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/tickets', async (req, res) => {
    if (req.session && req.session.isAdmin) {
        const tickets = await Ticket.find().sort({ _id: -1 });
        res.json(tickets);
    } else {
        res.status(401).json({ error: "Unauthorized" });
    }
});

// Keep track of the last assigned staff index in memory
let nextStaffIndex = 0;

// DATABASE API ACTIONS WITH PERSISTENT AUTO ALLOCATION
app.post('/tickets', upload.single('screenshot'), async (req, res) => {
    try {
        // Count how many tickets are already in the database
        const ticketCount = await Ticket.countDocuments();
        
        // Mathematically determine the next staff member based on the count
        const staffIndex = ticketCount % IT_STAFF.length;
        const assignedStaff = IT_STAFF[staffIndex];

        const newTicket = new Ticket({
            title: req.body.title,
            priority: req.body.priority,
            description: req.body.description,
            screenshot: req.file ? req.file.path : null,
            assignedTo: assignedStaff.id // Persists the ID directly to the database record
        });

        await newTicket.save();
        res.status(201).json(newTicket);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/tickets/:id/resolve', async (req, res) => {
    if (!req.session || !req.session.isAdmin) return res.status(401).json({ error: "Unauthorized" });
    await Ticket.findByIdAndUpdate(req.params.id, { status: 'Resolved' });
    res.json({ success: true });
});

// START THE SERVER IMMEDIATELY
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server cloud interface active on port ${PORT}`);
});