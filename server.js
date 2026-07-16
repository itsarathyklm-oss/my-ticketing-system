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
const MONGO_URI = process.env.MONGO_URI; 
mongoose.connect(MONGO_URI)
    .then(() => console.log("Connected permanently to MongoDB Cloud"))
    .catch(err => console.error("Database connection error:", err));

// Updated Mongoose Schema to support internal comments/notes
const ticketSchema = new mongoose.Schema({
    title: String,
    priority: { type: String, default: 'Medium' },
    description: String,
    screenshot: String, 
    status: { type: String, default: 'Open' },
    assignedTo: { type: String, default: 'Unassigned' },
    comments: [{
        author: String,
        text: String,
        createdAt: { type: Date, default: Date.now }
    }]
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

// Staff data with login credentials and notification emails
const IT_STAFF = [
    { id: 'IT001', name: 'SADIQ', password: 'sadiq123', email: 'itsarathy...' },
    { id: 'IT002', name: 'ABHIMANYU', password: 'abhi123', email: 'abhima...' },
    { id: 'IT003', name: 'ANANDHU', password: 'anandhu123', email: 'anuac...' },
    { id: 'IT004', name: 'sabari', password: 'sabari123', email: 'sabari...' }
];

// Configure Email Transporter (Uses environment variables for security)
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
    cookie: { maxAge: 1800000 } // Expanded to 30 mins for convenient working window
}));

// Middlewares to handle multiple access levels
function checkAdminLogin(req, res, next) {
    if (req.session && req.session.isAdmin) {
        next();
    } else {
        res.redirect('/login');
    }
}

function checkUserLogin(req, res, next) {
    if (req.session && (req.session.isAdmin || req.session.isStaff)) {
        next();
    } else {
        res.redirect('/login');
    }
}

// ROUTERS

// User Ticket Submission Page
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>IT Helpdesk Support Ticket</title><style>body { font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; }.company-header { display: flex; align-items: center; gap: 15px; margin-bottom: 30px; padding-bottom: 15px; border-bottom: 2px solid #eee; }.company-logo { height: 50px; width: auto; object-fit: contain; }.company-name { font-size: 24px; font-weight: bold; color: #333; }label { display: block; margin-top: 12px; font-weight: bold; }input, textarea, select { width: 100%; padding: 10px; margin-top: 5px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px; }button { margin-top: 20px; padding: 12px; background: #007bff; color: white; border: none; cursor: pointer; width: 100%; font-size: 16px; border-radius: 4px; }button:hover { background: #0056b3; }</style></head><body><div class="company-header"><img src="/logo.png" alt="Company Logo" class="company-logo" onerror="this.style.display='none'"><span class="company-name">IT HELPDESK</span></div><h2>Submit a New Ticket</h2><form id="ticketForm" enctype="multipart/form-data"><label>Issue Title:</label><input type="text" id="title" required><label>Priority Level:</label><select id="priority"><option value="Low">Low</option><option value="Medium" selected>Medium</option><option value="High">High</option></select><label>Description:</label><textarea id="description" rows="4" required></textarea><label>Upload Screenshot (Optional):</label><input type="file" id="screenshot" accept="image/*"><button type="submit">Submit Ticket</button></form><script>document.getElementById('ticketForm').addEventListener('submit', async (e) => { e.preventDefault(); const formData = new FormData(); formData.append('title', document.getElementById('title').value); formData.append('priority', document.getElementById('priority').value); formData.append('description', document.getElementById('description').value); const fileInput = document.getElementById('screenshot'); if (fileInput.files[0]) formData.append('screenshot', fileInput.files[0]); const response = await fetch('/tickets', { method: 'POST', body: formData }); if (response.ok) { alert('Ticket submitted to IT cloud database!'); document.getElementById('ticketForm').reset(); } });</script></body></html>`);
});

