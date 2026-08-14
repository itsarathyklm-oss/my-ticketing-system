const express = require('express');
const path = require('path');
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
    escalatedBy: { type: String, default: '' },
    escalatedAt: { type: Date },
    escalationReason: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date },
    resolvedBy: { type: String, default: '' },
    comments: [{
        author: String,
        text: String,
        attachment: { type: String, default: null },
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

// In-app notifications for newly assigned or reallocated tickets.
const notificationSchema = new mongoose.Schema({
    recipient: { type: String, required: true },
    ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', required: true },
    ticketNumber: { type: Number, required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    read: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});
const Notification = mongoose.model('Notification', notificationSchema);

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
        allowed_formats: ['jpg', 'png', 'jpeg', 'webp', 'gif', 'pdf']
    }
});

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

// Staff Schema
const staffSchema = new mongoose.Schema({
    staffId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    password: { type: String, required: true },
    email: { type: String, required: true },
    region: { type: String, default: '' }
});
const Staff = mongoose.model('Staff', staffSchema);

// Region Admin Schema
const regionAdminSchema = new mongoose.Schema({
    name: { type: String, required: true },
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    region: { type: String, required: true },
    enabled: { type: Boolean, default: true }
});
const RegionAdmin = mongoose.model('RegionAdmin', regionAdminSchema);

// Inbox Schema
const inboxMessageSchema = new mongoose.Schema({
    sender: { type: String, required: true },
    senderStaffId: { type: String, default: '' },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    status: { type: String, default: 'Open' },
    reply: { type: String, default: '' },
    repliedBy: { type: String, default: '' },
    repliedAt: { type: Date },
    adminRead: { type: Boolean, default: false },
    staffRead: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
});
const InboxMessage = mongoose.model('InboxMessage', inboxMessageSchema);

// Seed initial IT staff accounts
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

async function getNextStaffId() {
    const allStaff = await Staff.find();
    let maxNum = 0;
    allStaff.forEach(s => {
        const match = s.staffId.match(/(\d+)$/);
        if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    });
    return 'IT' + String(maxNum + 1).padStart(3, '0');
}

async function getBranchNamesForRegion(regionName) {
    return Branch.find({ region: regionName }).distinct('name');
}

// Mailer Setup
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

