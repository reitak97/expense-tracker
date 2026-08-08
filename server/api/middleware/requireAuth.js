// Rejects any request without a signed-in user, so handlers behind it can
// assume req.userId exists.

const { getAuth } = require('@clerk/express')

function requireAuth(req, res, next) {
  let userId
  try {
    userId = getAuth(req)?.userId
  } catch (_) {
    // getAuth throws when Clerk can't parse the request at all; that's a 401,
    // not a 500, so it falls through to the check below.
  }

  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  // Request-scoped, not global — handlers still pass it explicitly to Prisma.
  req.userId = userId

  next()
}

module.exports = { requireAuth }