// Shared Login Page (Admin & Staff)
app.get('/login', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Login</title><style>body { font-family: Arial, sans-serif; max-width: 350px; margin: 80px auto; padding: 25px; border: 1px solid #ddd; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }.company-brand { text-align: center; margin-bottom: 25px; padding-bottom: 15px; border-bottom: 1px solid #eee; }.company-logo { height: 50px; width: auto; object-fit: contain; margin-bottom: 10px; }.company-name { font-size: 20px; font-weight: bold; color: #333; display: block; }label { display: block; margin-top: 12px; font-weight: bold; }input { width: 100%; padding: 10px; margin-top: 5px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px; }button { margin-top: 25px; padding: 12px; background: #28a745; color: white; border: none; cursor: pointer; width: 100%; font-size: 16px; border-radius: 4px; }</style></head><body><div class="company-brand"><img src="/logo.png" alt="Company Logo" class="company-logo" onerror="this.style.display='none'"><span class="company-name">IT HELPDESK</span></div><form action="/login" method="POST"><label>Username / Staff Name:</label> <input type="text" name="username" required><label>Password:</label> <input type="password" name="password" required><button type="submit">Login</button></form></body></html>`);
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    // Check Admin Credentials
    if (username === 'admin' && password === '123') {
        req.session.isAdmin = true;
        req.session.isStaff = false;
        req.session.username = 'Admin';
        return res.redirect('/admin');
    }
    
    // Check Staff Credentials
    const staffUser = IT_STAFF.find(s => s.name.toLowerCase() === username.toLowerCase() && s.password === password);
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
    res.redirect('/');
});

