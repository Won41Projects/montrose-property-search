import { checkEagleWebConnection, searchProperties } from "./server.mjs";

console.log("Checking connection to Montrose County EagleWeb...\n");

try {
  const health = await checkEagleWebConnection();
  if (!health.ok) {
    console.error("Connected, but EagleWeb did not return the search page.");
    process.exit(1);
  }

  console.log(`OK: EagleWeb reachable in ${health.elapsedMs}ms\n`);

  const sample = await searchProperties("Troy Masters");
  console.log(`Sample search: ${sample.message}`);
  if (sample.results.length > 0) {
    console.log(`First result: ${sample.results[0].accountNumber}`);
  } else {
    console.log("No sample results returned.");
  }
} catch (error) {
  console.error("FAILED:", error instanceof Error ? error.message : error);
  if (error instanceof Error && error.cause instanceof Error) {
    console.error("Cause:", error.cause.message);
  }
  console.error(
    "\nTry opening this in Safari first:\nhttps://eagleweb.montrosecounty.net/eagleassessor/web/",
  );
  process.exit(1);
}
