/**
 * Pure Bugsweeper model, board generator, and no-guess solver.
 *
 * This module deliberately has no browser dependencies. It can be imported by
 * Node tests, the module worker, and the Alpine integration.
 */

export const CELL_STATE = Object.freeze({
  HIDDEN: "hidden",
  FLAGGED: "flagged",
  REVEALED: "revealed",
});

export const GAME_PHASE = Object.freeze({
  READY: "ready",
  PLAYING: "playing",
  WON: "won",
  LOST: "lost",
});

export const DIFFICULTIES = Object.freeze({
  easy: Object.freeze({ label: "Easy", density: 0.14 }),
  medium: Object.freeze({ label: "Medium", density: 0.17 }),
  hard: Object.freeze({ label: "Hard", density: 0.2 }),
  insane: Object.freeze({ label: "Insane", density: 0.25 }),
});

export const SAVE_VERSION = 2;

const UNKNOWN = 0;
const KNOWN_SAFE = 1;
const KNOWN_MINE = 2;
const MAX_DIMENSION = 200;
const MAX_CELLS = 10_000;
const DEFAULT_SEARCH_NODES = 500_000;

export class GenerationError extends Error {
  constructor(message, code = "GENERATION_FAILED") {
    super(message);
    this.name = "GenerationError";
    this.code = code;
  }
}

function isIntegerInRange(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function validateSettings(settings) {
  if (!settings || typeof settings !== "object") {
    throw new TypeError("Board settings are required.");
  }

  const { columns, rows, mines } = settings;
  if (
    !isIntegerInRange(columns, 2, MAX_DIMENSION) ||
    !isIntegerInRange(rows, 2, MAX_DIMENSION) ||
    columns * rows > MAX_CELLS
  ) {
    throw new RangeError("Board dimensions are outside the supported range.");
  }
  if (!isIntegerInRange(mines, 0, columns * rows - 1)) {
    throw new RangeError("Mine count must leave at least one safe cell.");
  }
}

function validateIndex(index, cellCount) {
  if (!isIntegerInRange(index, 0, cellCount - 1)) {
    throw new RangeError("Cell index is outside the board.");
  }
}

export function calculateBoardSettings(
  viewportWidth,
  playAreaHeight,
  difficulty = "hard",
  boardSize = "L",
) {
  if (!DIFFICULTIES[difficulty]) {
    throw new RangeError(`Unknown difficulty: ${difficulty}`);
  }
  if (!(viewportWidth > 0) || !(playAreaHeight > 0)) {
    throw new RangeError("Viewport dimensions must be positive.");
  }

  const fixedSizes = { S: [8, 8], M: [12, 12], XL: [20, 20], XXL: [24, 24] };
  if (boardSize !== "L" && !fixedSizes[boardSize]) throw new RangeError("Unknown board size: " + boardSize);
  let columns, rows;
  if (boardSize === "L") {
    const compact = viewportWidth < 500 || playAreaHeight < 500;
    const cellSize = compact ? 44 : 45;
    const gap = 2;
    const padding = compact ? 0 : 24;
    const usableWidth = Math.max(0, viewportWidth - padding);
    const usableHeight = Math.max(0, playAreaHeight - padding);
    columns = Math.max(2, Math.floor((usableWidth + gap) / (cellSize + gap)));
    rows = Math.max(2, Math.floor((usableHeight + gap) / (cellSize + gap)));
  } else {
    [columns, rows] = fixedSizes[boardSize];
  }
  const cellCount = columns * rows;
  const mines = Math.min(
    cellCount - 1,
    Math.max(1, Math.floor(cellCount * DIFFICULTIES[difficulty].density)),
  );

  const settings = { columns, rows, mines, difficulty };
  validateSettings(settings);
  return settings;
}

export function cellIndex(column, row, columns) {
  return row * columns + column;
}

export function cellCoordinates(index, columns) {
  return { column: index % columns, row: Math.floor(index / columns) };
}

export function neighborsOf(index, columns, rows) {
  validateIndex(index, columns * rows);
  const { column, row } = cellCoordinates(index, columns);
  const neighbors = [];

  for (let nextRow = row - 1; nextRow <= row + 1; nextRow += 1) {
    for (let nextColumn = column - 1; nextColumn <= column + 1; nextColumn += 1) {
      if (
        nextColumn >= 0 &&
        nextRow >= 0 &&
        nextColumn < columns &&
        nextRow < rows &&
        (nextColumn !== column || nextRow !== row)
      ) {
        neighbors.push(cellIndex(nextColumn, nextRow, columns));
      }
    }
  }

  return neighbors;
}

function makeNeighborMap(columns, rows) {
  return Array.from(
    { length: columns * rows },
    (_, index) => neighborsOf(index, columns, rows),
  );
}

function blankCells(cellCount) {
  return Array.from({ length: cellCount }, () => ({
    mine: false,
    adjacent: 0,
    state: CELL_STATE.HIDDEN,
  }));
}

export function createBoard(settings, mineIndices = []) {
  validateSettings(settings);
  if (!Array.isArray(mineIndices) || mineIndices.length !== settings.mines) {
    throw new RangeError("Mine locations must match the configured mine count.");
  }

  const cellCount = settings.columns * settings.rows;
  const cells = blankCells(cellCount);
  const uniqueMines = new Set();

  for (const index of mineIndices) {
    validateIndex(index, cellCount);
    if (uniqueMines.has(index)) {
      throw new RangeError("Mine locations must be unique.");
    }
    uniqueMines.add(index);
    cells[index].mine = true;
  }

  const neighbors = makeNeighborMap(settings.columns, settings.rows);
  for (const mineIndex of uniqueMines) {
    for (const adjacentIndex of neighbors[mineIndex]) {
      if (!cells[adjacentIndex].mine) {
        cells[adjacentIndex].adjacent += 1;
      }
    }
  }

  return {
    columns: settings.columns,
    rows: settings.rows,
    mineCount: settings.mines,
    cells,
  };
}

export function createGame(settings) {
  validateSettings(settings);
  return {
    columns: settings.columns,
    rows: settings.rows,
    mineCount: settings.mines,
    difficulty: DIFFICULTIES[settings.difficulty] ? settings.difficulty : "hard",
    logicDifficulty: ["beginner", "intermediate", "advanced", "expert"].includes(settings.logicDifficulty) ? settings.logicDifficulty : "beginner",
    generated: false,
    phase: GAME_PHASE.READY,
    explodedIndex: null,
    cells: blankCells(settings.columns * settings.rows),
  };
}

function cloneCells(cells) {
  return cells.map((cell) => ({ ...cell }));
}

export function cloneGame(game) {
  return { ...game, cells: cloneCells(game.cells) };
}

export function createSeededRng(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle(values, rng) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(rng() * (index + 1));
    [values[index], values[randomIndex]] = [values[randomIndex], values[index]];
  }
  return values;
}