// Dashboard UI supporting Notes, Metrics Panels, and customized context views
app.get('/admin', checkUserLogin, (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>IT Panel Dashboard</title><style>body { font-family: Arial, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background-color: #f4f6f9; }.company-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; padding-bottom: 15px; border-bottom: 2px solid #ddd; }.brand-side { display: flex; align-items: center; gap: 15px; }.company-logo { height: 40px; width: auto; object-fit: contain; }.company-name { font-size: 20px; font-weight: bold; color: #333; }.logout-btn { background: #dc3545; color: white; text-decoration: none; padding: 6px 12px; border-radius: 4px; font-size: 14px; }.metrics-row { display: flex; gap: 15px; margin-bottom: 25px; }.card-stat { flex: 1; padding: 15px; border-radius: 6px; background: white; box-shadow: 0 2px 4px rgba(0,0,0,0.05); text-align: center; border-left: 5px solid #007bff; }.card-stat h4 { margin: 0; color: #666; font-size: 14px; }.card-stat div { font-size: 24px; font-weight: bold; margin-top: 5px; color: #222; }.ticket-card { border: 1px solid #ddd; padding: 15px; margin-top: 15px; border-radius: 6px; background: white; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }.badge { padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; display: inline-block; margin-right: 5px; }.p-Low { background: #e2e3e5; color: #383d41; }.p-Medium { background: #fff3cd; color: #856404; }.p-High { background: #f8d7da; color: #721c24; }.status-open { background: #cce5ff; color: #004085; }.status-resolved { background: #d4edda; color: #155724; }.resolve-btn { background: #28a745; color: white; border: none; padding: 6px 12px; font-size: 13px; border-radius: 4px; cursor: pointer; float: right; }.screenshot-preview { max-width: 100%; max-height: 200px; margin-top: 10px; display: block; border: 1px solid #ddd; border-radius: 4px; }.assignment-box { margin-top: 15px; padding-top: 10px; border-top: 1px dashed #eee; font-size: 14px; color: #555; }.comment-section { margin-top: 15px; background: #f8f9fa; padding: 10px; border-radius: 4px; }.comment-item { border-bottom: 1px solid #e9ecef; padding: 5px 0; font-size: 13px; }.comment-item:last-child { border-bottom: none; }.comment-input-box { display: flex; gap: 8px; margin-top: 10px; }.comment-input-box input { flex: 1; padding: 6px; border: 1px solid #ccc; border-radius: 4px; }.comment-input-box button { padding: 6px 12px; background: #17a2b8; color: white; border: none; border-radius: 4px; cursor: pointer; }</style></head><body><div class="company-header"><div class="brand-side"><img src="/logo.png" alt="Company Logo" class="company-logo" onerror="this.style.display='none'"><span class="company-name">IT HELPDESK</span></div><div><span style="margin-right:15px; font-weight:bold;">User: ${req.session.username}</span><a href="/logout" class="logout-btn">Logout</a></div></div><div class="metrics-row"><div class="card-stat"><h4>Total Open</h4><div id="statOpen">0</div></div><div class="card-stat" style="border-left-color: #28a745;"><h4>Total Resolved</h4><div id="statResolved">0</div></div><div class="card-stat" style="border-left-color: #ffc107;"><h4>My Assigned</h4><div id="statMine">0</div></div></div><div id="ticketList">Loading system records...</div><script>const currentUser = "${req.session.username}"; const isAdmin = ${req.session.isAdmin}; async function loadTickets() { const response = await fetch('/tickets'); if (response.status === 401) { window.location.href = '/login'; return; } let tickets = await response.json(); if (!isAdmin) { tickets = tickets.filter(t => t.assignedTo === currentUser); } let openCount = tickets.filter(t => t.status === 'Open').length; let resolvedCount = tickets.filter(t => t.status === 'Resolved').length; let mineCount = tickets.filter(t => t.assignedTo === currentUser).length; document.getElementById('statOpen').innerText = openCount; document.getElementById('statResolved').innerText = resolvedCount; document.getElementById('statMine').innerText = mineCount; const listDiv = document.getElementById('ticketList'); if (tickets.length === 0) { listDiv.innerHTML = '<p>No tickets logged under this view perspective.</p>'; return; } listDiv.innerHTML = ''; tickets.forEach(ticket => { const isResolved = ticket.status === 'Resolved'; const actionBtn = isResolved ? '' : \`<button class="resolve-btn" onclick="resolveTicket('\${ticket._id}')">Resolve</button>\`; const statusClass = isResolved ? 'status-resolved' : 'status-open'; let imageHtml = ticket.screenshot ? \`<a href="\${ticket.screenshot}" target="_blank"><img src="\${ticket.screenshot}" class="screenshot-preview"></a>\` : ''; let commentListHtml = ''; if(ticket.comments && ticket.comments.length > 0) { ticket.comments.forEach(c => { commentListHtml += \`<div class="comment-item"><strong>\${c.author}:</strong> \${c.text}</div>\`; }); } listDiv.innerHTML += \`<div class="ticket-card">\${actionBtn}<h3>\${ticket.title}</h3><p>\${ticket.description}</p>\${imageHtml}<div style="margin-top:15px;"><span class="badge p-\${ticket.priority}">\${ticket.priority} Priority</span><span class="badge \${statusClass}">\${ticket.status}</span></div><div class="assignment-box"><strong>Assigned Staff Member:</strong> \${ticket.assignedTo}</div><div class="comment-section"><h5>Notes & Updates</h5><div>\${commentListHtml}</div><div class="comment-input-box"><input type="text" id="input-\${ticket._id}" placeholder="Type internal note..."><button onclick="addComment('\${ticket._id}')">Add Note</button></div></div></div>\`; }); } async function addComment(id) { const textInput = document.getElementById(\`input-\${id}\`); const text = textInput.value.trim(); if(!text) return; await fetch(\`/tickets/\${id}/comment\`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); textInput.value = ''; loadTickets(); } async function resolveTicket(id) { const response = await fetch(\`/tickets/\${id}/resolve\`, { method: 'POST' }); if (response.ok) loadTickets(); } loadTickets();</script></body></html>`);
});

// DATABASE ACTIONS WITH DIRECT ALLOCATION & EMAIL PIPELINE
app.post('/tickets', upload.single('screenshot'), async (req, res) => {
    try {
        const ticketCount = await Ticket.countDocuments();
        const staffIndex = ticketCount % IT_STAFF.length;
        const assignedStaff = IT_STAFF[staffIndex];

        const newTicket = new Ticket({
            title: req.body.title,
            priority: req.body.priority,
            description: req.body.description,
            screenshot: req.file ? req.file.path : null,
            assignedTo: assignedStaff.name 
        });

        await newTicket.save();

        // Fire & Forget Email Notification Loop
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: assignedStaff.email,
            subject: `[New Ticket Assigned] - ${newTicket.title}`,
            text: `Hello ${assignedStaff.name},\n\nA new IT support ticket has been automatically allocated to you.\n\nTitle: ${newTicket.title}\nPriority: ${newTicket.priority}\nDescription: ${newTicket.description}\n\nPlease check your panel dashboard to resolve it.`
        };

        transporter.sendMail(mailOptions, (err, info) => {
            if (err) console.error("Email pipeline dispatch error:", err);
            else console.log("Notification sent successfully to: " + assignedStaff.email);
        });

        res.status(201).json(newTicket);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API Routes
app.get('/tickets', checkUserLogin, async (req, res) => {
    const tickets = await Ticket.find().sort({ _id: -1 });
    res.json(tickets);
});

app.post('/tickets/:id/resolve', checkUserLogin, async (req, res) => {
    await Ticket.findByIdAndUpdate(req.params.id, { status: 'Resolved' });
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

// START THE SERVER
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server cloud interface active on port ${PORT}`);
});