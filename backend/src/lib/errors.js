'use strict';

/**
 * Typed application errors.
 *
 * Route handlers throw these; the central error middleware turns them into
 * responses. This keeps handlers free of res.status(...).json(...) branching and
 * guarantees a single response shape across the whole API:
 *
 *   { error: { code, message, details? } }
 */

class AppError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code   stable machine-readable code for clients
   * @param {string} message human-readable message (safe to show a user)
   * @param {object} [details] extra structured context, e.g. conflicting seat ids
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
    // Keep stack traces pointing at the throw site, not this constructor.
    Error.captureStackTrace?.(this, AppError);
  }

  toJSON() {
    const body = { code: this.code, message: this.message };
    if (this.details !== undefined) body.details = this.details;
    return { error: body };
  }
}

const badRequest = (message, details) => new AppError(400, 'BAD_REQUEST', message, details);
const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message);
const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'FORBIDDEN', message);
const notFound = (message = 'Resource not found') => new AppError(404, 'NOT_FOUND', message);
const conflict = (message, details) => new AppError(409, 'CONFLICT', message, details);

/**
 * Seat contention is the one conflict clients must handle programmatically, so
 * it gets its own code and always carries the offending seat ids.
 */
const seatConflict = (unavailableSeatIds, message) =>
  new AppError(
    409,
    'SEATS_UNAVAILABLE',
    message || 'One or more selected seats are no longer available',
    { unavailableSeatIds }
  );

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  seatConflict,
};
