import test from "node:test";
import assert from "node:assert/strict";
import { assessRelease } from "../scripts/release-preflight.mjs";

test("release gate blocks missing production capabilities and emits no secrets", () => {
  const result = assessRelease({
    publicOrigin: "http://localhost:4173", rpID: "localhost",
    databaseProvider: "sqlite-local",
  });
  assert.equal(result.ready, false);
  assert.equal(result.checks.filter(c=>c.status==="BLOCKED").length, 11);
  assert.equal(result.scope, "pre-publication-readiness");
  assert.equal(result.checks.find(c=>c.id==="sites_private_preview").status, "BLOCKED");
  assert.equal(result.checks.find(c=>c.id==="d1_schema").status, "BLOCKED");
  assert.equal(result.checks[0].id, "https");
  assert.equal(result.origin, "http://localhost:4173");
});

test("release requires RP ID matching public origin", () => {
  const result = assessRelease({
    publicOrigin: "https://example.org", rpID: "example.net",
    databaseProvider: "sites-native", privatePreviewVerified: true,
    d1SchemaVerified: true,
    durableSchedulerVerified: true, passkeyDeviceTested: true,
    algorithmApproved: true, policyApproved: true,
    backupRestoreTested: true, securityReviewed: true, loadTested: true,
  });
  assert.equal(result.ready, false);
  assert.equal(result.checks.find(c=>c.id==="webauthn_rp").status, "BLOCKED");
});

test("release gate passes only with all externally verified requirements", () => {
  const result = assessRelease({
    publicOrigin: "https://map.example.org", rpID: "example.org",
    databaseProvider: "sites-native", durableSchedulerVerified: true,
    privatePreviewVerified: true, d1SchemaVerified: true,
    passkeyDeviceTested: true, algorithmApproved: true, policyApproved: true,
    backupRestoreTested: true, securityReviewed: true, loadTested: true,
  });
  assert.equal(result.ready, true);
  assert.equal(result.checks.length, 12);
  assert.equal(result.scope, "pre-publication-readiness");
});

test("release assessment never accepts unverified flags as truthy", () => {
  assert.equal(assessRelease({
    publicOrigin: "https://map.example.org", rpID: "example.org",
    databaseProvider: "sites-native",
    algorithmApproved: "true", securityReviewed: "yes",
  }).ready, false);
});

test("unpublished first launch cannot pass on GitHub CI and other flags alone", () => {
  const config = {
    publicOrigin: "https://preview.example.org", rpID: "example.org",
    databaseProvider: "sites-native", durableSchedulerVerified: true,
    passkeyDeviceTested: true, algorithmApproved: true, policyApproved: true,
    backupRestoreTested: true, securityReviewed: true, loadTested: true,
  };
  const unpublished = assessRelease(config);
  assert.equal(unpublished.ready, false);
  assert.deepEqual(unpublished.checks.filter(item => item.status === "BLOCKED")
    .map(item => item.id), ["sites_private_preview", "d1_schema"]);
  assert.equal(assessRelease({ ...config, privatePreviewVerified: "true",
    d1SchemaVerified: "true" }).ready, false,
    "string flags must not be accepted as independently verified results");
  assert.equal(assessRelease({ ...config, privatePreviewVerified: true }).ready, false,
    "preview creation cannot replace checking the newly provisioned D1 schema");
});
