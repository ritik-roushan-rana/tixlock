'use strict';

const { api, query, truncateAll, closePool, createUser, auth } = require('./helpers');

beforeEach(truncateAll);
afterAll(closePool);

describe('POST /api/auth/register', () => {
  it('registers a customer, returns a token, and never returns the password hash', async () => {
    const res = await api()
      .post('/api/auth/register')
      .send({ name: 'Asha Rao', email: 'asha@example.com', password: 'hunter2hunter2' });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      name: 'Asha Rao',
      email: 'asha@example.com',
      role: 'customer',
    });
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).not.toHaveProperty('password_hash');
    expect(JSON.stringify(res.body)).not.toContain('hunter2hunter2');
  });

  it('stores a bcrypt hash, not the plaintext password', async () => {
    await api()
      .post('/api/auth/register')
      .send({ name: 'B', email: 'b@example.com', password: 'plaintextpw1' });

    const { rows } = await query('SELECT password_hash FROM users WHERE email = $1', [
      'b@example.com',
    ]);
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$/);
    expect(rows[0].password_hash).not.toContain('plaintextpw1');
  });

  it('allows registering as an organiser', async () => {
    const res = await api()
      .post('/api/auth/register')
      .send({ name: 'Org', email: 'org@example.com', password: 'password123', role: 'organiser' });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('organiser');
  });

  it('refuses to create an admin via the public endpoint (privilege escalation)', async () => {
    const res = await api()
      .post('/api/auth/register')
      .send({ name: 'Sneaky', email: 'sneaky@example.com', password: 'password123', role: 'admin' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/admin accounts are provisioned/i);

    const { rows } = await query("SELECT count(*)::int AS n FROM users WHERE role = 'admin'");
    expect(rows[0].n).toBe(0);
  });

  it('rejects a duplicate email with 409, case-insensitively', async () => {
    await api()
      .post('/api/auth/register')
      .send({ name: 'First', email: 'dupe@example.com', password: 'password123' });

    const res = await api()
      .post('/api/auth/register')
      .send({ name: 'Second', email: 'DUPE@example.com', password: 'password123' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it.each([
    ['missing name', { email: 'x@example.com', password: 'password123' }],
    ['bad email', { name: 'X', email: 'not-an-email', password: 'password123' }],
    ['short password', { name: 'X', email: 'x@example.com', password: 'short' }],
  ])('rejects invalid input: %s', async (_label, body) => {
    const res = await api().post('/api/auth/register').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with correct credentials', async () => {
    await createUser({ email: 'login@test.local', password: 'correctpassword' });

    const res = await api()
      .post('/api/auth/login')
      .send({ email: 'login@test.local', password: 'correctpassword' });

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user.email).toBe('login@test.local');
  });

  it('is case-insensitive on email', async () => {
    await createUser({ email: 'case@test.local', password: 'correctpassword' });
    const res = await api()
      .post('/api/auth/login')
      .send({ email: 'CASE@TEST.LOCAL', password: 'correctpassword' });
    expect(res.status).toBe(200);
  });

  it('returns an identical error for a wrong password and an unknown email (no user enumeration)', async () => {
    await createUser({ email: 'real@test.local', password: 'correctpassword' });

    const wrongPassword = await api()
      .post('/api/auth/login')
      .send({ email: 'real@test.local', password: 'wrongpassword' });
    const unknownEmail = await api()
      .post('/api/auth/login')
      .send({ email: 'ghost@test.local', password: 'correctpassword' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });
});

describe('auth middleware', () => {
  it('rejects a request with no token as 401', async () => {
    const res = await api().get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/missing bearer token/i);
  });

  it('rejects a malformed token as 401', async () => {
    const res = await api().get('/api/auth/me').set('Authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with the wrong secret as 401', async () => {
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ sub: 1, role: 'admin' }, 'the-wrong-secret');
    const res = await api().get('/api/auth/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('rejects an expired token as 401', async () => {
    const jwt = require('jsonwebtoken');
    const config = require('../src/config/env');
    const user = await createUser();
    const expired = jwt.sign({ sub: user.id, role: user.role }, config.jwt.secret, {
      expiresIn: '-1s',
    });
    const res = await api().get('/api/auth/me').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/expired/i);
  });

  it('rejects a valid token whose user has since been deleted', async () => {
    const user = await createUser();
    await query('DELETE FROM users WHERE id = $1', [user.id]);

    const res = await api().get('/api/auth/me').set(auth(user));
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/no longer exists/i);
  });

  it('reflects a role change immediately, without waiting for token expiry', async () => {
    const user = await createUser({ role: 'customer' });
    await query("UPDATE users SET role = 'organiser' WHERE id = $1", [user.id]);

    const res = await api().get('/api/auth/me').set(auth(user));
    expect(res.status).toBe(200);
    // Token still says customer; the DB is authoritative.
    expect(res.body.user.role).toBe('organiser');
  });

  it('accepts a valid token', async () => {
    const user = await createUser({ role: 'organiser' });
    const res = await api().get('/api/auth/me').set(auth(user));
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.user.role).toBe('organiser');
  });
});

describe('GET /api/health', () => {
  it('reports database connectivity and the configured TTLs', async () => {
    const res = await api().get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'connected' });
    expect(res.body.holdTtlMinutes).toEqual(expect.any(Number));
    expect(res.body.offerTtlMinutes).toEqual(expect.any(Number));
  });

  it('names the mail transport without leaking a credential', async () => {
    const res = await api().get('/api/health');
    expect(['mailjet', 'smtp', 'console (not sent)']).toContain(res.body.mail);

    // The point of the field is diagnosis, not disclosure: assert the response body
    // contains no part of whatever keys the environment happens to hold.
    const serialised = JSON.stringify(res.body);
    for (const secret of [
      process.env.MJ_APIKEY_PRIVATE,
      process.env.MJ_APIKEY_PUBLIC,
      process.env.SMTP_PASS,
    ]) {
      if (secret) expect(serialised).not.toContain(secret);
    }
  });
});

describe('unmatched API routes', () => {
  it('returns a JSON 404 rather than HTML', async () => {
    const res = await api().get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
