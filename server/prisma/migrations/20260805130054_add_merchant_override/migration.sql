-- CreateTable
CREATE TABLE "MerchantOverride" (
    "userId" TEXT NOT NULL,
    "normalizedHash" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantOverride_pkey" PRIMARY KEY ("userId","normalizedHash")
);

