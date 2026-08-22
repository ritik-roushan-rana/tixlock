'use strict';

/**
 * Email delivery.
 *
 * Every function here is best-effort and never throws. Mail is always sent from a
 * post-commit side effect, so a raised exception could only either be swallowed by
 * the caller anyway or — worse, if someone later moved a send inside a transaction
 * — roll back a perfectly good booking because an SMTP host was slow. Failures are
 * logged and returned as `{ sent: false }`.
 *
 * With SMTP_HOST unset the module falls back to a console transport, so the whole
 * application runs end to end in development with no Mailtrap account. That
 * fallback is also what makes the "booking survives a broken mailer" test
 * meaningful rather than vacuous.
 */

const nodemailer = require('nodemailer');

const config = require('../config/env');

let transport = null;
/** Messages captured by the console transport. Used by tests to assert on mail. */
const outbox = [];

/**
 * True when mail leaves the process for real, by either delivery path.
 *
 * The console transport is the only mode that fills `outbox`, so this is what
 * distinguishes "logged" from "sent" — previously that decision read
 * `config.smtp.enabled` directly, which would have mis-classified Brevo sends as
 * console sends and pushed real mail into the test outbox.
 */
const deliversForReal = () => config.brevo.enabled || config.smtp.enabled;

/** `"TixLock <no-reply@x.com>"` -> `{ name: 'TixLock', email: 'no-reply@x.com' }`. */
function parseAddress(value) {
  const raw = String(value ?? '').trim();
  const angled = raw.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
  if (angled) {
    return { name: angled[1].replace(/^"|"$/g, '').trim() || undefined, email: angled[2].trim() };
  }
  return { email: raw };
}

