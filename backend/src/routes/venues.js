'use strict';

const express = require('express');

const venueService = require('../services/venueService');
const v = require('../lib/validate');
const { badRequest } = require('../lib/errors');
const { asyncHandler } = require('../middleware/error');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/venues
 * Readable by any signed-in user: organisers need it to pick a venue when
 * creating an event, so this is not admin-only.
 */
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ venues: await venueService.listVenues() });
  })
);

/** GET /api/venues/:id — venue detail including the grouped seat layout. */
router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const venueId = v.id(req.params.id, 'venue id');
    res.json({ venue: await venueService.getVenueWithLayout(venueId) });
  })
);

/**
 * POST /api/venues  (admin)
 * Body: { name, address?, layout? }
 *
 * `layout` is optional so the admin UI can create a venue and define seats in one
 * request, which is how the form actually behaves.
 */
router.post(
  '/',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const name = v.str(req.body.name, 'name', { max: 200 });
    const address = req.body.address === undefined ? '' : v.str(req.body.address, 'address', { min: 0, max: 500 });
    const layout = req.body.layout === undefined ? null : parseLayout(req.body.layout);

    const venue = await venueService.createVenue({ name, address, createdBy: req.user.id });

    if (layout) {
      await venueService.defineLayout(venue.id, layout);
    }

    res.status(201).json({ venue: await venueService.getVenueWithLayout(venue.id) });
  })
);

/** PATCH /api/venues/:id  (admin) — rename / re-address. */
router.patch(
  '/:id',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const venueId = v.id(req.params.id, 'venue id');
    const name = v.optional(req.body.name, (x) => v.str(x, 'name', { max: 200 }));
    const address = v.optional(req.body.address, (x) => v.str(x, 'address', { min: 0, max: 500 }));

    if (name === undefined && address === undefined) {
      throw badRequest('Provide at least one of: name, address');
    }

    await venueService.updateVenue(venueId, { name, address });
    res.json({ venue: await venueService.getVenueWithLayout(venueId) });
  })
);

/**
 * PUT /api/venues/:id/layout  (admin)
 * Body: { layout: [{ row_label, seats, category }, ...] }
 *
 * PUT rather than POST: this replaces the whole layout, so it is idempotent —
 * sending the same body twice leaves the same 30 seats, not 60.
 */
router.put(
  '/:id/layout',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const venueId = v.id(req.params.id, 'venue id');
    const layout = parseLayout(req.body.layout);

    const result = await venueService.defineLayout(venueId, layout);
    res.json({ ...result, venue: await venueService.getVenueWithLayout(venueId) });
  })
);

/**
 * Validate the row-spec array.
 *
 * Capped at 100 rows × 100 seats. Without a cap, `{"seats": 100000000}` would
 * ask Postgres to generate a hundred million rows inside a transaction and take
 * the database down — a trivially cheap denial of service on an admin endpoint.
 */
function parseLayout(raw) {
  if (!Array.isArray(raw)) throw badRequest('layout must be an array of row definitions');
  if (raw.length === 0) throw badRequest('layout must contain at least one row');
  if (raw.length > 100) throw badRequest('layout must contain at most 100 rows');

  return raw.map((row, i) => {
    if (typeof row !== 'object' || row === null) {
      throw badRequest(`layout[${i}] must be an object`);
    }
    return {
      row_label: v.str(row.row_label, `layout[${i}].row_label`, { max: 10 }),
      seats: v.int(row.seats, `layout[${i}].seats`, { min: 1, max: 100 }),
      category: v.str(row.category, `layout[${i}].category`, { max: 50 }),
    };
  });
}

module.exports = router;
