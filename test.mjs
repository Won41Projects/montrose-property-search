import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseResults,
  parseAssessmentTable,
  parseTreasurerTaxInfo,
  calculateLevyImpact,
  buildSearchAttempts,
  normalizeAccount,
  deriveMillLevy,
  estimateAnnualIncrease,
} from "./server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sampleHtml = fs.readFileSync(
  path.join(__dirname, "fixtures", "owner-results.html"),
  "utf8",
);

test("parses EagleWeb result rows", () => {
  const results = parseResults(sampleHtml);
  assert.equal(results.length, 1);
  assert.equal(results[0].accountNumber, "R0007980");
  assert.match(results[0].summary, /MASTERS TROY A/);
  assert.match(results[0].parcel, /4269-302-00-055/);
});

test("routes owner, account, and parcel queries", () => {
  assert.equal(buildSearchAttempts("Jane Doe")[0].matchType, "Owner");
  assert.equal(
    buildSearchAttempts("R0007980")[0].fields.AccountNumID,
    "R0007980",
  );
  assert.equal(
    buildSearchAttempts("4269-302-00-055")[0].fields.ParcelNumberID,
    "4269-302-00-055",
  );
  assert.equal(normalizeAccount("7980"), "R0007980");
  assert.equal(
    buildSearchAttempts("203 Highway 97").every((a) => a.matchType === "Owner"),
    true,
  );
});

test("parses non-school assessed value from assessment history", () => {
  const sampleHtml = fs.readFileSync(
    path.join(__dirname, "fixtures", "assessment-value.txt"),
    "utf8",
  );
  const assessment = parseAssessmentTable(sampleHtml);
  assert.equal(assessment.assessmentYear, "2026");
  assert.equal(assessment.nonSchoolAssessedValue, 17540);
  assert.equal(assessment.nonSchoolActualValue, 258000);
});

test("parses account summary non-school assessed format", () => {
  const summaryHtml =
    "Assessment History Actual (2026): $61,600 Non-School Assessed: $16,020";
  const assessment = parseAssessmentTable(summaryHtml);
  assert.equal(assessment.nonSchoolAssessedValue, 16020);
});

test("estimates levy increase from non-school assessed value", () => {
  const millLevy = deriveMillLevy(320.4, 16020);
  assert.ok(Math.abs(millLevy - 20) < 0.01);
  assert.equal(estimateAnnualIncrease(17540, 20), 350.8);
  assert.equal(estimateAnnualIncrease(16020, 20), 320.4);
});

test("parses senior exemption from TreasurerWeb value summary", () => {
  const treasurerText = fs.readFileSync(
    path.join(__dirname, "fixtures", "treasurer-r0009705.txt"),
    "utf8",
  );
  const treasurer = parseTreasurerTaxInfo(treasurerText);
  assert.equal(treasurer.nonSchoolAssessed, 14770);
  assert.equal(treasurer.seniorExemptionNonSchool, 280.72);
  assert.ok(Math.abs(treasurer.nonSchoolMillLevy - 44.911) < 0.001);
  assert.equal(treasurer.hasSeniorExemption, true);
});

test("reduces proposed levy estimate when senior exemption applies", () => {
  const treasurerText = fs.readFileSync(
    path.join(__dirname, "fixtures", "treasurer-r0009705.txt"),
    "utf8",
  );
  const treasurer = parseTreasurerTaxInfo(treasurerText);
  const assessment = {
    assessmentYear: "2026",
    nonSchoolAssessedValue: 16080,
    nonSchoolActualValue: null,
  };
  const impact = calculateLevyImpact(assessment, treasurer, 20);
  assert.equal(impact.annualIncreaseGross, 321.6);
  assert.ok(Math.abs(impact.annualIncreaseNet - 185.48) < 0.05);
  assert.equal(impact.hasSeniorExemption, true);
  assert.ok(impact.seniorExemption > 130 && impact.seniorExemption < 140);
});
