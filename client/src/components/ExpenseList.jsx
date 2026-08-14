import { useState } from 'react'

// Color classes for each category badge.
// ?? is the "nullish coalescing" operator — falls back to the gray style
// if a category isn't in this map (e.g. a future category we haven't added yet).
const CATEGORY_COLORS = {
  'Food & Drink': 'bg-orange-100 text-orange-700',
  'Transport':    'bg-blue-100 text-blue-700',
  'Bills':        'bg-red-100 text-red-700',
  'Shopping':     'bg-pink-100 text-pink-700',
  'Health':       'bg-green-100 text-green-700',
  'Other':        'bg-gray-100 text-gray-700',
}

// Converts cents back to a display string. 650 → "6.50"
function formatCents(cents) {
  return (cents / 100).toFixed(2)
}

export default function ExpenseList({ expenses, onDelete, onDeleteAll, total }) {
  // Two-step, because this one is not undoable. The first click only arms the
  // button; nothing is sent until the second.
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function confirmDeleteAll() {
    setDeleting(true)
    try {
      await onDeleteAll()
      setConfirming(false)
    } finally {
      setDeleting(false)
    }
  }

  // Early return — show an empty state instead of an empty list
  if (expenses.length === 0) {
    return (
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-10 text-center text-gray-400">
        No expenses yet. Add one above!
      </div>
    )
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
      {/* Header row */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <h2 className="text-lg font-semibold text-gray-800">Expenses</h2>

        {confirming ? (
          // The count is spelled out here rather than on the arming button, so
          // the number is in front of you at the moment you commit to it.
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-600">
              Delete all {expenses.length} expenses?
            </span>
            <button
              onClick={confirmDeleteAll}
              disabled={deleting}
              className="text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 px-3 py-1 rounded-lg cursor-pointer"
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={deleting}
              className="text-sm font-medium text-gray-500 hover:text-gray-700 cursor-pointer"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-500">
              {expenses.length} item{expenses.length !== 1 ? 's' : ''}
            </span>
            <button
              onClick={() => setConfirming(true)}
              className="text-sm font-medium text-gray-400 hover:text-red-600 transition-colors cursor-pointer"
            >
              Delete all
            </button>
          </div>
        )}
      </div>

      {/* Expense rows */}
      <ul>
        {expenses.map((expense, index) => (
          // `key` is required when rendering a list in React.
          // React uses it to efficiently update only the items that changed.
          // We use the expense id (not the array index) because ids are stable
          // even when items are deleted.
          <li
            key={expense.id}
            className={`flex items-center gap-4 px-6 py-4 ${
              index !== expenses.length - 1 ? 'border-b border-gray-50' : ''
            }`}
          >
            {/* Description + date */}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{expense.description}</p>
              <p className="text-xs text-gray-400 mt-0.5">{expense.date}</p>
            </div>

            {/* Category badge */}
            <span className={`text-xs font-medium px-2 py-1 rounded-full ${CATEGORY_COLORS[expense.category] ?? 'bg-gray-100 text-gray-700'}`}>
              {expense.category}
            </span>

            {/* Amount */}
            <span className="text-sm font-semibold text-gray-900 w-16 text-right">
              ${formatCents(expense.amount)}
            </span>

            {/* Delete button — calls onDelete with this expense's id.
                App.jsx filters out that id and updates state, causing a re-render. */}
            <button
              onClick={() => onDelete(expense.id)}
              className="text-gray-300 hover:text-red-400 transition-colors text-xl leading-none cursor-pointer"
              aria-label="Delete expense"
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      {/* Total footer */}
      <div className="flex justify-between items-center px-6 py-4 bg-gray-50 border-t border-gray-100">
        <span className="text-sm font-medium text-gray-600">Total</span>
        <span className="text-base font-bold text-gray-900">${formatCents(total)}</span>
      </div>
    </div>
  )
}
