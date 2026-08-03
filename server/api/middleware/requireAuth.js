// Express middleware that rejects any request without a signed-in user.
//
// A "middleware" in Express is just a function with the signature
// (req, res, next). Express calls it before the route handler. It can either:
//   - end the request itself (by calling res.status().json()), or
//   - call next() to hand control to whatever comes after it.
// That fork is the whole idea: this file is the gate, the route handlers
// behind it can assume the gate was passed.
//
// Before this existed, the same six lines were pasted into all four expense
// routes. Four copies of an auth check is four chances for one of them to
// drift — the worst kind of code to duplicate.

// getAuth reads the userId out of the request. It works because
// clerkMiddleware() has already run in app.js and attached Clerk's parsed
// auth state to the request object.
const { getAuth } = require('@clerk/express')

function requireAuth(req, res, next) {
  // getAuth doesn't just return null on a bad request — it THROWS if Clerk
  // can't parse the request at all (no token, or Clerk isn't configured
  // because the keys are missing). The try/catch converts that throw into
  // "userId stays undefined", so both failure shapes fall through to the same
  // 401 below instead of one becoming an unhandled 500.
  //
  // `let` rather than `const` because it's assigned inside the try but read
  // outside it — a const would be scoped to the block and invisible below.
  let userId
  try {
    // ?. is optional chaining: if getAuth(req) returns null/undefined, the
    // whole expression evaluates to undefined instead of throwing
    // "cannot read property userId of null".
    userId = getAuth(req)?.userId
  } catch (_) {
    // Deliberately empty, and the one place in this codebase where that's
    // correct — the throw IS the "not authenticated" signal, and the check
    // below handles it. The underscore is a naming convention for "I know
    // there's an argument here, I'm intentionally not using it."
    //
    // This is not the silent-catch that CLAUDE.md forbids: nothing is being
    // hidden, the failure is handled two lines down.
  }

  // No userId means unauthenticated. Return ends the request here; the route
  // handler behind this middleware never runs.
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  // Stash the userId on the request so handlers don't each have to call
  // getAuth again. This is request-scoped state — a fresh req object per
  // request — not a global, so there's no risk of one user's id leaking into
  // another's request. Handlers still pass req.userId explicitly into every
  // Prisma call, which is what CLAUDE.md's "userId as an explicit parameter"
  // rule is actually about.
  req.userId = userId

  // Hand off to the next middleware or the route handler. Forgetting this
  // call is the classic Express bug: the request hangs forever with no error,
  // because nothing ever responds.
  next()
}

module.exports = { requireAuth }
