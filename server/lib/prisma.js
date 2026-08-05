// The one PrismaClient shared by the API and the worker.
const { PrismaClient } = require('@prisma/client')

// Constructed but not connected — Prisma dials the database on first query.
const prisma = new PrismaClient()

module.exports = { prisma }