function protectedOpening(settings, firstIndex) {
  const cellCount = settings.columns * settings.rows;
  const opening = [
    firstIndex,
    ...neighborsOf(firstIndex, settings.columns, settings.rows),
  ];
  return cellCount - opening.length >= settings.mines
    ? new Set(opening)
    : new Set([firstIndex]);
}

export function createCandidateBoard(settings, firstIndex, rng = Math.random) {
  validateSettings(settings);
  const cellCount = settings.columns * settings.rows;
  validateIndex(firstIndex, cellCount);
  if (typeof rng !== "function") {
    throw new TypeError("The RNG must be a function.");
  }

  const excluded = protectedOpening(settings, firstIndex);
  const available = [];
  for (let index = 0; index < cellCount; index += 1) {
    if (!excluded.has(index)) {
      available.push(index);
    }
  }
  shuffle(available, rng);
  return createBoard(settings, available.slice(0, settings.mines));
}

function buildConstraints(board, states, revealed, neighbors) {
  const constraints = [];
  const seen = new Set();

  for (let index = 0; index < board.cells.length; index += 1) {
    if (!revealed[index]) continue;

    const unknown = [];
    let knownMines = 0;
    for (const adjacent of neighbors[index]) {
      if (states[adjacent] === KNOWN_MINE) knownMines += 1;
      else if (states[adjacent] === UNKNOWN) unknown.push(adjacent);
    }

    const mines = board.cells[index].adjacent - knownMines;
    if (mines < 0 || mines > unknown.length) {
      return { valid: false, constraints: [] };
    }
    if (unknown.length === 0) continue;

    unknown.sort((left, right) => left - right);
    const key = `${unknown.join(",")}:${mines}`;
    if (!seen.has(key)) {
      seen.add(key);
      constraints.push({ cells: unknown, mines });
    }
  }

  return { valid: true, constraints };
}

