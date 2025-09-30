import { evalite } from "evalite";
import { Levenshtein } from "autoevals";

const handle = evalite("Export API Test", {
  data: () => {
    return [
      {
        input: "test1",
        expected: "test1-output",
      },
      {
        input: "test2",
        expected: "test2-output",
      },
      {
        input: "test3",
        expected: "test3-fail",
      },
    ];
  },
  task: async (input) => {
    return input + "-output";
  },
  scorers: [Levenshtein],
});

// Test onResult callback
let resultCount = 0;
handle.onResult((result) => {
  resultCount++;
  console.log(`Result ${resultCount} completed:`, {
    input: result.input,
    output: result.output,
    scores: result.scores,
    status: result.status,
  });
});

// Test getResults
handle.getResults().then((results) => {
  console.log("All results:", {
    evalName: results.evalName,
    totalResults: results.results.length,
    averageScore: results.averageScore,
    status: results.status,
  });
});

// Test getSummary
handle.getSummary().then((summary) => {
  console.log("Summary:", summary);
});