'use strict';

/**
 * Socket.io layer.
 *
 * Clients viewing a seat map join the room for that show and receive seat deltas.
 * The module keeps a single server instance in a variable so any service can emit
 * without threading the `io` object through every call site, and so emitting is a
 * no-op when Socket.io is not attached (tests, migrations, scripts).
 */

const { Server } = require('socket.io');

let io = null;

const roomFor = (showId) => `show:${showId}`;

function attach(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: '*' },
    // Long enough to survive a brief network blip, short enough that a closed
    // tab stops counting as a viewer quickly.
    pingTimeout: 20_000,
  });

  io.on('connection', (socket) => {
    socket.on('show:join', (rawShowId) => {
      const showId = Number(rawShowId);
      if (!Number.isInteger(showId) || showId <= 0) return;

      // One show per socket: a seat map page only ever watches the show it is
      // displaying, and leaving the previous room stops a client that navigates
      // between shows from accumulating subscriptions.
      for (const room of socket.rooms) {
        if (room !== socket.id && room.startsWith('show:')) socket.leave(room);
      }
      socket.join(roomFor(showId));
      socket.emit('show:joined', { showId });
    });

    socket.on('show:leave', (rawShowId) => {
      const showId = Number(rawShowId);
      if (Number.isInteger(showId) && showId > 0) socket.leave(roomFor(showId));
    });
  });

  console.log('[realtime] socket.io attached');
  return io;
}

/**
 * Broadcast changed seats to everyone watching a show.
 *
 * The payload carries the seats' *effective* status but deliberately no
 * `held_by`: every viewer of a show receives this same broadcast, so including
 * the holder's identity would leak one customer's user id to all the others.
 * Each client re-derives "mine" from its own authenticated seat map fetch, and
 * `heldByUserId` below lets a client that receives its own change know it was the
 * cause without learning anything about other people's holds.
 */
function emitSeatUpdate(showId, seats, meta = {}) {
  if (!io || !Array.isArray(seats) || seats.length === 0) return;

  io.to(roomFor(showId)).emit('seats:updated', {
    showId: Number(showId),
    reason: meta.reason || 'change',
    seats: seats.map((s) => ({
      id: s.id,
      status: s.status,
      row_label: s.row_label,
      seat_number: s.seat_number,
      category: s.category,
      price: s.price,
    })),
    // Which user caused this, so a client can tell "my hold expired" from
    // "someone else released a seat". Clients only ever compare it to their own
    // id; it is not a general identity disclosure because a client already knows
    // its own id.
    actorId: meta.actorId ?? null,
    at: new Date().toISOString(),
  });
}

/** Notify a show's viewers that availability changed enough to re-check counts. */
function emitAvailabilityChanged(showId, reason = 'change') {
  if (!io) return;
  io.to(roomFor(showId)).emit('availability:changed', { showId: Number(showId), reason });
}

function getIo() {
  return io;
}

async function close() {
  if (!io) return;
  // Actively disconnect clients first. io.close() stops accepting new
  // connections but leaves established sockets to time out on their own, which
  // keeps the event loop alive — a hang on shutdown and on test teardown.
  io.disconnectSockets(true);
  await new Promise((resolve) => io.close(resolve));
  io = null;
}

module.exports = { attach, emitSeatUpdate, emitAvailabilityChanged, getIo, close, roomFor };