function splitComponents(constraints) {
  const byCell = new Map();
  constraints.forEach((constraint, constraintIndex) => {
    for (const location of constraint.cells) {
      if (!byCell.has(location)) byCell.set(location, []);
      byCell.get(location).push(constraintIndex);
    }
  });

  const components = [];
  const visitedConstraints = new Set();
  for (let start = 0; start < constraints.length; start += 1) {
    if (visitedConstraints.has(start)) continue;
    const pending = [start];
    const componentConstraints = [];
    const componentCells = new Set();
    visitedConstraints.add(start);

    while (pending.length > 0) {
      const constraintIndex = pending.pop();
      const constraint = constraints[constraintIndex];
      componentConstraints.push(constraint);
      for (const location of constraint.cells) {
        componentCells.add(location);
        for (const linked of byCell.get(location)) {
          if (!visitedConstraints.has(linked)) {
            visitedConstraints.add(linked);
            pending.push(linked);
          }
        }
      }
    }

    components.push({
      cells: [...componentCells],
      constraints: componentConstraints,
    });
  }
  return components;
}

function enumerateComponent(component, budget) {
  const localIndex = new Map(component.cells.map((location, index) => [location, index]));
  const constraints = component.constraints.map((constraint) => ({
    cells: constraint.cells.map((location) => localIndex.get(location)),
    mines: constraint.mines,
  }));
  const memberships = Array.from({ length: component.cells.length }, () => []);
  constraints.forEach((constraint, constraintIndex) => {
    constraint.cells.forEach((index) => memberships[index].push(constraintIndex));
  });

  const order = Array.from({ length: component.cells.length }, (_, index) => index)
    .sort((left, right) => memberships[right].length - memberships[left].length);
  const assignedCounts = new Uint16Array(constraints.length);
  const assignedMines = new Uint16Array(constraints.length);
  const assignment = new Uint8Array(component.cells.length);
  const possibleCounts = new Uint8Array(component.cells.length + 1);
  const safePossible = Array.from(
    { length: component.cells.length },
    () => new Uint8Array(component.cells.length + 1),
  );
  const minePossible = Array.from(
    { length: component.cells.length },
    () => new Uint8Array(component.cells.length + 1),
  );
  let aborted = false;

  function search(depth, mineCount) {
    budget.remaining -= 1;
    if (budget.remaining < 0) {
      aborted = true;
      return;
    }
    if (depth === order.length) {
      possibleCounts[mineCount] = 1;
      assignment.forEach((value, index) => {
        (value ? minePossible : safePossible)[index][mineCount] = 1;
      });
      return;
    }

    const variable = order[depth];
    for (let value = 0; value <= 1; value += 1) {
      assignment[variable] = value;
      let valid = true;
      for (const constraintIndex of memberships[variable]) {
        assignedCounts[constraintIndex] += 1;
        assignedMines[constraintIndex] += value;
        const constraint = constraints[constraintIndex];
        const unassigned = constraint.cells.length - assignedCounts[constraintIndex];
        if (
          assignedMines[constraintIndex] > constraint.mines ||
          assignedMines[constraintIndex] + unassigned < constraint.mines
        ) {
          valid = false;
        }
      }

      if (valid) search(depth + 1, mineCount + value);

      for (const constraintIndex of memberships[variable]) {
        assignedCounts[constraintIndex] -= 1;
        assignedMines[constraintIndex] -= value;
      }
      if (aborted) return;
    }
  }

  search(0, 0);
  return {
    cells: component.cells,
    possibleCounts,
    safePossible,
    minePossible,
    aborted,
  };
}

function combineCounts(left, right, maximum) {
  const combined = new Uint8Array(maximum + 1);
  for (let leftCount = 0; leftCount < left.length; leftCount += 1) {
    if (!left[leftCount]) continue;
    for (let rightCount = 0; rightCount < right.length; rightCount += 1) {
      if (right[rightCount] && leftCount + rightCount <= maximum) {
        combined[leftCount + rightCount] = 1;
      }
    }
  }
  return combined;
}

