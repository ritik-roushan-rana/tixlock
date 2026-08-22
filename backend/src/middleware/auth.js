'use strict';

/**
 * JWT authentication and role authorisation.
 *
 * requireAuth resolves the caller from the Bearer token and attaches req.user.
 * requireRole(...roles) gates a route on the caller's role.
 */

const { verifyToken, findById } = require('../services/authService');
const { unauthorized, forbidden } = require('../lib/errors');
const { asyncHandler } = require('./error');

function extractToken(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match) return match[1].trim();

  // Accepted only for the emailed waitlist-offer link, where the browser
  // navigates directly and cannot set a header.
  if (typeof req.query.token === 'string' && req.query.token) return req.query.token;

  return null;
}

/**
 * Require a valid token.
 *
 * The user row is re-read from the database on every request rather than trusted
 * from the token payload. It costs one indexed primary-key lookup and means a
 * deleted user's outstanding token stops working immediately, and a role change
 * takes effect at once instead of whenever the token happens to expire.
 */
const requireAuth = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) throw unauthorized('Missing Bearer token');

  const payload = verifyToken(token);
  const user = await findById(payload.sub);
  if (!user) throw unauthorized('Account no longer exists');

  req.user = user;
  next();
});

/**
 * Restrict a route to the given roles. Must be mounted after requireAuth.
 *
 * Distinguishes 401 from 403 deliberately: an unauthenticated caller should be
 * told to log in, an authenticated one with the wrong role should be told it will
 * never work.
 */
function requireRole(...roles) {
  const allowed = roles.flat();
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!allowed.includes(req.user.role)) {
      return next(
        forbidden(
          `This action requires the ${allowed.join(' or ')} role; you are signed in as ${req.user.role}`
        )
      );
    }
    next();
  };
}

/**
 * Attach req.user when a token is present, but allow anonymous access.
 * Used on public reads that behave slightly differently when signed in — the
 * seat map, which flags a caller's own holds.
 */
const optionalAuth = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) return next();
  try {
    const payload = verifyToken(token);
    req.user = (await findById(payload.sub)) || undefined;
  } catch {
    // A bad token on a public route is simply anonymous, not an error.
  }
  next();
});

module.exports = { requireAuth, requireRole, optionalAuth };
