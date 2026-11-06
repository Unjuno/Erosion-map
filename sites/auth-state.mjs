/**
 * Authentication challenge classification from durable D1 fields.
 * The schema stores 'authenticate' for BOTH sign-in and account deletion.
 * The bound user_id disambiguates the two ceremonies. Never accept an
 * unbound login challenge to delete an account, or a deletion challenge to
 * create a login session.
 */
export function challengePurpose(challenge) {
  if (!challenge || typeof challenge.kind !== "string" ||
      !Object.hasOwn(challenge, "userId")) {
    throw new RangeError("malformed authentication challenge");
  }
  const user = challenge.userId;
  if (challenge.kind === "register" &&
      typeof user === "string" && /^[A-Za-z0-9._~-]{1,128}$/.test(user)) {
    return "register";
  }
  if (challenge.kind === "authenticate" && user === null) return "login";
  if (challenge.kind === "authenticate" &&
      typeof user === "string" && /^[A-Za-z0-9._~-]{1,128}$/.test(user)) {
    return "delete";
  }
  throw new RangeError("malformed authentication challenge");
}

export function requireChallengePurpose(challenge, requested) {
  if (!["register", "login", "delete"].includes(requested)) {
    throw new RangeError("unsupported authentication ceremony");
  }
  if (challengePurpose(challenge) !== requested) {
    throw new Error("wrong challenge kind");
  }
  return challenge;
}
