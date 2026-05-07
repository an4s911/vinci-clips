-- CreateTable
CREATE TABLE "BlockedWord" (
    "id" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlockedWord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BlockedWord_term_key" ON "BlockedWord"("term");

-- Seed current global blocked terms from the deleted JSON config.
INSERT INTO "BlockedWord" ("id", "term", "updatedAt")
VALUES
    ('seed-blocked-word-asshole', 'asshole', CURRENT_TIMESTAMP),
    ('seed-blocked-word-bastard', 'bastard', CURRENT_TIMESTAMP),
    ('seed-blocked-word-bitch', 'bitch', CURRENT_TIMESTAMP),
    ('seed-blocked-word-cunt', 'cunt', CURRENT_TIMESTAMP),
    ('seed-blocked-word-damn', 'damn', CURRENT_TIMESTAMP),
    ('seed-blocked-word-dick', 'dick', CURRENT_TIMESTAMP),
    ('seed-blocked-word-faggot', 'faggot', CURRENT_TIMESTAMP),
    ('seed-blocked-word-fuck', 'fuck', CURRENT_TIMESTAMP),
    ('seed-blocked-word-fucking', 'fucking', CURRENT_TIMESTAMP),
    ('seed-blocked-word-motherfucker', 'motherfucker', CURRENT_TIMESTAMP),
    ('seed-blocked-word-nigga', 'nigga', CURRENT_TIMESTAMP),
    ('seed-blocked-word-nigger', 'nigger', CURRENT_TIMESTAMP),
    ('seed-blocked-word-pussy', 'pussy', CURRENT_TIMESTAMP),
    ('seed-blocked-word-retard', 'retard', CURRENT_TIMESTAMP),
    ('seed-blocked-word-shit', 'shit', CURRENT_TIMESTAMP),
    ('seed-blocked-word-slut', 'slut', CURRENT_TIMESTAMP),
    ('seed-blocked-word-whore', 'whore', CURRENT_TIMESTAMP)
ON CONFLICT ("term") DO NOTHING;
