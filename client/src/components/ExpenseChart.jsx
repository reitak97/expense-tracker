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

    const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884D8']

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
                {data.map((entry, index) => (
                    <Cell key={entry.name} fill={COLORS[index % COLORS.length]} />
                ))}
            </Pie>
            <Tooltip formatter={(value) => [`$${(value/100).toFixed(2)}`, 'Amount']} />
            <Legend />
        </PieChart>
    )
}