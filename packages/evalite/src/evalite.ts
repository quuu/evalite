import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { describe, inject, it } from "vitest";
import { reportTraceLocalStorage } from "./traces.js";
import { writeFileQueueLocalStorage } from "./write-file-queue-local-storage.js";
import { createEvaliteFileIfNeeded } from "./utils.js";
import type { Evalite } from "./types.js";
import { FILES_LOCATION } from "./backend-only-constants.js";
import { createScorer } from "./index.js";
import { average } from "./utils.js";

declare module "vitest" {
  interface TaskMeta {
    evalite?: Evalite.TaskMeta;
  }
}

const joinArrayOfUnknownResults = (results: unknown[]): unknown => {
  return results.reduce((acc, result) => {
    if (
      typeof result === "string" ||
      typeof result === "number" ||
      typeof result === "boolean"
    ) {
      return `${acc}${result}`;
    }
    throw new Error(
      `Cannot display results of stream: stream contains non-string, non-number, non-boolean chunks.`
    );
  }, "");
};

const executeTask = async <TInput, TOutput>(
  task: Evalite.Task<TInput, TOutput>,
  input: TInput
): Promise<TOutput> => {
  const taskResultOrStream = await task(input);

  if (
    typeof taskResultOrStream === "object" &&
    taskResultOrStream &&
    Symbol.asyncIterator in taskResultOrStream
  ) {
    const chunks: TOutput[] = [];

    for await (const chunk of taskResultOrStream) {
      chunks.push(chunk);
    }

    return joinArrayOfUnknownResults(chunks) as TOutput;
  }

  return taskResultOrStream;
};

const runTask = async <TInput, TOutput, TExpected>(
  opts: {
    input: TInput;
    expected: TExpected | undefined;
  } & Omit<
    Evalite.RunnerOpts<TInput, TOutput, TExpected>,
    "data" | "experimental_customColumns"
  >
) => {
  const start = performance.now();
  const output = await executeTask(opts.task, opts.input);
  const duration = Math.round(performance.now() - start);

  const columns =
    (await opts.columns?.({
      input: opts.input,
      output,
      expected: opts.expected,
    })) || [];

  const scores = await Promise.all(
    opts.scorers.map(async (scorerOrOpts) => {
      if (typeof scorerOrOpts === "function") {
        return scorerOrOpts({
          input: opts.input,
          output,
          expected: opts.expected,
        });
      } else {
        return createScorer(scorerOrOpts)({
          input: opts.input,
          output,
          expected: opts.expected,
        });
      }
    })
  );

  return {
    output,
    scores,
    duration,
    columns,
  };
};

export const evalite = <TInput, TOutput, TExpected = TOutput>(
  evalName: string,
  opts: Evalite.RunnerOpts<TInput, TOutput, TExpected>
): Evalite.EvaliteHandle => registerEvalite(evalName, opts);

evalite.experimental_skip = <TInput, TOutput, TExpected>(
  evalName: string,
  opts: Evalite.RunnerOpts<TInput, TOutput, TExpected>
): Evalite.EvaliteHandle =>
  registerEvalite(evalName, opts, { modifier: "skip" });

