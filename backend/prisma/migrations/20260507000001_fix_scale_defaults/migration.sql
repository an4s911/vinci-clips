-- Scale values are 0-1 fractions (1.0 = 100% = normal), not ASS percentages.
-- Fix defaults and existing seeded data inserted in previous migration.

ALTER TABLE "CaptionTemplate" ALTER COLUMN "scaleX" SET DEFAULT 1;
ALTER TABLE "CaptionTemplate" ALTER COLUMN "scaleY" SET DEFAULT 1;

-- Fix seeded rows: 100 → 1.0, 110 → 1.1
UPDATE "CaptionTemplate" SET "scaleX" = "scaleX" / 100.0 WHERE "scaleX" > 2;
UPDATE "CaptionTemplate" SET "scaleY" = "scaleY" / 100.0 WHERE "scaleY" > 2;
