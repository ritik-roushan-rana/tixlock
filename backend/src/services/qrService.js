'use strict';

/**
 * QR code generation.
 *
 * The payload is the booking reference and nothing else — no name, no email, no
 * seat list, no show details. Two reasons:
 *
 *  1. A QR code is not a secret. It gets printed, screenshotted, and shown to a
 *     stranger at a door. Anything encoded in it is effectively public, so
 *     embedding personal data would be leaking it.
 *  2. A reference is a lookup key. Whoever scans it queries the authoritative
 *     record, so encoding a copy of the booking would only create a second version
 *     that can go stale — a cancelled booking whose QR still claims to be valid.
 */

const QRCode = require('qrcode');

/**
 * Render a booking reference as a PNG data URL.
 *
 * Returns null rather than throwing: the caller is a post-commit side effect, and
 * a QR failure must never look like a booking failure.
 */
async function generateBookingQr(bookingRef) {
  try {
    return await QRCode.toDataURL(String(bookingRef), {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: { dark: '#000000ff', light: '#ffffffff' },
    });
  } catch (err) {
    console.error(`[qr] failed to generate QR for ${bookingRef}:`, err.message);
    return null;
  }
}

/** PNG buffer of the same payload, for use as an email attachment. */
async function generateBookingQrBuffer(bookingRef) {
  try {
    return await QRCode.toBuffer(String(bookingRef), {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
    });
  } catch (err) {
    console.error(`[qr] failed to generate QR buffer for ${bookingRef}:`, err.message);
    return null;
  }
}

module.exports = { generateBookingQr, generateBookingQrBuffer };
