-- 0005: Durable per-window throttling for unauthenticated auth-start and posts.
-- This table stores ONLY SHA-256 bucket digests, counters and expiry; never
-- raw IP addresses, credential IDs, request bodies or secret salts.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_hash TEXT PRIMARY KEY NOT NULL CHECK(length(bucket_hash)=64),
  window_end INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK(attempts >= 1)
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_expiry ON rate_limits(window_end);
