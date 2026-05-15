/*
  Warnings:

  - You are about to drop the column `hookOverrides` on the `CaptionTemplate` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "CaptionTemplate" DROP COLUMN "hookOverrides",
ADD COLUMN     "usage" TEXT NOT NULL DEFAULT 'both';
