import { useState } from 'react'

const CATEGORIES = ['Food & Drink', 'Transport', 'Bills', 'Shopping', 'Health', 'Other']

// A "blank" form object we can reuse to reset the form after submit.
const EMPTY_FORM = { description: '', amount: '', category: 'Food & Drink', date: '' }

// `onAdd` is a function passed down from App.jsx.
// When the form submits we call it with the new expense data.
export default function ExpenseForm({ onAdd }) {
  // One state object holds all four fields.
  // This is a common pattern — one useState for the whole form instead of four separate ones.
  const [form, setForm] = useState(EMPTY_FORM)

  // A single handler for all inputs. e.target.name matches the `name` attribute
  // on each <input>/<select>, so we don't need separate onChange for each field.
  function handleChange(e) {
    setForm({ ...form, [e.target.name]: e.target.value })
  }

  function handleSubmit(e) {
    e.preventDefault() // Prevents the page from refreshing (default browser behavior for forms)

    if (!form.description.trim() || !form.amount || !form.date) return

    onAdd({
      description: form.description.trim(),
      amount: Math.round(parseFloat(form.amount) * 100), // $6.50 → 650 cents
      category: form.category,
      date: form.date,
    })

    setForm(EMPTY_FORM) // Clear the form after adding
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-6"
    >
      <h2 className="text-lg font-semibold text-gray-800 mb-4">Add Expense</h2>

      <div className="grid grid-cols-2 gap-4">
        {/* col-span-2 makes this field take the full width */}
        <div className="col-span-2">
          <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
          <input
            name="description"
            value={form.description}
            onChange={handleChange}
            placeholder="e.g. Starbucks coffee"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Amount ($)</label>
          <input
            name="amount"
            type="number"
            step="0.01"
            min="0"
            value={form.amount}
            onChange={handleChange}
            placeholder="0.00"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
          <input
            name="date"
            type="date"
            value={form.date}
            onChange={handleChange}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div className="col-span-2">
          <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
          <select
            name="category"
            value={form.category}
            onChange={handleChange}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            {CATEGORIES.map(cat => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
        </div>
      </div>

      <button
        type="submit"
        className="mt-4 w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 rounded-lg text-sm transition-colors cursor-pointer"
      >
        Add Expense
      </button>
    </form>
  )
}
