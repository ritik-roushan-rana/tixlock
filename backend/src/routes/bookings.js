'use strict';

const express = require('express');

const bookingService = require('../services/bookingService');
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
