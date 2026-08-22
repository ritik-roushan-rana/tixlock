'use strict';

const express = require('express');

const waitlistService = require('../services/waitlistService');
const v = require('../lib/validate');
const { asyncHandler } = require('../middleware/error');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /api/waitlist
 * Body: { show_id, category }
 */
router.post(
  '/',
  requireAuth,
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const entry = await waitlistService.joinWaitlist({
      showId: v.id(req.body.show_id, 'show_id'),
      category: v.str(req.body.category, 'category', { max: 50 }),
      customerId: req.user.id,
    });
    res.status(201).json({ waitlist: entry });
  })
);

/** GET /api/waitlist/mine — the caller's entries with queue positions. */
router.get(
  '/mine',
  requireAuth,
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    res.json({ waitlist: await waitlistService.listMyWaitlist(req.user.id) });
  })
);

/** DELETE /api/waitlist/:id — leave the queue (only while still waiting). */
router.delete(
  '/:id',
  requireAuth,
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const id = v.id(req.params.id, 'waitlist id');
    res.json(await waitlistService.leaveWaitlist(id, req.user.id));
  })
);

/**
 * GET /api/waitlist/offers/:token
 *
 * Read an offer without consuming it, so the emailed link can render a landing page
 * showing what is on the table before the customer commits. Deliberately does not
 * require auth: the recipient may not have a session in the browser they opened the
 * email in, and the token itself is the credential. It exposes only the seat, show,
 * and deadline — no customer identity.
 */
router.get(
  '/offers/:token',
  asyncHandler(async (req, res) => {
    const token = v.str(req.params.token, 'token', { max: 128 });
    const offer = await waitlistService.getOfferByToken(token);

    res.json({
      offer: {
        category: offer.category,
        offer_expires_at: offer.offer_expires_at,
        still_valid: offer.still_valid,
        show: {
          id: offer.show_id,
          date: offer.date,
          time: offer.time,
          event_title: offer.event_title,
          venue_name: offer.venue_name,
        },
        seat: {
          id: offer.offered_show_seat_id,
          row_label: offer.row_label,
          seat_number: offer.seat_number,
          price: offer.price,
        },
      },
    });
  })
);

/**
 * POST /api/waitlist/offers/:token/accept
 *
 * Consumes the single-use token and converts the offer into a normal hold, which
 * the standard booking endpoint then completes. Requires auth so the offer can be
 * matched to the signed-in customer — a forwarded link must not let a third party
 * claim someone else's seat.
 */
router.post(
  '/offers/:token/accept',
  requireAuth,
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const token = v.str(req.params.token, 'token', { max: 128 });
    res.json(await waitlistService.acceptOffer(token, req.user.id));
  })
);

module.exports = router;
