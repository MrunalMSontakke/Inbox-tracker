export type Label =
  | "applied" | "in_review" | "interview" | "offer" | "rejected"
  | "other" | "unclear";

// Senders that match the query but are never job applications
const NOT_JOB_SENDERS = ["github.com", "jobscan.co"];

// Subjects that are job-related but never about one of your applications
const NOT_JOB_SUBJECTS = /profile is being discovered|job alert|new jobs for|jobs similar to|feedback for assignment/i;

// Job boards, ATS tools and test platforms: never the employer itself
const PLATFORMS = [
  "seek", "linkedin", "workday", "glassdoor", "indeed", "smartrecruiters",
  "greenhouse", "lever", "workable", "livehire", "pageup", "successfactors",
  "hirevue", "codesignal", "hackerrank", "testgorilla",
];

// Leftovers after stripping "Careers", "Recruitment" etc. from a sender name
const GENERIC_NAMES = /^(talent|hiring|people|info|support|no-?reply)$/i;

// Order matters: bad news first, so "Unfortunately... thanks for applying" is a rejection
const RULES: [Label, RegExp][] = [
  ["rejected", /isn['’]t progressing|not progressing|unsuccessful|unfortunately|regret to (?:inform|advise)|not (?:be )?moving forward|has closed|position has been filled/i],
  ["offer", /job offer|offer of employment|pleased to offer/i],
  ["interview", /interview|assessment|next stage|phone screen|shortlisted/i],
  ["in_review", /was viewed by|has viewed your application|under review|reviewing your application/i],
  ["applied", /application was sent|successfully submitted|thank(?:s| you) for (?:applying|your application)|received your application|application (?:submitted|received)|your application to|job application|^your .+ application$/i],
];

export function classify(from: string, subject: string): Label {
  const f = from.toLowerCase();
  if (NOT_JOB_SENDERS.some((d) => f.includes(d))) return "other";
  if (NOT_JOB_SUBJECTS.test(subject)) return "other";
  for (const [label, re] of RULES) {
    if (re.test(subject)) return label;
  }
  return "unclear";
}

// Checked in order, first match wins
const SUBJECT_PATTERNS = [
  /application was (?:sent to|viewed by) (.+)$/i,            // LinkedIn
  /^(.+?) has (?:viewed|responded to) your application/i,     // SEEK
  /job with (.+?) has closed/i,                               // SEEK
  /thank(?:s| you) for applying to (.+)$/i,
  /your (.+?) application(?: isn|$)/i,                        // "your Accenture application isn't..."
  / from ([^–|]+)$/i,                                         // "Interview invitation from Canva"
  / at ([^–|]+)$/i,                                           // "... Software Engineer at Zinfra"
];

function clean(name: string) {
  return name.replace(/[!.\s]+$/, "").trim();
}

// Reject names that are platforms or generic leftovers
function usable(name: string | null): string | null {
  if (!name) return null;
  if (GENERIC_NAMES.test(name)) return null;
  if (PLATFORMS.some((p) => name.toLowerCase().includes(p))) return null;
  return name;
}

function companyFromSender(from: string): string | null {
  const m = from.match(/^"?([^"<]+?)"?\s*</);
  let name = m ? m[1].trim() : "";
  if (name.includes(" - ")) name = name.split(" - ").pop()!;  // "Claire Medina - FleetGuru"
  name = name
    .replace(/\b(careers?|recruitment|recruiting|jobs|talent acquisition|hr|team|applications|notifications?|invitation)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return usable(name);
}

export function extractCompany(from: string, subject: string): string | null {
  for (const re of SUBJECT_PATTERNS) {
    const m = subject.match(re);
    if (m) return usable(clean(m[1]));
  }
  return companyFromSender(from);
}

// "Deloitte Australia", "Deloitte" and "Deloitte Pty Ltd" all become "deloitte"
const SUFFIX = /\s+(pty|ltd|limited|inc|llc|group|australia|au|holdings)$/;

export function companyKey(name: string) {
  let k = name.toLowerCase().replace(/[.,!™®]/g, "").replace(/\s+/g, " ").trim();
  while (SUFFIX.test(k)) k = k.replace(SUFFIX, "");
  return k;
}

// ---------- Second pass: rules on Gmail's ~200-char preview ----------
// For emails whose subject says nothing ("Application update"), the first line usually does.
// Same priority as subjects: bad news first.
const PREVIEW_RULES: [Label, RegExp][] = [
  ["rejected", /unfortunately|unsuccessful|other candidates|not (?:be )?(?:progressing|proceeding|moving forward)|won['’]?t be (?:progressing|proceeding|moving forward)|decided (?:not to|to (?:pursue|progress|proceed|move forward) with)|no longer (?:being )?considered|not been (?:selected|successful)|position has been filled|regret to/i],
  ["offer", /pleased to offer|offer of employment|job offer/i],
  ["interview", /invite you to (?:an? )?(?:interview|assessment|chat|call|meet)|schedule (?:an? )?(?:interview|call|time)|next (?:stage|step|round)|shortlisted|online assessment|video interview|coding (?:test|challenge)/i],
  ["in_review", /currently (?:reviewing|being reviewed)|under review|(?:reviewing|review) (?:your|all) applications/i],
  ["applied", /(?:received|receipt of) your application|thank(?:s| you) for (?:applying|your application|submitting)|application (?:has been )?(?:received|submitted)/i],
];

export function classifyPreview(preview: string): Label {
  for (const [label, re] of PREVIEW_RULES) {
    if (re.test(preview)) return label;
  }
  return "unclear";
}

// "Outcome of your application", "Update on your Shell application", "Application update for X".
// These are almost always rejections: good news usually says "interview" or "offer" in the subject.
// Used only as a fallback, after the preview has had its say.
const OUTCOME_SUBJECT =
  /outcome of your application|application outcome|update on your (?:\S+ )?application|an update on your application|application (?:status )?update|your application (?:status|update)/i;

export function isOutcomeSubject(subject: string) {
  return OUTCOME_SUBJECT.test(subject);
}