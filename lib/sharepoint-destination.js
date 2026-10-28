// Is this destination a TEAM SITE, or somebody's personal OneDrive?
//
// Its own file so it can be CALLED by a test rather than grepped for. The
// first version of this lived inside the backup script, and the tests could
// only assert that the words were present — mutation testing showed both
// checks could be switched off with every assertion still green. A guard you
// cannot execute in a test is a comment.
//
// WHY THE CHECK EXISTS. The social screenshots were uploaded to
// admin@metricpropertymanagement.com's personal OneDrive, and every link we
// stored answered "You need access" for everyone except admin@ (migration
// 116). A personal drive is one person's permissions object and it leaves
// with the person.
'use strict';

// Thrown rather than returned false: a caller that forgets to check a boolean
// uploads to the wrong place, and there is no safe default here.
function assertTeamSite(site) {
  const s = String(site == null ? '' : site).trim();
  if (!s) throw new Error('No SharePoint destination given.');
  if (/-my\.sharepoint\.com/i.test(s)) {
    throw new Error('That is a PERSONAL OneDrive host (-my.sharepoint.com). '
      + 'Use a team site — this is the social-screenshots mistake (migration 116).');
  }
  // The same drive, spelled as a path instead of a host. Graph will happily
  // take /users/{upn}/drive and /personal/{upn}; both are one person's.
  //
  // THIS BRANCH IS FOR THE MESSAGE, NOT THE SAFETY. Neither spelling contains
  // :/sites/, so the check below already refuses them — mutation testing
  // confirms removing this changes nothing about what is accepted. It stays
  // because "that is a user drive" is a more useful thing to read at 6pm than
  // "that is not a team site", and it is deleted the day the site check moves.
  if (/\/personal\//i.test(s) || /(^|\/)users\//i.test(s)) {
    throw new Error('That path addresses a user drive, not a team site. Use '
      + '<host>.sharepoint.com:/sites/<SiteName>.');
  }
  if (!/:\/sites\/[^/\s]/.test(s)) {
    throw new Error('--site must name a team site, as '
      + '<host>.sharepoint.com:/sites/<SiteName>. Got: ' + s);
  }
  return s;
}

// Checked AGAIN after Graph answers, against the drive we actually landed on.
// The name resolving is not proof of where it pointed.
function assertTeamDrive(webUrl) {
  if (/-my\.sharepoint\.com/i.test(String(webUrl || ''))) {
    throw new Error('That site resolved to a personal OneDrive (' + webUrl + '). Refusing.');
  }
  return webUrl;
}

module.exports = { assertTeamSite, assertTeamDrive };
