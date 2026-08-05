// Run real bank descriptors through the normalizer to see what they become.
//
//   node scripts/try-normalize.js "STARBUCKS *4471 SEATTLE WA"
//   node scripts/try-normalize.js --file ~/Downloads/statement.csv
//
// The --file form reads a CSV and guesses the description column. Nothing is
// written anywhere and nothing leaves your machine.

const fs = require('fs')
const { normalizeMerchant, hashMerchant } = require('../lib/normalize')

const args = process.argv.slice(2)

let descriptors = []

if (args[0] === '--file') {
  const path = args[1]
  if (!path) {
    console.error('usage: node scripts/try-normalize.js --file <path-to-csv>')
    process.exit(1)
  }

  const lines = fs.readFileSync(path, 'utf8').split('\n').filter((l) => l.trim())
  const header = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase())

  // Look for the column banks usually call description, or fall back to the
  // widest column, which is nearly always the merchant text.
  let col = header.findIndex((h) => /desc|merchant|name|detail|payee|memo/.test(h))
  if (col === -1) col = 0

  console.log(`column: "${header[col]}" (index ${col})\n`)

  descriptors = lines.slice(1).map((line) => {
    const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
    return cells[col] || ''
  })
} else if (args.length > 0) {
  descriptors = args
} else {
  console.error('usage: node scripts/try-normalize.js "DESCRIPTOR" ["DESCRIPTOR" ...]')
  console.error('       node scripts/try-normalize.js --file <path-to-csv>')
  process.exit(1)
}

// Group by normalized value, so it's obvious what collapsed together and what
// didn't. Merchants that should have merged but didn't are the thing to look for.
const groups = new Map()
for (const raw of descriptors) {
  const norm = normalizeMerchant(raw)
  if (!groups.has(norm)) groups.set(norm, [])
  groups.get(norm).push(raw)
}

const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)

console.log(`${descriptors.length} descriptors -> ${groups.size} distinct merchants`)
console.log(`${descriptors.length - groups.size} LLM calls saved by caching\n`)

for (const [norm, raws] of sorted) {
  const label = norm === '' ? '(empty — would be a failed row)' : norm
  console.log(`${label}   [${raws.length}]  ${hashMerchant(norm).slice(0, 8)}`)
  for (const raw of raws.slice(0, 4)) {
    console.log(`    ${raw}`)
  }
  if (raws.length > 4) console.log(`    ... and ${raws.length - 4} more`)
  console.log('')
}
