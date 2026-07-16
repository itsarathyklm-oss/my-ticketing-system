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

// 1. CONNECT TO MONGOBASE DB
const MONGO_URI = process.env.MONGO_URI; 
mongoose.connect(MONGO_URI)
    .then(() => console.log("Connected permanently to MongoDB Cloud"))
    .catch(err => console.error("Database connection error:", err));

// Define Mongoose Ticket Layout Template
const ticketSchema = new mongoose.Schema({
    title: String,
    priority: { type: String, default: 'Medium' },
    description: String,
    screenshot: String, // Will store the permanent Cloudinary image web URL URL
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
    { id: 'IT002', name: 'ANANTHU' },
    { id: 'IT003', name: 'ABHIMANYU' }
];

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

app.use(session({
    secret: 'my-super-secret-key-123',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 600000 }
}));

const FILE_PATH = path.join(__dirname, 'tickets.json');

function readTicketsFromFile() {
    try {
        if (!fs.existsSync(FILE_PATH)) return [];
        const fileData = fs.readFileSync(FILE_PATH, 'utf8');
        return JSON.parse(fileData);
    } catch (error) {
        return [];
    }
}

function saveTicketsToFile(ticketsArray) {
    fs.writeFileSync(FILE_PATH, JSON.stringify(ticketsArray, null, 2), 'utf8');
}

function checkAdminLogin(req, res, next) {
    if (req.session && req.session.isAdmin) {
        next();
    } else {
        res.redirect('/login');
    }
}

