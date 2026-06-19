-- AlterTable
ALTER TABLE "items" ADD COLUMN     "stock" INTEGER NOT NULL DEFAULT 0;

-- Backfill the stock cache from the existing movement log. The effect of a
-- movement on stock is +quantity for 'in'/'adjust' (adjust is signed) and
-- -quantity for 'out', matching `movementEffect` in src/domain/ledger.ts.
UPDATE "items" i SET "stock" = COALESCE((
  SELECT SUM(CASE WHEN m."type" = 'out' THEN -m."quantity" ELSE m."quantity" END)
  FROM "movements" m
  WHERE m."itemId" = i."id"
), 0);