function inferForcedCells(constraints, states, remainingMines, maximumNodes) {
  const components = splitComponents(constraints);
  const budget = { remaining: maximumNodes };
  const results = [];
  const frontier = new Set();
  let largestComponent = 0;

  for (const component of components) {
    largestComponent = Math.max(largestComponent, component.cells.length);
    component.cells.forEach((index) => frontier.add(index));
    const result = enumerateComponent(component, budget);
    if (result.aborted) {
      return { valid: true, aborted: true, safe: [], mines: [], frontier: [...frontier] };
    }
    results.push(result);
  }

  const offFrontier = [];
  states.forEach((state, index) => {
    if (state === UNKNOWN && !frontier.has(index)) offFrontier.push(index);
  });

  const prefixes = new Array(results.length + 1);
  const suffixes = new Array(results.length + 1);
  prefixes[0] = new Uint8Array(remainingMines + 1);
  prefixes[0][0] = 1;
  for (let index = 0; index < results.length; index += 1) {
    prefixes[index + 1] = combineCounts(
      prefixes[index],
      results[index].possibleCounts,
      remainingMines,
    );
  }
  suffixes[results.length] = new Uint8Array(remainingMines + 1);
  suffixes[results.length][0] = 1;
  for (let index = results.length - 1; index >= 0; index -= 1) {
    suffixes[index] = combineCounts(
      results[index].possibleCounts,
      suffixes[index + 1],
      remainingMines,
    );
  }

  let globallyPossible = false;
  let offFrontierCanBeSafe = false;
  let offFrontierCanBeMine = false;
  for (let componentMines = 0; componentMines < prefixes[results.length].length; componentMines += 1) {
    if (!prefixes[results.length][componentMines]) continue;
    const outsideMines = remainingMines - componentMines;
    if (outsideMines < 0 || outsideMines > offFrontier.length) continue;
    globallyPossible = true;
    if (outsideMines > 0) offFrontierCanBeMine = true;
    if (outsideMines < offFrontier.length) offFrontierCanBeSafe = true;
  }
  if (!globallyPossible) {
    return { valid: false, aborted: false, safe: [], mines: [], frontier: [...frontier] };
  }

  const safe = [];
  const mines = [];
  if (offFrontier.length > 0) {
    if (!offFrontierCanBeMine) safe.push(...offFrontier);
    else if (!offFrontierCanBeSafe) mines.push(...offFrontier);
  }

  results.forEach((result, resultIndex) => {
    const otherCounts = combineCounts(
      prefixes[resultIndex],
      suffixes[resultIndex + 1],
      remainingMines,
    );
    result.cells.forEach((location, localIndex) => {
      let canBeSafe = false;
      let canBeMine = false;

      for (let componentMines = 0; componentMines < result.possibleCounts.length; componentMines += 1) {
        if (!result.possibleCounts[componentMines]) continue;
        let compatible = false;
        for (let otherMines = 0; otherMines < otherCounts.length; otherMines += 1) {
          if (!otherCounts[otherMines]) continue;
          const outsideMines = remainingMines - componentMines - otherMines;
          if (outsideMines >= 0 && outsideMines <= offFrontier.length) {
            compatible = true;
            break;
          }
        }
        if (!compatible) continue;
        if (result.safePossible[localIndex][componentMines]) canBeSafe = true;
        if (result.minePossible[localIndex][componentMines]) canBeMine = true;
      }

      if (!canBeMine) safe.push(location);
      else if (!canBeSafe) mines.push(location);
    });
  });

  return { valid: true, aborted: false, safe, mines, frontier: [...frontier], largestComponent };
}

