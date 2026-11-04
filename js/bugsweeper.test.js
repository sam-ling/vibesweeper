import assert from "node:assert/strict";
import {
  CELL_STATE,
  GAME_PHASE,
  SAVE_VERSION,
  analyzeSolvability,
  calculateBoardSettings,
  chordCell,
  cloneGame,
  correctFlagCount,
  createBoard,
  createCandidateBoard,
  createGame,
  createSeededRng,
  deserializeGame,
  generateSolvableBoard,
  installGeneratedBoard,
  isSolvableWithoutGuessing,
  neighborsOf,
  remainingFlags,
  revealCell,
  serializeGame,
  toggleFlag,
  validateFlags,
} from "./bugsweeper.js";

function settings(columns, rows, mines, difficulty = "hard") {
  return { columns, rows, mines, difficulty };
}

function activeGame(board, difficulty = "hard") {
  return installGeneratedBoard(
    createGame(settings(board.columns, board.rows, board.mineCount, difficulty)),
    board,
  );
}

function mineLocations(board) {
  return board.cells.flatMap((cell, index) => (cell.mine ? [index] : []));
}

function testViewportDimensionsAndMineCounts() {
  assert.deepEqual(calculateBoardSettings(1280, 670, "hard"), {
    columns: 26,
    rows: 13,
    mines: 67,
    difficulty: "hard",
  });
  assert.deepEqual(calculateBoardSettings(375, 617, "easy"), {
    columns: 8,
    rows: 13,
    mines: 14,
    difficulty: "easy",
  });
  assert.equal(calculateBoardSettings(1280, 670, "insane").mines, 84);
  assert.throws(() => calculateBoardSettings(800, 600, "nightmare"), /Unknown difficulty/);
}

function testAdjacencyValuesAndNeighbors() {
  const board = createBoard(settings(3, 3, 1), [4]);
  assert.deepEqual(board.cells.map((cell) => cell.adjacent), [1, 1, 1, 1, 0, 1, 1, 1, 1]);
  assert.deepEqual(neighborsOf(0, 3, 3), [1, 3, 4]);
  assert.equal(neighborsOf(4, 3, 3).length, 8);
}

function testDeterministicCandidateGeneration() {
  const boardSettings = settings(7, 6, 8);
  const first = 17;
  const firstBoard = createCandidateBoard(boardSettings, first, createSeededRng(42));
  const secondBoard = createCandidateBoard(boardSettings, first, createSeededRng(42));
  const differentBoard = createCandidateBoard(boardSettings, first, createSeededRng(43));
  assert.deepEqual(firstBoard, secondBoard);
  assert.notDeepEqual(mineLocations(firstBoard), mineLocations(differentBoard));
  assert.equal(mineLocations(firstBoard).length, 8);
}

function testDeterministicVerifiedGeneration() {
  const boardSettings = settings(6, 6, 6);
  const first = 14;
  const firstBoard = generateSolvableBoard(boardSettings, first, {
    rng: createSeededRng(7331),
    maxAttempts: 500,
  });
  const secondBoard = generateSolvableBoard(boardSettings, first, {
    rng: createSeededRng(7331),
    maxAttempts: 500,
  });
  assert.deepEqual(firstBoard, secondBoard);
  assert.equal(isSolvableWithoutGuessing(firstBoard, first), true);
}

function testFirstRevealAndOpeningNeighborSafety() {
  const boardSettings = settings(8, 8, 16);
  const first = 27;
  const board = createCandidateBoard(boardSettings, first, createSeededRng(9));
  assert.equal(board.cells[first].mine, false);
  assert.equal(board.cells[first].adjacent, 0);
  for (const adjacent of neighborsOf(first, 8, 8)) {
    assert.equal(board.cells[adjacent].mine, false);
  }

  const dense = createCandidateBoard(settings(2, 2, 3), 0, createSeededRng(1));
  assert.equal(dense.cells[0].mine, false);
  assert.equal(mineLocations(dense).length, 3);
}

function testSolverAcceptanceAndRejectionWithoutMutation() {
  const solvable = createBoard(settings(4, 4, 4), [0, 1, 2, 3]);
  const ambiguous = createBoard(settings(2, 2, 1), [3]);
  const before = JSON.stringify(ambiguous);
  assert.equal(isSolvableWithoutGuessing(solvable, 15), true);
  assert.equal(isSolvableWithoutGuessing(ambiguous, 0), false);
  assert.equal(JSON.stringify(ambiguous), before);
  const analysis = analyzeSolvability(ambiguous, 0);
  assert.equal(analysis.valid, true);
  assert.equal(analysis.exhaustive, true);
}

