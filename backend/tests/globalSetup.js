'use strict';

/**
 * Jest globalSetup: rebuild the test schema once per run.
 *
 * Tests run against a real PostgreSQL database rather than a mock. That is a
 * deliberate and load-bearing choice: the correctness argument for this codebase
 * is entirely about PostgreSQL's row-locking and transaction semantics
 * (SELECT ... FOR UPDATE, SKIP LOCKED, READ COMMITTED re-checking a predicate
 * after a lock wait). A mocked pg client would happily "pass" a test suite while
 * the real race condition remained wide open, which is precisely the failure this
 * project is meant to rule out.
 */

process.env.NODE_ENV = 'test';

module.exports = async () => {
  const config = require('../src/config/env');

  if (!config.isTest) {
    throw new Error('Test setup refused to run: NODE_ENV is not "test"');
  }

  // Guard against ever pointing the destructive reset at a real database.
  const url = config.db.connectionString;
  if (!/test/i.test(url)) {
    throw new Error(
      `Refusing to reset a database whose URL does not contain "test": ${url}\n` +
        'Set TEST_DATABASE_URL to a dedicated test database.'
    );
  }

  const { reset } = require('../src/migrations/run');
  const { close } = require('../src/config/db');

  await reset({ quiet: true });
  // The pool opened here belongs to this process; each test file opens its own.
  await close();
};