export function analyzeSolvability(board, firstIndex, options = {}) {
  assertBoard(board);
  validateIndex(firstIndex, board.cells.length);
  const maximumNodes = options.maxSearchNodes ?? DEFAULT_SEARCH_NODES;
  const neighbors = makeNeighborMap(board.columns, board.rows);
  const states = new Uint8Array(board.cells.length);
  const revealed = new Uint8Array(board.cells.length);
  let revealedSafeCount = 0;
  let inferenceCount = 0;
  let largestComponent = 0;

  function result(solvable, valid, exhaustive, frontier = []) {
    return {
      solvable,
      logicLevel: inferenceCount <= 1 ? 1 : largestComponent <= 6 ? 2 : largestComponent <= 10 ? 3 : 4,
      inferenceCount,
      largestComponent,
      valid,
      exhaustive,
      states,
      revealed,
      neighbors,
      frontier,
      revealedSafeCount,
    };
  }

  function revealKnownSafe(startIndex) {
    const pending = [startIndex];
    while (pending.length > 0) {
      const index = pending.pop();
      if (revealed[index] || states[index] === KNOWN_MINE) continue;
      if (board.cells[index].mine) return false;
      states[index] = KNOWN_SAFE;
      revealed[index] = 1;
      revealedSafeCount += 1;
      if (board.cells[index].adjacent === 0) {
        for (const adjacent of neighbors[index]) {
          if (!revealed[adjacent]) pending.push(adjacent);
        }
      }
    }
    return true;
  }

  if (!revealKnownSafe(firstIndex)) return result(false, false, true);

  const safeTarget = board.cells.length - board.mineCount;
  while (revealedSafeCount < safeTarget) {
    const unknown = [];
    let knownMineCount = 0;
    states.forEach((state, index) => {
      if (state === KNOWN_MINE) knownMineCount += 1;
      else if (state === UNKNOWN) unknown.push(index);
    });
    const remainingMines = board.mineCount - knownMineCount;
    if (remainingMines < 0 || remainingMines > unknown.length) {
      return result(false, false, true);
    }

    if (remainingMines === 0 || remainingMines === unknown.length) {
      inferenceCount += 1;
      for (const index of unknown) {
        if (remainingMines === 0) {
          if (!revealKnownSafe(index)) return result(false, false, true);
        } else {
          states[index] = KNOWN_MINE;
        }
      }
      continue;
    }

    const built = buildConstraints(board, states, revealed, neighbors);
    if (!built.valid) return result(false, false, true);
    let madeProgress = false;

    for (const constraint of built.constraints) {
      if (constraint.mines !== 0 && constraint.mines !== constraint.cells.length) continue;
      inferenceCount += 1;
      for (const index of constraint.cells) {
        if (states[index] !== UNKNOWN) continue;
        madeProgress = true;
        if (constraint.mines === 0) {
          if (!revealKnownSafe(index)) return result(false, false, true);
        } else {
          states[index] = KNOWN_MINE;
        }
      }
    }
    if (madeProgress) continue;
    if (built.constraints.length === 0) return result(false, true, true);

    const inference = inferForcedCells(
      built.constraints,
      states,
      remainingMines,
      maximumNodes,
    );
    largestComponent = Math.max(largestComponent, inference.largestComponent || 0);
    if (!inference.valid) return result(false, false, !inference.aborted, inference.frontier);
    if (inference.aborted) return result(false, true, false, inference.frontier);

    for (const index of inference.mines) {
      if (states[index] === UNKNOWN) {
        states[index] = KNOWN_MINE;
        madeProgress = true;
      }
    }
    for (const index of inference.safe) {
      if (states[index] === UNKNOWN) {
        madeProgress = true;
        if (!revealKnownSafe(index)) return result(false, false, true, inference.frontier);
      }
    }
    if (!madeProgress) return result(false, true, true, inference.frontier);
  }

  return result(true, true, true);
}

export function isSolvableWithoutGuessing(board, firstIndex, options) {
  return analyzeSolvability(board, firstIndex, options).solvable;
}

function recalculateBoard(board) {
  board.cells.forEach((cell) => {
    cell.adjacent = 0;
  });
  const neighbors = makeNeighborMap(board.columns, board.rows);
  board.cells.forEach((cell, index) => {
    if (!cell.mine) return;
    for (const adjacent of neighbors[index]) {
      if (!board.cells[adjacent].mine) board.cells[adjacent].adjacent += 1;
    }
  });
}

function repairCandidate(sourceBoard, firstIndex) {
  const board = { ...sourceBoard, cells: cloneCells(sourceBoard.cells) };
  const protectedCells = new Set([firstIndex]);
  if (board.cells[firstIndex].adjacent === 0) {
    neighborsOf(firstIndex, board.columns, board.rows).forEach((index) => protectedCells.add(index));
  }
  const maximumMoves = Math.min(
    128,
    Math.max(24, Math.ceil(Math.sqrt(board.cells.length) * 2)),
  );

  for (let move = 0; move < maximumMoves; move += 1) {
    const analysis = analyzeSolvability(board, firstIndex);
    if (analysis.solvable) return board;
    if (!analysis.valid || !analysis.exhaustive) return null;

    let source = -1;
    let sourceScore = 0;
    let destination = -1;
    let destinationScore = Infinity;
    let destinationDistance = -1;
    const first = cellCoordinates(firstIndex, board.columns);

    analysis.states.forEach((state, index) => {
      if (state !== UNKNOWN) return;
      const revealedNeighbors = analysis.neighbors[index]
        .reduce((count, adjacent) => count + analysis.revealed[adjacent], 0);
      if (board.cells[index].mine) {
        if (revealedNeighbors > sourceScore) {
          source = index;
          sourceScore = revealedNeighbors;
        }
      } else if (!protectedCells.has(index)) {
        const coordinates = cellCoordinates(index, board.columns);
        const distance = Math.abs(coordinates.column - first.column) + Math.abs(coordinates.row - first.row);
        if (
          revealedNeighbors < destinationScore ||
          (revealedNeighbors === destinationScore && distance > destinationDistance)
        ) {
          destination = index;
          destinationScore = revealedNeighbors;
          destinationDistance = distance;
        }
      }
    });

    if (source < 0 || destination < 0 || sourceScore === 0) return null;
    board.cells[source].mine = false;
    board.cells[destination].mine = true;
    recalculateBoard(board);
  }
  return isSolvableWithoutGuessing(board, firstIndex) ? board : null;
}

