// RIO-NFR-005/006 — gives each virtual user its own synthetic source IP for
// the whole session, via a per-VU X-Forwarded-For header (see pilot.yml and
// README.md's "Recommended next step" section for why this exists).
//
// TRUST_PROXY defaults to "loopback" (env.schema.ts) and Artillery connects
// to the API from loopback, so Express honors this header for req.ip with no
// server-side config change — this is a load-test methodology fix, not a
// change to any production security code. Without it, all 15,000 virtual
// users share the load generator's one real IP, so the login endpoint's
// per-IP anti-brute-force limiter (5 attempts/60s, 60/600s ceiling) sees
// 15,000 rapid logins from one address and — correctly, by design — treats
// it as a credential-stuffing flood rather than 500 distinct real users.
//
// Generated once per virtual user (beforeScenario), not per request: a real
// user has one IP for their whole session, not a new one every request.
function setSpoofedIp(context, _events, done) {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  context.vars.spoofedIp = `10.${octet()}.${octet()}.${octet()}`;
  return done();
}

module.exports = { setSpoofedIp };
