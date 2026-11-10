// db.js — MySQL connection + Sequelize models for the staging (MySQL) version of the helpdesk.
// This mirrors the Mongoose schemas in server.js as closely as possible, so route logic
// converts with minimal behavior change. Two things that were Mongo-specific had to change:
//
// 1. Ticket.comments (an embedded array in Mongo) is now its own table, TicketComment,
//    linked to Ticket via a foreign key. Loading a ticket's comments now means an extra
//    query/association instead of it just being part of the document.
//
// 2. StaffBranch.branches (an embedded array of branch names) is now its own table,
//    StaffBranchAssignment, with one row per (staffId, branchName) pair.
//
// 3. The Counter model (used to hand out sequential ticket numbers in Mongo, since Mongo
//    has no native auto-increment) is gone entirely — MySQL's own AUTO_INCREMENT on
//    Ticket.id does that job natively and atomically. ticketNumber is just the row's id.
//
// Everything else (Region, Branch, Staff, RegionAdmin, AuditLog, Notification, InboxMessage)
// maps over field-for-field. Region/branch relationships stay as plain strings (not foreign
// keys) — matching the original's loose, rename-by-string-update design — to keep the port
// mechanical and low-risk rather than introducing a schema redesign.

const fs = require('fs');
const { Sequelize, DataTypes } = require('sequelize');

// Managed MySQL (Aiven, Render, etc.) refuses plain connections — TLS is required,
// while a local XAMPP/Workbench MySQL has no TLS. So: enable TLS whenever we are not
// connecting to localhost, or when MYSQL_SSL=1 forces it. If MYSQL_CA_FILE points at
// the service's CA certificate we verify it strictly; otherwise TLS still encrypts but
// skips certificate verification, so the app works before the cert is downloaded.
const useTls = process.env.MYSQL_SSL === '1' ||
    (!!process.env.MYSQL_HOST && !['localhost', '127.0.0.1'].includes(process.env.MYSQL_HOST));
const tlsOptions = useTls
    ? (process.env.MYSQL_CA_FILE
        ? { require: true, rejectUnauthorized: true, ca: fs.readFileSync(process.env.MYSQL_CA_FILE, 'utf8') }
        : { require: true, rejectUnauthorized: false })
    : undefined;

const sequelize = new Sequelize(
    process.env.MYSQL_DATABASE || 'helpdesk',
    process.env.MYSQL_USER || 'root',
    process.env.MYSQL_PASSWORD || '',
    {
        host: process.env.MYSQL_HOST || 'localhost',
        port: process.env.MYSQL_PORT || 3306,
        dialect: 'mysql',
        logging: false, // set to console.log while debugging a specific query
        pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
        dialectOptions: { ssl: tlsOptions } // ssl: undefined = plain connection (local dev)
    }
);

// --- Region ---
const Region = sequelize.define('Region', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(120), allowNull: false, unique: true }
}, { tableName: 'regions', timestamps: false });

// --- Branch ---
const Branch = sequelize.define('Branch', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(150), allowNull: false },
    region: { type: DataTypes.STRING(120), defaultValue: 'Unassigned' },
    // Branch code stamped at the front of ticket numbers issued through this branch
    // (e.g. SAC70 -> #SAC70/0001). NULL = branch keeps legacy #0001 numbering.
    code: { type: DataTypes.STRING(12), allowNull: true, unique: true },
    // Per-branch ticket counter - bumped atomically when a ticket is created.
    ticketSeq: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'ticket_seq' },
    // Per-branch assignment cursor - bumped atomically on every auto-assigned ticket so
    // branch staff rotate strictly 1,2,3,1,2,3 without races (unlike counting tickets).
    assignSeq: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'assign_seq' }
}, { tableName: 'branches', timestamps: false });

