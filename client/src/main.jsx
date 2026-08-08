import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Client-side counterpart to the server's clerkMiddleware — gives every
// component under it access to Clerk's auth state/hooks (useAuth, useUser, etc).
import { ClerkProvider } from '@clerk/clerk-react'

import './index.css'
import App from './App.jsx'

// Vite exposes env vars prefixed VITE_ to the browser bundle (anything else
// in .env is stripped out at build time). This is the *publishable* key —
// safe to ship to the browser, unlike the secret key app.js uses.
const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

// Finds the <div id="root"> in index.html and mounts the React tree into it —
// this is the one place the React app touches the raw DOM directly.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* Wraps the whole app so any component can ask "is someone logged in?"
        without prop-drilling auth state down through every layer. */}
    <ClerkProvider publishableKey={publishableKey}>
      <App />
    </ClerkProvider>
  </StrictMode>,
)
