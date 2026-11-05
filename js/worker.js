import {
  GenerationError,
  generateSolvableBoard,
} from "./bugsweeper.js";

let latestRequestId = null;

self.addEventListener("message", (event) => {
  const request = event.data;
  if (!request || request.type !== "generate") return;
  latestRequestId = request.requestId;
  const requestId = request.requestId;
  let lastProgressAt = 0;

  try {
    const board = generateSolvableBoard(request.settings, request.firstIndex, {
      onProgress(attempts) {
        const now = Date.now();
        if (attempts === 1 || now - lastProgressAt >= 150) {
          lastProgressAt = now;
          self.postMessage({ type: "progress", requestId, attempts });
        }
      },
    });

    if (requestId === latestRequestId) {
      self.postMessage({ type: "complete", requestId, board });
    }
  } catch (error) {
    if (requestId !== latestRequestId) return;
    self.postMessage({
      type: "error",
      requestId,
      error: {
        code: error instanceof GenerationError ? error.code : "WORKER_ERROR",
        message: error instanceof Error
          ? error.message
          : "The board generator stopped unexpectedly.",
      },
    });
  }
});