// --- Staff ---
const Staff = sequelize.define('Staff', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    staffId: { type: DataTypes.STRING(20), allowNull: false, unique: true, field: 'staff_id' },
    name: { type: DataTypes.STRING(150), allowNull: false },
    password: { type: DataTypes.STRING(255), allowNull: false },
    email: { type: DataTypes.STRING(150), allowNull: false },
    region: { type: DataTypes.STRING(120), defaultValue: '' }, // '' = unassigned/global
    mobile: { type: DataTypes.STRING(20), allowNull: true }, // 10-digit Indian mobile; NULL for staff added before this
    photoUrl: { type: DataTypes.STRING(500), field: 'photo_url' } // Cloudinary avatar, NULL = initials
}, { tableName: 'staff', timestamps: false });

// --- StaffBranchAssignment (was StaffBranch.branches[] in Mongo — one row per pairing) ---
const StaffBranchAssignment = sequelize.define('StaffBranchAssignment', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    staffId: { type: DataTypes.STRING(20), allowNull: false, field: 'staff_id' },
    branchName: { type: DataTypes.STRING(150), allowNull: false, field: 'branch_name' }
}, {
    tableName: 'staff_branch_assignments',
    timestamps: false,
    indexes: [{ unique: true, fields: ['staff_id', 'branch_name'] }]
});

// --- RegionAdmin ---
const RegionAdmin = sequelize.define('RegionAdmin', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(150), allowNull: false },
    username: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    password: { type: DataTypes.STRING(255), allowNull: false },
    // Comma-separated region list (e.g. "KOLLAM, TRIVANDRUM") — a region admin can
    // now be assigned multiple regions; widened on boot by ensureRegionAdminColumns().
    region: { type: DataTypes.STRING(500), allowNull: false },
    enabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    photoUrl: { type: DataTypes.STRING(500), field: 'photo_url' } // Cloudinary avatar, NULL = initials
}, { tableName: 'region_admins', timestamps: false });

// --- Ticket ---
// ticketNumber is just this row's auto-increment id — no separate counter needed in MySQL.
const Ticket = sequelize.define('Ticket', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    title: { type: DataTypes.STRING(255) },
    submittedBy: { type: DataTypes.STRING(150), defaultValue: 'Unknown', field: 'submitted_by' },
    designation: { type: DataTypes.STRING(150), defaultValue: '' },
    category: { type: DataTypes.STRING(50), defaultValue: 'Other' },
    branch: { type: DataTypes.STRING(150), defaultValue: 'N/A' },
    priority: { type: DataTypes.STRING(20), defaultValue: 'Medium' },
    description: { type: DataTypes.TEXT },
    mobile: { type: DataTypes.STRING(20), allowNull: false },
    screenshot: { type: DataTypes.STRING(500) },
    status: { type: DataTypes.STRING(20), defaultValue: 'Open' },
    assignedTo: { type: DataTypes.STRING(150), defaultValue: 'Unassigned', field: 'assigned_to' },
    // Which staff ROW owns this ticket. Ownership follows the record, never the name, so
    // deleting a staff member and creating a new one with the same name cannot hand the
    // old person's tickets to the new person. The historical assigned_to text is kept.
    assignedStaffId: { type: DataTypes.INTEGER, field: 'assigned_staff_id' },
    escalated: { type: DataTypes.BOOLEAN, defaultValue: false },
    escalatedBy: { type: DataTypes.STRING(150), defaultValue: '', field: 'escalated_by' },
    escalatedByStaffId: { type: DataTypes.INTEGER, field: 'escalated_by_staff_id' },
    escalatedAt: { type: DataTypes.DATE, field: 'escalated_at' },
    escalationReason: { type: DataTypes.STRING(500), defaultValue: '', field: 'escalation_reason' },
    createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'created_at' },
    resolvedAt: { type: DataTypes.DATE, field: 'resolved_at' },
    resolvedBy: { type: DataTypes.STRING(150), defaultValue: '', field: 'resolved_by' },
    // Number stamped at creation for coded branches (SAC70/0001); NULL = legacy
    // id-based number (#0001). Never rewritten, so renaming a branch or changing its
    // code never alters numbers already issued.
    displayNumber: { type: DataTypes.STRING(40), allowNull: true, unique: true, field: 'display_number' }
}, { tableName: 'tickets', timestamps: false });

