'use strict';

/**
 * Seat hold endpoints, mounted under /api/shows.
 *
 * Kept separate from routes/shows.js because these are the contended writes and
 * benefit from being read in one place alongside holdService.
 */

const express = require('express');

const holdService = require('../services/holdService');
const v = require('../lib/validate');
const { asyncHandler } = require('../middleware/error');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /api/shows/:id/hold
 * Body: { seat_ids: [1,2,3] }
 *
 * Holds every listed seat or none of them. 409 with the conflicting seat ids if
 * any is unavailable.
 *
 * The customer is taken from the JWT, never from the body. Accepting a
 * client-supplied customer_id would let anyone place holds in someone else's
 * name — the brief describes the endpoint as taking a customer id, but the
 * authenticated identity is the only trustworthy source for it.
 */
router.post(
  '/:id/hold',
  requireAuth,
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const showId = v.id(req.params.id, 'show id');
    // idArray de-duplicates, which keeps the row-count comparison in holdService
    // honest when a client sends the same seat twice.
    const seatIds = v.idArray(req.body.seat_ids, 'seat_ids', { min: 1, max: 10 });

    const result = await holdService.holdSeats(showId, seatIds, req.user.id);
    res.status(201).json(result);
  })
);

/**
 * DELETE /api/shows/:id/hold
 * Body (optional): { seat_ids: [...] } — omit to release all of the caller's holds.
 */
router.delete(
  '/:id/hold',
  requireAuth,
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const showId = v.id(req.params.id, 'show id');
    const seatIds =
      req.body && req.body.seat_ids !== undefined
        ? v.idArray(req.body.seat_ids, 'seat_ids', { min: 1, max: 50 })
        : null;

    res.json(await holdService.releaseHold(showId, req.user.id, seatIds));
  })
);

/** GET /api/shows/:id/my-holds — restore a countdown after a page reload. */
router.get(
  '/:id/my-holds',
  requireAuth,
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const showId = v.id(req.params.id, 'show id');
    res.json(await holdService.getMyHolds(showId, req.user.id));
  })
);

module.exports = router;
