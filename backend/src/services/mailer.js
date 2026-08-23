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
 * `config.smtp.enabled` directly, which would have mis-classified HTTPS API sends as
 * console sends and pushed real mail into the test outbox.
 */
const deliversForReal = () => !config.isTest && (config.mailjet.enabled || config.smtp.enabled);

/**
 * Domains that can never receive mail, so sending to them only burns provider quota
 * and sender reputation.
 *
 * RFC 2606 and RFC 6761 reserve most of these for documentation and testing; `.local`
 * is mDNS. Nearly every fixture address in this repo lands in one of them —
 * `neha@audience.tixlock.local`, `customer147@test.local`, `wlowner…@example.com`.
 *
 * This guard exists because those addresses reached the real provider: 651 sends in
 * two days produced 625 soft bounces ("Unable to find MX of domain test.local"),
 * which exhausted a free-plan send allowance and stopped genuine booking
 * confirmations from going out. A 96% bounce rate is also how a sending account gets
 * suspended outright, so this protects more than the credit balance.
 *
 * `tixlock.com` is the one entry here that is not reserved by an RFC, and it is listed
 * for a concrete reason: the demo sign-in accounts are `admin@`, `organiser@`,
 * `customer1@` and `customer2@tixlock.com`, and no mailbox exists behind any of them.
 * This project sends *from* a Gmail address, not from tixlock.com, so nothing real is
 * being suppressed. The demo actively invites an evaluator to cancel a booking, which
 * fires a cancellation notice and possibly a waitlist offer, so without this line the
 * headline demo action would generate guaranteed hard bounces every time it is
 * performed. Delete this alternative the day real mailboxes exist at tixlock.com.
 */
const UNROUTABLE_DOMAIN =
  /@(?:[^@]*\.)?(?:test|example|invalid|localhost|local)$|@example\.(?:com|net|org)$|@(?:[^@]*\.)?tixlock\.com$/i;

const isUnroutable = (to) =>
  String(to ?? '')
    .split(',')
    .map((entry) => parseAddress(entry).email)
    .filter(Boolean)
    .every((email) => UNROUTABLE_DOMAIN.test(email));

/** `"TixLock <no-reply@x.com>"` -> `{ name: 'TixLock', email: 'no-reply@x.com' }`. */
function parseAddress(value) {
  const raw = String(value ?? '').trim();
  const angled = raw.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
  if (angled) {
    return { name: angled[1].replace(/^"|"$/g, '').trim() || undefined, email: angled[2].trim() };
  }
  return { email: raw };
}

/** Mailjet takes a list of recipients; our call sites pass one address as a string. */
const parseRecipients = (value) =>
  (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map((entry) => parseAddress(entry))
    .filter((addr) => addr.email);

/**
 * Nodemailer custom transport backed by Mailjet's HTTPS Send API v3.1.
 *
 * Implemented as a transport plugin rather than as a branch inside `send()` so that
 * every existing call site, template and attachment stays byte-identical — the swap
 * is invisible above `getTransport()`.
 *
 * Two things about this API are easy to get wrong:
 *
 *  - the schema is PascalCase and wraps everything in a `Messages` array. Lowercase
 *    keys are not merely ignored, they 400.
 *  - **a 200 does not mean accepted.** v3.1 reports per-message outcomes inside the
 *    body, so a message can be rejected under an HTTP 200 with
 *    `Messages[0].Status === "error"`. Checking only `res.ok` is how a provider-side
 *    refusal gets logged as a successful send, which is precisely the blindness that
 *    hid an exhausted quota on the previous provider. Both are treated as failures
 *    here.
 */
function createMailjetTransport() {
  const auth = Buffer.from(`${config.mailjet.apiKey}:${config.mailjet.secretKey}`).toString(
    'base64'
  );

  return nodemailer.createTransport({
    name: 'mailjet-http',
    version: '1.0.0',

    send(mail, callback) {
      const data = mail.data || {};
      const from = parseAddress(data.from);
      const to = parseRecipients(data.to);
      const html = String(data.html ?? '');

      // Mailjet does support CID embedding, via a separate `InlinedAttachments` list.
      // An attachment is only routed there when the HTML actually references its
      // `cid:` — otherwise it belongs in `Attachments`, where the recipient can
      // download it. Today's confirmation template points at an absolute image URL
      // and tells the reader the QR is attached, so the QR lands in `Attachments`;
      // switch that template to `cid:booking-qr` and it becomes inline on its own.
      const attachments = [];
      const inlined = [];
      for (const att of data.attachments || []) {
        const content = Buffer.isBuffer(att.content)
          ? att.content
          : att.content != null
            ? Buffer.from(String(att.content))
            : null;
        if (!content) continue;

        const entry = {
          ContentType: att.contentType || 'application/octet-stream',
          Filename: att.filename || 'attachment',
          Base64Content: content.toString('base64'),
        };
        if (att.cid && html.includes(`cid:${att.cid}`)) inlined.push({ ...entry, ContentID: att.cid });
        else attachments.push(entry);
      }

      const payload = {
        Messages: [
          {
            From: { Email: from.email, ...(from.name ? { Name: from.name } : {}) },
            To: to.map((addr) => ({
              Email: addr.email,
              ...(addr.name ? { Name: addr.name } : {}),
            })),
            Subject: data.subject,
            ...(data.text ? { TextPart: data.text } : {}),
            ...(html ? { HTMLPart: html } : {}),
            ...(attachments.length ? { Attachments: attachments } : {}),
            ...(inlined.length ? { InlinedAttachments: inlined } : {}),
          },
        ],
      };

      fetch(config.mailjet.baseUrl, {
        method: 'POST',
        headers: {
          authorization: `Basic ${auth}`,
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
            // Surface Mailjet's own message — it names the offending field, which a
            // bare status code does not.
            throw new Error(`Mailjet API ${res.status}: ${body.slice(0, 300)}`);
          }

          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            throw new Error(`Mailjet API returned unparseable body: ${body.slice(0, 200)}`);
          }

          const result = parsed.Messages?.[0];
          if (!result || result.Status !== 'success') {
            const reason = (result?.Errors || [])
              .map((e) => `${e.ErrorCode || e.ErrorIdentifier || 'error'}: ${e.ErrorMessage}`)
              .join('; ');
            throw new Error(
              `Mailjet rejected the message (Status=${result?.Status ?? 'unknown'})` +
                (reason ? `: ${reason}` : `: ${body.slice(0, 300)}`)
            );
          }

          const recipient = result.To?.[0];
          callback(null, {
            // MessageUUID is the handle Mailjet's own event and message endpoints
            // take, so it is the one worth putting in a log line.
            messageId: recipient?.MessageUUID || recipient?.MessageID,
            envelope: { from: from.email, to: to.map((t) => t.email) },
          });
        })
        .catch((err) => callback(err));
    },
  });
}

