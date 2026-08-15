import { PieChart, Pie, Cell, Tooltip, Legend } from 'recharts'
export default function ExpenseChart({ expenses }) {

    if (expenses.length === 0) {
        return null
    }
// Group expenses by category and sum their amounts
    const data = expenses.reduce((acc, expense) => {
        const existing = acc.find(item => item.name === expense.category)
        if (existing) {
            existing.value += expense.amount
        } else {
            acc.push({ name: expense.category, value: expense.amount })
        }
        return acc
    }, [])

    // Keyed by category, not by position. The old list held five colors for
    // what is now eight categories, so slices repeated a color — and because
    // the index came from order of first appearance in `expenses`, a category
    // changed color whenever the data did. These are the 500-weight versions
    // of the badge colors in ExpenseList, so a category reads the same in both.
    const CATEGORY_COLORS = {
        'Food & Drink':  '#f97316',
        'Transport':     '#3b82f6',
        'Travel':        '#0ea5e9',
        'Bills':         '#ef4444',
        'Subscriptions': '#8b5cf6',
        'Shopping':      '#ec4899',
        'Health':        '#22c55e',
        'Other':         '#9ca3af',
    }
    const FALLBACK_COLOR = '#9ca3af'

    return (
        <PieChart width={400} height={400}>
            <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={80}
                label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
              >
                {data.map((entry) => (
                    <Cell key={entry.name} fill={CATEGORY_COLORS[entry.name] ?? FALLBACK_COLOR} />
                ))}
            </Pie>
            <Tooltip formatter={(value) => [`$${(value/100).toFixed(2)}`, 'Amount']} />
            <Legend />
        </PieChart>
    )
}