-- DropIndex
DROP INDEX "movements_itemId_idx";

-- CreateIndex
CREATE INDEX "movements_itemId_occurredAt_id_idx" ON "movements"("itemId", "occurredAt", "id");