function getTransport() {
  if (transport) return transport;

  if (config.isTest) {
    // Never a real transport under test, whatever the environment happens to hold.
    //
    // This used to fall through to the branches below, so a developer with SMTP_HOST
    // or provider API keys in their .env had `npm test` deliver every fixture message to
    // the live provider — hundreds of them, to addresses like customer147@test.local.
    // It also emptied `outbox`, which is what the mail assertions read, so those
    // tests failed on exactly the machines that were doing the damage.
    transport = nodemailer.createTransport({ jsonTransport: true });
  } else if (config.mailjet.enabled) {
    transport = createMailjetTransport();
    console.log('[mail] Mailjet HTTPS API transport ready');
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
        '[mail] no MJ_APIKEY_PUBLIC/MJ_APIKEY_PRIVATE and no SMTP_HOST — using console transport, mail will be logged not sent'
      );
    }
  }

  return transport;
}

async function send({ to, subject, text, html, attachments }) {
  const message = { from: config.smtp.from, to, subject, text, html, attachments };

  // Reserved domains never resolve, so handing one to the provider buys a guaranteed
  // bounce. Recorded in the outbox exactly as the console transport would, so a smoke
  // script driving seeded fixtures still sees its mail.
  if (deliversForReal() && isUnroutable(to)) {
    outbox.push({ to, subject, text, html, sentAt: new Date().toISOString() });
    console.log(`[mail] (skipped, unroutable domain) to=${to} subject="${subject}"`);
    return { sent: false, skipped: true };
  }

  try {
    const info = await getTransport().sendMail(message);

    if (!deliversForReal()) {
      outbox.push({ to, subject, text, html, sentAt: new Date().toISOString() });
      if (!config.isTest) {
        console.log(`[mail] (not sent) to=${to} subject="${subject}"`);
      }
    } else if (!config.isTest) {
      // A successful real send used to log nothing at all, which makes "delivered"
      // and "silently never attempted" indistinguishable in production logs. The
      // provider's message id is the handle needed to look a delivery up later.
      console.log(`[mail] sent to=${to} id=${info.messageId || 'n/a'} subject="${subject}"`);
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
 * The QR appears twice, deliberately, and neither copy uses `cid:`:
 *
 *  - inline in the HTML, as an absolute https:// URL served by
 *    GET /api/bookings/qr/:ref.png
 *  - as a downloadable .png attachment, so the ticket survives offline
 *
 * The absolute URL is deliberate, and survives the move to Mailjet even though
 * Mailjet *does* support CID embedding (see `InlinedAttachments` in the transport).
 * Two reasons to keep it: the URL renders in Gmail, which fetches it through its
 * image proxy, whereas Mailjet's own issue tracker has inline attachments failing in
 * Thunderbird and GSuite; and the same endpoint backs the "view it here" link in the
 * text part. A `data:` URI is not an option either — Gmail strips those.
 *
 * That the QR endpoint is fetched by an image proxy rather than the recipient is
 * also why it cannot require authentication.
 */
async function sendBookingConfirmation({ to, name, booking, show, seats, qrBuffer }) {
  const seatsText = seatList(seats);
  const when = `${show.date} at ${show.time}`;
  const qrImageUrl = `${config.apiPublicUrl}/api/bookings/qr/${encodeURIComponent(booking.booking_ref)}.png`;

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
    'Show the QR code at the venue entrance. It is attached to this email, and',
    'also viewable here:',
    qrImageUrl,
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
    <p style="margin:20px 0 6px">Show this at the entrance:</p>
    <img src="${escapeHtml(qrImageUrl)}" width="200" height="200" alt="Booking QR code for ${escapeHtml(booking.booking_ref)}" style="border:1px solid #ddd;display:block" />
    <p style="color:#666;font-size:12px;margin:6px 0 0">
      Not showing? The same QR code is attached to this email as
      ${escapeHtml(booking.booking_ref)}.png, and your ticket is always available in
      your booking history.
    </p>
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
  // `/offer`, not `/offer.html`: the frontend is a Vite SPA whose router declares
  // `path: 'offer'`. A `.html` suffix still returns 200 because the host rewrites
  // every non-asset path to index.html, but React Router then matches nothing and
  // renders the 404 page — so the offer would look expired to the recipient.
  const link = `${config.publicUrl}/offer?token=${encodeURIComponent(offerToken)}`;
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