dns.promises.resolve4('smtp.gmail.com')
    .then(addresses => {
        transporter = nodemailer.createTransport({
            host: addresses[0],
            port: 465,
            secure: true,
            tls: { servername: 'smtp.gmail.com' },
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

app.set('trust proxy', 1);

if (!process.env.SESSION_SECRET) {
    console.warn('WARNING: SESSION_SECRET is not set — using an insecure default.');
}

app.use(session({
    secret: process.env.SESSION_SECRET || 'my-super-secret-key-123',
    resave: false,
    rolling: true,
    saveUninitialized: true,
    cookie: {
        maxAge: 4 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production'
    }
}));

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

function checkSuperAdminLogin(req, res, next) {
    if (req.session && req.session.isAdmin && req.session.isSuperAdmin) {
        next();
    } else {
        res.status(403).json({ error: 'You are not authorized to access this page.' });
    }
}

// -------------------------------------------------------------
// 1. PUBLIC TICKET SUBMISSION / STATUS PAGE (APPLE LIQUID GLASS UI)
// -------------------------------------------------------------
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Submit a Ticket | SARATHY IT</title>
    <link rel="icon" type="image/png" href="/logo.png">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --glass-bg: rgba(255, 255, 255, 0.72);
            --glass-border: rgba(255, 255, 255, 0.8);
            --glass-card-border: rgba(255, 255, 255, 0.65);
            --glass-shadow: 0 24px 60px rgba(0, 0, 0, 0.12), 0 8px 24px rgba(0, 0, 0, 0.06), inset 0 1px 1px rgba(255, 255, 255, 0.9);
            --apple-blue: #0071e3;
            --apple-blue-hover: #0077ed;
            --apple-red: #ff3b30;
            --text-primary: #1d1d1f;
            --text-secondary: #86868b;
            --input-bg: rgba(255, 255, 255, 0.6);
            --input-border: rgba(0, 0, 0, 0.08);
            --radius-xl: 24px;
            --radius-lg: 16px;
            --radius-md: 12px;
            --radius-pill: 9999px;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Plus Jakarta Sans", "SF Pro Text", "SF Pro Display", "Helvetica Neue", sans-serif;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #f5f5f7 0%, #e8e8ed 100%);
            color: var(--text-primary);
            padding: 20px;
            overflow-x: hidden;
            position: relative;
        }

        /* Apple Ambient Fluid Background Mesh */
        .ambient-mesh {
            position: fixed;
            inset: 0;
            z-index: 0;
            overflow: hidden;
            pointer-events: none;
        }
        .orb {
            position: absolute;
            border-radius: 50%;
            filter: blur(80px);
            opacity: 0.55;
            animation: orbFloat 20s ease-in-out infinite alternate;
        }
        .orb-1 {
            width: 450px;
            height: 450px;
            background: radial-gradient(circle, #ff6b6b 0%, #ff8e53 100%);
            top: -100px;
            left: -80px;
            animation-duration: 18s;
        }
        .orb-2 {
            width: 550px;
            height: 550px;
            background: radial-gradient(circle, #4facfe 0%, #00f2fe 100%);
            bottom: -150px;
            right: -100px;
            animation-duration: 24s;
        }
        .orb-3 {
            width: 400px;
            height: 400px;
            background: radial-gradient(circle, #a18cd1 0%, #fbc2eb 100%);
            top: 40%;
            right: 20%;
            opacity: 0.35;
            animation-duration: 20s;
        }
        @keyframes orbFloat {
            0% { transform: translate(0, 0) scale(1); }
            100% { transform: translate(40px, 30px) scale(1.08); }
        }

        /* Liquid Glass Container Card */
        .ticket-card {
            position: relative;
            z-index: 1;
            width: 100%;
            max-width: 680px;
            max-height: 94vh;
            background: var(--glass-bg);
            backdrop-filter: blur(35px) saturate(190%);
            -webkit-backdrop-filter: blur(35px) saturate(190%);
            border: 1px solid var(--glass-card-border);
            border-radius: var(--radius-xl);
            box-shadow: var(--glass-shadow);
            overflow-y: auto;
            overflow-x: hidden;
            display: flex;
            flex-direction: column;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        /* Glass Header Ribbon */
        .ticket-ribbon {
            padding: 20px 28px 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            border-bottom: 1px solid rgba(255, 255, 255, 0.45);
            background: rgba(255, 255, 255, 0.4);
            backdrop-filter: blur(20px);
        }
        .brand-group {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .ticket-ribbon img {
            height: 32px;
            width: auto;
            object-fit: contain;
            filter: drop-shadow(0 2px 4px rgba(0,0,0,0.05));
        }
        .ticket-ribbon-text {
            font-weight: 700;
            font-size: 17px;
            letter-spacing: -0.3px;
            color: var(--text-primary);
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .portal-tag {
            font-size: 11px;
            font-weight: 600;
            background: rgba(0, 113, 227, 0.1);
            color: var(--apple-blue);
            padding: 3px 9px;
            border-radius: var(--radius-pill);
            border: 1px solid rgba(0, 113, 227, 0.2);
        }

        /* Segmented Glass Control Tabs */
        .tab-switch {
            display: flex;
            padding: 6px;
            margin: 16px 28px 4px;
            background: rgba(0, 0, 0, 0.05);
            border-radius: var(--radius-pill);
            gap: 4px;
            border: 1px solid rgba(255, 255, 255, 0.6);
        }
        .tab-btn {
            flex: 1;
            padding: 9px 18px;
            border: none;
            background: transparent;
            cursor: pointer;
            font-family: inherit;
            font-weight: 600;
            font-size: 13px;
            color: var(--text-secondary);
            border-radius: var(--radius-pill);
            transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .tab-btn.active {
            background: #ffffff;
            color: var(--text-primary);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.04);
        }

        .ticket-body {
            padding: 20px 28px 28px;
        }
        
        .header-title-box {
            margin-bottom: 20px;
        }
        h2.form-title {
            font-weight: 700;
            font-size: 22px;
            letter-spacing: -0.5px;
            color: var(--text-primary);
        }
        .form-subtitle {
            font-size: 13px;
            color: var(--text-secondary);
            margin-top: 4px;
        }

        /* Responsive Form Grid */
        .form-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 14px;
        }
        @media (max-width: 620px) {
            .form-grid { grid-template-columns: 1fr 1fr; }
            .ticket-body { padding: 18px 20px; }
            .ticket-ribbon { padding: 16px 20px; }
            .tab-switch { margin: 14px 20px 0; }
        }
        @media (max-width: 440px) {
            .form-grid { grid-template-columns: 1fr; }
        }

        .form-field {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .full-width { grid-column: 1 / -1; }

        label {
            font-weight: 600;
            font-size: 12px;
            color: #48484a;
            letter-spacing: -0.1px;
        }

        /* Glass Input Fields */
        input, textarea, select {
            width: 100%;
            padding: 10px 14px;
            border: 1px solid var(--input-border);
            border-radius: var(--radius-md);
            font-size: 13.5px;
            font-family: inherit;
            background: var(--input-bg);
            backdrop-filter: blur(10px);
            color: var(--text-primary);
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            outline: none;
            box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.02);
        }
        input::placeholder, textarea::placeholder {
            color: #a1a1a6;
        }
        input:focus, textarea:focus, select:focus {
            background: #ffffff;
            border-color: var(--apple-blue);
            box-shadow: 0 0 0 4px rgba(0, 113, 227, 0.15), 0 2px 8px rgba(0, 0, 0, 0.04);
        }
        textarea {
            resize: none;
            height: 68px;
        }

        /* File Upload Apple Glass Pill */
        .file-upload-wrapper {
            position: relative;
        }
        input[type="file"] {
            padding: 8px 12px;
            font-size: 12px;
            color: var(--text-secondary);
        }
        input[type="file"]::file-selector-button {
            border: 1px solid rgba(0, 0, 0, 0.08);
            padding: 6px 14px;
            border-radius: var(--radius-pill);
            background: #ffffff;
            color: var(--text-primary);
            font-weight: 600;
            font-size: 11.5px;
            cursor: pointer;
            margin-right: 10px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.06);
            transition: all 0.2s;
        }
        input[type="file"]::file-selector-button:hover {
            background: #f5f5f7;
        }

        /* Apple Liquid Buttons */
        button[type="submit"], .check-status-btn {
            grid-column: 1 / -1;
            margin-top: 10px;
            padding: 13px 20px;
            width: 100%;
            background: linear-gradient(180deg, #0077ed 0%, #0062c4 100%);
            color: #ffffff;
            border: 1px solid rgba(255, 255, 255, 0.25);
            border-radius: var(--radius-pill);
            cursor: pointer;
            font-family: inherit;
            font-weight: 600;
            font-size: 14.5px;
            letter-spacing: -0.2px;
            box-shadow: 0 8px 20px rgba(0, 113, 227, 0.3), inset 0 1px 1px rgba(255, 255, 255, 0.4);
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }
        button[type="submit"]:hover, .check-status-btn:hover {
            transform: translateY(-1.5px);
            box-shadow: 0 12px 24px rgba(0, 113, 227, 0.38), inset 0 1px 1px rgba(255, 255, 255, 0.5);
            background: linear-gradient(180deg, #0081fb 0%, #006edc 100%);
        }
        button[type="submit"]:active, .check-status-btn:active {
            transform: translateY(0.5px) scale(0.99);
        }
        button[type="submit"]:disabled {
            opacity: 0.7;
            cursor: not-allowed;
            transform: none;
        }

        .spinner {
            width: 16px;
            height: 16px;
            border: 2px solid rgba(255, 255, 255, 0.4);
            border-top-color: #fff;
            border-radius: 50%;
            animation: spin 0.6s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* Status Cards Glass Styling */
        .status-result-card {
            border: 1px solid rgba(255, 255, 255, 0.7);
            border-radius: var(--radius-lg);
            padding: 16px;
            margin-top: 14px;
            background: rgba(255, 255, 255, 0.6);
            backdrop-filter: blur(15px);
            box-shadow: 0 4px 16px rgba(0,0,0,0.03);
            transition: transform 0.2s ease;
        }
        .status-result-card:hover {
            transform: translateY(-2px);
            background: rgba(255, 255, 255, 0.75);
        }
        .status-result-top {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .status-result-number {
            font-weight: 700;
            font-size: 15px;
            color: var(--apple-blue);
            letter-spacing: -0.3px;
        }
        .status-result-title {
            font-size: 14px;
            color: var(--text-primary);
            font-weight: 600;
            margin-top: 6px;
        }
        .status-result-meta {
            font-size: 12px;
            color: var(--text-secondary);
            margin-top: 4px;
        }

        /* Glass Badges */
        .badge {
            padding: 4px 10px;
            border-radius: var(--radius-pill);
            font-size: 11px;
            font-weight: 600;
            display: inline-block;
            border: 1px solid transparent;
        }
        .status-open {
            background-color: rgba(0, 113, 227, 0.12);
            color: #0062c4;
            border-color: rgba(0, 113, 227, 0.2);
        }
        .status-resolved {
            background-color: rgba(52, 199, 89, 0.14);
            color: #248a3d;
            border-color: rgba(52, 199, 89, 0.25);
        }

        /* Toast Floating Notification */
        .toast {
            position: fixed;
            top: 24px;
            left: 50%;
            transform: translateX(-50%) translateY(-20px) scale(0.96);
            background: rgba(30, 30, 35, 0.85);
            backdrop-filter: blur(25px) saturate(180%);
            color: #ffffff;
            padding: 12px 24px;
            border-radius: var(--radius-pill);
            font-size: 13.5px;
            font-weight: 600;
            box-shadow: 0 16px 36px rgba(0, 0, 0, 0.2);
            z-index: 2000;
            opacity: 0;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            pointer-events: none;
            max-width: 90vw;
            text-align: center;
            border: 1px solid rgba(255, 255, 255, 0.15);
        }
        .toast.show {
            opacity: 1;
            transform: translateX(-50%) translateY(0) scale(1);
        }
        .toast.error {
            background: rgba(255, 59, 48, 0.9);
        }

        .page-footer {
            position: fixed;
            bottom: 12px;
            left: 0;
            width: 100%;
            text-align: center;
            font-size: 12px;
            color: var(--text-secondary);
            letter-spacing: -0.1px;
            z-index: 1;
        }
    </style>
</head>
<body>
    <div class="ambient-mesh">
        <div class="orb orb-1"></div>
        <div class="orb orb-2"></div>
        <div class="orb orb-3"></div>
    </div>

    <div id="formToast" class="toast"></div>

    <div class="ticket-card">
        <div class="ticket-ribbon">
            <div class="brand-group">
                <img src="/logo.png" alt="Company Logo" onerror="this.style.display='none'">
                <span class="ticket-ribbon-text">Sarathy IT <span class="portal-tag">Helpdesk</span></span>
            </div>
            <a href="/login" style="font-size: 12.5px; font-weight: 600; color: var(--apple-blue); text-decoration: none; padding: 5px 12px; border-radius: var(--radius-pill); background: rgba(0, 113, 227, 0.08); border: 1px solid rgba(0, 113, 227, 0.15); transition: all 0.2s;">Staff Portal &rarr;</a>
        </div>

        <div class="tab-switch">
            <button type="button" class="tab-btn active" id="tabSubmitBtn" onclick="showTab('submit')">Submit Ticket</button>
            <button type="button" class="tab-btn" id="tabStatusBtn" onclick="showTab('status')">Check Status</button>
        </div>

        <div class="ticket-body">
            <div id="submitPane">
                <div class="header-title-box">
                    <h2 class="form-title">Create Support Request</h2>
                    <div class="form-subtitle">Fill in the details below to route your ticket directly to IT specialists.</div>
                </div>

                <form id="ticketForm" enctype="multipart/form-data" class="form-grid">
                    <div class="form-field">
                        <label>Your Name</label>
                        <input type="text" id="submitterName" placeholder="e.g. Rahul Nair" required>
                    </div>
                    <div class="form-field">
                        <label>Designation</label>
                        <input type="text" id="submitterDesignation" placeholder="e.g. Sales Manager">
                    </div>
                    <div class="form-field">
                        <label>Mobile Number</label>
                        <input type="tel" id="mobile" placeholder="10-digit number" pattern="[0-9]{10}" maxlength="10" inputmode="numeric" oninput="this.value=this.value.replace(/[^0-9]/g,'').slice(0,10)" required>
                    </div>
                    <div class="form-field">
                        <label>Priority Level</label>
                        <select id="priority">
                            <option value="Low">Low</option>
                            <option value="Medium" selected>Medium</option>
                            <option value="High">High</option>
                        </select>
                    </div>

                    <div class="form-field full-width">
                        <label>Issue Title</label>
                        <input type="text" id="title" placeholder="Brief summary of the issue" required>
                    </div>

                    <div class="form-field">
                        <label>Region</label>
                        <select id="region" required onchange="updateBranchOptions()">
                            <option value="" disabled selected>Loading regions...</option>
                        </select>
                    </div>
                    <div class="form-field">
                        <label>Branch Location</label>
                        <select id="branch" required>
                            <option value="" disabled selected>Select region first</option>
                        </select>
                    </div>
                    <div class="form-field full-width" style="grid-column: span 2;">
                        <label>Category</label>
                        <select id="category" required>
                            <option value="" disabled selected>Select Category</option>
                            <option value="Hardware">Hardware</option>
                            <option value="Software">Software</option>
                            <option value="Network">Network</option>
                            <option value="Printer">Printer</option>
                            <option value="Other">Other</option>
                        </select>
                    </div>

                    <div class="form-field full-width">
                        <label>Issue Description</label>
                        <textarea id="description" placeholder="Describe the problem, error messages, or steps to reproduce..." required></textarea>
                    </div>

                    <div class="form-field full-width file-upload-wrapper">
                        <label>Upload Screenshot / Document (Optional, max 5MB)</label>
                        <input type="file" id="screenshot" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,.jpg,.jpeg,.png,.webp,.gif,.pdf">
                    </div>

                    <button type="submit" id="submitTicketBtn">Submit Ticket</button>
                </form>
            </div>

            <div id="statusPane" style="display:none;">
                <div class="header-title-box">
                    <h2 class="form-title">Check Ticket Status</h2>
                    <div class="form-subtitle">Enter the 10-digit mobile number associated with your ticket.</div>
                </div>
                
                <div class="form-field">
                    <label>Mobile Number</label>
                    <input type="tel" id="statusMobile" placeholder="Enter your 10-digit mobile number" pattern="[0-9]{10}" maxlength="10" inputmode="numeric" oninput="this.value=this.value.replace(/[^0-9]/g,'').slice(0,10)">
                </div>
                <button type="button" class="check-status-btn" onclick="checkTicketStatus()">Track Status</button>
                <div id="statusResults"></div>
            </div>
        </div>
    </div>

    <div class="page-footer">&copy; 2026 Sarathy Pvt Ltd &bull; Liquid Glass Helpdesk</div>

    <script>
    let allBranchesCache = [];
    let toastTimer = null;

    function showToast(message, isError) {
        const toast = document.getElementById('formToast');
        toast.textContent = message;
        toast.className = 'toast show' + (isError ? ' error' : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toast.classList.remove('show'); }, 4200);
    }

    async function loadFormBranches() {
        try {
            const res = await fetch('/public-branches');
            allBranchesCache = await res.json();
            const regionSelect = document.getElementById('region');
            const branchSelect = document.getElementById('branch');
            if (allBranchesCache.length === 0) {
                regionSelect.innerHTML = '<option value="">No branches configured</option>';
                branchSelect.innerHTML = '<option value="General">General / Headquarters</option>';
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
        submitBtn.innerHTML = '<span class="spinner"></span> Submitting Request...';
        
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
            showToast('Something went wrong submitting the ticket. Please check your connection.', true);
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
        if (!mobile) { showToast('Please enter your mobile number.', true); return; }
        const res = await fetch('/tickets/lookup?mobile=' + encodeURIComponent(mobile));
        const tickets = await res.json();
        renderStatusResults(tickets);
    }

    function renderStatusResults(tickets) {
        const container = document.getElementById('statusResults');
        if (tickets.length === 0) {
            container.innerHTML = '<p style="text-align:center;color:#86868b;padding:24px 0;font-size:13.5px;">No tickets found for that mobile number.</p>';
            return;
        }
        let html = '';
        tickets.forEach(t => {
            const statusClass = t.status === 'Resolved' ? 'status-resolved' : 'status-open';
            const resolvedLine = (t.status === 'Resolved' && t.resolvedAt)
                ? '<div class="status-result-meta">Resolved by ' + (t.assignedTo || 'staff') + ' on ' + new Date(t.resolvedAt).toLocaleString() + '</div>'
                : '<div class="status-result-meta">Assigned to: ' + (t.assignedTo || 'Unassigned') + '</div>';
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
    </script>
</body>
</html>`);
});

// -------------------------------------------------------------
// 2. LOGIN PAGE (APPLE LIQUID GLASS UI)
// -------------------------------------------------------------
app.get('/login', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Staff Login | SARATHY IT</title>
    <link rel="icon" type="image/png" href="/logo.png">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --glass-bg: rgba(255, 255, 255, 0.72);
            --glass-border: rgba(255, 255, 255, 0.85);
            --glass-shadow: 0 30px 80px rgba(0, 0, 0, 0.12), 0 10px 30px rgba(0, 0, 0, 0.06), inset 0 1px 1px rgba(255, 255, 255, 0.95);
            --apple-blue: #0071e3;
            --text-primary: #1d1d1f;
            --text-secondary: #86868b;
            --radius-xl: 26px;
            --radius-pill: 9999px;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Plus Jakarta Sans", "SF Pro Text", "SF Pro Display", "Helvetica Neue", sans-serif;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #f5f5f7 0%, #e2e2e9 100%);
            padding: 20px;
            position: relative;
            overflow: hidden;
        }

        .ambient-mesh {
            position: fixed;
            inset: 0;
            z-index: 0;
            overflow: hidden;
            pointer-events: none;
        }
        .orb {
            position: absolute;
            border-radius: 50%;
            filter: blur(90px);
            opacity: 0.6;
            animation: orbFloat 22s ease-in-out infinite alternate;
        }
        .orb-1 {
            width: 500px;
            height: 500px;
            background: radial-gradient(circle, #ff512f 0%, #dd2476 100%);
            top: -120px;
            right: -80px;
        }
        .orb-2 {
            width: 550px;
            height: 550px;
            background: radial-gradient(circle, #00c6ff 0%, #0072ff 100%);
            bottom: -150px;
            left: -100px;
            animation-duration: 26s;
        }
        @keyframes orbFloat {
            0% { transform: translate(0, 0) scale(1); }
            100% { transform: translate(30px, -40px) scale(1.06); }
        }

        .login-card {
            position: relative;
            z-index: 1;
            width: 100%;
            max-width: 400px;
            background: var(--glass-bg);
            backdrop-filter: blur(40px) saturate(190%);
            -webkit-backdrop-filter: blur(40px) saturate(190%);
            border: 1px solid var(--glass-border);
            border-radius: var(--radius-xl);
            box-shadow: var(--glass-shadow);
            padding: 36px 32px 38px;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .brand-header {
            text-align: center;
            margin-bottom: 28px;
        }
        .brand-logo-wrap {
            width: 64px;
            height: 64px;
            margin: 0 auto 14px;
            background: rgba(255, 255, 255, 0.85);
            border: 1px solid rgba(255, 255, 255, 0.9);
            border-radius: 18px;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 8px 20px rgba(0, 0, 0, 0.06);
        }
        .brand-logo-wrap img {
            width: 40px;
            height: auto;
            object-fit: contain;
        }
        .login-title {
            font-weight: 700;
            font-size: 24px;
            letter-spacing: -0.6px;
            color: var(--text-primary);
        }
        .login-sub {
            font-size: 13px;
            color: var(--text-secondary);
            margin-top: 4px;
        }

        label {
            display: block;
            margin-top: 18px;
            font-weight: 600;
            font-size: 12px;
            color: #48484a;
            letter-spacing: -0.1px;
        }
        input {
            width: 100%;
            padding: 12px 14px;
            margin-top: 6px;
            border: 1px solid rgba(0, 0, 0, 0.08);
            border-radius: 12px;
            font-size: 14px;
            font-family: inherit;
            background: rgba(255, 255, 255, 0.65);
            backdrop-filter: blur(10px);
            color: var(--text-primary);
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            outline: none;
        }
        input:focus {
            background: #ffffff;
            border-color: var(--apple-blue);
            box-shadow: 0 0 0 4px rgba(0, 113, 227, 0.15), 0 2px 8px rgba(0, 0, 0, 0.04);
        }
        
        .password-wrapper {
            position: relative;
        }
        .password-wrapper input {
            padding-right: 44px;
        }
        .toggle-password {
            position: absolute;
            right: 8px;
            top: calc(50% + 3px);
            transform: translateY(-50%);
            background: none;
            border: none;
            padding: 6px;
            cursor: pointer;
            color: #86868b;
            display: flex;
            align-items: center;
            border-radius: 8px;
        }
        .toggle-password:hover {
            color: var(--text-primary);
        }

        .caps-warning {
            display: none;
            margin-top: 6px;
            font-size: 11.5px;
            color: #ff9500;
            font-weight: 600;
        }
        .login-error {
            display: none;
            margin-top: 16px;
            padding: 11px 14px;
            background: rgba(255, 59, 48, 0.12);
            color: #d70015;
            border: 1px solid rgba(255, 59, 48, 0.25);
            border-radius: 12px;
            font-size: 13px;
            font-weight: 500;
            backdrop-filter: blur(10px);
        }

        button[type="submit"] {
            margin-top: 24px;
            padding: 13px;
            width: 100%;
            background: linear-gradient(180deg, #0077ed 0%, #0062c4 100%);
            color: #ffffff;
            border: 1px solid rgba(255, 255, 255, 0.3);
            border-radius: var(--radius-pill);
            cursor: pointer;
            font-family: inherit;
            font-weight: 600;
            font-size: 15px;
            letter-spacing: -0.2px;
            box-shadow: 0 8px 20px rgba(0, 113, 227, 0.32), inset 0 1px 1px rgba(255, 255, 255, 0.45);
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }
        button[type="submit"]:hover {
            transform: translateY(-1.5px);
            box-shadow: 0 12px 26px rgba(0, 113, 227, 0.4);
            background: linear-gradient(180deg, #0081fb 0%, #006edc 100%);
        }
        button[type="submit"]:active {
            transform: translateY(0.5px) scale(0.99);
        }

        .back-link {
            display: block;
            text-align: center;
            margin-top: 20px;
            font-size: 13px;
            font-weight: 500;
            color: var(--text-secondary);
            text-decoration: none;
            transition: color 0.2s;
        }
        .back-link:hover {
            color: var(--apple-blue);
        }

        .page-footer {
            position: fixed;
            bottom: 12px;
            left: 0;
            width: 100%;
            text-align: center;
            font-size: 12px;
            color: var(--text-secondary);
        }
    </style>
</head>
<body>
    <div class="ambient-mesh">
        <div class="orb orb-1"></div>
        <div class="orb orb-2"></div>
    </div>

    <div class="login-card">
        <div class="brand-header">
            <div class="brand-logo-wrap">
                <img src="/logo.png" alt="Sarathy Logo" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'32\\' height=\\'32\\' viewBox=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'%230071e3\\' stroke-width=\\'2\\'><path d=\\'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5\\'/></svg>'">
            </div>
            <h1 class="login-title">Sarathy Helpdesk</h1>
            <p class="login-sub">Sign in to manage and resolve support operations</p>
        </div>

        <form id="loginForm">
            <label>Username / Staff Name</label>
            <input type="text" id="username" placeholder="Enter username or staff ID" required autocomplete="username">

            <label>Password</label>
            <div class="password-wrapper">
                <input type="password" id="password" placeholder="Enter password" required autocomplete="current-password">
                <button type="button" class="toggle-password" id="togglePassword" aria-label="Show password">
                    <svg id="eyeIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                    </svg>
                </button>
            </div>

            <div class="caps-warning" id="capsWarning">Caps Lock is on</div>
            <div class="login-error" id="loginError"></div>

            <button type="submit" id="loginBtn">Sign In</button>
            <a href="/" class="back-link">&larr; Back to Ticket Submission</a>
        </form>
    </div>

    <div class="page-footer">&copy; 2026 Sarathy Pvt Ltd &bull; Liquid Glass</div>

    <script>
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
        loginBtn.innerHTML = '<span class="spinner" style="display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,0.4);border-top-color:#fff;border-radius:50%;animation:spin 0.6s linear infinite;margin-right:6px;"></span> Signing In...';
        
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
    </script>
</body>
</html>`);
});

// Authentication verify helper
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
        console.warn('WARNING: ADMIN_USERNAME/ADMIN_PASSWORD not set — using defaults.');
    }
    if (username === adminUser && password === adminPass) {
        req.session.isAdmin = true;
        req.session.isSuperAdmin = true;
        req.session.isStaff = false;
        req.session.region = null;
        req.session.username = 'Admin';
        return res.json({ success: true, redirect: '/admin' });
    }

    const regionAdmin = await RegionAdmin.findOne({ username: username.trim() });
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

    const allStaff = await Staff.find();
    const staffUser = allStaff.find(s => s.name.toLowerCase() === username.toLowerCase());
    if (staffUser && await verifyPassword(password, staffUser.password)) {
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

app.post('/change-password', checkUserLogin, async (req, res) => {
    try {
        if (req.session.isAdmin) {
            return res.status(400).json({ error: 'Admin password is set via the ADMIN_PASSWORD environment variable in your hosting dashboard.' });
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

// -------------------------------------------------------------
// 3. ADMIN / STAFF DASHBOARD (APPLE LIQUID GLASS UI)
// -------------------------------------------------------------
app.get('/admin', checkUserLogin, (req, res) => {
    const dynamicUsername = req.session.username || 'User';
    const dynamicIsAdmin = req.session.isAdmin ? 'true' : 'false';
    const dynamicIsSuperAdmin = req.session.isSuperAdmin ? 'true' : 'false';
    const isAdminUser = !!req.session.isAdmin;
    const isSuperAdminUser = !!req.session.isSuperAdmin;

    let html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>IT Helpdesk | Apple Liquid Glass Dashboard</title>
    <link rel="icon" type="image/png" href="/logo.png">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"></script>
    <style>
        :root {
            --bg-canvas: #f2f3f7;
            --glass-sidebar: rgba(255, 255, 255, 0.75);
            --glass-topbar: rgba(255, 255, 255, 0.68);
            --glass-card: rgba(255, 255, 255, 0.72);
            --glass-card-hover: rgba(255, 255, 255, 0.86);
            --glass-border: rgba(255, 255, 255, 0.8);
            --glass-subtle-border: rgba(0, 0, 0, 0.06);
            --glass-shadow: 0 12px 32px rgba(0, 0, 0, 0.05), 0 2px 6px rgba(0, 0, 0, 0.02), inset 0 1px 1px rgba(255, 255, 255, 0.85);
            --apple-blue: #0071e3;
            --apple-blue-rgb: 0, 113, 227;
            --apple-green: #34c759;
            --apple-orange: #ff9500;
            --apple-red: #ff3b30;
            --apple-purple: #af52de;
            --apple-teal: #5ac8fa;
            --text-primary: #1d1d1f;
            --text-secondary: #86868b;
            --radius-xl: 20px;
            --radius-lg: 14px;
            --radius-md: 10px;
            --radius-pill: 9999px;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }
        body {
            display: flex;
            height: 100vh;
            background: linear-gradient(135deg, #f5f6fa 0%, #e9eaf0 100%);
            color: var(--text-primary);
            font-family: -apple-system, BlinkMacSystemFont, "Plus Jakarta Sans", "SF Pro Text", "SF Pro Display", "Helvetica Neue", sans-serif;
            overflow: hidden;
            position: relative;
        }

        /* Ambient Glass Backdrop Mesh */
        .ambient-mesh {
            position: fixed;
            inset: 0;
            z-index: 0;
            overflow: hidden;
            pointer-events: none;
        }
        .orb {
            position: absolute;
            border-radius: 50%;
            filter: blur(95px);
            opacity: 0.45;
            animation: orbFloat 22s ease-in-out infinite alternate;
        }
        .orb-1 { width: 550px; height: 550px; background: radial-gradient(circle, #70a6ff 0%, #91e6ff 100%); top: -150px; left: -100px; }
        .orb-2 { width: 600px; height: 600px; background: radial-gradient(circle, #ffb199 0%, #ff0844 100%); bottom: -200px; right: -150px; }
        .orb-3 { width: 450px; height: 450px; background: radial-gradient(circle, #c471ed 0%, #f64f59 100%); top: 30%; left: 35%; opacity: 0.25; }

        @keyframes orbFloat {
            0% { transform: translate(0, 0) scale(1); }
            100% { transform: translate(35px, 25px) scale(1.05); }
        }

        /* Responsive Mobile Drawer */
        .hamburger-btn {
            display: none;
            background: rgba(255, 255, 255, 0.6);
            border: 1px solid var(--glass-border);
            cursor: pointer;
            padding: 8px;
            border-radius: var(--radius-md);
            flex-direction: column;
            gap: 4px;
            backdrop-filter: blur(10px);
        }
        .hamburger-btn span {
            display: block;
            width: 20px;
            height: 2px;
            background: var(--text-primary);
            border-radius: 2px;
        }
        .sidebar-backdrop {
            display: none;
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.3);
            backdrop-filter: blur(5px);
            z-index: 998;
        }
        .sidebar-backdrop.active { display: block; }

        @media (max-width: 860px) {
            .sidebar {
                position: fixed;
                top: 0; bottom: 0; left: -290px;
                z-index: 999;
                transition: left 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                width: 275px;
            }
            .sidebar.sidebar-open { left: 0; }
            .hamburger-btn { display: flex; }
            .top-navbar { padding: 0 18px; }
            .content-body { padding: 18px; }
            .metrics-grid { gap: 12px; }
            .ticket-header { flex-direction: column; align-items: flex-start; gap: 10px; }
        }

        /* Apple Liquid Glass Sidebar */
        .sidebar {
            width: 270px;
            height: 100vh;
            background: var(--glass-sidebar);
            backdrop-filter: blur(35px) saturate(190%);
            -webkit-backdrop-filter: blur(35px) saturate(190%);
            border-right: 1px solid var(--glass-border);
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            overflow: hidden;
            z-index: 10;
            box-shadow: 4px 0 24px rgba(0,0,0,0.03);
        }
        .sidebar-scroll {
            flex: 1 1 auto;
            min-height: 0;
            overflow-y: auto;
        }
        .sidebar-brand {
            padding: 24px 22px 20px;
            display: flex;
            align-items: center;
            gap: 12px;
            border-bottom: 1px solid rgba(0, 0, 0, 0.05);
        }
        .sidebar-logo {
            height: 34px;
            width: auto;
            object-fit: contain;
        }
        .sidebar-title {
            font-size: 16px;
            font-weight: 700;
            color: var(--text-primary);
            letter-spacing: -0.3px;
        }
        .sidebar-menu {
            list-style: none;
            padding: 14px 12px;
        }
        .menu-category {
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            color: var(--text-secondary);
            padding: 10px 14px 6px;
            letter-spacing: 0.5px;
        }
        .menu-item {
            padding: 10px 14px;
            display: flex;
            align-items: center;
            gap: 12px;
            color: #48484a;
            text-decoration: none;
            font-size: 13.5px;
            font-weight: 500;
            cursor: pointer;
            border-radius: var(--radius-md);
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            margin-bottom: 3px;
        }
        .menu-icon {
            width: 18px;
            height: 18px;
            flex-shrink: 0;
            color: #86868b;
            transition: color 0.2s;
        }
        .menu-item:hover {
            background: rgba(255, 255, 255, 0.65);
            color: var(--text-primary);
        }
        .menu-item.active {
            background: rgba(0, 113, 227, 0.12);
            color: var(--apple-blue);
            font-weight: 600;
        }
        .menu-item.active .menu-icon {
            color: var(--apple-blue);
        }

        .sidebar-footer {
            padding: 18px 20px;
            border-top: 1px solid rgba(0, 0, 0, 0.05);
            background: rgba(255, 255, 255, 0.4);
            flex-shrink: 0;
        }
        .user-info {
            font-size: 11.5px;
            color: var(--text-secondary);
            margin-bottom: 12px;
        }
        .user-info strong {
            color: var(--text-primary);
            display: block;
            font-size: 14px;
            margin-bottom: 2px;
            font-weight: 700;
        }
        .logout-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            width: 100%;
            background: rgba(255, 59, 48, 0.1);
            color: var(--apple-red);
            border: 1px solid rgba(255, 59, 48, 0.2);
            text-decoration: none;
            padding: 9px;
            border-radius: var(--radius-pill);
            font-size: 13px;
            font-weight: 600;
            transition: all 0.2s;
        }
        .logout-btn:hover {
            background: rgba(255, 59, 48, 0.18);
            transform: translateY(-1px);
        }

        /* Liquid Glass Main Content */
        .main-content {
            flex-grow: 1;
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow-y: auto;
            position: relative;
            z-index: 1;
        }
        .top-navbar {
            height: 68px;
            background: var(--glass-topbar);
            backdrop-filter: blur(28px) saturate(180%);
            -webkit-backdrop-filter: blur(28px) saturate(180%);
            border-bottom: 1px solid var(--glass-border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 32px;
            position: sticky;
            top: 0;
            z-index: 100;
        }
        .page-title {
            font-size: 19px;
            font-weight: 700;
            letter-spacing: -0.4px;
            color: var(--text-primary);
        }
        .notification-wrap { position: relative; }
        .notification-btn {
            position: relative;
            width: 38px;
            height: 38px;
            border: 1px solid var(--glass-border);
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.8);
            color: var(--text-primary);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
            transition: all 0.2s;
        }
        .notification-btn:hover {
            background: #ffffff;
            transform: scale(1.05);
        }
        .notification-btn svg { width: 18px; height: 18px; }
        .notification-count {
            position: absolute;
            top: -3px; right: -3px;
            min-width: 17px; height: 17px;
            padding: 0 4px;
            border-radius: var(--radius-pill);
            background: var(--apple-red);
            color: #fff;
            font-size: 10px;
            font-weight: 700;
            display: none;
            align-items: center;
            justify-content: center;
            box-shadow: 0 2px 6px rgba(255, 59, 48, 0.4);
        }
        .notification-menu {
            display: none;
            position: absolute;
            top: 48px; right: 0;
            width: 340px;
            max-height: 380px;
            overflow-y: auto;
            background: rgba(255, 255, 255, 0.9);
            backdrop-filter: blur(35px);
            border: 1px solid var(--glass-border);
            border-radius: var(--radius-lg);
            box-shadow: 0 20px 48px rgba(0, 0, 0, 0.15);
            z-index: 3000;
        }
        .notification-menu.show { display: block; }
        .notification-head {
            padding: 14px 16px;
            font-size: 13.5px;
            font-weight: 700;
            border-bottom: 1px solid rgba(0, 0, 0, 0.06);
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .notification-item {
            padding: 12px 16px;
            border-bottom: 1px solid rgba(0, 0, 0, 0.04);
            font-size: 12.5px;
            color: #48484a;
        }
        .notification-item.unread {
            background: rgba(0, 113, 227, 0.06);
        }
        .notification-item strong {
            display: block;
            color: var(--text-primary);
            margin-bottom: 2px;
        }
        .notification-empty {
            padding: 24px;
            text-align: center;
            color: var(--text-secondary);
            font-size: 13px;
        }

        .content-body {
            padding: 28px 32px;
            max-width: 1240px;
            width: 100%;
            margin: 0 auto;
        }
        .dashboard-view { display: none; }
        .dashboard-view.active { display: block; }

        /* Liquid Glass Metric Cards */
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 16px;
            margin-bottom: 22px;
        }
        .metric-card {
            background: var(--glass-card);
            backdrop-filter: blur(28px) saturate(180%);
            -webkit-backdrop-filter: blur(28px) saturate(180%);
            border-radius: var(--radius-lg);
            padding: 16px 18px;
            box-shadow: var(--glass-shadow);
            border: 1px solid var(--glass-border);
            cursor: pointer;
            transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
            position: relative;
            overflow: hidden;
        }
        .metric-card:hover {
            background: var(--glass-card-hover);
            transform: translateY(-3px);
            box-shadow: 0 16px 36px rgba(0, 0, 0, 0.08), inset 0 1px 1px rgba(255, 255, 255, 0.95);
        }
        .metric-icon-badge {
            width: 36px;
            height: 36px;
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 10px;
            box-shadow: 0 4px 10px rgba(0, 0, 0, 0.04);
        }
        .metric-icon-badge svg { width: 18px; height: 18px; }
        .metric-icon-blue { background: rgba(0, 113, 227, 0.14); color: var(--apple-blue); }
        .metric-icon-green { background: rgba(52, 199, 89, 0.15); color: var(--apple-green); }
        .metric-icon-amber { background: rgba(255, 149, 0, 0.15); color: var(--apple-orange); }
        .metric-icon-red { background: rgba(255, 59, 48, 0.14); color: var(--apple-red); }

        .metric-label {
            font-size: 11.5px;
            font-weight: 600;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.4px;
        }
        .metric-value {
            font-size: 24px;
            font-weight: 800;
            color: var(--text-primary);
            margin-top: 2px;
            letter-spacing: -0.5px;
        }
        .metric-subtitle {
            font-size: 11px;
            color: var(--text-secondary);
            margin-top: 4px;
            font-weight: 500;
        }

        /* Liquid Glass Ticket Items */
        .ticket-card {
            background: var(--glass-card);
            backdrop-filter: blur(28px) saturate(180%);
            -webkit-backdrop-filter: blur(28px) saturate(180%);
            border: 1px solid var(--glass-border);
            border-radius: var(--radius-lg);
            padding: 22px;
            margin-bottom: 18px;
            box-shadow: var(--glass-shadow);
            position: relative;
            transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .ticket-card:hover {
            box-shadow: 0 16px 36px rgba(0, 0, 0, 0.07);
        }
        .ticket-card.ticket-resolved {
            border-left: 4px solid var(--apple-green);
        }
        .ticket-card.ticket-escalated {
            border-left: 4px solid var(--apple-orange);
            background: rgba(255, 248, 235, 0.75);
        }
        .ticket-card.ticket-high-priority {
            border-left: 4px solid var(--apple-red);
            background: rgba(255, 242, 242, 0.75);
        }
        .ticket-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 12px;
        }
        .ticket-title {
            font-size: 16.5px;
            font-weight: 700;
            color: var(--text-primary);
            letter-spacing: -0.3px;
        }
        .ticket-desc {
            color: #48484a;
            font-size: 13.5px;
            line-height: 1.5;
            margin-bottom: 16px;
        }

        /* Apple Glass Badges */
        .badge {
            padding: 3px 9px;
            border-radius: var(--radius-pill);
            font-size: 11px;
            font-weight: 600;
            display: inline-block;
            margin-right: 6px;
            border: 1px solid transparent;
        }
        .p-Low { background: rgba(142, 142, 147, 0.12); color: #636366; }
        .p-Medium { background: rgba(255, 149, 0, 0.14); color: #c97500; }
        .p-High { background: rgba(255, 59, 48, 0.14); color: #d70015; }
        .status-open { background: rgba(0, 113, 227, 0.12); color: #0062c4; }
        .status-resolved { background: rgba(52, 199, 89, 0.14); color: #248a3d; }
        .badge-escalated { background: rgba(255, 149, 0, 0.16); color: #b25000; }
        .badge-category { background: rgba(90, 200, 250, 0.16); color: #0077a6; }

        /* Action Buttons */
        .ticket-actions {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-shrink: 0;
        }
        .resolve-btn {
            background: linear-gradient(180deg, #34c759 0%, #28a745 100%);
            color: white;
            border: 1px solid rgba(255, 255, 255, 0.3);
            padding: 7px 15px;
            font-size: 12.5px;
            font-weight: 600;
            border-radius: var(--radius-pill);
            cursor: pointer;
            box-shadow: 0 4px 12px rgba(52, 199, 89, 0.25);
            transition: all 0.2s;
        }
        .resolve-btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 6px 16px rgba(52, 199, 89, 0.35);
        }
        .reallocate-btn {
            background: linear-gradient(180deg, #af52de 0%, #9333ea 100%);
            color: white;
            border: 1px solid rgba(255, 255, 255, 0.3);
            padding: 7px 15px;
            font-size: 12.5px;
            font-weight: 600;
            border-radius: var(--radius-pill);
            cursor: pointer;
            box-shadow: 0 4px 12px rgba(175, 82, 222, 0.25);
            transition: all 0.2s;
        }
        .escalate-btn {
            background: linear-gradient(180deg, #ff9500 0%, #ea580c 100%);
            color: white;
            border: 1px solid rgba(255, 255, 255, 0.3);
            padding: 7px 15px;
            font-size: 12.5px;
            font-weight: 600;
            border-radius: var(--radius-pill);
            cursor: pointer;
            box-shadow: 0 4px 12px rgba(255, 149, 0, 0.25);
            transition: all 0.2s;
        }

        .screenshot-preview {
            max-width: 100%;
            max-height: 180px;
            border-radius: 10px;
            border: 1px solid var(--glass-border);
            margin-top: 10px;
            display: block;
            object-fit: cover;
            box-shadow: 0 4px 12px rgba(0,0,0,0.06);
        }
        .assignment-info {
            margin-top: 14px;
            padding: 12px 14px;
            background: rgba(255, 255, 255, 0.5);
            border-radius: var(--radius-md);
            border: 1px solid rgba(0, 0, 0, 0.04);
        }
        .assignment-row {
            display: flex;
            gap: 10px;
            padding: 4px 0;
            font-size: 13px;
        }
        .assignment-label {
            flex: 0 0 110px;
            font-weight: 600;
            color: var(--text-secondary);
            font-size: 11.5px;
            text-transform: uppercase;
        }
        .assignment-value { color: var(--text-primary); flex: 1; }

        /* Comments / Work Notes Section */
        .comments-section {
            margin-top: 16px;
            background: rgba(255, 255, 255, 0.45);
            padding: 14px;
            border-radius: var(--radius-md);
            border: 1px solid rgba(0, 0, 0, 0.04);
        }
        .comments-header {
            font-size: 11px;
            font-weight: 700;
            color: var(--text-secondary);
            text-transform: uppercase;
            margin-bottom: 8px;
            letter-spacing: 0.4px;
        }
        .comment-item {
            padding: 7px 0;
            border-bottom: 1px solid rgba(0, 0, 0, 0.04);
            font-size: 12.5px;
            color: #48484a;
        }
        .comment-item strong { color: var(--text-primary); }
        .comment-form {
            display: flex;
            gap: 8px;
            margin-top: 10px;
            flex-wrap: wrap;
            align-items: center;
        }
        .comment-form input {
            flex-grow: 1;
            padding: 8px 12px;
            border: 1px solid rgba(0, 0, 0, 0.08);
            border-radius: var(--radius-pill);
            font-size: 12.5px;
            background: rgba(255, 255, 255, 0.8);
            outline: none;
        }
        .comment-form button {
            background: var(--apple-blue);
            color: white;
            border: none;
            padding: 8px 16px;
            font-size: 12.5px;
            font-weight: 600;
            border-radius: var(--radius-pill);
            cursor: pointer;
            box-shadow: 0 4px 10px rgba(0, 113, 227, 0.25);
        }
        .comment-attach-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 6px 10px;
            border: 1px solid rgba(0, 0, 0, 0.08);
            border-radius: var(--radius-pill);
            background: rgba(255, 255, 255, 0.8);
            cursor: pointer;
            font-size: 13px;
        }
        .attachment-name-tag { font-size: 11px; color: var(--text-secondary); }

        /* Panels & Tables */
        .branch-panel-card {
            background: var(--glass-card);
            backdrop-filter: blur(28px) saturate(180%);
            -webkit-backdrop-filter: blur(28px) saturate(180%);
            border: 1px solid var(--glass-border);
            border-radius: var(--radius-lg);
            padding: 22px;
            box-shadow: var(--glass-shadow);
            margin-bottom: 20px;
        }
        .branch-panel-card h2 {
            font-size: 16px;
            font-weight: 700;
            color: var(--text-primary);
            letter-spacing: -0.3px;
            margin-bottom: 16px;
        }
        .branch-input-group {
            display: flex;
            gap: 10px;
            margin-bottom: 18px;
            flex-wrap: wrap;
        }
        .branch-input-group input, .branch-input-group select {
            flex-grow: 1;
            padding: 10px 14px;
            border: 1px solid rgba(0, 0, 0, 0.08);
            border-radius: var(--radius-md);
            font-size: 13.5px;
            background: rgba(255, 255, 255, 0.7);
            outline: none;
        }
        .branch-add-btn {
            background: linear-gradient(180deg, #0077ed 0%, #0062c4 100%);
            color: white;
            border: 1px solid rgba(255, 255, 255, 0.25);
            padding: 10px 22px;
            font-size: 13px;
            font-weight: 600;
            border-radius: var(--radius-pill);
            cursor: pointer;
            box-shadow: 0 4px 14px rgba(0, 113, 227, 0.3);
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            transition: all 0.2s;
        }
        .branch-add-btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 6px 18px rgba(0, 113, 227, 0.38);
        }
        .branch-delete-btn {
            color: var(--apple-red);
            background: none;
            border: none;
            cursor: pointer;
            font-weight: 600;
            font-size: 12.5px;
        }

        .branch-table {
            width: 100%;
            border-collapse: collapse;
            text-align: left;
            margin-top: 10px;
        }
        .branch-table th {
            background: rgba(255, 255, 255, 0.5);
            color: var(--text-secondary);
            font-size: 11.5px;
            font-weight: 700;
            text-transform: uppercase;
            padding: 12px 14px;
            border-bottom: 1px solid rgba(0, 0, 0, 0.06);
            letter-spacing: 0.3px;
        }
        .branch-table td {
            padding: 12px 14px;
            font-size: 13px;
            color: var(--text-primary);
            border-bottom: 1px solid rgba(0, 0, 0, 0.04);
        }

        /* Charts */
        .chart-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
            gap: 18px;
            margin-top: 20px;
        }
        .chart-card {
            background: var(--glass-card);
            backdrop-filter: blur(28px) saturate(180%);
            border: 1px solid var(--glass-border);
            border-radius: var(--radius-lg);
            padding: 20px;
            box-shadow: var(--glass-shadow);
            position: relative;
            height: 300px;
        }
        .chart-card.wide { grid-column: 1 / -1; }
        .chart-card h3 {
            font-size: 14px;
            font-weight: 700;
            color: var(--text-primary);
            margin-bottom: 12px;
        }

        /* Modals & Dialogs */
        .confirm-overlay {
            display: none;
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.35);
            backdrop-filter: blur(8px);
            z-index: 3000;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .confirm-overlay.show { display: flex; }
        .confirm-box {
            background: rgba(255, 255, 255, 0.88);
            backdrop-filter: blur(40px) saturate(190%);
            border: 1px solid var(--glass-border);
            border-radius: var(--radius-xl);
            padding: 26px;
            max-width: 400px;
            width: 100%;
            box-shadow: 0 24px 60px rgba(0, 0, 0, 0.2);
        }
        .confirm-box p {
            font-size: 14px;
            color: var(--text-primary);
            line-height: 1.5;
            margin-bottom: 18px;
            font-weight: 500;
        }
        .confirm-actions {
            display: flex;
            gap: 10px;
            justify-content: flex-end;
        }
        .confirm-actions button {
            padding: 9px 18px;
            border-radius: var(--radius-pill);
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            border: none;
        }
        .confirm-cancel-btn {
            background: rgba(0, 0, 0, 0.06);
            color: #48484a;
        }
        .confirm-ok-btn {
            background: var(--apple-blue);
            color: #fff;
            box-shadow: 0 4px 12px rgba(0, 113, 227, 0.3);
        }

        /* Glass Toasts */
        .admin-toast {
            position: fixed;
            top: 20px; right: 20px;
            background: rgba(255, 255, 255, 0.88);
            backdrop-filter: blur(35px) saturate(180%);
            color: var(--text-primary);
            padding: 14px 18px;
            border-radius: var(--radius-lg);
            font-size: 13px;
            box-shadow: 0 16px 40px rgba(0, 0, 0, 0.12);
            z-index: 4000;
            opacity: 0;
            transform: translateX(24px);
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            pointer-events: none;
            max-width: 350px;
            border: 1px solid var(--glass-border);
            border-left: 4px solid var(--apple-green);
            display: flex;
            align-items: flex-start;
            gap: 10px;
        }
        .admin-toast.show { opacity: 1; transform: translateX(0); }
        .admin-toast.error { border-left-color: var(--apple-red); }

        .pagination-bar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 12px;
            padding: 16px 4px 4px;
        }
        .page-btn {
            min-width: 32px;
            height: 32px;
            padding: 0 10px;
            border: 1px solid rgba(0, 0, 0, 0.08);
            background: rgba(255, 255, 255, 0.8);
            color: #48484a;
            border-radius: var(--radius-pill);
            font-size: 12.5px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
        }
        .page-btn.active {
            background: var(--apple-blue);
            border-color: var(--apple-blue);
            color: #fff;
            box-shadow: 0 2px 8px rgba(0, 113, 227, 0.3);
        }
    </style>
</head>
<body>
    <div class="ambient-mesh">
        <div class="orb orb-1"></div>
        <div class="orb orb-2"></div>
        <div class="orb orb-3"></div>
    </div>

    <div class="confirm-overlay" id="confirmOverlay">
        <div class="confirm-box">
            <p id="confirmMessage"></p>
            <input type="text" id="confirmInput" style="display:none;width:100%;padding:10px;border:1px solid rgba(0,0,0,0.1);border-radius:10px;font-size:14px;margin-bottom:16px;background:rgba(255,255,255,0.9);">
            <select id="confirmStaffSelect" style="display:none;width:100%;padding:10px;border:1px solid rgba(0,0,0,0.1);border-radius:10px;font-size:14px;margin-bottom:16px;background:rgba(255,255,255,0.9);"></select>
            <div class="confirm-actions">
                <button class="confirm-cancel-btn" onclick="closeConfirmModal(false)">Cancel</button>
                <button class="confirm-ok-btn" id="confirmOkBtn" onclick="closeConfirmModal(true)">Confirm</button>
            </div>
        </div>
    </div>

    <div id="adminToast" class="admin-toast"></div>
    <div class="sidebar-backdrop" id="sidebarBackdrop" onclick="closeSidebar()"></div>

    <aside class="sidebar" id="sidebar">
        <div class="sidebar-scroll">
            <div class="sidebar-brand" style="cursor:pointer;" onclick="window.location.href='/admin'" title="Refresh dashboard">
                <img src="/logo.png" alt="Logo" class="sidebar-logo" onerror="this.style.display='none'">
                <span class="sidebar-title">SARATHY IT</span>
            </div>
            <div class="menu-category">Navigation</div>
            <ul class="sidebar-menu">
                <li class="menu-item active" id="tabTicketsLink" onclick="refreshTicketsDashboard()">
                    <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v2z"></path><line x1="13" y1="5" x2="13" y2="19"></line></svg>
                    Tickets System
                </li>
                ${isSuperAdminUser ? `
                <li class="menu-item" id="tabAdminsLink" onclick="switchView('admins')">
                    <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3 6 6.5 1-5 4.5 1.5 6.5-6-3.5-6 3.5 1.5-6.5-5-4.5 6.5-1z"></path></svg>
                    Manage Admins
                </li>` : ''}
                ${isAdminUser ? `
                <li class="menu-item" id="tabBranchesLink" onclick="switchView('branches')">
                    <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
                    Manage Branches
                </li>
                <li class="menu-item" id="tabStaffLink" onclick="switchView('staff')">
                    <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
                    Manage IT Staff
                </li>
                <li class="menu-item" id="tabAuditLink" onclick="switchView('audit')">
                    <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>
                    Audit Log
                </li>` : ''}
                <li class="menu-item" id="tabReportsLink" onclick="switchView('reports')">
                    <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>
                    Reports
                </li>
                <li class="menu-item" id="tabInboxLink" onclick="switchView('inbox')">
                    <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"></path><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path></svg>
                    Inbox
                    <span id="inboxUnreadBadge" style="display:none;margin-left:auto;background:var(--apple-red);color:#fff;font-size:10px;font-weight:700;border-radius:10px;min-width:16px;height:16px;padding:0 5px;align-items:center;justify-content:center;"></span>
                </li>
                <li class="menu-item" id="tabPasswordLink" onclick="switchView('password')">
                    <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
                    Change Password
                </li>
            </ul>
        </div>
        <div class="sidebar-footer">
            <div class="user-info">
                <span>Logged in as</span>
                <strong id="displayUserLabel">${dynamicUsername}</strong>
            </div>
            <a href="/logout" class="logout-btn" id="logoutBtn">Log Out</a>
        </div>
    </aside>

    <main class="main-content">
        <header class="top-navbar">
            <button class="hamburger-btn" onclick="toggleSidebar()" aria-label="Menu"><span></span><span></span><span></span></button>
            <h1 class="page-title" id="panelViewTitle">Helpdesk Operations</h1>
            <div class="notification-wrap">
                <button type="button" class="notification-btn" onclick="toggleNotifications(event)" aria-label="Notifications">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>
                    <span id="notificationCount" class="notification-count">0</span>
                </button>
                <div id="notificationMenu" class="notification-menu">
                    <div class="notification-head">
                        Notifications
                        <button type="button" onclick="clearAllNotifications()" style="background:none;border:none;color:var(--apple-red);font-size:12px;font-weight:600;cursor:pointer;">Clear</button>
                    </div>
                    <div id="notificationList" class="notification-empty">No notifications.</div>
                </div>
            </div>
        </header>

        <section class="content-body">
            <!-- 1. TICKETS VIEW -->
            <div id="viewTickets" class="dashboard-view active">
                <div class="metrics-grid">
                    <div class="metric-card" onclick="filterByStatus('Open')">
                        <div class="metric-icon-badge metric-icon-blue">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                        </div>
                        <div class="metric-label">Open Issues</div>
                        <div class="metric-value" id="statOpen">0</div>
                        <div class="metric-subtitle">Needs attention</div>
                    </div>
                    <div class="metric-card" onclick="filterByStatus('Resolved')">
                        <div class="metric-icon-badge metric-icon-green">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                        </div>
                        <div class="metric-label">Resolved Issues</div>
                        <div class="metric-value" id="statResolved">0</div>
                        <div class="metric-subtitle">Completed successfully</div>
                    </div>
                    <div class="metric-card" onclick="filterByStatus('Escalated')">
                        <div class="metric-icon-badge metric-icon-amber">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                        </div>
                        <div class="metric-label">Escalated Tickets</div>
                        <div class="metric-value" id="statEscalated">0</div>
                        <div class="metric-subtitle">Needs admin action</div>
                    </div>
                    <div class="metric-card" onclick="filterByStatus('all')">
                        <div class="metric-icon-badge metric-icon-red">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v2z"></path><line x1="13" y1="5" x2="13" y2="19"></line></svg>
                        </div>
                        <div class="metric-label">Total Tickets</div>
                        <div class="metric-value" id="statMine">0</div>
                        <div class="metric-subtitle">All requests in scope</div>
                    </div>
                </div>

                <div style="margin-bottom: 14px;">
                    <button type="button" id="toggleFilterBtn" class="branch-add-btn" onclick="toggleFilterPanel()" style="padding: 8px 18px;">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>
                        Filter Queue
                    </button>
                </div>

                <div class="branch-panel-card" id="ticketFilterPanel" style="display:none; margin-bottom: 20px; align-items: flex-end; gap: 12px; flex-wrap: wrap;">
                    <div style="flex-grow: 1; min-width: 220px;">
                        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">Search</label>
                        <input type="text" id="filterSearchText" placeholder="Ticket #, Name, Branch, Mobile..." style="width:100%; padding: 8px 12px; border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; font-size: 13.5px;" onkeydown="if(event.key==='Enter') applyTicketFilters();">
                    </div>
                    <div>
                        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">From Date</label>
                        <input type="date" id="filterFromDate" style="padding: 8px 12px; border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; font-size: 13px;">
                    </div>
                    <div>
                        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">To Date</label>
                        <input type="date" id="filterToDate" style="padding: 8px 12px; border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; font-size: 13px;">
                    </div>
                    <div id="staffFilterWrapper" style="display:none;">
                        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">Staff</label>
                        <select id="filterStaff" style="padding: 8px 12px; border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; font-size: 13px;"><option value="">All Staff</option></select>
                    </div>
                    <div id="regionFilterWrapper" style="display:none;">
                        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">Region</label>
                        <select id="filterRegion" style="padding: 8px 12px; border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; font-size: 13px;"><option value="">All Regions</option></select>
                    </div>
                    <div>
                        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">Category</label>
                        <select id="filterCategory" style="padding: 8px 12px; border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; font-size: 13px;">
                            <option value="">All Categories</option>
                            <option value="Hardware">Hardware</option>
                            <option value="Software">Software</option>
                            <option value="Network">Network</option>
                            <option value="Printer">Printer</option>
                            <option value="Other">Other</option>
                        </select>
                    </div>
                    <button class="branch-add-btn" id="searchTicketsBtn" onclick="applyTicketFilters()">Apply</button>
                    <button class="branch-delete-btn" onclick="clearTicketFilters()" style="padding: 8px 12px;">Reset</button>
                </div>

                <div id="ticketList">Loading active queue...</div>
                <div id="ticketPagination" class="pagination-bar" style="display:none;"></div>
            </div>

            <!-- 2. REPORTS VIEW -->
            <div id="viewReports" class="dashboard-view">
                <div class="branch-panel-card" style="display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 20px;">
                    <strong style="font-size: 14px; color: var(--text-primary);">Region Scope:</strong>
                    <select id="reportRegion" style="padding: 8px 12px; border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; font-size: 13.5px;"><option value="">All Regions</option></select>
                </div>
                <div class="branch-panel-card" style="display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 20px;">
                    <strong style="font-size: 14px; color: var(--text-primary);">Monthly Excel:</strong>
                    <input type="month" id="reportMonth" style="padding: 8px 12px; border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; font-size: 13.5px;">
                    <button class="branch-add-btn" onclick="downloadReport()">Export Month (.xlsx)</button>
                </div>
                <div class="branch-panel-card" style="display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap;">
                    <div><strong style="font-size: 14px; color: var(--text-primary); display:block; margin-bottom: 6px;">Date Range Export:</strong></div>
                    <div><label style="display:block;font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:3px;">From</label><input type="date" id="reportFromDate" style="padding: 8px 12px; border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; font-size: 13px;"></div>
                    <div><label style="display:block;font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:3px;">To</label><input type="date" id="reportToDate" style="padding: 8px 12px; border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; font-size: 13px;"></div>
                    <button class="branch-add-btn" onclick="downloadReportByRange()">Export Custom Range</button>
                </div>
                <div class="chart-grid">
                    <div class="chart-card"><h3>Status Breakdown</h3><canvas id="chartStatus"></canvas></div>
                    <div class="chart-card"><h3>Priority Distribution</h3><canvas id="chartPriority"></canvas></div>
                    <div class="chart-card"><h3>Category Breakdown</h3><canvas id="chartCategory"></canvas></div>
                    <div class="chart-card wide"><h3>30-Day Support Demand Trend</h3><canvas id="chartTrend"></canvas></div>
                    ${isAdminUser ? `
                    <div class="chart-card"><h3>Workload by IT Staff</h3><canvas id="chartStaff"></canvas></div>
                    <div class="chart-card"><h3>Tickets by Branch</h3><canvas id="chartBranch"></canvas></div>` : ''}
                </div>
            </div>

            <!-- 3. CHANGE PASSWORD VIEW -->
            <div id="viewChangePassword" class="dashboard-view">
                <div class="branch-panel-card">
                    <h2>Change Account Password</h2>
                    ${isAdminUser ? `
                    <p style="color:var(--text-secondary);font-size:14px;line-height:1.6;max-width:520px;">Admin password is configured via the <code>ADMIN_PASSWORD</code> environment variable in your hosting platform (Render/Docker). Update it there and redeploy.</p>` : `
                    <div style="max-width:380px;">
                        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-top:14px;margin-bottom:4px;">Current Password</label>
                        <input type="password" id="currentPassword" style="width:100%;padding:10px;border:1px solid rgba(0,0,0,0.1);border-radius:8px;font-size:14px;">
                        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-top:14px;margin-bottom:4px;">New Password</label>
                        <input type="password" id="newPassword" style="width:100%;padding:10px;border:1px solid rgba(0,0,0,0.1);border-radius:8px;font-size:14px;">
                        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-top:14px;margin-bottom:4px;">Confirm New Password</label>
                        <input type="password" id="confirmPassword" style="width:100%;padding:10px;border:1px solid rgba(0,0,0,0.1);border-radius:8px;font-size:14px;">
                        <button class="branch-add-btn" onclick="changePassword()" style="margin-top:18px;">Update Password</button>
                    </div>`}
                </div>
            </div>

            ${isSuperAdminUser ? `
            <!-- 4. MANAGE ADMINS VIEW -->
            <div id="viewAdmins" class="dashboard-view">
                <div class="branch-panel-card">
                    <h2>Create Region Administrator</h2>
                    <div class="branch-input-group">
                        <input type="text" id="newAdminName" placeholder="Full Name">
                        <input type="text" id="newAdminUsername" placeholder="Username">
                        <input type="text" id="newAdminPassword" placeholder="Password">
                        <select id="newAdminRegion"><option value="" disabled selected>Select Region</option></select>
                        <button class="branch-add-btn" id="addAdminBtn" onclick="addNewRegionAdmin()">Add Admin</button>
                    </div>
                </div>
                <div class="branch-panel-card">
                    <h2>Region Administrators</h2>
                    <table class="branch-table">
                        <thead><tr><th>Name</th><th>Username</th><th>Region</th><th>Status</th><th>Edit</th><th>Delete</th></tr></thead>
                        <tbody id="regionAdminsTableBody"></tbody>
                    </table>
                </div>
            </div>` : ''}

            ${isAdminUser ? `
            <!-- 5. MANAGE BRANCHES VIEW -->
            <div id="viewBranches" class="dashboard-view">
                ${isSuperAdminUser ? `
                <div class="branch-panel-card">
                    <h2>Regional Hierarchy</h2>
                    <div class="branch-input-group">
                        <input type="text" id="newRegionName" placeholder="Enter Region Name (e.g. KOCHI)">
                        <button class="branch-add-btn" id="addRegionBtn" onclick="addNewRegion()">Create Region</button>
                    </div>
                    <table class="branch-table">
                        <thead><tr><th>Region Name</th><th>Edit</th><th>Delete</th></tr></thead>
                        <tbody id="regionTableBody"></tbody>
                    </table>
                </div>` : ''}
                <div class="branch-panel-card">
                    <h2>Create Branch Location</h2>
                    <div class="branch-input-group">
                        <input type="text" id="newBranchName" placeholder="Enter Branch Name">
                        ${isSuperAdminUser ? `
                        <select id="newBranchRegion"><option value="" disabled selected>Select Region</option></select>` : `
                        <input type="text" value="${req.session.region || ''}" disabled style="background:rgba(0,0,0,0.04); color:var(--text-secondary);">`}
                        <button class="branch-add-btn" id="addBranchBtn" onclick="addNewBranch()">Save Branch</button>
                    </div>
                    <div id="branchGroupsContainer"></div>
                </div>
            </div>

            <!-- 6. MANAGE STAFF VIEW -->
            <div id="viewStaff" class="dashboard-view">
                <div class="branch-panel-card">
                    <h2>Add IT Specialist Profile</h2>
                    <div class="branch-input-group">
                        <input type="text" id="newStaffName" placeholder="Full Name">
                        <input type="text" id="newStaffId" placeholder="Staff ID (e.g. IT005)">
                        <input type="text" id="newStaffPassword" placeholder="Temporary Password">
                        <input type="email" id="newStaffEmail" placeholder="Official Email">
                        ${isSuperAdminUser ? `<select id="newStaffRegion"><option value="">Unassigned (Global)</option></select>` : ''}
                        <button class="branch-add-btn" id="addStaffBtn" onclick="addNewStaff()">Create Staff</button>
                    </div>
                </div>
                <div class="branch-panel-card">
                    <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:18px;">
                        <h2 style="margin-bottom:0;">Assigned Support Specialists</h2>
                        <input type="text" id="staffSearchInput" placeholder="Search staff members..." oninput="renderStaffTable()" style="padding: 8px 14px; border: 1px solid rgba(0,0,0,0.1); border-radius: var(--radius-pill); font-size: 13px; width: 280px; background: rgba(255,255,255,0.7);">
                    </div>
                    <table class="branch-table">
                        <thead><tr><th>Staff ID</th><th>Name Tag</th><th>Email</th>${isSuperAdminUser ? '<th>Region</th>' : ''}<th>Branch Routes</th><th>Edit</th><th>Delete</th></tr></thead>
                        <tbody id="staffTableBody"></tbody>
                    </table>
                </div>
            </div>

            <!-- 7. AUDIT LOG VIEW -->
            <div id="viewAuditLog" class="dashboard-view">
                <div class="branch-panel-card">
                    <h2>Management Audit Trail</h2>
                    <table class="branch-table">
                        <thead><tr><th>Timestamp</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead>
                        <tbody id="auditLogTableBody"></tbody>
                    </table>
                </div>
            </div>` : ''}

            <!-- 8. INBOX VIEW -->
            <div id="viewInbox" class="dashboard-view">
                ${!isAdminUser ? `
                <div class="branch-panel-card">
                    <h2>Dispatch Message to Administrator</h2>
                    <div style="max-width:520px;">
                        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">Subject</label>
                        <input type="text" id="inboxSubject" style="width:100%;padding:10px;border:1px solid rgba(0,0,0,0.1);border-radius:8px;font-size:13.5px;margin-bottom:12px;">
                        <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">Message</label>
                        <textarea id="inboxBody" rows="4" style="width:100%;padding:10px;border:1px solid rgba(0,0,0,0.1);border-radius:8px;font-size:13.5px;resize:vertical;"></textarea>
                        <button class="branch-add-btn" id="sendInboxBtn" onclick="sendInboxMessage()" style="margin-top:12px;">Send Message</button>
                    </div>
                </div>` : ''}
                <div id="inboxList">Loading messages...</div>
            </div>
        </section>
    </main>

    <script>
        const currentUser = "${dynamicUsername}";
        const isAdmin = ${dynamicIsAdmin};
        const isSuperAdmin = ${dynamicIsSuperAdmin};
        
        let knownNotificationIds = new Set();
        let notificationsInitialized = false;

        function toggleSidebar() {
            document.getElementById("sidebar").classList.toggle("sidebar-open");
            document.getElementById("sidebarBackdrop").classList.toggle("active");
        }
        function closeSidebar() {
            document.getElementById("sidebar").classList.remove("sidebar-open");
            document.getElementById("sidebarBackdrop").classList.remove("active");
        }

        function toggleNotifications(event) {
            if (event) event.stopPropagation();
            document.getElementById("notificationMenu").classList.toggle("show");
        }
        document.addEventListener("click", (e) => {
            const wrap = document.querySelector(".notification-wrap");
            const menu = document.getElementById("notificationMenu");
            if (menu && menu.classList.contains("show") && wrap && !wrap.contains(e.target)) {
                menu.classList.remove("show");
            }
        });

        async function markNotificationRead(id) {
            await fetch("/notifications/" + id + "/read", { method: "POST" });
            loadNotifications();
        }
        async function clearAllNotifications() {
            await fetch("/notifications", { method: "DELETE" });
            loadNotifications();
        }
        async function loadNotifications() {
            try {
                const response = await fetch("/notifications");
                if (!response.ok) return;
                const notifications = await response.json();
                const unread = notifications.filter(n => !n.read);
                const count = document.getElementById("notificationCount");
                count.innerText = unread.length > 99 ? "99+" : unread.length;
                count.style.display = unread.length ? "flex" : "none";
                const list = document.getElementById("notificationList");
                list.innerHTML = notifications.length ? notifications.map(n => \`<div class="notification-item \${!n.read ? 'unread' : ''}"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;"><div><strong>Ticket #\${String(n.ticketNumber).padStart(4,"0")}</strong>\${n.message}<br><small style="color:#86868b">\${new Date(n.createdAt).toLocaleString()}</small></div>\${!n.read ? \`<button onclick="markNotificationRead('\${n._id}')" style="flex-shrink:0;background:rgba(0,113,227,0.1);border:none;border-radius:12px;padding:3px 8px;font-size:10px;font-weight:600;color:var(--apple-blue);cursor:pointer;">Read</button>\` : ''}</div></div>\`).join('') : '<div class="notification-empty">No notifications.</div>';
            } catch (err) {}
        }

        let adminToastTimer = null;
        function showAdminToast(message, isError) {
            const toast = document.getElementById("adminToast");
            toast.textContent = message;
            toast.className = "admin-toast show" + (isError ? " error" : "");
            clearTimeout(adminToastTimer);
            adminToastTimer = setTimeout(() => { toast.classList.remove("show"); }, 3800);
        }

        let confirmCallback = null;
        let confirmHasInput = false;
        let confirmHasSelect = false;

        function showConfirmModal(message, callback, okLabel) {
            document.getElementById("confirmMessage").innerText = message;
            document.getElementById("confirmOkBtn").innerText = okLabel || "Confirm";
            document.getElementById("confirmInput").style.display = "none";
            document.getElementById("confirmStaffSelect").style.display = "none";
            confirmHasInput = false;
            confirmHasSelect = false;
            confirmCallback = callback;
            document.getElementById("confirmOverlay").classList.add("show");
        }
        function showPromptModal(message, defaultValue, callback, okLabel) {
            document.getElementById("confirmMessage").innerText = message;
            document.getElementById("confirmOkBtn").innerText = okLabel || "Save";
            const input = document.getElementById("confirmInput");
            input.style.display = "block";
            document.getElementById("confirmStaffSelect").style.display = "none";
            input.value = defaultValue || "";
            confirmHasInput = true;
            confirmHasSelect = false;
            confirmCallback = callback;
            document.getElementById("confirmOverlay").classList.add("show");
            setTimeout(() => input.focus(), 50);
        }
        function showStaffSelectModal(message, staffList, callback, okLabel) {
            document.getElementById("confirmMessage").innerText = message;
            document.getElementById("confirmOkBtn").innerText = okLabel || "Reallocate";
            document.getElementById("confirmInput").style.display = "none";
            const select = document.getElementById("confirmStaffSelect");
            select.style.display = "block";
            select.innerHTML = '<option value="" disabled selected>Select staff member</option>';
            staffList.forEach(s => { select.innerHTML += '<option value="'+s.name+'">'+s.name+'</option>'; });
            confirmHasInput = false;
            confirmHasSelect = true;
            confirmCallback = callback;
            document.getElementById("confirmOverlay").classList.add("show");
        }
        function closeConfirmModal(confirmed) {
            const inputValue = document.getElementById("confirmInput").value;
            const selectValue = document.getElementById("confirmStaffSelect").value;
            const hadInput = confirmHasInput;
            const hadSelect = confirmHasSelect;
            document.getElementById("confirmOverlay").classList.remove("show");
            const cb = confirmCallback;
            confirmCallback = null;
            if (confirmed && cb) {
                if (hadSelect) { if (selectValue) cb(selectValue); }
                else if (hadInput) { cb(inputValue); }
                else { cb(); }
            }
        }

        function toggleFilterPanel() {
            const panel = document.getElementById("ticketFilterPanel");
            panel.style.display = panel.style.display === "none" ? "flex" : "none";
        }
        function refreshTicketsDashboard() {
            currentStatusFilter = "default-view";
            currentPage = 1;
            switchView("tickets");
        }

        function switchView(target) {
            closeSidebar();
            document.querySelectorAll(".dashboard-view").forEach(el => el.classList.remove("active"));
            document.querySelectorAll(".menu-item").forEach(el => el.classList.remove("active"));
            
            if (target === "tickets") {
                document.getElementById("viewTickets").classList.add("active");
                document.getElementById("tabTicketsLink").classList.add("active");
                document.getElementById("panelViewTitle").innerText = "Helpdesk Operations";
                loadTickets();
            } else if (target === "reports") {
                document.getElementById("viewReports").classList.add("active");
                document.getElementById("tabReportsLink").classList.add("active");
                document.getElementById("panelViewTitle").innerText = "Executive Analytics & Reports";
                loadReportCharts();
            } else if (target === "password") {
                document.getElementById("viewChangePassword").classList.add("active");
                document.getElementById("tabPasswordLink").classList.add("active");
                document.getElementById("panelViewTitle").innerText = "Account Settings";
            } else if (target === "branches") {
                document.getElementById("viewBranches").classList.add("active");
                document.getElementById("tabBranchesLink").classList.add("active");
                document.getElementById("panelViewTitle").innerText = "Manage Branch Network";
                loadRegionsList();
                loadBranchesList();
            } else if (target === "staff") {
                document.getElementById("viewStaff").classList.add("active");
                document.getElementById("tabStaffLink").classList.add("active");
                document.getElementById("panelViewTitle").innerText = "IT Specialists Directory";
                loadStaffList();
            } else if (target === "audit") {
                document.getElementById("viewAuditLog").classList.add("active");
                document.getElementById("tabAuditLink").classList.add("active");
                document.getElementById("panelViewTitle").innerText = "Audit & Compliance Log";
                loadAuditLog();
            } else if (target === "admins") {
                document.getElementById("viewAdmins").classList.add("active");
                document.getElementById("tabAdminsLink").classList.add("active");
                document.getElementById("panelViewTitle").innerText = "Region Administrators";
                loadRegionAdminsList();
            } else if (target === "inbox") {
                document.getElementById("viewInbox").classList.add("active");
                document.getElementById("tabInboxLink").classList.add("active");
                document.getElementById("panelViewTitle").innerText = "Direct Inbox Messages";
                loadInbox();
            }
        }

        let currentStatusFilter = "default-view";
        let currentPage = 1;
        const PAGE_SIZE = 10;

        function filterByStatus(status) {
            currentStatusFilter = status;
            currentPage = 1;
            loadTickets();
        }
        async function applyTicketFilters() {
            currentPage = 1;
            await loadTickets();
        }
        function clearTicketFilters() {
            document.getElementById("filterFromDate").value = "";
            document.getElementById("filterToDate").value = "";
            document.getElementById("filterCategory").value = "";
            const sf = document.getElementById("filterStaff"); if (sf) sf.value = "";
            const rf = document.getElementById("filterRegion"); if (rf) rf.value = "";
            const searchEl = document.getElementById("filterSearchText"); if (searchEl) searchEl.value = "";
            currentStatusFilter = "default-view";
            currentPage = 1;
            loadTickets();
        }

        function goToPage(page) {
            currentPage = page;
            loadTickets();
            document.querySelector(".main-content").scrollTop = 0;
        }

        function renderPagination(totalItems) {
            const bar = document.getElementById("ticketPagination");
            const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
            if (currentPage > totalPages) currentPage = totalPages;
            if (totalItems === 0) { bar.style.display = "none"; return; }
            bar.style.display = "flex";
            const startItem = (currentPage - 1) * PAGE_SIZE + 1;
            const endItem = Math.min(currentPage * PAGE_SIZE, totalItems);
            
            let pageBtns = '<button class="page-btn" '+(currentPage === 1 ? 'disabled' : '')+' onclick="goToPage('+(currentPage - 1)+')">&larr;</button>';
            for (let p = 1; p <= totalPages; p++) {
                if (p === 1 || p === totalPages || Math.abs(p - currentPage) <= 1) {
                    pageBtns += '<button class="page-btn '+(p === currentPage ? 'active' : '')+'" onclick="goToPage('+p+')">'+p+'</button>';
                }
            }
            pageBtns += '<button class="page-btn" '+(currentPage === totalPages ? 'disabled' : '')+' onclick="goToPage('+(currentPage + 1)+')">&rarr;</button>';
            bar.innerHTML = '<div style="font-size:13px;color:var(--text-secondary)">Showing '+startItem+' &ndash; '+endItem+' of '+totalItems+' tickets</div><div>'+pageBtns+'</div>';
        }

        async function loadStaffFilterOptions() {
            if (!isAdmin) return;
            const sfWrap = document.getElementById("staffFilterWrapper");
            if (sfWrap) sfWrap.style.display = "block";
            const res = await fetch("/tickets/staff-list");
            const staff = await res.json();
            const select = document.getElementById("filterStaff");
            if (select) {
                select.innerHTML = '<option value="">All Staff</option>';
                staff.forEach(s => { select.innerHTML += '<option value="'+s.name+'">'+s.name+'</option>'; });
            }
        }

        async function loadRegionFilterOptions() {
            if (!isAdmin) return;
            const res = await fetch("/tickets/regions");
            const regions = await res.json();
            const rfWrap = document.getElementById("regionFilterWrapper");
            if (rfWrap) rfWrap.style.display = "block";
            const filterSelect = document.getElementById("filterRegion");
            if (filterSelect) {
                filterSelect.innerHTML = '<option value="">All Regions</option>';
                regions.forEach(r => { filterSelect.innerHTML += '<option value="'+r.name+'">'+r.name+'</option>'; });
            }
            const reportSelect = document.getElementById("reportRegion");
            if (reportSelect) {
                reportSelect.innerHTML = '<option value="">All Regions</option>';
                regions.forEach(r => { reportSelect.innerHTML += '<option value="'+r.name+'">'+r.name+'</option>'; });
            }
        }

        async function loadTickets() {
            try {
                const response = await fetch("/tickets");
                if (response.status === 401) { window.location.href = "/login"; return; }
                let tickets = await response.json();

                const staffFilterEl = document.getElementById("filterStaff");
                if (staffFilterEl && staffFilterEl.value) { tickets = tickets.filter(t => t.assignedTo === staffFilterEl.value); }
                const categoryFilterValue = document.getElementById("filterCategory").value;
                if (categoryFilterValue) { tickets = tickets.filter(t => (t.category || "Other") === categoryFilterValue); }
                
                const searchTextValue = document.getElementById("filterSearchText").value.trim().toLowerCase();
                if (searchTextValue) {
                    tickets = tickets.filter(t => {
                        return String(t.ticketNumber || "").includes(searchTextValue) ||
                               (t.submittedBy || "").toLowerCase().includes(searchTextValue) ||
                               (t.branch || "").toLowerCase().includes(searchTextValue) ||
                               (t.mobile || "").includes(searchTextValue) ||
                               (t.title || "").toLowerCase().includes(searchTextValue);
                    });
                }

                document.getElementById("statOpen").innerText = tickets.filter(t => t.status === "Open").length;
                document.getElementById("statResolved").innerText = tickets.filter(t => t.status === "Resolved").length;
                document.getElementById("statEscalated").innerText = tickets.filter(t => t.escalated && t.status !== "Resolved").length;
                document.getElementById("statMine").innerText = tickets.length;

                if (currentStatusFilter === "default-view") { tickets = tickets.filter(t => t.status === "Open"); }
                else if (currentStatusFilter === "Escalated") { tickets = tickets.filter(t => t.escalated); }
                else if (currentStatusFilter === "Resolved") { tickets = tickets.filter(t => t.status === "Resolved"); }
                else if (currentStatusFilter !== "all") { tickets = tickets.filter(t => t.status === currentStatusFilter); }

                const totalFilteredCount = tickets.length;
                const pageStart = (currentPage - 1) * PAGE_SIZE;
                const pagedTickets = tickets.slice(pageStart, pageStart + PAGE_SIZE);
                const listDiv = document.getElementById("ticketList");

                if (pagedTickets.length === 0) {
                    listDiv.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:40px 0;">No matching tickets in queue.</p>';
                    renderPagination(totalFilteredCount);
                    return;
                }

                let ticketCardsHtml = "";
                pagedTickets.forEach(ticket => {
                    const isResolved = ticket.status === "Resolved";
                    const isMineOrAdmin = isAdmin || ticket.assignedTo === currentUser;
                    const reallocateBtn = (isAdmin && !isResolved && ticket.escalated) ? '<button class="reallocate-btn" onclick="reallocateTicket(\''+ticket._id+'\')">Reallocate</button>' : "";
                    const actionBtn = (!isResolved && isMineOrAdmin) ? '<button class="resolve-btn" onclick="resolveTicket(\''+ticket._id+'\')">Resolve Ticket</button>' : "";
                    const escalateBtn = (!isAdmin && !isResolved && !ticket.escalated && ticket.assignedTo === currentUser) ? '<button class="escalate-btn" onclick="escalateTicket(\''+ticket._id+'\')">Escalate</button>' : "";
                    const cardStateClass = isResolved ? "ticket-resolved" : (ticket.priority === "High" ? "ticket-high-priority" : (ticket.escalated ? "ticket-escalated" : ""));
                    const imageHtml = ticket.screenshot ? '<a href="'+ticket.screenshot+'" target="_blank"><img src="'+ticket.screenshot+'" class="screenshot-preview"></a>' : "";

                    let commentListHtml = "";
                    if (ticket.comments) {
                        ticket.comments.forEach(c => {
                            commentListHtml += '<div class="comment-item"><strong>'+c.author+':</strong> '+c.text+(c.attachment ? ' <a href="'+c.attachment+'" target="_blank" style="color:var(--apple-blue);text-decoration:none;">📎 View File</a>' : "")+'</div>';
                        });
                    }

                    ticketCardsHtml += '<div class="ticket-card '+cardStateClass+'">' +
                        '<div class="ticket-header"><div>' +
                        '<h3 class="ticket-title">#'+String(ticket.ticketNumber).padStart(4,"0")+' '+ticket.title+'</h3>' +
                        '<div style="margin-top: 8px;"><span class="badge p-'+ticket.priority+'">'+ticket.priority+'</span><span class="badge status-'+ticket.status.toLowerCase()+'">'+ticket.status+'</span><span class="badge badge-category">'+(ticket.category || "Other")+'</span>'+(ticket.escalated ? '<span class="badge badge-escalated">Escalated</span>' : '')+'</div>' +
                        '</div><div class="ticket-actions">'+reallocateBtn+actionBtn+escalateBtn+'</div></div>' +
                        '<p class="ticket-desc">'+ticket.description+'</p>'+imageHtml+
                        '<div class="assignment-info">' +
                        '<div class="assignment-row"><span class="assignment-label">Submitted By</span><span class="assignment-value">'+(ticket.submittedBy || "Unknown")+(ticket.designation ? " ("+ticket.designation+")" : "")+'</span></div>' +
                        '<div class="assignment-row"><span class="assignment-label">Branch</span><span class="assignment-value">'+ticket.branch+'</span></div>' +
                        '<div class="assignment-row"><span class="assignment-label">Mobile</span><span class="assignment-value">'+ticket.mobile+'</span></div>' +
                        '<div class="assignment-row"><span class="assignment-label">Assigned</span><span class="assignment-value">'+ticket.assignedTo+'</span></div>' +
                        '<div class="assignment-row"><span class="assignment-label">Submitted</span><span class="assignment-value">'+(ticket.createdAt ? new Date(ticket.createdAt).toLocaleString() : "N/A")+'</span></div>' +
                        '</div>' +
                        '<div class="comments-section"><h4 class="comments-header">Internal Work Notes</h4><div>'+(commentListHtml || "No updates yet.")+'</div>' +
                        '<div class="comment-form"><input type="text" id="input-'+ticket._id+'" placeholder="Write operational note..."><label class="comment-attach-btn" title="Attach file">📎<input type="file" id="attachment-'+ticket._id+'" style="display:none;"></label><button onclick="addComment(\''+ticket._id+'\')">Post</button></div></div>' +
                        '</div>';
                });

                listDiv.innerHTML = ticketCardsHtml;
                renderPagination(totalFilteredCount);
            } catch (err) {
                document.getElementById("ticketList").innerHTML = '<p style="text-align:center;color:var(--apple-red);padding:40px 0;">Could not load tickets.</p>';
            }
        }

        async function resolveTicket(id) {
            showConfirmModal("Mark this ticket as resolved?", async () => {
                const response = await fetch("/tickets/" + id + "/resolve", { method: "POST" });
                if (response.ok) loadTickets();
                else showAdminToast("Could not resolve ticket.", true);
            }, "Mark Resolved");
        }

        async function escalateTicket(id) {
            showPromptModal("Reason for escalating to Admin:", "", async (reason) => {
                if (!reason) return;
                const response = await fetch("/tickets/" + id + "/escalate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ reason })
                });
                if (response.ok) { showAdminToast("Ticket escalated to Admin."); loadTickets(); }
                else showAdminToast("Could not escalate ticket.", true);
            }, "Escalate");
        }

        async function reallocateTicket(id) {
            const res = await fetch("/tickets/staff-list");
            const staff = await res.json();
            showStaffSelectModal("Select IT staff member:", staff, async (staffName) => {
                const response = await fetch("/tickets/" + id + "/reallocate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ assignTo: staffName })
                });
                if (response.ok) { showAdminToast("Ticket reallocated to " + staffName); loadTickets(); }
                else showAdminToast("Could not reallocate ticket.", true);
            });
        }

        async function addComment(id) {
            const textInput = document.getElementById("input-" + id);
            const fileInput = document.getElementById("attachment-" + id);
            const text = textInput.value.trim();
            const file = fileInput && fileInput.files && fileInput.files[0];
            if (!text && !file) return;

            const formData = new FormData();
            formData.append("text", text);
            if (file) formData.append("attachment", file);

            const res = await fetch("/tickets/" + id + "/comment", { method: "POST", body: formData });
            if (res.ok) {
                textInput.value = "";
                if (fileInput) fileInput.value = "";
                loadTickets();
            }
        }

        let chartInstances = {};
        function renderChart(canvasId, config) {
            const el = document.getElementById(canvasId);
            if (!el) return;
            if (chartInstances[canvasId]) chartInstances[canvasId].destroy();
            chartInstances[canvasId] = new Chart(el, config);
        }

        async function loadReportCharts() {
            const response = await fetch("/tickets");
            const tickets = await response.json();
            const openCount = tickets.filter(t => t.status === "Open").length;
            const resolvedCount = tickets.filter(t => t.status === "Resolved").length;

            renderChart("chartStatus", {
                type: "doughnut",
                data: { labels: ["Open", "Resolved"], datasets: [{ data: [openCount, resolvedCount], backgroundColor: ["#0071e3", "#34c759"] }] },
                options: { maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } }
            });

            const lowCount = tickets.filter(t => t.priority === "Low").length;
            const medCount = tickets.filter(t => t.priority === "Medium").length;
            const highCount = tickets.filter(t => t.priority === "High").length;
            renderChart("chartPriority", {
                type: "doughnut",
                data: { labels: ["Low", "Medium", "High"], datasets: [{ data: [lowCount, medCount, highCount], backgroundColor: ["#8e8e93", "#ff9500", "#ff3b30"] }] },
                options: { maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } }
            });

            const categoryTotals = {};
            tickets.forEach(t => { const key = t.category || "Other"; categoryTotals[key] = (categoryTotals[key] || 0) + 1; });
            renderChart("chartCategory", {
                type: "doughnut",
                data: { labels: Object.keys(categoryTotals), datasets: [{ data: Object.values(categoryTotals), backgroundColor: ["#5ac8fa", "#af52de", "#0071e3", "#ff9500", "#8e8e93"] }] },
                options: { maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } }
            });

            const dayLabels = [];
            const dayCounts = [];
            const today = new Date();
            for (let i = 29; i >= 0; i--) {
                const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
                dayLabels.push((d.getMonth() + 1) + "/" + d.getDate());
                const count = tickets.filter(t => {
                    if (!t.createdAt) return false;
                    const td = new Date(t.createdAt);
                    return td.getFullYear() === d.getFullYear() && td.getMonth() === d.getMonth() && td.getDate() === d.getDate();
                }).length;
                dayCounts.push(count);
            }
            renderChart("chartTrend", {
                type: "line",
                data: { labels: dayLabels, datasets: [{ label: "Tickets", data: dayCounts, borderColor: "#0071e3", backgroundColor: "rgba(0,113,227,0.1)", tension: 0.35, fill: true }] },
                options: { maintainAspectRatio: false, plugins: { legend: { display: false } } }
            });

            if (isAdmin) {
                const staffTotals = {};
                tickets.forEach(t => { const key = t.assignedTo || "Unassigned"; staffTotals[key] = (staffTotals[key] || 0) + 1; });
                renderChart("chartStaff", {
                    type: "bar",
                    data: { labels: Object.keys(staffTotals), datasets: [{ label: "Handled", data: Object.values(staffTotals), backgroundColor: "#0071e3" }] },
                    options: { indexAxis: "y", maintainAspectRatio: false, plugins: { legend: { display: false } } }
                });

                const branchTotals = {};
                tickets.forEach(t => { const key = t.branch || "N/A"; branchTotals[key] = (branchTotals[key] || 0) + 1; });
                renderChart("chartBranch", {
                    type: "bar",
                    data: { labels: Object.keys(branchTotals), datasets: [{ label: "Tickets", data: Object.values(branchTotals), backgroundColor: "#5ac8fa" }] },
                    options: { indexAxis: "y", maintainAspectRatio: false, plugins: { legend: { display: false } } }
                });
            }
        }

        function downloadReport() {
            const month = document.getElementById("reportMonth").value;
            if (!month) { alert("Please select a month."); return; }
            const region = document.getElementById("reportRegion").value;
            let url = "/tickets/report?month=" + month;
            if (region) url += "&region=" + encodeURIComponent(region);
            window.location.href = url;
        }

        function downloadReportByRange() {
            const from = document.getElementById("reportFromDate").value;
            const to = document.getElementById("reportToDate").value;
            if (!from || !to) { alert("Please select both dates."); return; }
            const region = document.getElementById("reportRegion").value;
            let url = "/tickets/report?from=" + from + "&to=" + to;
            if (region) url += "&region=" + encodeURIComponent(region);
            window.location.href = url;
        }

        async function changePassword() {
            const current = document.getElementById("currentPassword").value;
            const next = document.getElementById("newPassword").value;
            const confirmVal = document.getElementById("confirmPassword").value;
            if (!current || !next || !confirmVal) { alert("Please fill all fields."); return; }
            if (next !== confirmVal) { alert("Passwords do not match."); return; }
            const res = await fetch("/change-password", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ currentPassword: current, newPassword: next })
            });
            if (res.ok) alert("Password updated successfully.");
            else { const d = await res.json(); alert(d.error || "Update failed."); }
        }

        // Branch & Region Functions
        async function loadRegionsList() {
            const res = await fetch("/tickets/regions");
            const regions = await res.json();
            const tbody = document.getElementById("regionTableBody");
            if (tbody) {
                tbody.innerHTML = regions.length ? regions.map(r => '<tr><td>'+r.name+'</td><td><button class="branch-delete-btn" onclick="editRegion(\''+r._id+'\', \''+r.name+'\')">Edit</button></td><td><button class="branch-delete-btn" onclick="deleteRegion(\''+r._id+'\')">Delete</button></td></tr>').join('') : '<tr><td colspan="3" style="text-align:center;color:var(--text-secondary);padding:20px;">No regions yet.</td></tr>';
            }
            const select = document.getElementById("newBranchRegion");
            if (select) {
                select.innerHTML = '<option value="" disabled selected>Select Region</option>' + regions.map(r => '<option value="'+r.name+'">'+r.name+'</option>').join('');
            }
        }
        async function addNewRegion() {
            const input = document.getElementById("newRegionName");
            if (!input.value.trim()) return;
            const res = await fetch("/tickets/regions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: input.value.trim() }) });
            if (res.ok) { input.value = ""; showAdminToast("Region added."); loadRegionsList(); loadBranchesList(); }
        }
        async function deleteRegion(id) {
            showConfirmModal("Delete this region?", async () => {
                const res = await fetch("/tickets/regions/" + id, { method: "DELETE" });
                if (res.ok) { showAdminToast("Region deleted."); loadRegionsList(); loadBranchesList(); }
            }, "Delete");
        }
        async function editRegion(id, name) {
            showPromptModal("Rename Region:", name, async (newName) => {
                if (!newName) return;
                const res = await fetch("/tickets/regions/" + id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newName }) });
                if (res.ok) { showAdminToast("Region updated."); loadRegionsList(); loadBranchesList(); }
            });
        }

        async function loadBranchesList() {
            const [bRes, rRes] = await Promise.all([fetch("/public-branches"), fetch("/tickets/regions")]);
            const branches = await bRes.json();
            const regions = await rRes.json();
            const container = document.getElementById("branchGroupsContainer");
            if (!branches.length) { container.innerHTML = '<p style="color:var(--text-secondary);padding:20px 0;">No branches created yet.</p>'; return; }

            const groups = {};
            branches.forEach(b => { const r = b.region || "Unassigned"; if (!groups[r]) groups[r] = []; groups[r].push(b); });
            let html = "";
            Object.keys(groups).sort().forEach(r => {
                let rows = groups[r].map(b => '<tr><td>'+b.name+'</td><td>'+r+'</td><td><button class="branch-delete-btn" onclick="editBranch(\''+b._id+'\', \''+b.name+'\')">Edit</button></td><td><button class="branch-delete-btn" onclick="deleteBranch(\''+b._id+'\')">Delete</button></td></tr>').join('');
                html += '<h3 style="margin:16px 0 8px;font-size:13px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;">'+r+'</h3><table class="branch-table"><thead><tr><th>Branch</th><th>Region</th><th>Edit</th><th>Delete</th></tr></thead><tbody>'+rows+'</tbody></table>';
            });
            container.innerHTML = html;
        }
        async function addNewBranch() {
            const name = document.getElementById("newBranchName").value.trim();
            const regionSelect = document.getElementById("newBranchRegion");
            const region = regionSelect ? regionSelect.value : "";
            if (!name) return;
            const res = await fetch("/tickets/branches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, region }) });
            if (res.ok) { document.getElementById("newBranchName").value = ""; showAdminToast("Branch added."); loadBranchesList(); }
        }
        async function deleteBranch(id) {
            showConfirmModal("Delete branch?", async () => {
                const res = await fetch("/tickets/branches/" + id, { method: "DELETE" });
                if (res.ok) { showAdminToast("Branch removed."); loadBranchesList(); }
            }, "Delete");
        }
        async function editBranch(id, name) {
            showPromptModal("Rename Branch:", name, async (newName) => {
                if (!newName) return;
                const res = await fetch("/tickets/branches/" + id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newName }) });
                if (res.ok) { showAdminToast("Branch updated."); loadBranchesList(); }
            });
        }

        // Staff & Region Admin Helpers
        let cachedStaffList = [];
        let cachedStaffBranches = [];
        let cachedStaffAssignments = {};
        async function loadStaffList() {
            const [sRes, bRes, aRes] = await Promise.all([fetch("/tickets/staff-list"), fetch("/public-branches"), fetch("/tickets/staff-branches")]);
            cachedStaffList = await sRes.json();
            cachedStaffBranches = await bRes.json();
            cachedStaffAssignments = await aRes.json();
            renderStaffTable();
        }
        function renderStaffTable() {
            const search = (document.getElementById("staffSearchInput")?.value || "").toLowerCase();
            const staff = cachedStaffList.filter(s => (s.name||"").toLowerCase().includes(search) || (s.id||"").toLowerCase().includes(search));
            const tbody = document.getElementById("staffTableBody");
            if (!tbody) return;
            tbody.innerHTML = staff.length ? staff.map(s => {
                const assigned = cachedStaffAssignments[s.id] || [];
                const checkBoxes = cachedStaffBranches.map(b => '<label style="display:inline-flex;align-items:center;gap:4px;margin-right:10px;font-size:12px;"><input type="checkbox" value="'+b.name+'" '+(assigned.includes(b.name)?'checked':'')+' onchange="updateStaffBranches(\''+s.id+'\')"> '+b.name+'</label>').join('');
                return '<tr><td>'+s.id+'</td><td>'+s.name+'</td><td>'+s.email+'</td>'+(isSuperAdmin ? '<td>'+(s.region || 'Global')+'</td>' : '')+'<td>'+(checkBoxes || 'None')+'</td><td><button class="branch-delete-btn" onclick="editStaff(\''+s.id+'\', \''+s.name+'\', \''+s.email+'\')">Edit</button></td><td><button class="branch-delete-btn" onclick="deleteStaff(\''+s.id+'\')">Delete</button></td></tr>';
            }).join('') : '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-secondary);">No staff found.</td></tr>';
        }
        async function updateStaffBranches(staffId) {
            const checks = Array.from(document.querySelectorAll('input[type="checkbox"]:checked')).map(c => c.value);
            await fetch("/tickets/staff-branches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ staffId, branches: checks }) });
        }
        async function addNewStaff() {
            const name = document.getElementById("newStaffName").value.trim();
            const staffId = document.getElementById("newStaffId").value.trim();
            const password = document.getElementById("newStaffPassword").value.trim();
            const email = document.getElementById("newStaffEmail").value.trim();
            const region = document.getElementById("newStaffRegion")?.value;
            if (!name || !password || !email) { showAdminToast("Please fill all required fields.", true); return; }
            const res = await fetch("/tickets/staff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, staffId, password, email, region }) });
            if (res.ok) { showAdminToast("Staff added successfully."); loadStaffList(); }
        }
        async function deleteStaff(id) {
            showConfirmModal("Delete this staff member?", async () => {
                const res = await fetch("/tickets/staff/" + id, { method: "DELETE" });
                if (res.ok) { showAdminToast("Staff deleted."); loadStaffList(); }
            }, "Delete");
        }
        async function editStaff(id, name, email) {
            showPromptModal("Edit staff email:", email, async (newEmail) => {
                if (!newEmail) return;
                const res = await fetch("/tickets/staff/" + id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email: newEmail }) });
                if (res.ok) { showAdminToast("Staff profile updated."); loadStaffList(); }
            });
        }

        async function loadAuditLog() {
            const tbody = document.getElementById("auditLogTableBody");
            if (!tbody) return;
            const res = await fetch("/audit-log");
            const entries = await res.json();
            tbody.innerHTML = entries.length ? entries.map(e => '<tr><td>'+new Date(e.createdAt).toLocaleString()+'</td><td>'+e.actor+'</td><td>'+e.action+'</td><td>'+(e.details||"")+'</td></tr>').join('') : '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--text-secondary);">No logs recorded.</td></tr>';
        }

        async function loadRegionAdminsList() {
            const res = await fetch("/region-admins");
            const admins = await res.json();
            const tbody = document.getElementById("regionAdminsTableBody");
            if (!tbody) return;
            tbody.innerHTML = admins.length ? admins.map(a => '<tr><td>'+a.name+'</td><td>'+a.username+'</td><td>'+a.region+'</td><td><span class="badge '+(a.enabled?'status-resolved':'p-High')+'">'+(a.enabled?'Active':'Disabled')+'</span></td><td><button class="branch-delete-btn" onclick="toggleRegionAdmin(\''+a.id+'\', '+(!a.enabled)+')">'+(a.enabled?'Disable':'Enable')+'</button></td><td><button class="branch-delete-btn" onclick="deleteRegionAdmin(\''+a.id+'\')">Delete</button></td></tr>').join('') : '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-secondary);">No region admins configured.</td></tr>';
        }
        async function toggleRegionAdmin(id, enabled) {
            await fetch("/region-admins/" + id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
            loadRegionAdminsList();
        }
        async function deleteRegionAdmin(id) {
            showConfirmModal("Delete admin?", async () => {
                await fetch("/region-admins/" + id, { method: "DELETE" });
                loadRegionAdminsList();
            }, "Delete");
        }
        async function addNewRegionAdmin() {
            const name = document.getElementById("newAdminName").value.trim();
            const username = document.getElementById("newAdminUsername").value.trim();
            const password = document.getElementById("newAdminPassword").value.trim();
            const region = document.getElementById("newAdminRegion").value;
            if (!name || !username || !password || !region) return;
            const res = await fetch("/region-admins", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, username, password, region }) });
            if (res.ok) { showAdminToast("Admin added."); loadRegionAdminsList(); }
        }

        async function loadInbox() {
            const res = await fetch("/inbox");
            const msgs = await res.json();
            const list = document.getElementById("inboxList");
            list.innerHTML = msgs.length ? msgs.map(m => '<div class="branch-panel-card" style="margin-bottom:14px;"><div style="display:flex;justify-content:space-between;"><strong>'+m.subject+'</strong><span class="badge '+(m.status==='Replied'?'status-resolved':'status-open')+'">'+m.status+'</span></div><p style="font-size:13px;color:var(--text-secondary);margin:6px 0 12px;">From: '+m.sender+' &bull; '+new Date(m.createdAt).toLocaleString()+'</p><p style="font-size:13.5px;line-height:1.5;">'+m.body+'</p>'+(m.reply ? '<div style="margin-top:12px;padding:10px 14px;background:rgba(52,199,89,0.1);border-radius:10px;font-size:13px;"><strong>Reply from '+m.repliedBy+':</strong> '+m.reply+'</div>' : '')+'</div>').join('') : '<p style="color:var(--text-secondary);text-align:center;padding:30px 0;">Inbox is empty.</p>';
        }
        async function sendInboxMessage() {
            const subject = document.getElementById("inboxSubject").value.trim();
            const body = document.getElementById("inboxBody").value.trim();
            if (!subject || !body) return;
            const res = await fetch("/inbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject, body }) });
            if (res.ok) { document.getElementById("inboxSubject").value = ""; document.getElementById("inboxBody").value = ""; showAdminToast("Message sent."); loadInbox(); }
        }

        document.getElementById("reportMonth").value = new Date().toISOString().slice(0, 7);
        loadNotifications();
        setInterval(loadNotifications, 30000);
        loadStaffFilterOptions();
        loadRegionFilterOptions();
        loadTickets();
    </script>
</body>
</html>`;

    res.send(html);
});

// -------------------------------------------------------------
// 4. FULL API ENDPOINTS BACKEND LOGIC
// -------------------------------------------------------------
app.get('/tickets', checkUserLogin, async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ error: 'Database connection is not ready.' });
        }
        let query;
        if (req.session.isSuperAdmin) {
            query = {};
        } else if (req.session.isAdmin) {
            const regionBranchNames = await getBranchNamesForRegion(req.session.region);
            query = { branch: { $in: regionBranchNames } };
        } else {
            query = { $or: [{ assignedTo: req.session.username }, { escalatedBy: req.session.username }] };
        }
        const tickets = await Ticket.find(query).sort({ _id: -1 });
        res.json(tickets);
    } catch (err) {
        res.status(500).json({ error: 'Could not load tickets.' });
    }
});

app.get('/notifications', checkUserLogin, async (req, res) => {
    try {
        const notifications = await Notification.find({ recipient: req.session.username }).sort({ createdAt: -1 }).limit(50);
        res.json(notifications);
    } catch (err) {
        res.status(500).json({ error: 'Could not load notifications.' });
    }
});

app.post('/notifications/:id/read', checkUserLogin, async (req, res) => {
    try {
        await Notification.findOneAndUpdate(
            { _id: req.params.id, recipient: req.session.username },
            { $set: { read: true } }
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Could not update notification.' });
    }
});

app.delete('/notifications', checkUserLogin, async (req, res) => {
    try {
        await Notification.deleteMany({ recipient: req.session.username });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Could not clear notifications.' });
    }
});

app.get('/tickets/report', checkUserLogin, async (req, res) => {
    try {
        let startDate, endDate, rangeLabel;
        if (req.query.month) {
            const monthParam = req.query.month;
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
            query.$or = [{ assignedTo: req.session.username }, { escalatedBy: req.session.username }];
        } else if (!req.session.isSuperAdmin) {
            const ownRegionBranches = await getBranchNamesForRegion(req.session.region);
            query.branch = { $in: ownRegionBranches };
        }
        let regionLabel = '';
        if (req.query.region && (req.session.isSuperAdmin || !req.session.isAdmin)) {
            const branchNamesInRegion = await Branch.find({ region: req.query.region }).distinct('name');
            query.branch = { $in: branchNamesInRegion };
            regionLabel = '-' + req.query.region.replace(/\s+/g, '-');
        } else if (!req.session.isSuperAdmin && req.session.isAdmin) {
            regionLabel = '-' + req.session.region.replace(/\s+/g, '-');
        }

        const tickets = await Ticket.find(query).sort({ ticketNumber: 1 });
        const allStaffForReport = await Staff.find();
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
                ticketNumber: t.ticketNumber,
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
        const ticket = await Ticket.findById(req.params.id);
        if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
        ticket.status = 'Resolved';
        ticket.resolvedAt = new Date();
        ticket.resolvedBy = req.session.username;
        await ticket.save();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/tickets/:id/escalate', checkUserLogin, async (req, res) => {
    try {
        const reason = (req.body.reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Please provide reason.' });
        const ticket = await Ticket.findById(req.params.id);
        if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });

        let recipientName = 'Admin';
        const branchDoc = await Branch.findOne({ name: ticket.branch });
        if (branchDoc && branchDoc.region) {
            const regionAdmin = await RegionAdmin.findOne({ region: branchDoc.region, enabled: true });
            if (regionAdmin) recipientName = regionAdmin.name;
        }

        ticket.escalated = true;
        ticket.escalatedBy = req.session.username;
        ticket.escalatedAt = new Date();
        ticket.escalationReason = reason;
        ticket.assignedTo = recipientName;
        await ticket.save();

        await Notification.create({
            recipient: recipientName,
            ticketId: ticket._id,
            ticketNumber: ticket.ticketNumber,
            title: ticket.title,
            message: `Ticket #${String(ticket.ticketNumber).padStart(4, '0')} was escalated by ${req.session.username}. Reason: ${reason}`
        });

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/tickets/:id/reallocate', checkAdminLogin, async (req, res) => {
    try {
        const assignTo = (req.body.assignTo || '').trim();
        const ticket = await Ticket.findById(req.params.id);
        if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
        ticket.assignedTo = assignTo;
        await ticket.save();

        await Notification.create({
            recipient: assignTo,
            ticketId: ticket._id,
            ticketNumber: ticket.ticketNumber,
            title: ticket.title,
            message: `Ticket #${String(ticket.ticketNumber).padStart(4, '0')} was reallocated to you.`
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/tickets/:id/comment', checkUserLogin, (req, res, next) => {
    commentUpload.single('attachment')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
        next();
    });
}, async (req, res) => {
    try {
        const text = (req.body.text || '').trim();
        const attachment = req.file ? req.file.path : null;
        if (!text && !attachment) return res.status(400).json({ error: 'Comment required.' });
        await Ticket.findByIdAndUpdate(req.params.id, {
            $push: { comments: { author: req.session.username, text, attachment } }
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/public-branches', async (req, res) => {
    try {
        let query = {};
        if (req.session && req.session.isAdmin && !req.session.isSuperAdmin && req.session.region) {
            query = { region: req.session.region };
        }
        const branches = await Branch.find(query).sort({ region: 1, name: 1 });
        res.json(branches);
    } catch(err) {
        res.status(500).json([]);
    }
});

app.get('/tickets/regions', checkAdminLogin, async (req, res) => {
    const query = req.session.isSuperAdmin ? {} : { name: req.session.region };
    const regions = await Region.find(query).sort({ name: 1 });
    res.json(regions);
});

app.post('/tickets/regions', checkSuperAdminLogin, async (req, res) => {
    try {
        const name = (req.body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Region name required' });
        const newRegion = new Region({ name });
        await newRegion.save();
        await logAudit(req.session.username, 'Add Region', `Added region "${newRegion.name}"`);
        res.status(201).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/tickets/regions/:id', checkSuperAdminLogin, async (req, res) => {
    try {
        const name = (req.body.name || '').trim();
        const region = await Region.findById(req.params.id);
        if (!region) return res.status(404).json({ error: 'Region not found' });
        const oldName = region.name;
        region.name = name;
        await region.save();
        if (oldName !== name) {
            await Branch.updateMany({ region: oldName }, { $set: { region: name } });
            await RegionAdmin.updateMany({ region: oldName }, { $set: { region: name } });
            await Staff.updateMany({ region: oldName }, { $set: { region: name } });
        }
        await logAudit(req.session.username, 'Edit Region', `Renamed region "${oldName}" to "${name}"`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/tickets/regions/:id', checkSuperAdminLogin, async (req, res) => {
    try {
        await Region.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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
        let region = (req.body.region || '').trim();
        if (!req.session.isSuperAdmin) region = req.session.region;
        const newBranch = new Branch({ name, region });
        await newBranch.save();
        await logAudit(req.session.username, 'Add Branch', `Added branch "${newBranch.name}" under "${region}"`);
        res.status(201).json({ success: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/tickets/branches/:id', checkAdminLogin, async (req, res) => {
    try {
        const branch = await Branch.findById(req.params.id);
        if (!branch) return res.status(404).json({ error: 'Branch not found' });
        const oldName = branch.name;
        if (req.body.name) branch.name = req.body.name.trim();
        if (req.body.region) branch.region = req.body.region.trim();
        await branch.save();
        if (req.body.name && oldName !== branch.name) {
            await StaffBranch.updateMany({ branches: oldName }, { $set: { "branches.$": branch.name } });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/tickets/branches/:id', checkAdminLogin, async (req, res) => {
    try {
        const branch = await Branch.findById(req.params.id);
        await Branch.findByIdAndDelete(req.params.id);
        if (branch) await StaffBranch.updateMany({}, { $pull: { branches: branch.name } });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/tickets/staff-list', checkAdminLogin, async (req, res) => {
    try {
        let query = {};
        if (!req.session.isSuperAdmin) query = { region: req.session.region };
        const staff = await Staff.find(query).sort({ name: 1 });
        res.json(staff.map(s => ({ id: s.staffId, name: s.name, email: s.email, region: s.region })));
    } catch (err) {
        res.status(500).json([]);
    }
});

app.get('/tickets/staff-branches', checkAdminLogin, async (req, res) => {
    try {
        const records = await StaffBranch.find();
        const map = {};
        records.forEach(r => { map[r.staffId] = r.branches; });
        res.json(map);
    } catch (err) {
        res.status(500).json({});
    }
});

app.post('/tickets/staff-branches', checkAdminLogin, async (req, res) => {
    try {
        const { staffId, branches } = req.body;
        await StaffBranch.findOneAndUpdate({ staffId }, { staffId, branches }, { upsert: true });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/tickets/staff', checkAdminLogin, async (req, res) => {
    try {
        const { name, email, password } = req.body;
        let staffId = (req.body.staffId || '').trim();
        if (!staffId) staffId = await getNextStaffId();
        const hashedPassword = await bcrypt.hash(password, 10);
        const newStaff = new Staff({
            staffId,
            name: name.trim(),
            email: email.trim(),
            password: hashedPassword,
            region: req.session.isSuperAdmin ? (req.body.region || '') : req.session.region
        });
        await newStaff.save();
        await logAudit(req.session.username, 'Add Staff', `Added staff ${newStaff.name} (${newStaff.staffId})`);
        res.status(201).json({ success: true, staffId: newStaff.staffId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/tickets/staff/:id', checkAdminLogin, async (req, res) => {
    try {
        const staff = await Staff.findOne({ staffId: req.params.id });
        if (!staff) return res.status(404).json({ error: 'Staff not found' });
        if (req.body.name) staff.name = req.body.name.trim();
        if (req.body.email) staff.email = req.body.email.trim();
        if (req.body.password) staff.password = await bcrypt.hash(req.body.password, 10);
        if (req.body.region !== undefined) staff.region = req.body.region;
        await staff.save();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/tickets/staff/:id', checkAdminLogin, async (req, res) => {
    try {
        await Staff.findOneAndDelete({ staffId: req.params.id });
        await StaffBranch.findOneAndDelete({ staffId: req.params.id });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/region-admins', checkSuperAdminLogin, async (req, res) => {
    try {
        const admins = await RegionAdmin.find().sort({ name: 1 });
        res.json(admins.map(a => ({ id: a._id, name: a.name, username: a.username, region: a.region, enabled: a.enabled })));
    } catch (err) {
        res.status(500).json([]);
    }
});

app.post('/region-admins', checkSuperAdminLogin, async (req, res) => {
    try {
        const { name, username, password, region } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const newAdmin = new RegionAdmin({ name, username, password: hashedPassword, region });
        await newAdmin.save();
        res.status(201).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/region-admins/:id', checkSuperAdminLogin, async (req, res) => {
    try {
        const admin = await RegionAdmin.findById(req.params.id);
        if (!admin) return res.status(404).json({ error: 'Admin not found' });
        if (req.body.name) admin.name = req.body.name.trim();
        if (req.body.region) admin.region = req.body.region;
        if (req.body.enabled !== undefined) admin.enabled = req.body.enabled;
        if (req.body.password) admin.password = await bcrypt.hash(req.body.password, 10);
        await admin.save();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/region-admins/:id', checkSuperAdminLogin, async (req, res) => {
    try {
        await RegionAdmin.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/audit-log', checkAdminLogin, async (req, res) => {
    try {
        const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(100);
        res.json(logs);
    } catch (err) {
        res.status(500).json([]);
    }
});

app.get('/inbox', checkUserLogin, async (req, res) => {
    try {
        let query = {};
        if (!req.session.isAdmin) query = { sender: req.session.username };
        const msgs = await InboxMessage.find(query).sort({ createdAt: -1 });
        res.json(msgs);
    } catch (err) {
        res.status(500).json([]);
    }
});

app.post('/inbox', checkUserLogin, async (req, res) => {
    try {
        const { subject, body } = req.body;
        const msg = new InboxMessage({
            sender: req.session.username,
            subject,
            body
        });
        await msg.save();
        res.status(201).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create ticket endpoint
app.post('/tickets', upload.single('screenshot'), async (req, res) => {
    try {
        const ticketNumber = await getNextTicketNumber();
        const { title, submittedBy, designation, category, branch, priority, description, mobile } = req.body;
        const screenshot = req.file ? req.file.path : null;

        let assignedTo = 'Unassigned';
        const assignedStaffRecord = await StaffBranch.findOne({ branches: branch });
        if (assignedStaffRecord) {
            const staffDoc = await Staff.findOne({ staffId: assignedStaffRecord.staffId });
            if (staffDoc) assignedTo = staffDoc.name;
        }

        const newTicket = new Ticket({
            ticketNumber,
            title,
            submittedBy,
            designation,
            category,
            branch,
            priority,
            description,
            mobile,
            screenshot,
            assignedTo,
            status: 'Open'
        });

        await newTicket.save();

        if (assignedTo !== 'Unassigned') {
            await Notification.create({
                recipient: assignedTo,
                ticketId: newTicket._id,
                ticketNumber: newTicket.ticketNumber,
                title: newTicket.title,
                message: `New Ticket #${String(newTicket.ticketNumber).padStart(4, '0')} assigned to you.`
            });
        }

        res.status(201).json({ success: true, ticketNumber });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Ticket creation failed.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running smoothly on port ${PORT}`);
});
