require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'complaints.json');

// Ensure data directory exists
const dataDir = path.dirname(DATA_FILE);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Middleware
app.use(cors());
app.use(bodyParser.json());

// --- Data helpers ---
function readComplaints() {
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

function writeComplaints(complaints) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(complaints, null, 2));
}

function sanitizeComplaint(complaint) {
  // Strip email before sending to any client
  const { email, ...rest } = complaint;
  return rest;
}

// --- Email transporter ---
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  connectionTimeout: 10000,  // 10s - fail fast if SMTP unreachable
  greetingTimeout: 10000,   // 10s
  socketTimeout: 10000,     // 10s
});

// --- Health check ---
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Routes ---

// Submit a new complaint
app.post('/api/complaints', (req, res) => {
  const { name, email, category, description } = req.body;

  if (!name || !email || !category || !description) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const complaint = {
    id: uuidv4(),
    name: name.trim(),
    email: email.trim().toLowerCase(),
    category,
    description: description.trim(),
    status: 'open',
    replySent: false,
    createdAt: new Date().toISOString(),
  };

  const complaints = readComplaints();
  complaints.push(complaint);
  writeComplaints(complaints);

  res.json({ id: complaint.id, message: 'Complaint submitted successfully.' });
});

// Get all complaints (email stripped)
app.get('/api/complaints', (req, res) => {
  const complaints = readComplaints();
  res.json(complaints.map(sanitizeComplaint));
});

// Get single complaint (email stripped)
app.get('/api/complaints/:id', (req, res) => {
  const complaints = readComplaints();
  const complaint = complaints.find(c => c.id === req.params.id);
  if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });
  res.json(sanitizeComplaint(complaint));
});

// Update complaint status
app.patch('/api/complaints/:id', (req, res) => {
  const { status } = req.body;
  const complaints = readComplaints();
  const idx = complaints.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Complaint not found.' });

  const validStatuses = ['open', 'in_progress', 'resolved'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }

  if (status) complaints[idx].status = status;
  writeComplaints(complaints);

  res.json(sanitizeComplaint(complaints[idx]));
});

// Send email to complaint submitter (dashboard cannot see email, only triggers send)
app.post('/api/complaints/:id/email', async (req, res) => {
  const { subject, body } = req.body;

  if (!subject || !body) {
    return res.status(400).json({ error: 'Subject and body are required.' });
  }

  const complaints = readComplaints();
  const complaint = complaints.find(c => c.id === req.params.id);
  if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });

  try {
    const info = await transporter.sendMail({
      from: `"${process.env.FROM_NAME}" <${process.env.FROM_EMAIL}>`,
      to: complaint.email,
      subject,
      text: body,
    });

    // Mark replySent
    const idx = complaints.findIndex(c => c.id === req.params.id);
    complaints[idx].replySent = true;
    writeComplaints(complaints);

    res.json({ success: true, messageId: info.messageId });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: 'Failed to send email.' });
  }
});

app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);
});