function createPackedCandidate(settings, firstIndex, variant) {
  const { columns, rows, mines } = settings;
  const excluded = protectedOpening(settings, firstIndex);
  const indices = Array.from({ length: columns * rows }, (_, index) => index)
    .filter((index) => !excluded.has(index));
  const direction = variant % 4;
  const reverseSecondary = Math.floor(variant / 4) % 2 === 1;

  indices.sort((left, right) => {
    const a = cellCoordinates(left, columns);
    const b = cellCoordinates(right, columns);
    let primaryA;
    let primaryB;
    let secondaryA;
    let secondaryB;
    if (direction === 0 || direction === 1) {
      primaryA = direction === 0 ? a.row : rows - 1 - a.row;
      primaryB = direction === 0 ? b.row : rows - 1 - b.row;
      secondaryA = a.column;
      secondaryB = b.column;
    } else {
      primaryA = direction === 2 ? a.column : columns - 1 - a.column;
      primaryB = direction === 2 ? b.column : columns - 1 - b.column;
      secondaryA = a.row;
      secondaryB = b.row;
    }
    return primaryA - primaryB || (reverseSecondary ? secondaryB - secondaryA : secondaryA - secondaryB);
  });
  return createBoard(settings, indices.slice(0, mines));
}

export function generateSolvableBoard(settings, firstIndex, options = {}) {
  validateSettings(settings);
  validateIndex(firstIndex, settings.columns * settings.rows);
  const rng = options.rng ?? Math.random;
  const onProgress = options.onProgress;
  const maximumAttempts = options.maxAttempts ?? 20_000;
  const repairAfter = options.repairAfter ?? 32;
  const logicDifficulty = options.logicDifficulty ?? "beginner";
  const logicLevels = { beginner: 1, intermediate: 2, advanced: 3, expert: 4 };
  if (!logicLevels[logicDifficulty]) throw new RangeError("Unknown logic difficulty.");
  const meetsLogic = (board) => { const analysis = analyzeSolvability(board, firstIndex); return analysis.solvable && analysis.logicLevel <= logicLevels[logicDifficulty]; };
  if (typeof rng !== "function") throw new TypeError("The RNG must be a function.");
  if (!isIntegerInRange(maximumAttempts, 1, 1_000_000)) {
    throw new RangeError("Generation attempt limit is invalid.");
  }

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    if (typeof onProgress === "function") onProgress(attempt);
    const candidate = attempt % 64 === 0
      ? createPackedCandidate(settings, firstIndex, Math.floor(attempt / 64) - 1)
      : createCandidateBoard(settings, firstIndex, rng);
    if (meetsLogic(candidate)) return candidate;

    if (attempt >= repairAfter) {
      const repaired = repairCandidate(candidate, firstIndex);
      if (repaired && meetsLogic(repaired)) return repaired;
    }
  }

  throw new GenerationError(
    `Could not create a ${logicDifficulty} logic board after ${maximumAttempts} attempts.`,
  );
}

function assertBoard(board) {
  if (!board || typeof board !== "object") throw new TypeError("A board is required.");
  validateSettings({ columns: board.columns, rows: board.rows, mines: board.mineCount });
  if (!Array.isArray(board.cells) || board.cells.length !== board.columns * board.rows) {
    throw new TypeError("Board cells do not match its dimensions.");
  }
  const mineCount = board.cells.reduce((count, cell) => count + (cell?.mine === true ? 1 : 0), 0);
  if (mineCount !== board.mineCount) throw new TypeError("Board mine count is inconsistent.");
}

export function installGeneratedBoard(game, board) {
  if (game.generated || game.phase !== GAME_PHASE.READY) {
    throw new Error("A generated board can only be installed into a ready game.");
  }
  assertBoard(board);
  if (
    board.columns !== game.columns ||
    board.rows !== game.rows ||
    board.mineCount !== game.mineCount
  ) {
    throw new RangeError("Generated board settings do not match the game.");
  }

  return {
    ...game,
    generated: true,
    phase: GAME_PHASE.PLAYING,
    cells: board.cells.map((cell, index) => ({
      mine: cell.mine,
      adjacent: cell.adjacent,
      state: game.cells[index].state === CELL_STATE.FLAGGED
        ? CELL_STATE.FLAGGED
        : CELL_STATE.HIDDEN,
    })),
  };
}

export function flagCount(game) {
  return game.cells.reduce(
    (count, cell) => count + (cell.state === CELL_STATE.FLAGGED ? 1 : 0),
    0,
  );
}

export function remainingFlags(game) {
  return game.mineCount - flagCount(game);
}