/** Brevo takes a list of recipients; our call sites pass one address as a string. */
const parseRecipients = (value) =>
  (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map((entry) => parseAddress(entry))
    .filter((addr) => addr.email);

/**
 * Nodemailer custom transport backed by Brevo's HTTPS API.
 *
 * Implemented as a transport plugin rather than as a branch inside `send()` so
 * that every existing call site, template and attachment stays byte-identical —
 * the swap is invisible above `getTransport()`.
 *
 * Note on the QR code: Brevo does not support CID/embedded images on
 * transactional email through either the API or its SMTP relay, so the
 * `<img src="cid:booking-qr">` in the confirmation template cannot render on this
 * path. The QR is delivered as a normal `.png` attachment instead, which is what
 * the plain-text part of that template already tells the recipient to look for.
 */
function createBrevoTransport() {
  return nodemailer.createTransport({
    name: 'brevo-http',
    version: '1.0.0',

    send(mail, callback) {
      const data = mail.data || {};
      const sender = parseAddress(data.from);
      const to = parseRecipients(data.to);

      const attachment = (data.attachments || [])
        .map((att) => {
          const content = Buffer.isBuffer(att.content)
            ? att.content
            : att.content != null
              ? Buffer.from(String(att.content))
              : null;
          if (!content) return null;
          return { name: att.filename || 'attachment', content: content.toString('base64') };
        })
        .filter(Boolean);

      const payload = {
        sender,
        to,
        subject: data.subject,
        ...(data.html ? { htmlContent: data.html } : {}),
        ...(data.text ? { textContent: data.text } : {}),
        ...(attachment.length ? { attachment } : {}),
      };

      fetch(config.brevo.baseUrl, {
        method: 'POST',
        headers: {
          'api-key': config.brevo.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(payload),
        // Bounded for the same reason the SMTP timeouts are: a hanging provider
        // must never pin a worker.
        signal: AbortSignal.timeout(15_000),
      })
        .then(async (res) => {
          const body = await res.text();
          if (!res.ok) {
            // Surface Brevo's own message — it names the bad field, which a bare
            // status code does not.
            throw new Error(`Brevo API ${res.status}: ${body.slice(0, 300)}`);
          }
          let messageId;
          try {
            messageId = JSON.parse(body).messageId;
          } catch {
            /* 2xx with an unparseable body still counts as accepted. */
          }
          callback(null, { messageId, envelope: { from: sender.email, to: to.map((t) => t.email) } });
        })
        .catch((err) => callback(err));
    },
  });
}

function getTransport() {
  if (transport) return transport;

  if (config.brevo.enabled) {
    transport = createBrevoTransport();
    console.log('[mail] Brevo HTTPS API transport ready');
  } else if (config.smtp.enabled) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      // Port 465 is implicit TLS; 587/2525 upgrade via STARTTLS.
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      // Bound every stage so a hanging SMTP server cannot pin a worker for minutes.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    console.log(`[mail] SMTP transport ready (${config.smtp.host}:${config.smtp.port})`);
  } else {
    // jsonTransport serialises the message instead of sending it, which keeps the
    // real nodemailer code path (templating, addressing, attachments) exercised.
    transport = nodemailer.createTransport({ jsonTransport: true });
    if (!config.isTest) {
      console.log(
        '[mail] neither BREVO_API_KEY nor SMTP_HOST set — using console transport, mail will be logged not sent'
      );
    }
  }

  return transport;
}

async function send({ to, subject, text, html, attachments }) {
  const message = { from: config.smtp.from, to, subject, text, html, attachments };

  try {
    const info = await getTransport().sendMail(message);

    if (!deliversForReal()) {
      outbox.push({ to, subject, text, html, sentAt: new Date().toISOString() });
      if (!config.isTest) {
        console.log(`[mail] (not sent) to=${to} subject="${subject}"`);
      }
    }

    return { sent: true, messageId: info.messageId };
  } catch (err) {
    // Deliberately swallowed. The caller has already committed its transaction.
    console.error(`[mail] failed to send "${subject}" to ${to}: ${err.message}`);
    return { sent: false, error: err.message };
  }
}

/* --- Templates ---------------------------------------------------------- */

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const seatList = (seats) => seats.map((s) => `${s.row_label}${s.seat_number}`).join(', ');

const wrap = (title, bodyHtml) => `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
    <h2 style="margin:0 0 16px">${escapeHtml(title)}</h2>
    ${bodyHtml}
    <hr style="border:none;border-top:1px solid #e2e2e2;margin:24px 0" />
    <p style="font-size:12px;color:#777;margin:0">TixLock — this is an automated message.</p>
  </div>
`;

/**
 * Booking confirmation with the QR code.
 *
 * The QR is attached with a Content-ID and referenced as <img src="cid:...">
 * rather than embedded as a base64 data URI, because most mail clients — Gmail
 * and Outlook included — strip data-URI images.
 */
async function sendBookingConfirmation({ to, name, booking, show, seats, qrBuffer }) {
  const seatsText = seatList(seats);
  const when = `${show.date} at ${show.time}`;

  const text = [
    `Hi ${name},`,
    '',
    `Your booking is confirmed.`,
    '',
    `Reference: ${booking.booking_ref}`,
    `Event:     ${show.event_title}`,
    `When:      ${when}`,
    `Venue:     ${show.venue_name}`,
    `Seats:     ${seatsText}`,
    `Total:     ${booking.total_amount}`,
    '',
    'Show the QR code attached to this email at the venue entrance.',
  ].join('\n');

  const html = wrap('Your booking is confirmed', `
    <p>Hi ${escapeHtml(name)},</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:6px 0;color:#666">Reference</td><td style="padding:6px 0"><strong>${escapeHtml(booking.booking_ref)}</strong></td></tr>
      <tr><td style="padding:6px 0;color:#666">Event</td><td style="padding:6px 0">${escapeHtml(show.event_title)}</td></tr>
      <tr><td style="padding:6px 0;color:#666">When</td><td style="padding:6px 0">${escapeHtml(when)}</td></tr>
      <tr><td style="padding:6px 0;color:#666">Venue</td><td style="padding:6px 0">${escapeHtml(show.venue_name)}</td></tr>
      <tr><td style="padding:6px 0;color:#666">Seats</td><td style="padding:6px 0">${escapeHtml(seatsText)}</td></tr>
      <tr><td style="padding:6px 0;color:#666">Total</td><td style="padding:6px 0"><strong>${escapeHtml(booking.total_amount)}</strong></td></tr>
    </table>
    ${qrBuffer ? '<p style="margin:20px 0 6px">Show this at the entrance:</p><img src="cid:booking-qr" width="200" height="200" alt="Booking QR code" style="border:1px solid #ddd" />' : ''}
  `);

  return send({
    to,
    subject: `Booking confirmed — ${show.event_title} (${booking.booking_ref})`,
    text,
    html,
    attachments: qrBuffer
      ? [{ filename: `${booking.booking_ref}.png`, content: qrBuffer, cid: 'booking-qr' }]
      : undefined,
  });
}

async function sendCancellationConfirmation({ to, name, booking, show, seats }) {
  const seatsText = seatList(seats);
  const text = [
    `Hi ${name},`,
    '',
    `Your booking ${booking.booking_ref} has been cancelled.`,
    '',
    `Event: ${show.event_title}`,
    `When:  ${show.date} at ${show.time}`,
    `Seats: ${seatsText}`,
  ].join('\n');

  return send({
    to,
    subject: `Booking cancelled — ${booking.booking_ref}`,
    text,
    html: wrap('Your booking has been cancelled', `
      <p>Hi ${escapeHtml(name)},</p>
      <p>Booking <strong>${escapeHtml(booking.booking_ref)}</strong> for
         ${escapeHtml(show.event_title)} has been cancelled.</p>
      <p style="color:#666;font-size:14px">Released seats: ${escapeHtml(seatsText)}</p>
    `),
  });
}

/**
 * Waitlist offer with a single-use, time-limited link.
 *
 * The token is the whole authorisation, so the link is the sensitive part of this
 * message and the reason offer tokens are 32 random bytes rather than a guessable
 * id.
 */
async function sendWaitlistOffer({ to, name, show, seat, offerToken, expiresAt, category }) {
  const link = `${config.publicUrl}/offer.html?token=${encodeURIComponent(offerToken)}`;
  const seatText = `${seat.row_label}${seat.seat_number}`;
  const deadline = new Date(expiresAt).toUTCString();

  const text = [
    `Hi ${name},`,
    '',
    `A ${category} seat has become available for ${show.event_title}.`,
    '',
    `Seat:  ${seatText}`,
    `When:  ${show.date} at ${show.time}`,
    `Venue: ${show.venue_name}`,
    '',
    `It is reserved for you until ${deadline}.`,
    `Complete your booking here (this link works once):`,
    link,
    '',
    `If you do not respond in time the seat passes to the next person waiting.`,
  ].join('\n');

  return send({
    to,
    subject: `A ${category} seat is available — ${show.event_title}`,
    text,
    html: wrap('A seat has become available', `
      <p>Hi ${escapeHtml(name)},</p>
      <p>A <strong>${escapeHtml(category)}</strong> seat has opened up for
         <strong>${escapeHtml(show.event_title)}</strong>.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:6px 0;color:#666">Seat</td><td style="padding:6px 0"><strong>${escapeHtml(seatText)}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#666">When</td><td style="padding:6px 0">${escapeHtml(`${show.date} at ${show.time}`)}</td></tr>
        <tr><td style="padding:6px 0;color:#666">Venue</td><td style="padding:6px 0">${escapeHtml(show.venue_name)}</td></tr>
      </table>
      <p style="margin:18px 0">
        <a href="${escapeHtml(link)}"
           style="background:#2563eb;color:#fff;padding:11px 20px;border-radius:6px;text-decoration:none;display:inline-block">
          Complete my booking
        </a>
      </p>
      <p style="color:#666;font-size:13px">
        Reserved until <strong>${escapeHtml(deadline)}</strong>. This link can be used once.
        If you do not respond, the seat passes to the next person waiting.
      </p>
    `),
  });
}

/** Test helpers. */
const getOutbox = () => [...outbox];
const clearOutbox = () => {
  outbox.length = 0;
};
/** Force the transport to be rebuilt — used by tests that simulate SMTP failure. */
const resetTransport = () => {
  transport = null;
};

module.exports = {
  send,
  sendBookingConfirmation,
  sendCancellationConfirmation,
  sendWaitlistOffer,
  getOutbox,
  clearOutbox,
  resetTransport,
};
