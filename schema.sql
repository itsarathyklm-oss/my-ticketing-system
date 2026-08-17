-- schema.sql — MySQL schema for the Sarathy IT Helpdesk staging (MySQL) build.
-- Run this in MySQL Workbench against your staging database, OR skip it entirely —
-- server-mysql.js can also create these tables automatically on first run via
-- sequelize.sync(). Doing it here first just lets you see/adjust the schema in
-- Workbench before any app code touches it.

CREATE DATABASE IF NOT EXISTS helpdesk CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE helpdesk;

CREATE TABLE regions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL UNIQUE
) ENGINE=InnoDB;

CREATE TABLE branches (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    region VARCHAR(120) DEFAULT 'Unassigned'
) ENGINE=InnoDB;

CREATE TABLE staff (
    id INT AUTO_INCREMENT PRIMARY KEY,
    staff_id VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(150) NOT NULL,
    password VARCHAR(255) NOT NULL,
    email VARCHAR(150) NOT NULL,
    region VARCHAR(120) DEFAULT ''
) ENGINE=InnoDB;

CREATE TABLE staff_branch_assignments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    staff_id VARCHAR(20) NOT NULL,
    branch_name VARCHAR(150) NOT NULL,
    UNIQUE KEY unique_staff_branch (staff_id, branch_name)
) ENGINE=InnoDB;

CREATE TABLE region_admins (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    username VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    region VARCHAR(120) NOT NULL,
    enabled BOOLEAN DEFAULT TRUE
) ENGINE=InnoDB;

-- ticket_number from the old Mongo Counter model is gone — the auto-increment `id`
-- here does that job natively. Ticket #0024 in the UI is just id = 24.
CREATE TABLE tickets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255),
    submitted_by VARCHAR(150) DEFAULT 'Unknown',
    designation VARCHAR(150) DEFAULT '',
    category VARCHAR(50) DEFAULT 'Other',
    branch VARCHAR(150) DEFAULT 'N/A',
    priority VARCHAR(20) DEFAULT 'Medium',
    description TEXT,
    mobile VARCHAR(20) NOT NULL,
    screenshot VARCHAR(500),
    status VARCHAR(20) DEFAULT 'Open',
    assigned_to VARCHAR(150) DEFAULT 'Unassigned',
    escalated BOOLEAN DEFAULT FALSE,
    escalated_by VARCHAR(150) DEFAULT '',
    escalated_at DATETIME NULL,
    escalation_reason VARCHAR(500) DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME NULL,
    resolved_by VARCHAR(150) DEFAULT ''
) ENGINE=InnoDB;

CREATE TABLE ticket_comments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ticket_id INT NOT NULL,
    author VARCHAR(150),
    text TEXT,
    attachment VARCHAR(500),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE audit_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    actor VARCHAR(150) NOT NULL,
    action VARCHAR(150) NOT NULL,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    recipient VARCHAR(150) NOT NULL,
    ticket_id INT NOT NULL,
    ticket_number INT NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    `read` BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE inbox_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sender VARCHAR(150) NOT NULL,
    sender_staff_id VARCHAR(20) DEFAULT '',
    subject VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'Open',
    reply TEXT,
    replied_by VARCHAR(150) DEFAULT '',
    replied_at DATETIME NULL,
    admin_read BOOLEAN DEFAULT FALSE,
    staff_read BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;