export function correctFlagCount(game) {
  return game.cells.reduce(
    (count, cell) => count + (cell.mine && cell.state === CELL_STATE.FLAGGED ? 1 : 0),
    0,
  );
}

function unchanged(game, reason = "noop") {
  return { game, changed: false, revealedCount: 0, flagDelta: 0, reason };
}

export function toggleFlag(game, index) {
  validateIndex(index, game.cells.length);
  if (game.phase === GAME_PHASE.WON || game.phase === GAME_PHASE.LOST) {
    return unchanged(game, "finished");
  }
  const cell = game.cells[index];
  if (cell.state === CELL_STATE.REVEALED) return unchanged(game, "revealed");

  const next = cloneGame(game);
  if (cell.state === CELL_STATE.FLAGGED) {
    next.cells[index].state = CELL_STATE.HIDDEN;
    return { game: next, changed: true, revealedCount: 0, flagDelta: -1, reason: "unflagged" };
  }
  if (remainingFlags(game) === 0) return unchanged(game, "flag-limit");
  next.cells[index].state = CELL_STATE.FLAGGED;
  return { game: next, changed: true, revealedCount: 0, flagDelta: 1, reason: "flagged" };
}

function revealSafeRegion(game, startIndex) {
  const pending = [startIndex];
  let revealedCount = 0;
  while (pending.length > 0) {
    const index = pending.pop();
    const cell = game.cells[index];
    if (cell.state !== CELL_STATE.HIDDEN || cell.mine) continue;
    cell.state = CELL_STATE.REVEALED;
    revealedCount += 1;
    if (cell.adjacent === 0) {
      pending.push(...neighborsOf(index, game.columns, game.rows));
    }
  }
  return revealedCount;
}

function finishIfWon(game) {
  const revealedSafe = game.cells.reduce(
    (count, cell) => count + (!cell.mine && cell.state === CELL_STATE.REVEALED ? 1 : 0),
    0,
  );
  if (revealedSafe !== game.cells.length - game.mineCount) return false;
  game.phase = GAME_PHASE.WON;
  game.cells.forEach((cell) => {
    if (cell.mine) cell.state = CELL_STATE.FLAGGED;
  });
  return true;
}

export function chordCell(game, index) {
  validateIndex(index, game.cells.length);
  if (!game.generated || game.phase !== GAME_PHASE.PLAYING) return unchanged(game, "unavailable");
  const source = game.cells[index];
  if (source.state !== CELL_STATE.REVEALED || source.mine || source.adjacent === 0) {
    return unchanged(game, "not-a-clue");
  }

  const neighbors = neighborsOf(index, game.columns, game.rows);
  const adjacentFlags = neighbors.reduce(
    (count, adjacent) => count + (game.cells[adjacent].state === CELL_STATE.FLAGGED ? 1 : 0),
    0,
  );
  if (adjacentFlags !== source.adjacent) return unchanged(game, "unsatisfied-clue");
  const targets = neighbors.filter((adjacent) => game.cells[adjacent].state === CELL_STATE.HIDDEN);
  if (targets.length === 0) return unchanged(game);

  const next = cloneGame(game);
  let revealedCount = 0;
  let explodedIndex = null;
  for (const target of targets) {
    if (next.cells[target].mine) {
      next.cells[target].state = CELL_STATE.REVEALED;
      if (explodedIndex === null) explodedIndex = target;
    } else {
      revealedCount += revealSafeRegion(next, target);
    }
  }
  if (explodedIndex !== null) {
    next.phase = GAME_PHASE.LOST;
    next.explodedIndex = explodedIndex;
  } else {
    finishIfWon(next);
  }
  return {
    game: next,
    changed: true,
    revealedCount,
    flagDelta: 0,
    reason: explodedIndex === null ? "chorded" : "exploded",
  };
}

export function revealCell(game, index) {
  validateIndex(index, game.cells.length);
  if (!game.generated) return { ...unchanged(game, "needs-generation"), needsGeneration: true };
  if (game.phase !== GAME_PHASE.PLAYING) return unchanged(game, "finished");
  const cell = game.cells[index];
  if (cell.state === CELL_STATE.FLAGGED) return unchanged(game, "flagged");
  if (cell.state === CELL_STATE.REVEALED) return chordCell(game, index);

  const next = cloneGame(game);
  if (cell.mine) {
    next.cells[index].state = CELL_STATE.REVEALED;
    next.explodedIndex = index;
    next.phase = GAME_PHASE.LOST;
    return {
      game: next,
      changed: true,
      revealedCount: 0,
      flagDelta: 0,
      reason: "exploded",
    };
  }

  const revealedCount = revealSafeRegion(next, index);
  finishIfWon(next);
  return {
    game: next,
    changed: revealedCount > 0,
    revealedCount,
    flagDelta: 0,
    reason: "revealed",
  };
}

