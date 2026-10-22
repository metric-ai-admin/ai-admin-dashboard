// What somebody typed into the Username box, as a username.
//
// The box says "Username" and the placeholder says "arturo", and four leasing
// agents were handed accounts whose address is sammy@metric.internal. Typing
// that produced sammy@metric.internal@metric.internal — Supabase rejected it
// and the screen said "Invalid username or password", which reads as a wrong
// password and sends somebody looking in the wrong place.
//
// Pure, so the rule can be tested without a login.

'use strict';

const DOMAIN = 'metric.internal';

/**
 * @returns {{username: string, typedFullEmail: boolean, typedOtherDomain: string|null}}
 */
function parseLogin(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase();
  const at = text.indexOf('@');
  if (at < 0) return { username: text, typedFullEmail: false, typedOtherDomain: null };

  const local = text.slice(0, at);
  const domain = text.slice(at + 1);

  // OUR OWN DOMAIN: take the left side and carry on. This is the common case
  // and it should simply work rather than teach a lesson.
  if (domain === DOMAIN) {
    return { username: local, typedFullEmail: true, typedOtherDomain: null };
  }

  // SOMEBODY ELSE'S DOMAIN is a different mistake and gets a different answer.
  // A person typing their real work address — arturo@metricpropertymanagement
  // .com — is not making the same error, and silently signing them in as
  // "arturo" would be guessing at what they meant.
  return { username: local, typedFullEmail: false, typedOtherDomain: domain };
}

// The sentence that names the mistake instead of blaming the password.
const WRONG_FIELD_MESSAGE =
  'Type only your username (e.g. sammy), not the full email.';

function loginHint(raw) {
  const p = parseLogin(raw);
  if (p.typedOtherDomain) {
    return 'Type only your Metric username (e.g. sammy) — not an email address.';
  }
  return null;
}

module.exports = { DOMAIN, parseLogin, loginHint, WRONG_FIELD_MESSAGE };
