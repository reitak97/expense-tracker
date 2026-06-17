import { useState, useEffect } from 'react'
import ExpenseForm from './components/ExpenseForm'
import ExpenseList from './components/ExpenseList'
import ExpenseChart from './components/ExpenseChart'
import { SignedIn, SignedOut, SignInButton, UserButton, useAuth } from '@clerk/clerk-react'



export default function App() {
  // useState holds the list of expenses.
  // `expenses` is the current value; `setExpenses` is the function to update it.
  // Whenever setExpenses is called, React re-renders the component with the new value.
  const [expenses, setExpenses] = useState([])
  const { getToken, isSignedIn } = useAuth()

  useEffect(() => {
    if (!isSignedIn) return
    async function loadExpenses() {
      const token = await getToken()
      const response = await fetch(`${import.meta.env.VITE_API_URL}/expenses`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      if (!response.ok) return
      const data = await response.json()
      setExpenses(data)
    }
    loadExpenses()
  }, [isSignedIn])

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

  // Derived value — recalculated every render. No need to store this in state.
  const total = expenses.reduce((sum, e) => sum + e.amount, 0)

  return (
    <>

    <SignedOut>
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900 mb-4">Welcome to Expense Tracker</h1>
          <p className="text-gray-500 mb-6">Please sign in to manage your expenses.</p>
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
            <ExpenseList expenses={expenses} onDelete={deleteExpense} total={total} />
            <ExpenseChart expenses={expenses} />
        </div>
      </div>
    </SignedIn>
      
    </>
  )
}
