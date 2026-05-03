-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'admin',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transcript" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "originalFilename" TEXT,
    "videoUrl" TEXT,
    "mp3Url" TEXT,
    "thumbnailUrl" TEXT,
    "duration" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'uploading',
    "failureReason" TEXT,
    "failedAt" TIMESTAMP(3),
    "platform" TEXT,
    "externalVideoId" TEXT,
    "importUrl" TEXT,
    "transcript" JSONB,
    "clips" JSONB,
    "processingJob" JSONB,
    "analysisMetadata" JSONB,
    "reframeAssets" JSONB,

    CONSTRAINT "Transcript_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- AddForeignKey
ALTER TABLE "Transcript" ADD CONSTRAINT "Transcript_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
