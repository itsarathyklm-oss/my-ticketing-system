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
    mobile: { type: String, required: true }, // Added mandatory mobile number field
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
    res.send(`<!DOCTYPE html><html><head><title>IT Helpdesk Support Ticket</title><style>body { font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; }.company-header { display: flex; align-items: center; gap: 15px; margin-bottom: 30px; padding-bottom: 15px; border-bottom: 2px solid #eee; }.company-logo { height: 50px; width: auto; object-fit: contain; }.company-name { font-size: 24px; font-weight: bold; color: #333; }label { display: block; margin-top: 12px; font-weight: bold; }input, textarea, select { width: 100%; padding: 10px; margin-top: 5px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px; }button { margin-top: 20px; padding: 12px; background: #007bff; color: white; border: none; cursor: pointer; width: 100%; font-size: 16px; border-radius: 4px; }button:hover { background: #0056b3; }</style></head><body><div class="company-header"><img src="/logo.png" alt="Company Logo" class="company-logo" onerror="this.style.display='none'"><span class="company-name">IT HELPDESK</span></div><h2>Submit a New Ticket</h2><form id="ticketForm" enctype="multipart/form-data"><label>Issue Title:</label><input type="text" id="title" required><label>Mobile Number:</label><input type="tel" id="mobile" placeholder="Enter your 10-digit mobile number" pattern="[0-9]{10}" required><label>Priority Level:</label><select id="priority"><option value="Low">Low</option><option value="Medium" selected>Medium</option><option value="High">High</option></select><label>Description:</label><textarea id="description" rows="4" required></textarea><label>Upload Screenshot (Optional):</label><input type="file" id="screenshot" accept="image/*"><button type="submit">Submit Ticket</button></form><script>document.getElementById('ticketForm').addEventListener('submit', async (e) => { e.preventDefault(); const formData = new FormData(); formData.append('title', document.getElementById('title').value); formData.append('mobile', document.getElementById('mobile').value); formData.append('priority', document.getElementById('priority').value); formData.append('description', document.getElementById('description').value); const fileInput = document.getElementById('screenshot'); if (fileInput.files[0]) formData.append('screenshot', fileInput.files[0]); const response = await fetch('/tickets', { method: 'POST', body: formData }); if (response.ok) { alert('Ticket submitted to IT cloud database!'); document.getElementById('ticketForm').reset(); } });</script></body></html>`);
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
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>IT Helpdesk | Dashboard</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        body { display: flex; height: 100vh; background-color: #f8f9fa; color: #333; overflow: hidden; }
        
        /* Sidebar Styles */
        .sidebar { width: 260px; background-color: #1e2229; color: #fff; display: flex; flex-direction: column; justify-content: space-between; }
        .sidebar-brand { padding: 24px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #2d323e; }
        .sidebar-logo { height: 35px; width: auto; object-fit: contain; }
        .sidebar-title { font-size: 18px; font-weight: 700; color: #fff; letter-spacing: 0.5px; }
        .sidebar-menu { list-style: none; padding: 20px 0; flex-grow: 1; }
        .menu-item { padding: 12px 24px; display: flex; align-items: center; gap: 12px; color: #a0aec0; text-decoration: none; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s; }
        .menu-item:hover, .menu-item.active { background-color: #2d323e; color: #fff; border-left: 4px solid #0056b3; }
        .sidebar-footer { padding: 20px; border-top: 1px solid #2d323e; }
        .user-info { font-size: 12px; color: #a0aec0; margin-bottom: 12px; }
        .user-info strong { color: #fff; display: block; font-size: 14px; margin-bottom: 2px; }
        .logout-btn { display: block; width: 100%; text-align: center; background-color: #e53e3e; color: white; text-decoration: none; padding: 10px; border-radius: 6px; font-size: 14px; font-weight: 600; transition: background 0.2s; }
        .logout-btn:hover { background-color: #c53030; }

        /* Main Content Container */
        .main-content { flex-grow: 1; display: flex; flex-direction: column; height: 100vh; overflow-y: auto; }
        .top-navbar { height: 70px; background-color: #fff; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between; padding: 0 30px; }
        .page-title { font-size: 20px; font-weight: 600; color: #2d3748; }
        .content-body { padding: 30px; max-width: 1200px; width: 100%; margin: 0 auto; }

        /* Metrics Grid */
        .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .metric-card { background: white; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); border: 1px solid #e2e8f0; border-top: 4px solid #3182ce; }
        .metric-card.resolved { border-top-color: #38a169; }
        .metric-card.assigned { border-top-color: #dd6b20; }
        .metric-label { font-size: 13px; font-weight: 600; color: #718096; text-transform: uppercase; letter-spacing: 0.5px; }
        .metric-value { font-size: 28px; font-weight: 700; color: #2d3748; margin-top: 5px; }

        /* Ticket Cards */
        .ticket-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); position: relative; }
        .ticket-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
        .ticket-title { font-size: 18px; font-weight: 600; color: #2d3748; }
        .ticket-desc { color: #4a5568; font-size: 14px; line-height: 1.5; margin-bottom: 16px; }
        
        .badge { padding: 4px 10px; border-radius: 50px; font-size: 11px; font-weight: 700; text-transform: uppercase; display: inline-block; margin-right: 8px; }
        .p-Low { background-color: #edf2f7; color: #4a5568; }
        .p-Medium { background-color: #feebc8; color: #c05621; }
        .p-High { background-color: #fed7d7; color: #9b2c2c; }
        .status-open { background-color: #ebf8ff; color: #2b6cb0; }
        .status-resolved { background-color: #c6f6d5; color: #22543d; }

        .resolve-btn { background-color: #38a169; color: white; border: none; padding: 8px 16px; font-size: 13px; font-weight: 600; border-radius: 6px; cursor: pointer; transition: background 0.2s; }
        .resolve-btn:hover { background-color: #2f855a; }
        .screenshot-preview { max-width: 100%; max-height: 180px; border-radius: 6px; border: 1px solid #e2e8f0; margin-top: 12px; display: block; object-fit: cover; }
        
        .assignment-info { margin-top: 16px; padding-top: 12px; border-top: 1px solid #edf2f7; font-size: 13px; color: #718096; }
        .assignment-info strong { color: #4a5568; }

        /* Comments / Notes Layout */
        .comments-section { margin-top: 20px; background-color: #f7fafc; padding: 16px; border-radius: 8px; border: 1px solid #edf2f7; }
        .comments-header { font-size: 12px; font-weight: 700; color: #718096; text-transform: uppercase; margin-bottom: 10px; letter-spacing: 0.5px; }
        .comment-item { padding: 8px 0; border-bottom: 1px solid #edf2f7; font-size: 13px; color: #4a5568; }
        .comment-item:last-child { border-bottom: none; }
        .comment-item strong { color: #2d3748; }
        
        .comment-form { display: flex; gap: 10px; margin-top: 12px; }
        .comment-form input { flex-grow: 1; padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 13px; }
        .comment-form input:focus { outline: none; border-color: #3182ce; }
        .comment-form button { background-color: #3182ce; color: white; border: none; padding: 8px 16px; font-size: 13px; font-weight: 600; border-radius: 6px; cursor: pointer; transition: background 0.2s; }
        .comment-form button:hover { background-color: #2b6cb0; }
    </style>
</head>
<body>

    <!-- SIDEBAR -->
    <aside class="sidebar">
        <div>
            <div class="sidebar-brand">
                <img src="/logo.png" alt="Logo" class="sidebar-logo" onerror="this.style.display='none'">
                <span class="sidebar-title">SARATHY IT</span>
            </div>
            <ul class="sidebar-menu">
                <li class="menu-item active">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                    All Tickets
                </li>
            </ul>
        </div>
        <div class="sidebar-footer">
            <div class="user-info">
                <span>Logged in as</span>
                <strong>${req.session.username}</strong>
            </div>
            <a href="/logout" class="logout-btn">Logout</a>
        </div>
    </aside>

    <!-- MAIN CONTENT LAYER -->
    <main class="main-content">
        <header class="top-navbar">
            <h1 class="page-title">Helpdesk Operations</h1>
        </header>

        <section class="content-body">
            <!-- Metrics Row -->
            <div class="metrics-grid">
                <div class="metric-card">
                    <div class="metric-label">Open Issues</div>
                    <div class="metric-value" id="statOpen">0</div>
                </div>
                <div class="metric-card resolved">
                    <div class="metric-label">Resolved Issues</div>
                    <div class="metric-value" id="statResolved">0</div>
                </div>
                <div class="metric-card assigned">
                    <div class="metric-label">My Active Tickets</div>
                    <div class="metric-value" id="statMine">0</div>
                </div>
            </div>

            <!-- Ticket Feed -->
            <div id="ticketList">Loading active queue...</div>
        </section>
    </main>

    <script>
        const currentUser = "${req.session.username}";
        const isAdmin = ${req.session.isAdmin};

        async function loadTickets() {
            const response = await fetch('/tickets');
            if (response.status === 401) {
                window.location.href = '/login';
                return;
            }
            let tickets = await response.json();
            
            if (!isAdmin) {
                tickets = tickets.filter(t => t.assignedTo === currentUser);
            }

            let openCount = tickets.filter(t => t.status === 'Open').length;
            let resolvedCount = tickets.filter(t => t.status === 'Resolved').length;
            let mineCount = tickets.filter(t => t.assignedTo === currentUser).length;

            document.getElementById('statOpen').innerText = openCount;
            document.getElementById('statResolved').innerText = resolvedCount;
            document.getElementById('statMine').innerText = mineCount;

            const listDiv = document.getElementById('ticketList');
            if (tickets.length === 0) {
                listDiv.innerHTML = '<p style="text-align: center; color: #718096; padding: 40px 0;">No support requests logged in this category.</p>';
                return;
            }

            listDiv.innerHTML = '';
            tickets.forEach(ticket => {
                const isResolved = ticket.status === 'Resolved';
                const actionBtn = isResolved ? '' : \`<button class="resolve-btn" onclick="resolveTicket('\${ticket._id}')">Resolve Ticket</button>\`;
                const statusClass = isResolved ? 'status-resolved' : 'status-open';
                let imageHtml = ticket.screenshot ? \`<a href="\${ticket.screenshot}" target="_blank"><img src="\${ticket.screenshot}" class="screenshot-preview"></a>\` : '';
                
                let commentListHtml = '';
                if (ticket.comments && ticket.comments.length > 0) {
                    ticket.comments.forEach(c => {
                        commentListHtml += \`<div class="comment-item"><strong>\${c.author}:</strong> \${c.text}</div>\`;
                    });
                }

                listDiv.innerHTML += \`
                    <div class="ticket-card">
                        <div class="ticket-header">
                            <div>
                                <h3 class="ticket-title">\${ticket.title}</h3>
                                <div style="margin-top: 8px;">
                                    <span class="badge p-\${ticket.priority}">\${ticket.priority} Priority</span>
                                    <span class="badge \${statusClass}">\${ticket.status}</span>
                                </div>
                            </div>
                            \${actionBtn}
                        </div>
                        <p class="ticket-desc">\${ticket.description}</p>
                        \${imageHtml}
                        <div class="assignment-info" style="display: flex; gap: 15px;">
    <span><strong>Mobile:</strong> \${ticket.mobile || 'N/A'}</span>
    <span><strong>Assigned Representative:</strong> \${ticket.assignedTo}</span>
</div>
                        <div class="comments-section">
                            <h4 class="comments-header">Internal Work Notes</h4>
                            <div id="comments-container-\${ticket._id}">
                                \${commentListHtml || '<p style="font-size: 13px; color: #a0aec0; font-style: italic;">No internal updates added yet.</p>'}
                            </div>
                            <div class="comment-form">
                                <input type="text" id="input-\${ticket._id}" placeholder="Write brief operational update...">
                                <button onclick="addComment('\${ticket._id}')">Post Note</button>
                            </div>
                        </div>
                    </div>
                \`;
            });
        }

        async function addComment(id) {
            const textInput = document.getElementById(\`input-\${id}\`);
            const text = textInput.value.trim();
            if(!text) return;

            await fetch(\`/tickets/\${id}/comment\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });

            textInput.value = '';
            loadTickets();
        }

        async function resolveTicket(id) {
            const response = await fetch(\`/tickets/\${id}/resolve\`, { method: 'POST' });
            if (response.ok) loadTickets();
        }

        loadTickets();
    </script>
</body>
</html>`);
});

// DATABASE ACTIONS WITH DIRECT ALLOCATION & EMAIL PIPELINE
app.post('/tickets', upload.single('screenshot'), async (req, res) => {
    try {
        const ticketCount = await Ticket.countDocuments();
        const staffIndex = ticketCount % IT_STAFF.length;
        const assignedStaff = IT_STAFF[staffIndex];

        const newTicket = new Ticket({
            title: req.body.title,
            mobile: req.body.mobile, // Capture mobile input from the form submission
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
            text: `Hello ${assignedStaff.name},\n\nA new IT support ticket has been automatically allocated to you.\n\nTitle: ${newTicket.title}\nMobile: ${newTicket.mobile}\nPriority: ${newTicket.priority}\nDescription: ${newTicket.description}\n\nPlease check your panel dashboard to resolve it.`
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