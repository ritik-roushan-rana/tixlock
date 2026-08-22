'use strict';

/**
 * Socket.io broadcast tests.
 *
 * Uses a real HTTP server and real socket clients rather than asserting that an
 * emit function was called: the thing worth verifying is that a browser sitting on
 * a seat map actually receives the update, which means exercising the room
 * subscription too.
 */

const http = require('node:http');
const { io: ioClient } = require('socket.io-client');

const { app, query, truncateAll, closePool, createUser, auth, createBookableShow } = require('./helpers');
const realtime = require('../src/realtime/io');
const sweeper = require('../src/jobs/sweeper');
const request = require('supertest');

let server;
let baseUrl;
let ctx;
let customerA;
let customerB;

beforeAll(async () => {
  server = http.createServer(app);
  realtime.attach(server);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await realtime.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

beforeEach(async () => {
  await truncateAll();
  ctx = await createBookableShow({
    layout: [{ row_label: 'A', seats: 4, category: 'Premium' }],
    pricing: { Premium: 500 },
  });
  customerA = await createUser({ role: 'customer' });
  customerB = await createUser({ role: 'customer' });
});

/** Connect a client and join a show room, resolving once the join is acked. */
function connectClient(showId) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, { transports: ['websocket'], reconnection: false });
    // Cleared on settle so a successful connect leaves no pending timer holding
    // the event loop open after the suite finishes.
    const timer = setTimeout(() => reject(new Error('socket connect timed out')), 5000);
    const settle = (fn) => (arg) => {
      clearTimeout(timer);
      fn(arg);
    };
    socket.on('connect_error', settle(reject));
    socket.on('connect', () => socket.emit('show:join', showId));
    socket.on('show:joined', () => settle(resolve)(socket));
  });
}

/** Resolve with the next event of the given name, or reject on timeout. */
function nextEvent(socket, name, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${name}"`)), timeoutMs);
    socket.once(name, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

const hold = (customer, seatIds, showId = ctx.show.id) =>
  request(app).post(`/api/shows/${showId}/hold`).set(auth(customer)).send({ seat_ids: seatIds });

describe('seat hold broadcasts', () => {
  it('notifies another viewer of the same show when a seat is held', async () => {
    const watcher = await connectClient(ctx.show.id);
    try {
      const waiting = nextEvent(watcher, 'seats:updated');
      await hold(customerA, [ctx.seats[0].id]);
      const payload = await waiting;

      expect(payload.showId).toBe(ctx.show.id);
      expect(payload.reason).toBe('hold');
      expect(payload.seats).toHaveLength(1);
      expect(payload.seats[0]).toMatchObject({
        id: ctx.seats[0].id,
        status: 'held',
        row_label: 'A',
        seat_number: 1,
      });
    } finally {
      watcher.close();
    }
  });

  it('never includes the holder’s user id in the broadcast', async () => {
    const watcher = await connectClient(ctx.show.id);
    try {
      const waiting = nextEvent(watcher, 'seats:updated');
      await hold(customerA, [ctx.seats[0].id]);
      const payload = await waiting;

      // actorId is present by design (a client compares it to its own id), but the
      // seat rows must not carry held_by.
      expect(payload.seats[0]).not.toHaveProperty('held_by');
      expect(JSON.stringify(payload.seats)).not.toContain('held_by');
    } finally {
      watcher.close();
    }
  });

  it('identifies the acting customer so a client can tell its own change apart', async () => {
    const watcher = await connectClient(ctx.show.id);
    try {
      const waiting = nextEvent(watcher, 'seats:updated');
      await hold(customerB, [ctx.seats[1].id]);
      expect((await waiting).actorId).toBe(customerB.id);
    } finally {
      watcher.close();
    }
  });

  it('broadcasts a release', async () => {
    await hold(customerA, [ctx.seats[0].id]);
    const watcher = await connectClient(ctx.show.id);
    try {
      const waiting = nextEvent(watcher, 'seats:updated');
      await request(app).delete(`/api/shows/${ctx.show.id}/hold`).set(auth(customerA)).send({});
      const payload = await waiting;

      expect(payload.reason).toBe('release');
      expect(payload.seats[0].status).toBe('available');
    } finally {
      watcher.close();
    }
  });

  it('does not leak events to viewers of a different show', async () => {
    const other = await createBookableShow({
      layout: [{ row_label: 'Z', seats: 2, category: 'Premium' }],
      pricing: { Premium: 100 },
      date: '2027-05-05',
    });

    const watcher = await connectClient(other.show.id);
    try {
      let received = false;
      watcher.on('seats:updated', () => {
        received = true;
      });

      await hold(customerA, [ctx.seats[0].id]);
      await new Promise((r) => setTimeout(r, 400));

      expect(received).toBe(false);
    } finally {
      watcher.close();
    }
  });

  it('reaches every viewer of the show, not just one', async () => {
    const [w1, w2, w3] = await Promise.all([
      connectClient(ctx.show.id),
      connectClient(ctx.show.id),
      connectClient(ctx.show.id),
    ]);
    try {
      const all = Promise.all([
        nextEvent(w1, 'seats:updated'),
        nextEvent(w2, 'seats:updated'),
        nextEvent(w3, 'seats:updated'),
      ]);
      await hold(customerA, [ctx.seats[0].id]);
      const payloads = await all;

      expect(payloads).toHaveLength(3);
      for (const p of payloads) expect(p.seats[0].id).toBe(ctx.seats[0].id);
    } finally {
      [w1, w2, w3].forEach((s) => s.close());
    }
  });

  it('switching shows unsubscribes from the previous room', async () => {
    const other = await createBookableShow({
      layout: [{ row_label: 'Z', seats: 2, category: 'Premium' }],
      pricing: { Premium: 100 },
      date: '2027-06-06',
    });

    const socket = await connectClient(ctx.show.id);
    try {
      // Move to the other show.
      const rejoined = nextEvent(socket, 'show:joined');
      socket.emit('show:join', other.show.id);
      await rejoined;

      let received = false;
      socket.on('seats:updated', () => {
        received = true;
      });

      // A change in the *original* show must no longer reach this socket.
      await hold(customerA, [ctx.seats[0].id]);
      await new Promise((r) => setTimeout(r, 400));
      expect(received).toBe(false);
    } finally {
      socket.close();
    }
  });
});

describe('sweeper broadcasts', () => {
  it('emits an update when the cron sweep releases an expired hold', async () => {
    await hold(customerA, [ctx.seats[0].id]);
    await query(
      "UPDATE show_seats SET hold_expires_at = now() - interval '1 second' WHERE status='held'"
    );

    const watcher = await connectClient(ctx.show.id);
    try {
      const waiting = nextEvent(watcher, 'seats:updated');
      await sweeper.runOnce({ quiet: true });
      const payload = await waiting;

      expect(payload.reason).toBe('hold-expired');
      expect(payload.seats[0]).toMatchObject({ id: ctx.seats[0].id, status: 'available' });
      // Nobody's action caused this — it was the scheduler.
      expect(payload.actorId).toBeNull();
    } finally {
      watcher.close();
    }
  });

  it('emits an availability change alongside the seat update', async () => {
    const watcher = await connectClient(ctx.show.id);
    try {
      const waiting = nextEvent(watcher, 'availability:changed');
      await hold(customerA, [ctx.seats[0].id]);
      expect((await waiting).showId).toBe(ctx.show.id);
    } finally {
      watcher.close();
    }
  });
});
