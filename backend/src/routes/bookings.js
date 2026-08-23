'use strict';

const express = require('express');

const bookingService = require('../services/bookingService');
const qrService = require('../services/qrService');
const v = require('../lib/validate');
const { asyncHandler } = require('../middleware/error');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /api/bookings
 * Body: { show_id, seat_ids: [...] }
 *
 * Converts the caller's live holds into a confirmed booking. Note there is no
 * `total_amount` in the request: the total is computed from show_pricing inside the
 * transaction, so a client cannot influence what it pays.
 */
router.post(
  '/',
  requireAuth,
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const showId = v.id(req.body.show_id, 'show_id');
    const seatIds = v.idArray(req.body.seat_ids, 'seat_ids', { min: 1, max: 10 });

    const result = await bookingService.createBooking({
      showId,
      seatIds,
      customer: req.user,
    });

    res.status(201).json(result);
  })
);

/** GET /api/bookings — the caller's booking history, newest first. */
router.get(
  '/',
  requireAuth,
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    res.json({ bookings: await bookingService.listBookingsForCustomer(req.user.id) });
  })
);

/** GET /api/bookings/ref/:ref — resolve a QR payload to a booking. */
router.get(
  '/ref/:ref',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ref = v.str(req.params.ref, 'booking reference', { max: 32 });
    res.json({ booking: await bookingService.getBookingByRef(ref, req.user) });
  })
);

/** GET /api/bookings/:id */
router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const bookingId = v.id(req.params.id, 'booking id');
    res.json({ booking: await bookingService.getBooking(bookingId, req.user) });
  })
);

/**
 * POST /api/bookings/:id/cancel
 *
 * Releases the seats. Each one is either offered to the head of that category's
 * waitlist queue or returned to general sale — see bookingService.cancelBooking.
 */
router.post(
  '/:id/cancel',
  requireAuth,
  asyncHandler(async (req, res) => {
    const bookingId = v.id(req.params.id, 'booking id');
    res.json(await bookingService.cancelBooking(bookingId, req.user));
  })
);

/**
 * GET /api/bookings/qr/:ref.png — the ticket QR as a PNG image. Public, no auth.
 *
 * Exists so the booking confirmation email can render the QR inline. Mail clients
 * cannot resolve `cid:` references here (Brevo does not support CID embedding on
 * transactional email, via its API or its SMTP relay) and Gmail strips
 * `data:` URIs, so an absolute `https://` image URL is the only thing that
 * actually displays. Gmail fetches it through its image proxy.
 *
 * Why it is safe to leave unauthenticated:
 *
 *  - The QR encodes the booking reference and nothing else — see qrService. A
 *    reference is not a secret; it is printed on a ticket and shown to a stranger
 *    at a door.
 *  - It is a pure function of the path: no database read, so it cannot leak
 *    anything about a booking, and it is not an existence oracle. A well-formed
 *    reference renders whether or not it exists, so probing tells an attacker
 *    nothing they did not already supply.
 *  - Redeeming a reference still requires an authenticated lookup via
 *    GET /api/bookings/ref/:ref, which is unchanged.
 *
 * Requiring auth here would defeat the purpose: the request arrives from Google's
 * image proxy, which carries no session.
 */
router.get(
  '/qr/:ref.png',
  asyncHandler(async (req, res) => {
    const ref = String(req.params.ref || '').toUpperCase();
    // Mirrors the generator in bookingService: TB- plus 8 chars from an alphabet
    // with no 0/O/1/I. Validated so this cannot be used to render arbitrary text.
    if (!/^TB-[2-9A-HJ-NP-Z]{8}$/.test(ref)) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'Malformed booking reference' },
      });
    }

    const png = await qrService.generateBookingQrBuffer(ref);
    if (!png) {
      return res.status(503).json({
        error: { code: 'QR_UNAVAILABLE', message: 'Could not render the QR code' },
      });
    }

    res.set({
      'Content-Type': 'image/png',
      'Content-Length': String(png.length),
      // Deterministic for a given reference, so it is safe to cache hard. This
      // also stops Gmail's proxy re-fetching on every open.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Disposition': `inline; filename="${ref}.png"`,
    });
    return res.send(png);
  })
);

/** GET /api/bookings/:id/qr — re-render the ticket QR. */
router.get(
  '/:id/qr',
  requireAuth,
  asyncHandler(async (req, res) => {
    const bookingId = v.id(req.params.id, 'booking id');
    res.json(await bookingService.getBookingQr(bookingId, req.user));
  })
);

module.exports = router;
