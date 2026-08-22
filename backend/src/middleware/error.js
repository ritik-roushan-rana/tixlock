'use strict';

/**
 * Central error handling.
 *
 * Two exports: asyncHandler wraps route handlers so a rejected promise reaches
 * Express (Express 4 does not forward async rejections on its own), and
 * errorHandler renders any thrown error as the standard error envelope.
 */

const config = require('../config/env');
const { AppError, notFound } = require('../lib/errors');

/** Wrap an async route handler so rejections reach the error middleware. */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/** 404 for unmatched API routes. Mounted after all real routes. */
function notFoundHandler(req, res, next) {
  next(notFound(`No route matches ${req.method} ${req.originalUrl}`));
}

/**
 * Translate Postgres driver errors into the right HTTP status.
 *
 * Without this, a race that slips past an application check surfaces as a 500
 * when the real answer is 409. Unique-violation in particular is a legitimate
 * concurrency outcome, not a server fault.
 */
function mapDatabaseError(err) {
  switch (err.code) {
    case '23505': // unique_violation
    case '23P01': // exclusion_violation
      return new AppError(409, 'CONFLICT', 'That record already exists');
    case '23503': // foreign_key_violation
      return new AppError(400, 'BAD_REQUEST', 'Referenced record does not exist');
    case '23502': // not_null_violation
    case '23514': // check_violation
      return new AppError(400, 'BAD_REQUEST', 'Values violate a database constraint');
    case '22P02': // invalid_text_representation, e.g. bad enum value
      return new AppError(400, 'BAD_REQUEST', 'Invalid value for one of the fields');
    case '40P01': // deadlock_detected
      return new AppError(
        409,
        'CONFLICT',
        'The request conflicted with another in-flight request. Please retry.'
      );
    case '57014': // query_canceled — our statement_timeout fired
      return new AppError(503, 'TIMEOUT', 'The database took too long to respond. Please retry.');
    case 'ECONNREFUSED':
    case '08006': // connection_failure
    case '08003': // connection_does_not_exist
      return new AppError(503, 'DB_UNAVAILABLE', 'The database is temporarily unavailable');
    default:
      return null;
  }
}

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity
function errorHandler(err, req, res, next) {
  let error = err;

  if (!(error instanceof AppError)) {
    const mapped = mapDatabaseError(error);
    if (mapped) {
      // Keep the driver detail in the log, out of the response.
      console.error(`[error] db ${error.code}: ${error.message}`);
      error = mapped;
    }
  }

  if (error instanceof AppError) {
    if (error.status >= 500) console.error('[error]', error);
    return res.status(error.status).json(error.toJSON());
  }

  // Malformed JSON body — body-parser marks these.
  if (error.type === 'entity.parse.failed' || error instanceof SyntaxError) {
    return res
      .status(400)
      .json({ error: { code: 'BAD_REQUEST', message: 'Request body is not valid JSON' } });
  }

  // Genuinely unexpected. Log everything, leak nothing.
  console.error('[error] unhandled:', error);
  const body = {
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
  };
  if (!config.isProduction) {
    body.error.debug = { message: error.message, stack: error.stack?.split('\n').slice(0, 5) };
  }
  return res.status(500).json(body);
}

module.exports = { asyncHandler, notFoundHandler, errorHandler };