export function validateFlags(game) {
  if (
    !game.generated ||
    game.phase !== GAME_PHASE.PLAYING ||
    remainingFlags(game) !== 0
  ) {
    return unchanged(game, "unavailable");
  }

  const next = cloneGame(game);
  let explodedIndex = null;
  let revealedCount = 0;
  next.cells.forEach((cell, index) => {
    if (cell.state !== CELL_STATE.HIDDEN) return;
    cell.state = CELL_STATE.REVEALED;
    if (cell.mine && explodedIndex === null) explodedIndex = index;
    if (!cell.mine) revealedCount += 1;
  });

  if (explodedIndex !== null) {
    next.phase = GAME_PHASE.LOST;
    next.explodedIndex = explodedIndex;
  } else {
    finishIfWon(next);
  }
  return {
    game: next,
    changed: true,
    revealedCount,
    flagDelta: 0,
    reason: explodedIndex === null ? "validated" : "exploded",
  };
}

function adjacencyIsValid(game, index) {
  if (game.cells[index].mine) return game.cells[index].adjacent === 0;
  const expected = neighborsOf(index, game.columns, game.rows)
    .reduce((count, adjacent) => count + (game.cells[adjacent].mine ? 1 : 0), 0);
  return game.cells[index].adjacent === expected;
}

function isValidRestorableGame(game, elapsedMs) {
  try {
    validateSettings({ columns: game.columns, rows: game.rows, mines: game.mineCount });
  } catch {
    return false;
  }
  if (!DIFFICULTIES[game.difficulty]) return false;
  if (!["beginner", "intermediate", "advanced", "expert"].includes(game.logicDifficulty || "beginner")) return false;
  if (!Number.isInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > 315_576_000_000) return false;
  if (!Array.isArray(game.cells) || game.cells.length !== game.columns * game.rows) return false;
  if (game.explodedIndex !== null) return false;
  if (game.phase === GAME_PHASE.WON || game.phase === GAME_PHASE.LOST) return false;
  if (game.generated !== (game.phase === GAME_PHASE.PLAYING)) return false;
  if (!game.generated && elapsedMs !== 0) return false;

  let mines = 0;
  let flags = 0;
  for (let index = 0; index < game.cells.length; index += 1) {
    const cell = game.cells[index];
    if (
      !cell ||
      typeof cell.mine !== "boolean" ||
      !isIntegerInRange(cell.adjacent, 0, 8) ||
      !Object.values(CELL_STATE).includes(cell.state)
    ) return false;
    if (cell.mine) mines += 1;
    if (cell.state === CELL_STATE.FLAGGED) flags += 1;
    if (!game.generated && (cell.mine || cell.adjacent !== 0 || cell.state === CELL_STATE.REVEALED)) {
      return false;
    }
  }
  if (flags > game.mineCount) return false;
  if (game.generated) {
    if (mines !== game.mineCount) return false;
    for (let index = 0; index < game.cells.length; index += 1) {
      if (!adjacencyIsValid(game, index)) return false;
      if (game.cells[index].mine && game.cells[index].state === CELL_STATE.REVEALED) return false;
    }
    const revealedSafe = game.cells.filter(
      (cell) => !cell.mine && cell.state === CELL_STATE.REVEALED,
    ).length;
    if (revealedSafe === game.cells.length - game.mineCount) return false;
  } else if (mines !== 0 || game.phase !== GAME_PHASE.READY) {
    return false;
  }
  return true;
}

export function serializeGame(game, elapsedMs = 0) {
  const roundedElapsed = Math.max(0, Math.floor(elapsedMs));
  if (!isValidRestorableGame(game, roundedElapsed)) {
    throw new TypeError("Only a valid unfinished game can be serialized.");
  }
  return JSON.stringify({
    version: SAVE_VERSION,
    elapsedMs: roundedElapsed,
    game: cloneGame(game),
  });
}

export function deserializeGame(serialized) {
  try {
    if (typeof serialized !== "string") return null;
    const value = JSON.parse(serialized);
    if (
      !value ||
      value.version !== SAVE_VERSION ||
      !value.game ||
      !isValidRestorableGame(value.game, value.elapsedMs)
    ) {
      return null;
    }
    return { game: cloneGame(value.game), elapsedMs: value.elapsedMs };
  } catch {
    return null;
  }
}
