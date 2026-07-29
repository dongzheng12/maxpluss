-- Remove CLOSED from the ExpertVoteRequest status machine.
--
-- Preconditions before applying this migration:
--   SELECT count(*) FROM "ExpertVoteRequest" WHERE status = 'CLOSED';
-- must return 0 in local, POC, and production databases.
--
-- The status column is currently stored as TEXT, so Prisma schema changes do not
-- emit an enum ALTER. This constraint is a forward-compatible database guard:
-- existing valid rows are unaffected, and future CLOSED writes are rejected.
ALTER TABLE "ExpertVoteRequest"
  ADD CONSTRAINT "ExpertVoteRequest_status_no_closed_chk"
  CHECK (status <> 'CLOSED');
