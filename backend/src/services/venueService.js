'use strict';

/**
 * Venue and seat-layout management (admin only).
 *
 * `venue_seats` is a template, not inventory: it describes the physical seats a
 * venue has. Actual sellable inventory is `show_seats`, stamped out from this
 * template when a show is created. That separation is why layout edits have to be
 * guarded — see defineLayout below.
 */

const { query, withTransaction } = require('../config/db');
const { notFound, conflict, badRequest } = require('../lib/errors');

async function listVenues() {
  const { rows } = await query(`
    SELECT v.*,
           COALESCE(s.seat_count, 0)::int      AS seat_count,
           COALESCE(s.category_count, 0)::int  AS category_count,
           COALESCE(e.event_count, 0)::int     AS event_count
      FROM venues v
      LEFT JOIN (
        SELECT venue_id,
               count(*)                  AS seat_count,
               count(DISTINCT category)  AS category_count
          FROM venue_seats GROUP BY venue_id
      ) s ON s.venue_id = v.id
      LEFT JOIN (
        SELECT venue_id, count(*) AS event_count FROM events GROUP BY venue_id
      ) e ON e.venue_id = v.id
     ORDER BY v.name
  `);
  return rows;
}

async function getVenue(venueId) {
  const { rows } = await query('SELECT * FROM venues WHERE id = $1', [venueId]);
  if (!rows[0]) throw notFound(`Venue ${venueId} not found`);
  return rows[0];
}

/**
 * Full venue detail including the seat layout, grouped into rows so the frontend
 * can render a grid without regrouping client-side.
 */
async function getVenueWithLayout(venueId) {
  const venue = await getVenue(venueId);

  const { rows: seats } = await query(
    `SELECT id, row_label, seat_number, category
       FROM venue_seats
      WHERE venue_id = $1
      ORDER BY row_label, seat_number`,
    [venueId]
  );

  const rowMap = new Map();
  for (const seat of seats) {
    if (!rowMap.has(seat.row_label)) {
      rowMap.set(seat.row_label, { row_label: seat.row_label, category: seat.category, seats: [] });
    }
    rowMap.get(seat.row_label).seats.push({
      id: seat.id,
      seat_number: seat.seat_number,
      category: seat.category,
    });
  }

  const categories = [...new Set(seats.map((s) => s.category))].sort();
  const showCount = await countShowsForVenue(venueId);

  return {
    ...venue,
    categories,
    seat_count: seats.length,
    rows: [...rowMap.values()],
    // Tells the frontend whether the layout is still editable.
    locked: showCount > 0,
    show_count: showCount,
  };
}

async function countShowsForVenue(venueId) {
  const { rows } = await query(
    `SELECT count(*)::int AS n
       FROM shows s
       JOIN events e ON e.id = s.event_id
      WHERE e.venue_id = $1`,
    [venueId]
  );
  return rows[0].n;
}

async function createVenue({ name, address, createdBy }) {
  const { rows } = await query(
    'INSERT INTO venues (name, address, created_by) VALUES ($1, $2, $3) RETURNING *',
    [name, address, createdBy]
  );
  return rows[0];
}

async function updateVenue(venueId, { name, address }) {
  await getVenue(venueId); // 404 before doing anything else

  const { rows } = await query(
    `UPDATE venues
        SET name    = COALESCE($2, name),
            address = COALESCE($3, address)
      WHERE id = $1
      RETURNING *`,
    [venueId, name ?? null, address ?? null]
  );
  return rows[0];
}

/**
 * Define (or redefine) a venue's seat layout from row specifications.
 *
 * Input: [{ row_label, seats, category }, ...] — a form-friendly shape that the
 * admin UI's grid generator produces directly.
 *
 * Two protections matter here:
 *
 * 1. **Refuse once shows exist.** show_seats rows hold a foreign key to
 *    venue_seats, and each carries a copy of its category. Rewriting the layout
 *    underneath live shows would either fail on that FK or silently desynchronise
 *    already-sold seats from the layout they were sold under. Since there is no
 *    correct way to retro-fit a layout change onto sold inventory, the operation
 *    is rejected rather than half-applied.
 *
 * 2. **Replace atomically.** The delete and re-insert happen in one transaction,
 *    so a failure part-way cannot leave a venue with no seats at all.
 */
async function defineLayout(venueId, rowSpecs) {
  await getVenue(venueId);

  const showCount = await countShowsForVenue(venueId);
  if (showCount > 0) {
    throw conflict(
      `Cannot change the seat layout: ${showCount} show(s) have already been created for this venue ` +
        'and their seats were generated from the current layout. Create a new venue instead.',
      { showCount }
    );
  }

  // Reject duplicate row labels up front — otherwise the unique constraint would
  // surface as an opaque 409 halfway through the insert loop.
  const labels = rowSpecs.map((r) => r.row_label);
  const duplicates = labels.filter((l, i) => labels.indexOf(l) !== i);
  if (duplicates.length > 0) {
    throw badRequest(`Duplicate row label(s): ${[...new Set(duplicates)].join(', ')}`);
  }

  return withTransaction(async (client) => {
    // Full replace. Safe because we've established no shows depend on these rows.
    await client.query('DELETE FROM venue_seats WHERE venue_id = $1', [venueId]);

    let inserted = 0;
    for (const spec of rowSpecs) {
      // One multi-row INSERT per row spec via generate_series: keeps this to one
      // round trip per row rather than one per seat, which matters for a
      // 50-row venue.
      const { rowCount } = await client.query(
        `INSERT INTO venue_seats (venue_id, row_label, seat_number, category)
         SELECT $1, $2, n, $4
           FROM generate_series(1, $3) AS n`,
        [venueId, spec.row_label, spec.seats, spec.category]
      );
      inserted += rowCount;
    }

    return { venue_id: venueId, seats_created: inserted, rows_created: rowSpecs.length };
  });
}

module.exports = {
  listVenues,
  getVenue,
  getVenueWithLayout,
  createVenue,
  updateVenue,
  defineLayout,
  countShowsForVenue,
};
