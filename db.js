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

const { Sequelize, DataTypes } = require('sequelize');

const sequelize = new Sequelize(
    process.env.MYSQL_DATABASE || 'helpdesk',
    process.env.MYSQL_USER || 'root',
    process.env.MYSQL_PASSWORD || 'Sarathy@65',
    {
        host: process.env.MYSQL_HOST || 'localhost',
        port: process.env.MYSQL_PORT || 3306,
        dialect: 'mysql',
        logging: false, // set to console.log while debugging a specific query
        pool: { max: 10, min: 0, acquire: 30000, idle: 10000 }
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
    region: { type: DataTypes.STRING(120), defaultValue: 'Unassigned' }
}, { tableName: 'branches', timestamps: false });

// --- Staff ---
const Staff = sequelize.define('Staff', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    staffId: { type: DataTypes.STRING(20), allowNull: false, unique: true, field: 'staff_id' },
    name: { type: DataTypes.STRING(150), allowNull: false },
    password: { type: DataTypes.STRING(255), allowNull: false },
    email: { type: DataTypes.STRING(150), allowNull: false },
    region: { type: DataTypes.STRING(120), defaultValue: '' } // '' = unassigned/global
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
    region: { type: DataTypes.STRING(120), allowNull: false },
    enabled: { type: DataTypes.BOOLEAN, defaultValue: true }
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
    escalated: { type: DataTypes.BOOLEAN, defaultValue: false },
    escalatedBy: { type: DataTypes.STRING(150), defaultValue: '', field: 'escalated_by' },
    escalatedAt: { type: DataTypes.DATE, field: 'escalated_at' },
    escalationReason: { type: DataTypes.STRING(500), defaultValue: '', field: 'escalation_reason' },
    createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'created_at' },
    resolvedAt: { type: DataTypes.DATE, field: 'resolved_at' },
    resolvedBy: { type: DataTypes.STRING(150), defaultValue: '', field: 'resolved_by' }
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
    subject: { type: DataTypes.STRING(255), allowNull: false },
    body: { type: DataTypes.TEXT, allowNull: false },
    status: { type: DataTypes.STRING(20), defaultValue: 'Open' },
    reply: { type: DataTypes.TEXT, defaultValue: '' },
    repliedBy: { type: DataTypes.STRING(150), defaultValue: '', field: 'replied_by' },
    repliedAt: { type: DataTypes.DATE, field: 'replied_at' },
    adminRead: { type: DataTypes.BOOLEAN, defaultValue: false, field: 'admin_read' },
    staffRead: { type: DataTypes.BOOLEAN, defaultValue: true, field: 'staff_read' },
    createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'created_at' }
}, { tableName: 'inbox_messages', timestamps: false });

module.exports = {
    sequelize,
    Region,
    Branch,
    Staff,
    StaffBranchAssignment,
    RegionAdmin,
    Ticket,
    TicketComment,
    AuditLog,
    Notification,
    InboxMessage
};