// --- TicketComment (was Ticket.comments[] in Mongo) ---
const TicketComment = sequelize.define('TicketComment', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    ticketId: { type: DataTypes.INTEGER, allowNull: false, field: 'ticket_id' },
    author: { type: DataTypes.STRING(150) },
    text: { type: DataTypes.TEXT },
    attachment: { type: DataTypes.STRING(500) },
    createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'created_at' }
}, { tableName: 'ticket_comments', timestamps: false });

Ticket.hasMany(TicketComment, { foreignKey: 'ticketId', as: 'comments' });
TicketComment.belongsTo(Ticket, { foreignKey: 'ticketId' });

// --- AuditLog ---
const AuditLog = sequelize.define('AuditLog', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    actor: { type: DataTypes.STRING(150), allowNull: false },
    action: { type: DataTypes.STRING(150), allowNull: false },
    details: { type: DataTypes.TEXT },
    createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'created_at' }
}, { tableName: 'audit_logs', timestamps: false });

// --- Notification ---
const Notification = sequelize.define('Notification', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    recipient: { type: DataTypes.STRING(150), allowNull: false },
    recipientStaffId: { type: DataTypes.INTEGER, field: 'recipient_staff_id' },
    ticketId: { type: DataTypes.INTEGER, allowNull: false, field: 'ticket_id' },
    ticketNumber: { type: DataTypes.INTEGER, allowNull: false, field: 'ticket_number' },
    title: { type: DataTypes.STRING(255), allowNull: false },
    message: { type: DataTypes.TEXT, allowNull: false },
    read: { type: DataTypes.BOOLEAN, defaultValue: false },
    createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'created_at' }
}, { tableName: 'notifications', timestamps: false });

// --- InboxMessage ---
const InboxMessage = sequelize.define('InboxMessage', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    sender: { type: DataTypes.STRING(150), allowNull: false },
    senderStaffId: { type: DataTypes.STRING(20), defaultValue: '', field: 'sender_staff_id' },
    // The staff ROW that sent it (senderStaffId is an editable display id, a name can be
    // reused after a delete) - this is what a staff member's own inbox is matched on.
    senderRowId: { type: DataTypes.INTEGER, field: 'sender_row_id' },
    subject: { type: DataTypes.STRING(255), allowNull: false },
    body: { type: DataTypes.TEXT, allowNull: false },
    status: { type: DataTypes.STRING(20), defaultValue: 'Open' },
    reply: { type: DataTypes.TEXT, defaultValue: '' },
    repliedBy: { type: DataTypes.STRING(150), defaultValue: '', field: 'replied_by' },
    repliedAt: { type: DataTypes.DATE, field: 'replied_at' },
    adminRead: { type: DataTypes.BOOLEAN, defaultValue: false, field: 'admin_read' },
    staffRead: { type: DataTypes.BOOLEAN, defaultValue: true, field: 'staff_read' },
    // Admin broadcast: the sender keeps one "Sent" row (broadcast_header = 1, broadcast_id =
    // its own id) and each recipient staff row gets its own copy carrying recipient_row_id,
    // so read/unread stays per person and the admin never sees one card per recipient.
    recipientRowId: { type: DataTypes.INTEGER, field: 'recipient_row_id' },
    broadcastId: { type: DataTypes.INTEGER, field: 'broadcast_id' },
    // Set on a staff reply so the sender's "Sent" card can name who answered. The reply is
    // still an ordinary message in the admin's inbox - this is only a back-reference.
    replyToBroadcastId: { type: DataTypes.INTEGER, field: 'reply_to_broadcast_id' },
    broadcastHeader: { type: DataTypes.BOOLEAN, defaultValue: false, field: 'broadcast_header' },
    audience: { type: DataTypes.STRING(255), defaultValue: '' },
    createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'created_at' }
}, { tableName: 'inbox_messages', timestamps: false });

// --- TicketChecklist (mandatory resolution checklist: one row per ticket+item) ---
const TicketChecklist = sequelize.define('TicketChecklist', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    ticketId: { type: DataTypes.INTEGER, allowNull: false, field: 'ticket_id' },
    itemKey: { type: DataTypes.STRING(60), allowNull: false, field: 'item_key' },
    state: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' }, // pending | done | na
    answer: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    updatedBy: { type: DataTypes.STRING(150), allowNull: false, defaultValue: '', field: 'updated_by' },
    updatedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'updated_at' }
}, {
    tableName: 'ticket_checklists',
    timestamps: false,
    indexes: [{ unique: true, fields: ['ticket_id', 'item_key'] }]
});

