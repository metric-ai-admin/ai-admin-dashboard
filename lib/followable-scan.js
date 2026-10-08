// MEASUREMENT ONLY. Which mail WOULD be followed, if we followed evictions,
// writs and time-off requests automatically.
//
// Lyndsay asked to "start following all the evictions, writs and time off
// requests automatically in my email for all folders" (2026-10-08). Before any
// of that is built, this counts what each keyword would actually catch, per
// term, per folder and per sender — because the failure mode of a keyword list
// is not that it misses things, it is that it catches a legal newsletter every
// week and the list stops being read.
//
// Nothing here writes, flags, moves or stores. It counts.
//
// THE MATCH IS ON THE SUBJECT, NOT THE BODY. A body match would pull in every
// thread that merely mentions a word, and the point of the exercise is to find
// out whether a NARROW rule is good enough before widening it.

'use strict';

const norm = s => String(s || '').trim().toLowerCase();

// Word-boundary, because the bare words are the dangerous ones: "writ" inside
// "written" and "write", "pto" inside other acronyms. Every term below was
// written as a regex for that reason and not as a substring test.
const TOPICS = [
  {
    key: 'evictions',
    label: 'Evictions',
    terms: [
      ['eviction', /\bevictions?\b/i],
      ['evict', /\bevict(ed|ing)?\b/i],
      ['forcible detainer', /\bforcible\s+detainer\b/i],
      ['justice court', /\b(justice|j\.?\s*p\.?)\s+court\b/i],
      ['default judgment', /\bdefault\s+judg(e)?ment\b/i],
      // "filing" alone is far too broad — it appears in tax, insurance and
      // corporate mail. Measured only in the company of an eviction word, so
      // the report can say whether it earns a place at all.
      ['filing (with eviction)', /\bfiling\b/i, { requires: /\bevict/i }],
      // THE SHAPE THE REAL MAIL ACTUALLY HAS, found by searching the live
      // mailbox on 2026-10-08 before trusting any of the words above.
      //
      // Searching "eviction" returned twelve messages and NOT ONE had the word
      // in its subject — every hit was body text, mostly EOD reports. The only
      // genuine eviction mail in the set was
      //   "Fw: Filing Submitted for Case: 120519758; ; Envelope Number: 120519758"
      // which is what the court's e-filing system emits. It contains neither
      // "eviction" nor "writ", so every term above would have missed it.
      //
      // This is the lesson the measurement pass exists to produce: the words
      // Lyndsay used are how she TALKS about this, not how the mail is
      // LABELLED.
      ['court e-filing', /\bfiling submitted for case\b|\benvelope number\b/i],
    ],
  },
  {
    key: 'writs',
    label: 'Writs',
    terms: [
      ['writ of possession', /\bwrit\s+of\s+possession\b/i],
      ['writ', /\bwrits?\b/i],
      ['lockout', /\block[\s-]?outs?\b/i],
      ['constable', /\bconstables?\b/i],
    ],
  },
  {
    key: 'timeoff',
    label: 'Time off',
    terms: [
      ['time off', /\btime[\s-]?off\b/i],
      ['PTO', /\bPTO\b/],                       // case-SENSITIVE: "pto" lowercase is usually a fragment
      ['vacation', /\bvacation\b/i],
      ['day off', /\bdays?\s+off\b/i],
      ['sick day', /\bsick\s+(day|leave)\b/i],
      ['leave request', /\bleave\s+request\b/i],
    ],
    // Time off is an INTERNAL conversation. Without this, every HR newsletter
    // and every vacation-rental advert lands in the list. Measured both ways
    // below so the decision is made on the gap between the two numbers.
    internalOnly: true,
  },
];

const INTERNAL_RE = /@(metricpropertymanagement|livewithmetric)\.com$/i;

const senderOf = m => (m && m.from && m.from.emailAddress && m.from.emailAddress.address) || '';
const subjectOf = m => (m && m.subject) || '';
const isInternal = address => INTERNAL_RE.test(norm(address));

// Every term a message's SUBJECT matches, within one topic. Returns [] for no
// match. A message can match several terms; all are reported, because "which
// term is pulling its weight" is the question being asked.
function termsHit(topic, message) {
  const subject = subjectOf(message);
  const out = [];
  for (const [name, re, opts] of topic.terms) {
    if (!re.test(subject)) continue;
    if (opts && opts.requires && !opts.requires.test(subject)) continue;
    out.push(name);
  }
  return out;
}

// One message against every topic.
// `internalOnly` is NOT applied here — it is reported as a separate count, so
// the cost of the rule is visible instead of silently applied.
function classify(message) {
  const hits = [];
  for (const topic of TOPICS) {
    const terms = termsHit(topic, message);
    if (!terms.length) continue;
    hits.push({
      topic: topic.key,
      terms,
      internal: isInternal(senderOf(message)),
      wouldCountInternalOnly: !topic.internalOnly || isInternal(senderOf(message)),
    });
  }
  return hits;
}

// Tally a folder's worth of messages. `folder` is carried through so the report
// can say where the noise is concentrated.
function tally(messages, folder, acc) {
  const a = acc || {
    scanned: 0,
    byTopic: {}, byTerm: {}, byFolder: {}, bySender: {},
    internalOnly: {}, samples: {},
  };
  for (const m of messages || []) {
    a.scanned++;
    const hits = classify(m);
    if (!hits.length) continue;
    const sender = senderOf(m) || '(none)';
    for (const h of hits) {
      a.byTopic[h.topic] = (a.byTopic[h.topic] || 0) + 1;
      if (h.wouldCountInternalOnly) a.internalOnly[h.topic] = (a.internalOnly[h.topic] || 0) + 1;
      h.terms.forEach(t => {
        const k = h.topic + ' / ' + t;
        a.byTerm[k] = (a.byTerm[k] || 0) + 1;
      });
      const fk = h.topic + ' / ' + (folder || '(unknown)');
      a.byFolder[fk] = (a.byFolder[fk] || 0) + 1;
      const sk = h.topic + ' / ' + sender;
      a.bySender[sk] = (a.bySender[sk] || 0) + 1;
      // A handful of real subjects per topic. Five is enough to tell a true
      // hit from a newsletter, and few enough that the report is not itself a
      // dump of resident names.
      (a.samples[h.topic] = a.samples[h.topic] || []);
      if (a.samples[h.topic].length < 5) {
        a.samples[h.topic].push({
          folder: folder || '(unknown)', from: sender,
          received: String(m.receivedDateTime || '').slice(0, 10),
          subject: subjectOf(m).slice(0, 110), terms: h.terms,
        });
      }
    }
  }
  return a;
}

module.exports = { TOPICS, INTERNAL_RE, norm, senderOf, subjectOf, isInternal, termsHit, classify, tally };