function registerEvalite<TInput, TOutput, TExpected>(
  evalName: string,
  opts: Evalite.RunnerOpts<TInput, TOutput, TExpected>,
  vitestOpts: { modifier?: "only" | "skip" } = {}
): Evalite.EvaliteHandle {
  const describeFn = vitestOpts.modifier === "skip" ? describe.skip : describe;
  const datasetPromise =
    vitestOpts.modifier === "skip" ? Promise.resolve([]) : opts.data();

  // State to track results
  const completedResults: Evalite.ExportedResultData[] = [];
  const resultCallbacks: Array<(result: Evalite.ExportedResultData) => void> =
    [];
  let completionPromise: Promise<void>;
  let resolveCompletion: () => void;
  let totalTests = 0;

  // Create completion promise upfront
  completionPromise = new Promise((resolve) => {
    resolveCompletion = resolve;
  });

  // Helper to check if all results are complete
  const checkCompletion = () => {
    if (totalTests > 0 && completedResults.length === totalTests) {
      resolveCompletion();
    }
  };

  // Register result
  const registerResult = (result: Evalite.Result) => {
    const exportedResult: Evalite.ExportedResultData = {
      input: result.input,
      output: result.output,
      expected: result.expected,
      scores: result.scores,
      duration: result.duration,
      traces: result.traces,
      renderedColumns: result.renderedColumns,
      status: result.status,
    };

    completedResults.push(exportedResult);

    // Notify callbacks
    resultCallbacks.forEach((callback) => {
      try {
        callback(exportedResult);
      } catch (e) {
        console.error("Error in onResult callback:", e);
      }
    });

    checkCompletion();
  };

  describeFn(evalName, async () => {
    const dataset = await datasetPromise;
    totalTests = dataset.length;

    // If no tests, complete immediately
    if (totalTests === 0) {
      resolveCompletion();
    }

    it.concurrent.for(dataset.map((d, index) => ({ ...d, index })))(
      evalName,
      async (data, { task }) => {
        const cwd = inject("cwd");

        const rootDir = path.join(cwd, FILES_LOCATION);

        task.meta.evalite = {
          duration: undefined,
          initialResult: {
            evalName: evalName,
            filepath: task.file.filepath,
            order: data.index,
          },
        };

        const start = performance.now();

        const filePromises: Promise<void>[] = [];

        writeFileQueueLocalStorage.enterWith(async (filePath, buffer) => {
          const func = async () => {
            await mkdir(path.dirname(filePath), { recursive: true });
            await writeFile(filePath, buffer);
          };

          const promise = func();

          filePromises.push(promise);
        });

        const traces: Evalite.Trace[] = [];
        reportTraceLocalStorage.enterWith((trace) => traces.push(trace));

        const [input, expected] = await Promise.all([
          createEvaliteFileIfNeeded({ rootDir, input: data.input }),
          createEvaliteFileIfNeeded({ rootDir, input: data.expected }),
        ]);

        task.meta.evalite.resultAfterFilesSaved = {
          evalName,
          filepath: task.file.filepath,
          order: data.index,
          input,
          expected,
        };

        try {
          const { output, scores, duration, columns } = await runTask({
            expected: data.expected,
            input: data.input,
            scorers: opts.scorers,
            task: opts.task,
            columns: opts.columns || opts.experimental_customColumns,
          });

          const [outputWithFiles, tracesWithFiles, renderedColumns] =
            await Promise.all([
              createEvaliteFileIfNeeded({
                rootDir,
                input: output,
              }),
              handleFilesInTraces(rootDir, traces),
              handleFilesInColumns(rootDir, columns),
            ]);

          const result = {
            evalName: evalName,
            filepath: task.file.filepath,
            order: data.index,
            duration,
            expected: expected,
            input: input,
            output: outputWithFiles,
            scores,
            traces: tracesWithFiles,
            status: "success" as const,
            renderedColumns,
          };

          task.meta.evalite = {
            result,
            duration: Math.round(performance.now() - start),
          };

          // Register result for export API
          registerResult(result);
        } catch (e) {
          const result = {
            evalName: evalName,
            filepath: task.file.filepath,
            order: data.index,
            duration: Math.round(performance.now() - start),
            expected: expected,
            input: input,
            output: e,
            scores: [],
            traces: await handleFilesInTraces(rootDir, traces),
            status: "fail" as const,
            renderedColumns: [],
          };

          task.meta.evalite = {
            result,
            duration: Math.round(performance.now() - start),
          };

          // Register result for export API
          registerResult(result);
          throw e;
        }

        await Promise.all(filePromises);
      }
    );
  });

  // Return the handle with export API
  return {
    onResult: (callback: (result: Evalite.ExportedResultData) => void) => {
      resultCallbacks.push(callback);
    },

    getResults: async (): Promise<Evalite.ExportedResults> => {
      await completionPromise;

      const allScores = completedResults.flatMap((r) => r.scores);
      const averageScore = average(allScores, (s) => s.score ?? 0);
      const totalDuration = Math.max(
        ...completedResults.map((r) => r.duration),
        0
      );
      const status = completedResults.some((r) => r.status === "fail")
        ? ("fail" as const)
        : ("success" as const);

      return {
        evalName,
        results: completedResults,
        averageScore,
        duration: totalDuration,
        status,
      };
    },

    getSummary: async (): Promise<Evalite.ExportedSummary> => {
      await completionPromise;

      const allScores = completedResults.flatMap((r) => r.scores);
      const averageScore = average(allScores, (s) => s.score ?? 0);

      // Calculate average by scorer
      const scoresByScorer: Record<string, number[]> = {};
      for (const result of completedResults) {
        for (const score of result.scores) {
          if (!scoresByScorer[score.name]) {
            scoresByScorer[score.name] = [];
          }
          scoresByScorer[score.name]?.push(score.score ?? 0);
        }
      }

      const averageScoreByScorer: Record<string, number> = {};
      for (const [scorerName, scores] of Object.entries(scoresByScorer)) {
        averageScoreByScorer[scorerName] = average(scores, (s) => s);
      }

      const totalDuration = completedResults.reduce(
        (sum, r) => sum + r.duration,
        0
      );
      const passedResults = completedResults.filter(
        (r) => r.status === "success"
      ).length;
      const failedResults = completedResults.filter(
        (r) => r.status === "fail"
      ).length;
      const status =
        failedResults > 0 ? ("fail" as const) : ("success" as const);

      return {
        evalName,
        totalResults: completedResults.length,
        passedResults,
        failedResults,
        averageScore,
        averageScoreByScorer,
        totalDuration,
        status,
      };
    },
  };
}

const handleFilesInColumns = async (
  rootDir: string,
  columns: Evalite.RenderedColumn[]
) => {
  return await Promise.all(
    columns.map(async (column) => {
      const file = await createEvaliteFileIfNeeded({
        rootDir,
        input: column.value,
      });
      return {
        ...column,
        value: file,
      };
    })
  );
};

const handleFilesInTraces = async (
  rootDir: string,
  traces: Evalite.Trace[]
) => {
  return await Promise.all(
    traces.map(async (trace) => {
      const [input, output] = await Promise.all([
        createEvaliteFileIfNeeded({
          rootDir,
          input: trace.input,
        }),
        createEvaliteFileIfNeeded({
          rootDir,
          input: trace.output,
        }),
      ]);
      return {
        ...trace,
        input,
        output,
      };
    })
  );
};
