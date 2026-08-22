'use strict';

const express = require('express');

const dashboardService = require('../services/dashboardService');
const v = require('../lib/validate');
const { asyncHandler } = require('../middleware/error');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Everything here is organiser reporting; an admin can see all of it.
router.use(requireAuth, requireRole('organiser', 'admin'));

/**
 * GET /api/dashboard/summary
 * All of the caller's events with seats sold and revenue. Admins see every event.
 */
router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    res.json(
      await dashboardService.getOrganiserSummary(req.user.id, {
        includeAll: req.user.role === 'admin',
      })
    );
  })
);

/** GET /api/dashboard/events/:id — per-show, per-category breakdown for one event. */
router.get(
  '/events/:id',
  asyncHandler(async (req, res) => {
    const eventId = v.id(req.params.id, 'event id');
    res.json(await dashboardService.getEventReport(eventId, req.user));
  })
);

/** GET /api/dashboard/events/:id/bookings — attendee list. */
router.get(
  '/events/:id/bookings',
  asyncHandler(async (req, res) => {
    const eventId = v.id(req.params.id, 'event id');
    const limit = v.optional(req.query.limit, (x) => v.int(x, 'limit', { min: 1, max: 500 })) ?? 100;

    res.json({
      bookings: await dashboardService.getEventBookings(eventId, req.user, { limit }),
    });
  })
);

module.exports = router;
