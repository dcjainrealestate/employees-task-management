#!/usr/bin/env node
// Sends the real emails for the Task Management System's mail feature.
// Runs from GitHub Actions (.github/workflows/task-emails.yml), not from the
// browser app, because this needs raw Gmail SMTP, which only a real Node
// environment can do (Supabase Edge Functions are HTTPS-only).
//
// Modes:
//   daily          - every active member with an email gets a digest of
//                    what's due today and what's overdue / not completed.
//                    Fired by the workflow's daily schedule.
//   broadcast      - sends one admin-composed message to every active member
//                    (or one, if BROADCAST_RECIPIENT is set) with an email.
//                    Fired by the app's "Send Update" button.
//   task-assigned  - sends one instant email to whoever a task was just
//                    assigned to. Fired automatically by DB.addTask() in the
//                    app whenever a task's assignee differs from its creator.
//   failure-alert  - sends GMAIL_USER itself a short email when a daily,
//                    broadcast, or task-assigned step in this same workflow
//                    run failed, so a broken secret or a Gmail outage gets
//                    noticed instead of silently skipping everyone's email.
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

// Same public anon key already embedded in index.html — read-only access to
// non-sensitive task/employee data, not a secret.
const SUPABASE_URL = 'https://iubvxxihxqesabwflxsq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_sZr74GUFEBqYaAJi8ar_fg_FtiYhsHz';

const mode = process.argv[2];
if (mode !== 'daily' && mode !== 'broadcast' && mode !== 'task-assigned' && mode !== 'failure-alert') {
  console.error('Usage: node send-task-emails.js <daily|broadcast|task-assigned|failure-alert>');
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
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  async function sendMail(to, subject, html) {
    await transporter.sendMail({ from: '"DC Jain Task Management" <' + process.env.GMAIL_USER + '>', to, subject, html });
  }

  if (mode === 'failure-alert') {
    const to = (process.env.GMAIL_USER || '').trim();
    const event = (process.env.FAILED_EVENT || 'unknown').trim();
    const runUrl = (process.env.FAILED_RUN_URL || '').trim();
    if (!to) {
      console.error('Missing GMAIL_USER — cannot send a failure alert to anyone');
      process.exit(1);
    }
    const html =
      '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937;max-width:560px">' +
      '<p>A step in the Task Emails workflow just failed (triggered by a <strong>' + escapeHtml(event) + '</strong> event).</p>' +
      (runUrl ? '<p><a href="' + runUrl + '">View the failed run on GitHub</a></p>' : '') +
      '<p style="color:#6b7280;font-size:12px;margin-top:16px">If this was the daily digest, members did not get their task update today. Check the run logs for the actual error.</p>' +
      '</div>';
    // Best-effort: if the failure itself was bad Gmail credentials, this
    // send will also fail — GitHub's own failure notification to the repo
    // owner is the fallback in that specific case.
    try {
      await sendMail(to, 'Task Emails workflow failed', html);
      console.log('Failure alert sent to ' + to);
    } catch (e) {
      console.error('Could not even send the failure alert:', e.message);
      process.exit(1);
    }
    return;
  }

  if (mode === 'task-assigned') {
    const to = (process.env.TASK_RECIPIENT || '').trim();
    const taskName = (process.env.TASK_NAME || '').trim();
    const dueDate = (process.env.TASK_DUE_DATE || '').trim();
    const assignedBy = (process.env.TASK_ASSIGNED_BY || 'A teammate').trim();
    if (!to || !taskName) {
      console.error('Missing TASK_RECIPIENT or TASK_NAME');
      process.exit(1);
    }
    const html =
      '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937;max-width:560px">' +
      '<p>You\'ve been assigned a new task:</p>' +
      '<p style="font-size:16px;font-weight:bold;margin:12px 0 4px">' + escapeHtml(taskName) + '</p>' +
      (dueDate ? '<p style="margin:0 0 12px">Due: ' + fmtDate(dueDate) + '</p>' : '') +
      '<p style="color:#6b7280;font-size:12px;margin-top:4px">Assigned by ' + escapeHtml(assignedBy) + '.</p>' +
      '<p style="margin-top:24px;color:#6b7280;font-size:12px">This is an automated notification from DC Jain Task Management.</p>' +
      '</div>';
    try {
      await sendMail(to, 'New Task Assigned: ' + taskName, html);
      console.log('Task-assigned email sent to ' + to);
    } catch (e) {
      console.error('Failed to send task-assigned email to', to, e.message);
      process.exit(1);
    }
    return;
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: employees, error: empErr } = await sb.from('employees').select('*').eq('active', true);
  if (empErr) throw empErr;
  const recipients = employees.filter((e) => e.email);
  if (!recipients.length) {
    console.log('No active employees have an email on file — nothing to send.');
    return;
  }

  if (mode === 'broadcast') {
    const subject = (process.env.BROADCAST_SUBJECT || '').trim();
    const message = (process.env.BROADCAST_MESSAGE || '').trim();
    const senderName = (process.env.BROADCAST_SENDER || 'Admin').trim();
    const onlyRecipient = (process.env.BROADCAST_RECIPIENT || '').trim().toLowerCase();
    if (!subject || !message) {
      console.error('Missing BROADCAST_SUBJECT or BROADCAST_MESSAGE');
      process.exit(1);
    }
    const targets = onlyRecipient ? recipients.filter((e) => e.email.toLowerCase() === onlyRecipient) : recipients;
    if (onlyRecipient && !targets.length) {
      console.error('BROADCAST_RECIPIENT ' + onlyRecipient + ' does not match any active member with an email on file');
      process.exit(1);
    }
    const html =
      '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937;max-width:560px">' +
      '<p style="white-space:pre-wrap">' + escapeHtml(message) + '</p>' +
      '<p style="margin-top:24px;color:#6b7280;font-size:12px">— ' + escapeHtml(senderName) + ', via DC Jain Task Management</p>' +
      '</div>';
    let sent = 0, failed = 0;
    for (const emp of targets) {
      try { await sendMail(emp.email, subject, html); sent++; }
      catch (e) { failed++; console.error('Failed to email', emp.email, e.message); }
    }
    console.log('Broadcast sent to ' + sent + ' of ' + targets.length + ' recipients (' + failed + ' failed).');
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
