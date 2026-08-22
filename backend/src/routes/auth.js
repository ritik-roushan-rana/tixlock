'use strict';

const express = require('express');

const authService = require('../services/authService');
const v = require('../lib/validate');
const { badRequest } = require('../lib/errors');
const { asyncHandler } = require('../middleware/error');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /api/auth/register
 * Body: { name, email, password, role? }  role ∈ customer | organiser
 */
router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const payload = {
      name: v.str(req.body.name, 'name', { max: 120 }),
      email: v.email(req.body.email),
      password: v.password(req.body.password),
      role: req.body.role === undefined ? 'customer' : v.str(req.body.role, 'role', { max: 20 }),
    };

    const user = await authService.register(payload);
    // Log them straight in — no separate round trip after registering.
    const token = authService.signToken(user);
    res.status(201).json({ user, token });
  })
);

/**
 * POST /api/auth/login
 * Body: { email, password }  — works for all three roles.
 */
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const email = v.email(req.body.email);
    // Not run through v.password(): length rules apply to *setting* a password.
    // Enforcing them here would reject a legacy password and, worse, reveal
    // through a 400-vs-401 difference that the submitted value was malformed.
    if (typeof req.body.password !== 'string' || req.body.password === '') {
      throw badRequest('password is required');
    }

    const { user, token } = await authService.login({ email, password: req.body.password });
    res.json({ user, token });
  })
);

/** GET /api/auth/me — current user, for the frontend to restore a session. */
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: req.user });
  })
);

module.exports = router;
