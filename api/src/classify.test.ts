// Regression tests built from real subject lines. If a rule change breaks one, CI goes red.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  classifyPreview,
  extractCompany,
  extractCompanyFromPreview,
  companyKey,
  isOutcomeSubject,
} from "./classify";

// [from, subject, expected label, expected company]
const SUBJECTS: [string, string, string, string | null][] = [
  // LinkedIn
  ["LinkedIn <jobs-noreply@linkedin.com>", "Mrunal, your application was sent to Salt", "applied", "Salt"],
  ["LinkedIn <jobs-noreply@linkedin.com>", "Your application was viewed by ALOIS Australia", "in_review", "ALOIS Australia"],
  ["LinkedIn <jobs-noreply@linkedin.com>", "Your application to Software Engineer at Atlassian", "applied", "Atlassian"],
  ["LinkedIn <jobs-noreply@linkedin.com>", "Canva is hiring", "other", null],
  ["LinkedIn <jobs-noreply@linkedin.com>", "Mrunal, apply to Software Engineer at MCRI and more", "other", null],
  // SEEK
  ["SEEK Applications <noreply@s.seek.com.au>", "Hi Mrunal Manoj, the AI engineer job with Kuga Electrical has closed", "rejected", "Kuga Electrical"],
  ["SEEK Applications <noreply@s.seek.com.au>", "Integrated Application Development Pty Ltd has viewed your application for Software Developer", "in_review", "Integrated Application Development Pty Ltd"],
  ["SEEK Applications <noreply@s.seek.com.au>", "Application update for Software Engineer at Energetica", "unclear", "Energetica"],
  ["SEEK Profile <noreply@s.seek.com.au>", "Mrunal Manoj, your profile is being discovered!", "other", null],
  // Indeed
  ["Indeed Apply <indeedapply@indeed.com>", "Indeed Application: Software Engineer", "applied", null],
  ["Indeed <donotreply@indeed.com>", "Canva viewed your application", "in_review", "Canva"],
  ["Indeed <donotreply@indeed.com>", "Your application was not selected", "rejected", null],
  // Employers and ATS
  ["Accenture Careers <accenture@myworkday.com>", "We’re sorry your Accenture application isn’t progressing further", "rejected", "Accenture"],
  ["Lendi Group <notification@smartrecruiters.com>", "Thank you for applying to Lendi Group", "applied", "Lendi Group"],
  ["Zinfra <zinfra-connect@livehire.com>", "Application submitted: Graduate Engineer at Zinfra", "applied", "Zinfra"],
  ["Deloitte Recruitment <no-reply@deloitte.com.au>", "Deloitte Job Application – Forward Deployed Engineer", "applied", "Deloitte"],
  ["Claire Medina - FleetGuru <c@autoguru.teamtailor-mail.com>", "We have received your application!", "applied", "FleetGuru"],
  ["HireVue <noreply@hirevue.com>", "Interview invitation from Canva", "interview", "Canva"],
  ["Recruiting <x@acme.com>", "We regret to advise", "rejected", null],
  // Not jobs
  ["GitHub <noreply@github.com>", "[GitHub] A third-party OAuth application has been added to your account", "other", "GitHub"],
  ["Teacher <t@school.edu>", "Qazi Sultana has given feedback for assignment AIS: Interview Preparation Guide (IPG)", "other", "Teacher"],
];

test("subject rules put each email in the right column", () => {
  for (const [from, subject, label] of SUBJECTS) {
    assert.equal(classify(from, subject), label, subject);
  }
});

test("company comes from the subject, or the sender name", () => {
  for (const [from, subject, , company] of SUBJECTS) {
    if (company === null) continue;
    assert.equal(extractCompany(from, subject), company, subject);
  }
});

test("job boards and test platforms are never treated as the company", () => {
  assert.equal(extractCompany("SEEK Applications <noreply@s.seek.com.au>", "Your application was successfully submitted"), null);
  assert.equal(extractCompany("CodeSignal <noreply@codesignal.com>", "Your assessment is ready"), null);
});

test("preview rules read the first line, bad news first", () => {
  const cases: [string, string][] = [
    ["Thank you for your interest in the role. Unfortunately, on this occasion you have not been successful", "rejected"],
    ["After careful consideration we have decided to proceed with other candidates", "rejected"],
    ["It is with regret that we", "rejected"],
    ["We'd like to invite you to an interview for the Graduate role", "interview"],
    ["We are pleased to offer you the position of", "offer"],
    ["Our team is currently reviewing all applications and will be in touch", "in_review"],
    ["We have received your application for the role of Developer", "applied"],
    ["Thanks for your time last week. I wanted to reach out about", "unclear"],
  ];
  for (const [preview, label] of cases) assert.equal(classifyPreview(preview), label, preview);
});

test("outcome/update subjects are flagged as likely rejections", () => {
  for (const s of [
    "Outcome of your application for the Graduate Program",
    "Application outcome",
    "Update on your Shell Application",
    "An update on your application from Jobman Pty Ltd",
    "Your update from Atlassian",
  ]) assert.ok(isOutcomeSubject(s), s);
  assert.ok(!isOutcomeSubject("Mrunal, your application was sent to Salt"));
});

test("company names from previews stop at the end of the name", () => {
  assert.equal(extractCompanyFromPreview("Thanks for applying to Acme Corp. Your application"), "Acme Corp");
  assert.equal(extractCompanyFromPreview("Your application to Globex Pty Ltd has been received"), "Globex Pty Ltd");
  assert.equal(extractCompanyFromPreview("Hi Mrunal, the job you applied for"), null);
});

test("company keys merge spelling variants", () => {
  assert.equal(companyKey("Deloitte Australia"), companyKey("Deloitte"));
  assert.equal(companyKey("Lendi Group"), companyKey("Lendi"));
  assert.equal(companyKey("Integrated Application Development Pty. Ltd."), "integrated application development");
});
