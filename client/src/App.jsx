import { useState, useEffect, useCallback } from 'react'
import ExpenseForm from './components/ExpenseForm'
import ExpenseList from './components/ExpenseList'
import ExpenseChart from './components/ExpenseChart'
import ImportUpload from './components/ImportUpload'
// SignedIn/SignedOut: render children only when that auth state is true —
// this is how the whole "logged out landing page" vs "app" split below works.
// useAuth: hook giving access to isSignedIn and getToken() from anywhere.
import { SignedIn, SignedOut, SignInButton, UserButton, useAuth } from '@clerk/clerk-react'



export default function App() {
  // useState holds the list of expenses.
  // `expenses` is the current value; `setExpenses` is the function to update it.
  // Whenever setExpenses is called, React re-renders the component with the new value.
  const [expenses, setExpenses] = useState([])
  // getToken() returns a fresh Clerk session JWT to attach to API requests;
  // isSignedIn drives both the effect below and the SignedIn/SignedOut JSX.
  const { getToken, isSignedIn } = useAuth()

  // Bumped to ask for the list again. An import needs this: the worker writes
  // its rows straight to the database, so they only reach this component when
  // it refetches. A counter rather than exposing the fetch itself keeps the
  // fetching inside the effect below, where React wants it.
  const [refreshKey, setRefreshKey] = useState(0)
  const refreshExpenses = useCallback(() => setRefreshKey(key => key + 1), [])

  // useEffect runs after render, whenever something in its dependency array
  // changes — so this re-fires the moment the user signs in, and again whenever
  // refreshKey moves (it doesn't run on every render).
  useEffect(() => {
    if (!isSignedIn) return // nothing to fetch yet, avoids an unauthorized request
    // Effects can't be async directly (React expects a cleanup function or
    // nothing back, not a Promise), so the async work is wrapped in an
    // inner function that's declared then immediately called below.
    async function loadExpenses() {
      const token = await getToken()
      const response = await fetch(`${import.meta.env.VITE_API_URL}/expenses`, {
        headers: { 'Authorization': `Bearer ${token}` } // this is what getAuth(req) on the server reads
      })
      if (!response.ok) return
      const data = await response.json()
      setExpenses(data)
    }
    loadExpenses()
  }, [isSignedIn, refreshKey])

  // Passed down to ExpenseForm as the onAdd prop — the form calls this once
  // the user submits, it doesn't know or care how the POST is implemented.
  async function addExpense(expense) {
    const token = await getToken()
    const response = await fetch(`${import.meta.env.VITE_API_URL}/expenses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(expense)
    })
    if (!response.ok) {
      console.error('Failed to add expense')
      return
    }

    const newExpense = await response.json()
    // Prepend rather than append+refetch: the server already sends back the
    // full row (including its DB-generated id and AI category), so the
    // cheapest way to stay in sync is to just splice that response into state.
    setExpenses([newExpense, ...expenses])
  }

  // Filter out the deleted expense by id. filter() returns a new array
  // (it never modifies the original), which is what React needs.
  async function deleteExpense(id) {
    const token = await getToken()
    const response = await fetch(`${import.meta.env.VITE_API_URL}/expenses/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    })

    if (!response.ok) {
      console.error('Failed to delete expense')
      return
    }
    setExpenses(expenses.filter(e => e.id !== id))
  }

  // Clears every expense this user has. The server scopes the delete by user,
  // so this can only ever affect the signed-in account.
  //
  // Throws rather than returning quietly, unlike the single-row delete above:
  // the caller closes its confirmation prompt as soon as this resolves, so a
  // silent return would look exactly like success on the one action that
  // cannot be undone.
  async function deleteAllExpenses() {
    const token = await getToken()
    const response = await fetch(`${import.meta.env.VITE_API_URL}/expenses`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    })

    // Safe to promise nothing was removed: the server's only failure path is
    // deleteMany itself throwing, and that is one statement — it does not
    // partially delete. A network error is different and says less, so it is
    // left to surface its own message.
    if (!response.ok) {
      throw new Error(`Could not delete your expenses (${response.status}). Nothing was removed.`)
    }
    // Emptied locally rather than refetched — the server just confirmed there
    // is nothing left to fetch.
    setExpenses([])
  }

  // Derived value — recalculated every render. No need to store this in state.
  const total = expenses.reduce((sum, e) => sum + e.amount, 0)

  return (
    <>

    {/* Both branches render in the tree at all times — Clerk decides at
        runtime which one actually shows, based on auth state. So this is
        never "loading" flicker, it's a clean either/or swap. */}
    <SignedOut>
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900 mb-4">Welcome to Expense Tracker</h1>
          <p className="text-gray-500 mb-6">Please sign in to manage your expenses.</p>
          {/* mode="modal" opens Clerk's prebuilt sign-in UI in a popup —
              no custom login form to build or secure yourself. */}
          <SignInButton mode="modal">
            <button className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500">
              Sign In
            </button>
          </SignInButton>
        </div>
      </div>
    </SignedOut>

    <SignedIn>
      <div className="min-h-screen bg-gray-50 py-10">
          <div className="max-w-2xl mx-auto px-4">
            
            <div className="flex justify-between items-center mb-8">
              <h1 className="text-3xl font-bold text-gray-900 mb-1">Expense Tracker</h1>
              <UserButton />
            </div>
          <p className="text-gray-500 mb-8">Track your spending, one entry at a time.</p>

          {/* Props are how a parent component talks to a child.
              onAdd and onDelete are callback functions — the child calls them
              when something happens (form submit, delete click). */}
          <ExpenseForm onAdd={addExpense} />
            {/* Refetches once the import settles — those rows were written by
                the worker, so they never passed through local state. */}
            <ImportUpload onImported={refreshExpenses} />
            <ExpenseList
              expenses={expenses}
              onDelete={deleteExpense}
              onDeleteAll={deleteAllExpenses}
              total={total}
            />
            <ExpenseChart expenses={expenses} />
        </div>
      </div>
    </SignedIn>
      
    </>
  )
}