// ----------------------------------------------------
// PAGE 1: EMPLOYEE SUBMISSION FORM
// ----------------------------------------------------
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Helpdesk Support Ticket</title>
            <style>
                body { font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; }
                .company-header { display: flex; align-items: center; gap: 15px; margin-bottom: 30px; padding-bottom: 15px; border-bottom: 2px solid #eee; }
                .company-logo { height: 50px; width: auto; object-fit: contain; }
                .company-name { font-size: 24px; font-weight: bold; color: #333; }
                label { display: block; margin-top: 12px; font-weight: bold; }
                input, textarea, select { width: 100%; padding: 10px; margin-top: 5px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px; }
                input[type="file"] { padding: 5px; }
                button { margin-top: 20px; padding: 12px; background: #007bff; color: white; border: none; cursor: pointer; width: 100%; font-size: 16px; border-radius: 4px; }
                button:hover { background: #0056b3; }
            </style>
        </head>
        <body>
            <div class="company-header">
                <img src="/logo.png" alt="Company Logo" class="company-logo" onerror="this.style.display='none'">
                <span class="company-name">IT HELPDESK</span>
            </div>

            <h2>Submit a New Ticket</h2>
            <form id="ticketForm" enctype="multipart/form-data">
                <label>Issue Title:</label>
                <input type="text" id="title" placeholder="e.g., Internet is dropping out" required>
                
                <label>Priority Level:</label>
                <select id="priority">
                    <option value="Low">Low</option>
                    <option value="Medium" selected>Medium</option>
                    <option value="High">High</option>
                </select>

                <label>Description:</label>
                <textarea id="description" rows="4" placeholder="Provide details..." required></textarea>
                
                <label>Upload Screenshot (Optional):</label>
                <input type="file" id="screenshot" accept="image/*">

                <button type="submit">Submit Ticket</button>
            </form>

            <script>
                document.getElementById('ticketForm').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const formData = new FormData();
                    formData.append('title', document.getElementById('title').value);
                    formData.append('priority', document.getElementById('priority').value);
                    formData.append('description', document.getElementById('description').value);
                    
                    const fileInput = document.getElementById('screenshot');
                    if (fileInput.files[0]) formData.append('screenshot', fileInput.files[0]);

                    const response = await fetch('/tickets', { method: 'POST', body: formData });
                    if (response.ok) {
                        alert('Ticket submitted to IT team!');
                        document.getElementById('ticketForm').reset();
                    }
                });
            </script>
        </body>
        </html>
    `);
});

// ----------------------------------------------------
// PAGE 2: LOGIN SCREEN
// ----------------------------------------------------
app.get('/login', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Admin Login</title>
            <style>
                body { font-family: Arial, sans-serif; max-width: 350px; margin: 80px auto; padding: 25px; border: 1px solid #ddd; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
                .company-brand { text-align: center; margin-bottom: 25px; padding-bottom: 15px; border-bottom: 1px solid #eee; }
                .company-logo { height: 50px; width: auto; object-fit: contain; margin-bottom: 10px; }
                .company-name { font-size: 20px; font-weight: bold; color: #333; display: block; }
                label { display: block; margin-top: 12px; font-weight: bold; }
                input { width: 100%; padding: 10px; margin-top: 5px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px; }
                button { margin-top: 25px; padding: 12px; background: #28a745; color: white; border: none; cursor: pointer; width: 100%; font-size: 16px; border-radius: 4px; }
                button:hover { background: #218838; }
            </style>
        </head>
        <body>
            <div class="company-brand">
                <img src="/logo.png" alt="Company Logo" class="company-logo" onerror="this.style.display='none'">
                <span class="company-name">IT HELPDESK</span>
            </div>
            <form action="/login" method="POST">
                <label>Username:</label> <input type="text" name="username" required>
                <label>Password:</label> <input type="password" name="password" required>
                <button type="submit">Login</button>
            </form>
        </body>
        </html>
    `);
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'SuperSecret123') {
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

// ----------------------------------------------------
// PAGE 3: ADMIN DASHBOARD WITH TICKET ASSIGNMENT
// ----------------------------------------------------
app.get('/admin', checkAdminLogin, (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Admin Dashboard</title>
            <style>
                body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background-color: #f4f6f9; }
                .company-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 30px; padding-bottom: 15px; border-bottom: 2px solid #ddd; }
                .brand-side { display: flex; align-items: center; gap: 15px; }
                .company-logo { height: 40px; width: auto; object-fit: contain; }
                .company-name { font-size: 20px; font-weight: bold; color: #333; }
                .logout-btn { background: #dc3545; color: white; text-decoration: none; padding: 6px 12px; border-radius: 4px; font-size: 14px; }
                .ticket-card { border: 1px solid #ddd; padding: 15px; margin-top: 15px; border-radius: 6px; background: white; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
                .badge { padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; display: inline-block; margin-right: 5px; }
                .p-Low { background: #e2e3e5; color: #383d41; }
                .p-Medium { background: #fff3cd; color: #856404; }
                .p-High { background: #f8d7da; color: #721c24; }
                .status-open { background: #cce5ff; color: #004085; }
                .status-resolved { background: #d4edda; color: #155724; }
                .resolve-btn { background: #28a745; color: white; border: none; padding: 6px 12px; font-size: 13px; border-radius: 4px; cursor: pointer; float: right; }
                .screenshot-preview { max-width: 100%; max-height: 200px; margin-top: 10px; display: block; border: 1px solid #ddd; border-radius: 4px; }
                .assignment-box { margin-top: 15px; padding-top: 10px; border-top: 1px dashed #eee; display: flex; align-items: center; gap: 10px; }
                .assign-select { padding: 5px; border-radius: 4px; border: 1px solid #ccc; }
            </style>
        </head>
        <body>
            <div class="company-header">
                <div class="brand-side">
                    <img src="/logo.png" alt="Company Logo" class="company-logo" onerror="this.style.display='none'">
                    <span class="company-name">IT HELPDESK <span style="font-weight: normal; color: #666;">(Admin Panel)</span></span>
                </div>
                <a href="/logout" class="logout-btn">Logout</a>
            </div>
            
            <div id="ticketList">Loading system tickets...</div>

            <script>
                // Fetch staff directory from backend
                let itStaffList = [];
                async function loadStaff() {
                    const response = await fetch('/admin/staff');
                    itStaffList = await response.json();
                }

                async function loadTickets() {
                    const response = await fetch('/tickets');
                    if (response.status === 401) { window.location.href = '/login'; return; }
                    
                    const tickets = await response.json();
                    const listDiv = document.getElementById('ticketList');
                    if (tickets.length === 0) { listDiv.innerHTML = '<p>No tickets logged.</p>'; return; }
                    
                    listDiv.innerHTML = '';
                    tickets.reverse().forEach(ticket => {
                        const isResolved = ticket.status === 'Resolved';
                        const actionBtn = isResolved ? '' : \`<button class="resolve-btn" onclick="resolveTicket(\${ticket.id})">Resolve</button>\`;
                        const statusClass = isResolved ? 'status-resolved' : 'status-open';
                        
                        let imageHtml = ticket.screenshot ? \`<a href="\${ticket.screenshot}" target="_blank"><img src="\${ticket.screenshot}" class="screenshot-preview"></a>\` : '';

                        // Build the HTML selection dropdown for staff assignment
                        let optionsHtml = '<option value="Unassigned">-- Unassigned --</option>';
                        itStaffList.forEach(staff => {
                            const selected = ticket.assignedTo === staff.id ? 'selected' : '';
                            optionsHtml += \`<option value="\${staff.id}" \${selected}>\${staff.name} (\${staff.id})</option>\`;
                        });

                        listDiv.innerHTML += \`
                            <div class="ticket-card">
                                \${actionBtn}
                                <h3>#\${ticket.id}: \${ticket.title}</h3>
                                <p style="color: #444;">\${ticket.description}</p>
                                \${imageHtml}
                                <div style="margin-top: 15px;">
                                    <span class="badge p-\${ticket.priority}">\${ticket.priority} Priority</span>
                                    <span class="badge \${statusClass}">\${ticket.status}</span>
                                </div>
                                <div class="assignment-box">
                                    <label style="font-size: 13px; font-weight: bold;">Assign Staff ID:</label>
                                    <select class="assign-select" onchange="assignTicket(\${ticket.id}, this.value)" \${isResolved ? 'disabled' : ''}>
                                        \${optionsHtml}
                                    </select>
                                </div>
                            </div>
                        \`;
                    });
                }

                async function assignTicket(ticketId, staffId) {
                    await fetch(\`/tickets/\${ticketId}/assign\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ staffId })
                    });
                }

                async function resolveTicket(id) {
                    const response = await fetch(\`/tickets/\${id}/resolve\`, { method: 'POST' });
                    if (response.ok) { loadTickets(); }
                }

                // Initial layout boot up
                async function init() {
                    await loadStaff();
                    await loadTickets();
                }
                init();
            </script>
        </body>
        </html>
    `);
});

// ----------------------------------------------------
// DATA API BACKEND ROUTES
// ----------------------------------------------------
app.get('/admin/staff', (req, res) => {
    res.json(IT_STAFF); // Expose the staff register array
});

app.post('/tickets', upload.single('screenshot'), (req, res) => {
    const tickets = readTicketsFromFile();
    const newTicket = {
        id: tickets.length + 1,
        title: req.body.title,
        priority: req.body.priority || 'Medium',
        description: req.body.description,
        screenshot: req.file ? '/uploads/' + req.file.filename : null,
        status: 'Open',
        assignedTo: 'Unassigned' // Default state
    };
    tickets.push(newTicket);
    saveTicketsToFile(tickets);
    res.status(201).json(newTicket);
});

// NEW ROUTE: Sets the assigned staff ID text field 
app.post('/tickets/:id/assign', (req, res) => {
    if (!req.session || !req.session.isAdmin) return res.status(401).json({ error: "Unauthorized" });
    const ticketId = parseInt(req.params.id);
    const { staffId } = req.body;
    
    let tickets = readTicketsFromFile();
    const ticket = tickets.find(t => t.id === ticketId);
    
    if (ticket) {
        ticket.assignedTo = staffId;
        saveTicketsToFile(tickets);
        res.json(ticket);
    } else {
        res.status(404).json({ message: 'Ticket not found' });
    }
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/tickets', (req, res) => {
    if (req.session && req.session.isAdmin) {
        res.json(readTicketsFromFile());
    } else {
        res.status(404).json({ error: "Unauthorized access" });
    }
});

app.post('/tickets/:id/resolve', (req, res) => {
    if (!req.session || !req.session.isAdmin) return res.status(401).json({ error: "Unauthorized" });
    const ticketId = parseInt(req.params.id);
    let tickets = readTicketsFromFile();
    const ticket = tickets.find(t => t.id === ticketId);
    
    if (ticket) {
        ticket.status = 'Resolved';
        saveTicketsToFile(tickets);
        res.json(ticket);
    } else {
        res.status(404).json({ message: 'Ticket not found' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});