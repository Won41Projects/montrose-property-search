#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveMillLevy } from "./server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "levy.config.json");

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) return null;
  return Number(process.argv[index + 1]);
}

const annualIncrease = readArg("--increase");
const assessed = readArg("--assessed");

if (!annualIncrease || !assessed) {
  console.log(`Usage:
  node derive-levy.mjs --increase <annual_tax_increase> --assessed <non_school_assessed_value>

Example:
  node derive-levy.mjs --increase 350.80 --assessed 17540

This writes the derived mill levy into levy.config.json.`);
  process.exit(1);
}

const millLevy = deriveMillLevy(annualIncrease, assessed);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

config.millLevy = Number(millLevy.toFixed(4));
config.calibration = {
  ...config.calibration,
  sampleAnnualIncrease: annualIncrease,
  sampleNonSchoolAssessedValue: assessed,
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

console.log(`Derived mill levy: ${config.millLevy}`);
console.log(`Saved to ${configPath}`);
console.log("Restart the server if it is already running.");
