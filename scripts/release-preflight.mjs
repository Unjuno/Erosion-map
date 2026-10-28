/**
 * Release gate for Erosion Map.
 * A green CI is necessary but NEVER sufficient for a live passkey service.
 * No network requests, credentials, or private configuration is logged.
 */
export function assessRelease(config = {}) {
  const checks = [];
  const check = (id, passed, reason) => {
    checks.push({ id, status: passed ? "PASS" : "BLOCKED", reason });
  };
  let origin = null;
  let parsed = null;
  try {
    parsed = new URL(config.publicOrigin ?? "");
    origin = parsed.origin;
  } catch {
    origin = null;
  }
  check("https", parsed?.protocol === "https:",
    "The final public origin must use HTTPS");
  const domain = parsed?.hostname ?? "";
  const rpID = config.rpID;
  check("webauthn_rp",
    typeof rpID === "string" &&
      (domain === rpID || domain.endsWith("." + rpID)) &&
      rpID.length >= 3 && !rpID.startsWith("."),
    "RP ID must be a valid parent or equal domain of the public site");
  check("sites_native_database", config.databaseProvider === "sites-native",
    "SQLite prototype cannot be used as Sites production persistence");
  check("durable_scheduler", config.durableSchedulerVerified === true,
    "A transactional scheduler and durable recovery mechanism are required");
  check("passkey_devices", config.passkeyDeviceTested === true,
    "Verify passkeys on real devices against final public origin/RP ID");
  check("algorithm_approved", config.algorithmApproved === true,
    "Resolve model rules and long-term simulation constraints");
  check("privacy_policy", config.policyApproved === true,
    "Final legal privacy/contact/retention/erasure notices must be published");
  check("backup_restore", config.backupRestoreTested === true,
    "Test production DB backup and actual restoration");
  check("security_review", config.securityReviewed === true,
    "Complete external edge rate limits, session management and penetration review");
  check("load_test", config.loadTested === true,
    "Validate map, users and daily runner at target load");
  return {
    ready: checks.every((entry) => entry.status === "PASS"),
    origin,
    checks,
  };
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  const options = {
    publicOrigin: process.env.PUBLIC_ORIGIN,
    rpID: process.env.RP_ID,
    databaseProvider: process.env.DATABASE_PROVIDER,
    durableSchedulerVerified: process.env.SCHEDULER_VERIFIED === "true",
    passkeyDeviceTested: process.env.PASSKEY_DEVICE_TESTED === "true",
    algorithmApproved: process.env.ALGORITHM_APPROVED === "true",
    policyApproved: process.env.POLICY_APPROVED === "true",
    backupRestoreTested: process.env.BACKUP_RESTORE_TESTED === "true",
    securityReviewed: process.env.SECURITY_REVIEWED === "true",
    loadTested: process.env.LOAD_TESTED === "true",
  };
  const result = assessRelease(options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
}
