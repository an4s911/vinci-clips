ALTER TABLE "Transcript" ADD COLUMN "expiresAt" TIMESTAMP(3);
CREATE INDEX "Transcript_expiresAt_idx" ON "Transcript"("expiresAt");
UPDATE "Transcript" SET "expiresAt" = NOW() + INTERVAL '24 hours' WHERE "expiresAt" IS NULL;
