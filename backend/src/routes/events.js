'use strict';

const express = require('express');

const eventService = require('../services/eventService');
const v = require('../lib/validate');
const { badRequest } = require('../lib/errors');
const { asyncHandler } = require('../middleware/error');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/events — browse and filter. Public: browsing does not need an account.
 * Query: type, date_from, date_to, venue_id, organiser_id, q, upcoming
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filters = {
      type: v.optional(req.query.type, (x) => v.oneOf(x, 'type', eventService.EVENT_TYPES)),
      dateFrom: v.optional(req.query.date_from, (x) => v.dateStr(x, 'date_from')),
      dateTo: v.optional(req.query.date_to, (x) => v.dateStr(x, 'date_to')),
      venueId: v.optional(req.query.venue_id, (x) => v.id(x, 'venue_id')),
      organiserId: v.optional(req.query.organiser_id, (x) => v.id(x, 'organiser_id')),
      search: v.optional(req.query.q, (x) => v.str(x, 'q', { max: 100 })),
      upcomingOnly: req.query.upcoming === 'true',
    };

    if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
      throw badRequest('date_from must not be after date_to');
    }

    res.json({ events: await eventService.listEvents(filters) });
  })
);

/** GET /api/events/mine — the signed-in organiser's own events. */
router.get(
  '/mine',
  requireAuth,
  requireRole('organiser', 'admin'),
  asyncHandler(async (req, res) => {
    // `requireShow: false` — an organiser has to see an event they just created,
    // before it has any showings, because this list is what the "add a showing" picker
    // reads. The public GET /events keeps the filter: an event with no showing is not
    // bookable and has no business in a browse list.
    const events = await eventService.listEvents(
      req.user.role === 'admin'
        ? { requireShow: false }
        : { organiserId: req.user.id, requireShow: false }
    );
    res.json({ events });
  })
);

/** GET /api/events/:id — event detail with shows, pricing and availability. */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const eventId = v.id(req.params.id, 'event id');
    res.json({ event: await eventService.getEventWithShows(eventId) });
  })
);

/**
 * POST /api/events  (organiser)
 * Body: { title, type, venue_id, description? }
 */
router.post(
  '/',
  requireAuth,
  requireRole('organiser', 'admin'),
  asyncHandler(async (req, res) => {
    const event = await eventService.createEvent({
      title: v.str(req.body.title, 'title', { max: 200 }),
      type: v.oneOf(req.body.type, 'type', eventService.EVENT_TYPES),
      description:
        req.body.description === undefined
          ? ''
          : v.str(req.body.description, 'description', { min: 0, max: 2000 }),
      venueId: v.id(req.body.venue_id, 'venue_id'),
      organiserId: req.user.id,
    });

    res.status(201).json({ event });
  })
);

/**
 * POST /api/events/:id/shows  (organiser, own events only)
 * Body: { date: 'YYYY-MM-DD', time: 'HH:MM', pricing: { Category: number, ... } }
 *
 * Generates show_seats from the venue layout and inserts pricing in one
 * transaction.
 */
router.post(
  '/:id/shows',
  requireAuth,
  requireRole('organiser', 'admin'),
  asyncHandler(async (req, res) => {
    const eventId = v.id(req.params.id, 'event id');
    await eventService.assertEventOwner(eventId, req.user);

    const show = await eventService.createShow({
      eventId,
      date: v.dateStr(req.body.date, 'date'),
      time: v.timeStr(req.body.time, 'time'),
      pricing: parsePricing(req.body.pricing),
    });

    res.status(201).json({ show });
  })
);

/** DELETE /api/events/:eventId/shows/:showId  (organiser, only if nothing sold) */
router.delete(
  '/:eventId/shows/:showId',
  requireAuth,
  requireRole('organiser', 'admin'),
  asyncHandler(async (req, res) => {
    const eventId = v.id(req.params.eventId, 'event id');
    const showId = v.id(req.params.showId, 'show id');
    await eventService.assertEventOwner(eventId, req.user);

    const show = await eventService.getShow(showId);
    if (show.event_id !== eventId) {
      throw badRequest('That show does not belong to this event');
    }

    await eventService.deleteShow(showId);
    res.status(204).end();
  })
);

/** Validate the { Category: price } pricing map. */
function parsePricing(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw badRequest('pricing must be an object mapping category name to price, e.g. {"Premium": 500}');
  }
  const entries = Object.entries(raw);
  if (entries.length === 0) throw badRequest('pricing must contain at least one category');
  if (entries.length > 20) throw badRequest('pricing must contain at most 20 categories');

  const out = {};
  for (const [category, price] of entries) {
    const key = v.str(category, 'pricing category', { max: 50 });
    out[key] = v.money(price, `pricing["${key}"]`);
  }
  return out;
}

module.exports = router;
