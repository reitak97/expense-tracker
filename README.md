# Expense Tracker

An AI-powered expense tracker that automatically categorizes your spending. Built as a full-stack portfolio project.

**Live demo:** https://expense-tracker-two-pi-27.vercel.app

## Features

- Add, view, and delete expenses
- AI-powered category suggestions via Claude (Anthropic API)
- Spending breakdown by category (pie chart)
- User authentication — each user only sees their own expenses
- Data persists across sessions

## Tech Stack

- **Frontend:** React, Vite, Tailwind CSS, Recharts
- **Backend:** Node.js, Express
- **Database:** PostgreSQL (Supabase) via Prisma ORM
- **Auth:** Clerk
- **AI:** Anthropic API (Claude Haiku)
- **Deploy:** Vercel (frontend) + Render (backend)
- **CI/CD:** GitHub Actions — runs tests on every push

## Architecture

```
Browser (React) → Express API → PostgreSQL (Supabase)
                      ↓
               Anthropic API (AI categorization)
               Clerk (auth token verification)
```

## Running Locally

**Prerequisites:** Node.js, a Supabase account, a Clerk account, an Anthropic API key

**Backend:**
```bash
cd server
cp .env.example .env   # fill in your keys
npm install
npx prisma migrate dev
npm run dev
```

**Frontend:**
```bash
cd client
cp .env.example .env   # fill in your Clerk publishable key
npm install
npm run dev
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /expenses | Get all expenses for the logged-in user |
| POST | /expenses | Create an expense (AI assigns category) |
| PATCH | /expenses/:id | Update an expense |
| DELETE | /expenses/:id | Delete an expense |

All endpoints require a valid Clerk JWT in the `Authorization` header.