Ticket.hasMany(TicketChecklist, { foreignKey: 'ticketId', as: 'checklist' });
TicketChecklist.belongsTo(Ticket, { foreignKey: 'ticketId' });

// --- Startup migration -------------------------------------------------------
// Plain sequelize.sync() only creates missing tables - it never ALTERs an existing
// one, so the branch-code columns are added here. Checks information_schema first
// and only issues the ALTER when the column is missing (MySQL has no
// "ADD COLUMN IF NOT EXISTS"), so it is safe on every boot, local and production.
async function ensureBranchCodeColumns() {
    const wanted = [
        { table: 'branches', column: 'code', ddl: 'ADD COLUMN code VARCHAR(12) NULL UNIQUE AFTER region' },
        { table: 'branches', column: 'ticket_seq', ddl: 'ADD COLUMN ticket_seq INT NOT NULL DEFAULT 0 AFTER code' },
        { table: 'branches', column: 'assign_seq', ddl: 'ADD COLUMN assign_seq INT NOT NULL DEFAULT 0 AFTER ticket_seq' },
        { table: 'tickets', column: 'display_number', ddl: 'ADD COLUMN display_number VARCHAR(40) NULL UNIQUE AFTER resolved_by' }
    ];
    for (const w of wanted) {
        const [[row]] = await sequelize.query(
            'SELECT COUNT(*) AS n FROM information_schema.COLUMNS ' +
            'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column',
            { replacements: { table: w.table, column: w.column } }
        );
        if (Number(row.n) === 0) {
            await sequelize.query('ALTER TABLE ' + w.table + ' ' + w.ddl);
        }
    }
}

// Widen region_admins.region when it was created narrower (the model originally
// declared 120 chars) so one row can hold several comma-separated region names.
// Reads CHARACTER_MAXIMUM_LENGTH first and only issues the MODIFY when needed,
// so it is idempotent and safe on every boot — same pattern as above.
async function ensureRegionAdminColumns() {
    const [[col]] = await sequelize.query(
        'SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.COLUMNS ' +
        'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column',
        { replacements: { table: 'region_admins', column: 'region' } }
    );
    if (col && Number(col.len) < 500) {
        await sequelize.query('ALTER TABLE region_admins MODIFY COLUMN region VARCHAR(500) NOT NULL');
    }
}

// Staff identity ---------------------------------------------------------------
// Tickets, bell notifications and inbox messages belong to a staff ROW (staff.id), not
// to the name typed at creation. Deleting "TEST" and later creating a new "TEST" must
// not hand the old person's queue, bell or inbox to the new person, and renaming a staff
// member must not lose their own. Columns are added here (plain sequelize.sync() never
// ALTERs an existing table) and the backfill runs ONLY on the boot that adds each column:
// it links today's rows to today's staff, and is never repeated - a name re-used later
// would otherwise adopt rows that belong to a previous, deleted person.
async function ensureStaffIdentityColumns() {
    const wanted = [
        {
            table: 'tickets', column: 'assigned_staff_id',
            ddl: 'ADD COLUMN assigned_staff_id INT NULL',
            backfill: 'UPDATE tickets t JOIN staff s ON t.assigned_to = s.name SET t.assigned_staff_id = s.id WHERE t.assigned_staff_id IS NULL'
        },
        {
            table: 'tickets', column: 'escalated_by_staff_id',
            ddl: 'ADD COLUMN escalated_by_staff_id INT NULL',
            backfill: 'UPDATE tickets t JOIN staff s ON t.escalated_by = s.name SET t.escalated_by_staff_id = s.id WHERE t.escalated_by_staff_id IS NULL'
        },
        {
            table: 'notifications', column: 'recipient_staff_id',
            ddl: 'ADD COLUMN recipient_staff_id INT NULL',
            backfill: 'UPDATE notifications n JOIN staff s ON n.recipient = s.name SET n.recipient_staff_id = s.id WHERE n.recipient_staff_id IS NULL'
        },
        {
            table: 'inbox_messages', column: 'sender_row_id',
            ddl: 'ADD COLUMN sender_row_id INT NULL',
            backfill: 'UPDATE inbox_messages m JOIN staff s ON m.sender = s.name SET m.sender_row_id = s.id WHERE m.sender_row_id IS NULL'
        }
    ];
    for (const w of wanted) {
        const [[row]] = await sequelize.query(
            'SELECT COUNT(*) AS n FROM information_schema.COLUMNS ' +
            'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column',
            { replacements: { table: w.table, column: w.column } }
        );
        if (Number(row.n) === 0) {
            await sequelize.query('ALTER TABLE ' + w.table + ' ' + w.ddl);
            await sequelize.query(w.backfill);
        }
    }
}