function testModelOperationsDoNotLeakMutations() {
  const board = createBoard(settings(3, 3, 1), [4]);
  const game = activeGame(board);
  const before = JSON.stringify(game);
  const marked = toggleFlag(game, 4);
  assert.equal(JSON.stringify(game), before);
  assert.notEqual(marked.game, game);
  assert.notEqual(marked.game.cells, game.cells);
  assert.equal(game.cells[4].state, CELL_STATE.HIDDEN);

  const revealBefore = JSON.stringify(game);
  const revealed = revealCell(game, 0);
  assert.equal(JSON.stringify(game), revealBefore);
  assert.notEqual(revealed.game.cells, game.cells);

  const copy = cloneGame(game);
  copy.cells[0].state = CELL_STATE.REVEALED;
  assert.equal(game.cells[0].state, CELL_STATE.HIDDEN);
}

function testRevealAndZeroRegionExpansion() {
  const board = createBoard(settings(5, 4, 4), [0, 1, 2, 3]);
  const game = activeGame(board);
  const result = revealCell(game, 19);
  assert.ok(result.revealedCount > 1);
  assert.equal(result.game.cells[19].state, CELL_STATE.REVEALED);
  assert.equal(result.game.phase, GAME_PHASE.PLAYING);
  const completed = revealCell(result.game, 4).game;
  assert.equal(completed.phase, GAME_PHASE.WON);
  assert.equal(remainingFlags(completed), 0);
}

function testFlaggingAndFlagLimitsBeforeGeneration() {
  const game = createGame(settings(2, 2, 1));
  const first = toggleFlag(game, 0);
  assert.equal(first.reason, "flagged");
  assert.equal(remainingFlags(first.game), 0);
  const limited = toggleFlag(first.game, 1);
  assert.equal(limited.changed, false);
  assert.equal(limited.reason, "flag-limit");
  const unflagged = toggleFlag(first.game, 0);
  assert.equal(unflagged.reason, "unflagged");
  assert.equal(remainingFlags(unflagged.game), 1);
}

function testGeneratedBoardKeepsPreStartFlags() {
  const ready = toggleFlag(createGame(settings(3, 3, 1)), 8).game;
  const board = createBoard(settings(3, 3, 1), [4]);
  const game = installGeneratedBoard(ready, board);
  assert.equal(game.cells[8].state, CELL_STATE.FLAGGED);
  assert.equal(game.cells[4].mine, true);
}

function testCorrectChordRevealsNeighbors() {
  const board = createBoard(settings(3, 3, 1), [4]);
  let game = activeGame(board);
  game = revealCell(game, 0).game;
  game = toggleFlag(game, 4).game;
  const result = chordCell(game, 0);
  assert.equal(result.reason, "chorded");
  assert.equal(result.game.cells[1].state, CELL_STATE.REVEALED);
  assert.equal(result.game.cells[3].state, CELL_STATE.REVEALED);
  assert.equal(result.game.phase, GAME_PHASE.PLAYING);
}

function testIncorrectChordCausesLoss() {
  const board = createBoard(settings(3, 3, 1), [4]);
  let game = activeGame(board);
  game = revealCell(game, 0).game;
  game = toggleFlag(game, 1).game;
  const result = revealCell(game, 0);
  assert.equal(result.reason, "exploded");
  assert.equal(result.game.phase, GAME_PHASE.LOST);
  assert.equal(result.game.explodedIndex, 4);
}

function testChordRequiresMatchingFlagCount() {
  const board = createBoard(settings(3, 3, 1), [4]);
  const game = revealCell(activeGame(board), 0).game;
  const result = chordCell(game, 0);
  assert.equal(result.changed, false);
  assert.equal(result.reason, "unsatisfied-clue");
}

function testCorrectFlagValidationWins() {
  const board = createBoard(settings(2, 2, 1), [3]);
  let game = activeGame(board);
  game = toggleFlag(game, 3).game;
  const result = validateFlags(game);
  assert.equal(result.reason, "validated");
  assert.equal(result.game.phase, GAME_PHASE.WON);
  assert.equal(result.game.cells[3].state, CELL_STATE.FLAGGED);
}

