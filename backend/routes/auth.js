const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const User    = require('../models/User');
const { registerLimiter } = require('../middleware/rateLimit');

// Helper: generate JWT
const generateToken = (user) =>
  jwt.sign({
    id: user._id,
    name: user.name,
    username: user.username,
    email: user.email
  }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '7d'
  });

// ── POST /api/auth/register ──────────────────────────────────────────────────
//
// registerLimiter is ROUTE-level, not router.use(), and that is the whole
// design. This router has no `protect` on it, so a router-level mount would
// cover /login as well — and a limiter keyed globally on login turns one
// credential-stuffing attempt into an outage for every existing user. See
// middleware/rateLimit.js's header: register is once-per-lifetime and can
// tolerate a shared budget; login is per-session and cannot.
//
// It is FIRST in the chain, before the body is read, so a flood is refused
// before it reaches the User.findOne() and the bcrypt hash it would otherwise
// pay for. That ordering is the point of putting it here rather than inside
// the handler.
router.post('/register', registerLimiter, async (req, res) => {
  const { name, username, email, password } = req.body;

  if (!name || !username || !email || !password) {
    return res.status(400).json({ message: 'Please provide name, username, email and password' });
  }

  try {
    // Check for existing user
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      const field = existingUser.email === email ? 'Email' : 'Username';
      return res.status(409).json({ message: `${field} already in use` });
    }

    const user  = await User.create({ name, username, email, password });
    const token = generateToken(user);

    return res.status(201).json({
      token,
      user: { id: user._id, name: user.name, username: user.username, email: user.email }
    });
  } catch (err) {
    console.error('Register error:', err);
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ message: messages.join('. ') });
    }
    return res.status(500).json({ message: 'Server error during registration' });
  }
});

// ── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Please provide email and password' });
  }

  try {
    // Include password field (excluded by default via schema `select: false`)
    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const token = generateToken(user);
    return res.json({
      token,
      user: { id: user._id, name: user.name, username: user.username, email: user.email }
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ message: 'Server error during login' });
  }
});

module.exports = router;