// Inbox broadcasts -------------------------------------------------------------
// A message an admin sends to staff is stored as one "Sent" row plus one copy per
// recipient staff row. These columns let an existing database grow the feature without
// a rebuild; no backfill is needed because every row that predates them is a staff ->
// admin message (recipient_row_id NULL), which is exactly how they are still read.
async function ensureInboxBroadcastColumns() {
    const wanted = [
        { column: 'recipient_row_id', ddl: 'ADD COLUMN recipient_row_id INT NULL' },
        { column: 'broadcast_id', ddl: 'ADD COLUMN broadcast_id INT NULL' },
        { column: 'broadcast_header', ddl: 'ADD COLUMN broadcast_header TINYINT(1) NOT NULL DEFAULT 0' },
        { column: 'audience', ddl: "ADD COLUMN audience VARCHAR(255) NOT NULL DEFAULT ''" },
        { column: 'reply_to_broadcast_id', ddl: 'ADD COLUMN reply_to_broadcast_id INT NULL' }
    ];
    for (const w of wanted) {
        const [[row]] = await sequelize.query(
            'SELECT COUNT(*) AS n FROM information_schema.COLUMNS ' +
            'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column',
            { replacements: { table: 'inbox_messages', column: w.column } }
        );
        if (Number(row.n) === 0) {
            await sequelize.query('ALTER TABLE inbox_messages ' + w.ddl);
        }
    }
}

// Staff mobile number -----------------------------------------------------------
// Added on boot for databases created before staff carried a mobile number; NULL means
// "not recorded yet", which My Profile simply omits.
async function ensureStaffMobileColumn() {
    const [[row]] = await sequelize.query(
        'SELECT COUNT(*) AS n FROM information_schema.COLUMNS ' +
        'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column',
        { replacements: { table: 'staff', column: 'mobile' } }
    );
    if (Number(row.n) === 0) {
        await sequelize.query('ALTER TABLE staff ADD COLUMN mobile VARCHAR(20) NULL');
    }
}

// Profile photos ----------------------------------------------------------------
// Added on boot for databases created before My Profile existed; NULL simply means the
// avatar falls back to the person's initials, so no backfill is needed.
async function ensureProfilePhotoColumns() {
    for (const table of ['staff', 'region_admins']) {
        const [[row]] = await sequelize.query(
            'SELECT COUNT(*) AS n FROM information_schema.COLUMNS ' +
            'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column',
            { replacements: { table, column: 'photo_url' } }
        );
        if (Number(row.n) === 0) {
            await sequelize.query('ALTER TABLE ' + table + ' ADD COLUMN photo_url VARCHAR(500) NULL');
        }
    }
}

module.exports = {
    sequelize,
    ensureBranchCodeColumns,
    ensureRegionAdminColumns,
    ensureStaffIdentityColumns,
    ensureInboxBroadcastColumns,
    ensureProfilePhotoColumns,
    ensureStaffMobileColumn,
    Region,
    Branch,
    Staff,
    StaffBranchAssignment,
    RegionAdmin,
    Ticket,
    TicketComment,
    AuditLog,
    Notification,
    InboxMessage,
    TicketChecklist
};