function testIncorrectFlagValidationLoses() {
  const board = createBoard(settings(2, 2, 1), [3]);
  let game = activeGame(board);
  game = toggleFlag(game, 1).game;
  const result = validateFlags(game);
  assert.equal(result.reason, "exploded");
  assert.equal(result.game.phase, GAME_PHASE.LOST);
  assert.equal(result.game.explodedIndex, 3);
  assert.equal(correctFlagCount(result.game), 0);
}

function testAutomaticWinTransitionAndMineFlagging() {
  const board = createBoard(settings(2, 2, 1), [3]);
  let game = activeGame(board);
  game = revealCell(game, 0).game;
  game = revealCell(game, 1).game;
  game = revealCell(game, 2).game;
  assert.equal(game.phase, GAME_PHASE.WON);
  assert.equal(game.cells[3].state, CELL_STATE.FLAGGED);
  assert.equal(correctFlagCount(game), 1);
}

function testMineRevealCausesLoss() {
  const board = createBoard(settings(2, 2, 1), [3]);
  const result = revealCell(activeGame(board), 3);
  assert.equal(result.game.phase, GAME_PHASE.LOST);
  assert.equal(result.game.explodedIndex, 3);
  assert.equal(result.game.cells[3].state, CELL_STATE.REVEALED);
}

function testReadyGameSerializationWithFlags() {
  const game = toggleFlag(createGame(settings(4, 4, 3, "medium")), 2).game;
  const serialized = serializeGame(game, 0);
  const restored = deserializeGame(serialized);
  assert.ok(restored);
  assert.deepEqual(restored.game, game);
  assert.equal(restored.elapsedMs, 0);
  restored.game.cells[2].state = CELL_STATE.HIDDEN;
  assert.equal(game.cells[2].state, CELL_STATE.FLAGGED);
}

function testPlayingGameSerializationAndValidation() {
  const board = createBoard(settings(3, 3, 1), [4]);
  const game = revealCell(activeGame(board), 0).game;
  const restored = deserializeGame(serializeGame(game, 12_345));
  assert.ok(restored);
  assert.equal(restored.elapsedMs, 12_345);
  assert.deepEqual(restored.game, game);

  const corrupt = JSON.parse(serializeGame(game, 12_345));
  corrupt.game.cells[0].adjacent = 8;
  assert.equal(deserializeGame(JSON.stringify(corrupt)), null);
}

function testInvalidAndFinishedSavesAreRejected() {
  assert.equal(deserializeGame("not json"), null);
  assert.equal(deserializeGame(JSON.stringify({ version: SAVE_VERSION + 1 })), null);
  assert.equal(deserializeGame(JSON.stringify({ version: SAVE_VERSION, elapsedMs: 0, game: {} })), null);

  const board = createBoard(settings(2, 2, 1), [3]);
  const lost = revealCell(activeGame(board), 3).game;
  assert.throws(() => serializeGame(lost, 10), /unfinished game/);
}

function testLargeBoardsAreSerialized() {
  let game = createGame(settings(50, 25, 250, "insane"));
  game = toggleFlag(game, 1_249).game;
  const serialized = serializeGame(game, 0);
  const restored = deserializeGame(serialized);
  assert.ok(restored);
  assert.equal(restored.game.cells.length, 1_250);
  assert.equal(restored.game.cells[1_249].state, CELL_STATE.FLAGGED);
}

const tests = [
  testViewportDimensionsAndMineCounts,
  testAdjacencyValuesAndNeighbors,
  testDeterministicCandidateGeneration,
  testDeterministicVerifiedGeneration,
  testFirstRevealAndOpeningNeighborSafety,
  testSolverAcceptanceAndRejectionWithoutMutation,
  testModelOperationsDoNotLeakMutations,
  testRevealAndZeroRegionExpansion,
  testFlaggingAndFlagLimitsBeforeGeneration,
  testGeneratedBoardKeepsPreStartFlags,
  testCorrectChordRevealsNeighbors,
  testIncorrectChordCausesLoss,
  testChordRequiresMatchingFlagCount,
  testCorrectFlagValidationWins,
  testIncorrectFlagValidationLoses,
  testAutomaticWinTransitionAndMineFlagging,
  testMineRevealCausesLoss,
  testReadyGameSerializationWithFlags,
  testPlayingGameSerializationAndValidation,
  testInvalidAndFinishedSavesAreRejected,
  testLargeBoardsAreSerialized,
];

for (const test of tests) {
  test();
  console.log(`ok - ${test.name}`);
}

console.log(`${tests.length} tests passed`);
