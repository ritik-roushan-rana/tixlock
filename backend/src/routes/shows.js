'use strict';

const express = require('express');

const seatService = require('../services/seatService');
const eventService = require('../services/eventService');
const v = require('../lib/validate');
const { asyncHandler } = require('../middleware/error');
const { optionalAuth } = require('../middleware/auth');

const router = express.Router();

/** GET /api/shows/:id — show detail plus pricing. */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const showId = v.id(req.params.id, 'show id');
    const show = await eventService.getShow(showId);
    res.json({ show, pricing: await eventService.getShowPricing(showId) });
  })
);

/**
 * GET /api/shows/:id/seats — the seat map.
 *
 * optionalAuth rather than requireAuth: an anonymous visitor should be able to
 * see what is available before creating an account. Signing in only adds the
 * held_by_me flag on the caller's own holds.
 */
router.get(
  '/:id/seats',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const showId = v.id(req.params.id, 'show id');
    const seatMap = await seatService.getSeatMap(showId, req.user ? req.user.id : null);
    res.json(seatMap);
  })
);

/** GET /api/shows/:id/availability — per-category counts and sold-out flags. */
router.get(
  '/:id/availability',
  asyncHandler(async (req, res) => {
    const showId = v.id(req.params.id, 'show id');
    await eventService.getShow(showId); // 404 if the show does not exist
    res.json({ categories: await seatService.getCategoryAvailability(showId) });
  })
);

module.exports = router;
