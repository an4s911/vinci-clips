-- CreateTable
CREATE TABLE "DriveExport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "folderName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "items" JSONB NOT NULL,
    "total" INTEGER NOT NULL,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriveExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DriveExport_status_idx" ON "DriveExport"("status");
