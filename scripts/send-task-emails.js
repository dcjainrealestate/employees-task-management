#!/usr/bin/env node
// Sends the real emails for the Task Management System's mail feature.
// Runs from GitHub Actions (.github/workflows/task-emails.yml), not from the
// browser app, because this needs raw Gmail SMTP, which only a real Node
// environment can do (Supabase Edge Functions are HTTPS-only).
//
// Modes:
//   daily     - every active member with an email gets a digest of what's
//               due today and what's overdue / not completed. Fired by the
//               workflow's daily schedule.
//   broadcast - sends one admin-composed message to every active member
//               with an email. Fired by the app's "Send Update to All"
//               button via a repository_dispatch event.
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

// Same public anon key already embedded in index.html — read-only access to
// non-sensitive task/employee data, not a secret.
const SUPABASE_URL = 'https://iubvxxihxqesabwflxsq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_sZr74GUFEBqYaAJi8ar_fg_FtiYhsHz';

const mode = process.argv[2];
if (mode !== 'daily' && mode !== 'broadcast') {
  console.error('Usage: node send-task-emails.js <daily|broadcast>');
  process.exit(1);
}

function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function taskListHtml(tasks) {
  if (!tasks.length) return '<p style="color:#6b7280;margin:4px 0 16px">None — you\'re all caught up here.</p>';
  return (
    '<ul style="margin:4px 0 16px;padding-left:20px">' +
    tasks
      .map((t) => '<li style="margin-bottom:6px"><strong>' + escapeHtml(t.name) + '</strong> — ' + escapeHtml(t.priority) + ' priority, due ' + fmtDate(t.due_date) + '</li>')
      .join('') +
    '</ul>'
  );
}

async function main() {
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  const { data: employees, error: empErr } = await sb.from('employees').select('*').eq('active', true);
  if (empErr) throw empErr;
  const recipients = employees.filter((e) => e.email);
  if (!recipients.length) {
    console.log('No active employees have an email on file — nothing to send.');
    return;
  }

  async function sendMail(to, subject, html) {
    await transporter.sendMail({ from: '"DC Jain Task Management" <' + process.env.GMAIL_USER + '>', to, subject, html });
  }

  if (mode === 'broadcast') {
    const subject = (process.env.BROADCAST_SUBJECT || '').trim();
    const message = (process.env.BROADCAST_MESSAGE || '').trim();
    const senderName = (process.env.BROADCAST_SENDER || 'Admin').trim();
    if (!subject || !message) {
      console.error('Missing BROADCAST_SUBJECT or BROADCAST_MESSAGE');
      process.exit(1);
    }
    const html =
      '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937;max-width:560px">' +
      '<p style="white-space:pre-wrap">' + escapeHtml(message) + '</p>' +
      '<p style="margin-top:24px;color:#6b7280;font-size:12px">— ' + escapeHtml(senderName) + ', via DC Jain Task Management</p>' +
      '</div>';
    let sent = 0, failed = 0;
    for (const emp of recipients) {
      try { await sendMail(emp.email, subject, html); sent++; }
      catch (e) { failed++; console.error('Failed to email', emp.email, e.message); }
    }
    console.log('Broadcast sent to ' + sent + ' of ' + recipients.length + ' recipients (' + failed + ' failed).');
    return;
  }

  // mode === 'daily'
  const { data: tasks, error: taskErr } = await sb.from('tasks').select('*');
  if (taskErr) throw taskErr;
  const today = todayISO();

  let sent = 0, failed = 0;
  for (const emp of recipients) {
    const mine = tasks.filter((t) => t.assigned_to === emp.id);
    const dueToday = mine.filter((t) => t.status !== 'Completed' && t.status !== 'Cancelled' && t.due_date === today);
    const overdue = mine.filter((t) => t.status !== 'Completed' && t.status !== 'Cancelled' && t.due_date && t.due_date < today);

    const html =
      '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937;max-width:560px">' +
      '<p>Hi ' + escapeHtml(emp.name.split(' ')[0]) + ',</p>' +
      '<p>Here\'s your task update for ' + fmtDate(today) + ':</p>' +
      '<h3 style="margin:18px 0 4px;font-size:14px">Due Today</h3>' + taskListHtml(dueToday) +
      '<h3 style="margin:18px 0 4px;font-size:14px;color:#b91c1c">Pending / Not Completed (Overdue)</h3>' + taskListHtml(overdue) +
      (overdue.length ? '<p style="color:#b91c1c;font-weight:bold">Please update or complete these as soon as you can.</p>' : '') +
      '<p style="margin-top:24px;color:#6b7280;font-size:12px">This is an automated daily update from DC Jain Task Management.</p>' +
      '</div>';
    const subject = (overdue.length ? '[' + overdue.length + ' Overdue] ' : '') + 'Your Daily Task Update — ' + fmtDate(today);

    try { await sendMail(emp.email, subject, html); sent++; }
    catch (e) { failed++; console.error('Failed to email', emp.email, e.message); }
  }
  console.log('Daily digest sent to ' + sent + ' of ' + recipients.length + ' recipients (' + failed + ' failed).');
}

main().catch((e) => { console.error(e); process.exit(1); });
