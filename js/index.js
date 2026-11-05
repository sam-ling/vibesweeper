import "./alpine.min.js";
import { APP_VERSION } from "./version.js";
import {
  CELL_STATE,
  DIFFICULTIES,
  GAME_PHASE,
  calculateBoardSettings,
  correctFlagCount,
  createGame,
  cloneGame,
  deserializeGame,
  installGeneratedBoard,
  remainingFlags,
  revealCell,
  serializeGame,
  toggleFlag,
  validateFlags,
} from "./bugsweeper.js";

const STORAGE_KEY = "bugsweeper:game:v2";
const SOUND_STORAGE_KEY = "vibesweeper:sound:v1";
const BOARD_SIZE_STORAGE_KEY = "vibesweeper:size:v1";
const FOOTER_HEIGHT = 112;
const RESIZE_THRESHOLD = 50;
const LONG_PRESS_MS = 550;
const MOVE_TOLERANCE = 12;

const SOUND_PATHS = Object.freeze({
  flag: "./sounds/cell_flag.mp3",
  unflag: "./sounds/cell_unflag.mp3",
  reveal: "./sounds/cell_clear.mp3",
  won: "./sounds/game_applause.mp3",
  lost: "./sounds/game_error.mp3",
});

function viewportSettings(difficulty, boardSize = "L") {
  return calculateBoardSettings(
    window.innerWidth,
    Math.max(1, window.innerHeight - FOOTER_HEIGHT),
    difficulty,
    boardSize,
  );
}

function preferredCellSize() {
  return window.innerWidth < 500 || window.innerHeight - FOOTER_HEIGHT < 500
    ? 44
    : 45;
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function canPlaySound() {
  return !window.matchMedia("(pointer: coarse)").matches;
}

document.addEventListener("alpine:init", () => {
  window.Alpine.data("bugsweeper", () => ({
    appVersion: APP_VERSION,
    game: createGame(viewportSettings("hard")),
    density: "hard",
    logicDifficulty: "beginner",
    boardSize: "L",
    difficultyMenuOpen: false,
    paused: false,
    shortcutsOpen: false,
    lastBoard: null,
    firstRevealIndex: null,
    keyboardHandler: null,
    generating: false,
    generationAttempts: 0,
    generationMessage: "Generating a solvable board…",
    generationError: false,
    overlayVisible: false,
    resizePromptOpen: false,
    resizeWasRunning: false,
    soundAvailable: false,
    soundOn: false,
    elapsedMs: 0,
    undoHistory: [],
    undosRemaining: 3,
    cellSize: preferredCellSize(),
    outcomeAnnouncement: "",
    worker: null,
    requestId: 0,
    overlayTimer: null,
    errorTimer: null,
    timerHandle: null,
    timerStartedAt: 0,
    lastSavedSecond: -1,
    baselineWidth: window.innerWidth,
    baselineHeight: window.innerHeight - FOOTER_HEIGHT,
    longPress: null,
    suppressClickIndex: null,
    suppressClickUntil: 0,
    recentLongPressIndex: null,
    recentLongPressUntil: 0,
    audio: new Map(),
    beforeUnloadHandler: null,

    get densityOptions() {
      return Object.entries(DIFFICULTIES).map(([value, details]) => ({
        value,
        label: details.label,
        percentage: `${Math.round(details.density * 100)}%`,
      }));
    },

    get isActive() {
      return this.game.phase === GAME_PHASE.READY || this.game.phase === GAME_PHASE.PLAYING;
    },

    get isFinished() {
      return this.game.phase === GAME_PHASE.WON || this.game.phase === GAME_PHASE.LOST;
    },

    get flagsRemaining() {
      return remainingFlags(this.game);
    },

    get densityLabel() { return DIFFICULTIES[this.density].label; },
    get logicLabel() { return ({ beginner: "Beginner", intermediate: "Intermediate", advanced: "Advanced", expert: "Expert" })[this.logicDifficulty]; },

    get timerLabel() {
      if (this.game.phase === GAME_PHASE.READY) return "0:00";
      if (this.game.phase === GAME_PHASE.LOST) {
        return `${Math.floor((correctFlagCount(this.game) / this.game.mineCount) * 100)}%`;
      }
      return formatElapsed(this.elapsedMs);
    },

    init() {
      this.soundAvailable = canPlaySound();
      try {
        this.soundOn = this.soundAvailable && window.localStorage.getItem(SOUND_STORAGE_KEY) === "on";
        this.boardSize = window.localStorage.getItem(BOARD_SIZE_STORAGE_KEY) || "L";
      } catch {
        this.soundOn = false;
        this.boardSize = "L";
      }
      if (this.soundAvailable) {
        Object.entries(SOUND_PATHS).forEach(([name, path]) => {
          const audio = new Audio(path);
          audio.preload = "auto";
          this.audio.set(name, audio);
        });
      }

      const restored = this.restoreSavedGame();
      if (!restored) this.startFreshGame("hard");
      else if (this.game.phase === GAME_PHASE.PLAYING) this.startTimer();

      this.keyboardHandler = (event) => this.handleKeyboard(event);
      window.addEventListener("keydown", this.keyboardHandler);
      this.beforeUnloadHandler = () => this.persistGame();
      window.addEventListener("beforeunload", this.beforeUnloadHandler);
    },

    destroy() {
      this.cancelGeneration();
      this.pauseTimer();
      if (this.keyboardHandler) window.removeEventListener("keydown", this.keyboardHandler);
      if (this.beforeUnloadHandler) {
        window.removeEventListener("beforeunload", this.beforeUnloadHandler);
      }
    },

    restoreSavedGame() {
      let serialized = null;
      try {
        serialized = window.localStorage.getItem(STORAGE_KEY);
      } catch {
        return false;
      }
      if (!serialized) return false;

      const restored = deserializeGame(serialized);
      if (!restored) {
        this.discardSavedGame();
        return false;
      }
      this.game = restored.game;
      this.density = restored.game.difficulty;
      this.logicDifficulty = restored.game.logicDifficulty || "beginner";
      this.elapsedMs = restored.elapsedMs;
      this.cellSize = preferredCellSize();
      this.baselineWidth = window.innerWidth;
      this.baselineHeight = window.innerHeight - FOOTER_HEIGHT;
      return true;
    },

    persistGame() {
      if (this.isFinished) {
        this.discardSavedGame();
        return;
      }
      if (this.timerHandle !== null) {
        this.elapsedMs = Math.max(0, Date.now() - this.timerStartedAt);
      }
      try {
        window.localStorage.setItem(STORAGE_KEY, serializeGame(this.game, this.elapsedMs));
      } catch {
        // Storage can be unavailable or full; gameplay must remain functional.
      }
    },

    discardSavedGame() {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        // Ignore unavailable storage.
      }
    },

    startFreshGame(density = this.density) {
      this.cancelGeneration();
      this.pauseTimer();
      this.paused = false;
      this.lastBoard = null;
      this.firstRevealIndex = null;
      this.undoHistory = [];
      this.undosRemaining = 3;
      this.density = density;
      this.game = createGame(viewportSettings(density, this.boardSize));
      this.game.logicDifficulty = this.logicDifficulty;
      this.elapsedMs = 0;
      this.lastSavedSecond = -1;
      this.cellSize = preferredCellSize();
      this.outcomeAnnouncement = "";
      this.resizePromptOpen = false;
      this.difficultyMenuOpen = false;
      this.baselineWidth = window.innerWidth;
      this.baselineHeight = window.innerHeight - FOOTER_HEIGHT;
      this.persistGame();
    },

    chooseBoardSize(value) {
      if (!["S", "M", "L", "XL", "XXL"].includes(value) || value === this.boardSize) return;
      this.boardSize = value;
      try { window.localStorage.setItem(BOARD_SIZE_STORAGE_KEY, value); } catch {}
      this.startFreshGame(this.density);
    },

    chooseDensity(value) {
      this.difficultyMenuOpen = false;
      if (!DIFFICULTIES[value] || value === this.density) return;
      this.startFreshGame(value);
    },
    chooseLogic(value) {
      if (!["beginner","intermediate","advanced","expert"].includes(value)) return;
      this.logicDifficulty = value;
      this.startFreshGame(this.density);
    },

    restart() {
      if (this.lastBoard && this.firstRevealIndex !== null) {
        this.cancelGeneration();
        this.pauseTimer();
        const ready = createGame({
          columns: this.lastBoard.columns,
          rows: this.lastBoard.rows,
          mines: this.lastBoard.mineCount,
          difficulty: this.density,
        });
        const generated = installGeneratedBoard(ready, this.lastBoard);
        this.game = revealCell(generated, this.firstRevealIndex).game;
        this.undoHistory = [];
        this.undosRemaining = 3;
        this.elapsedMs = 0;
        this.paused = false;
        this.outcomeAnnouncement = "";
        this.startTimer();
        this.persistGame();
      } else {
        this.startFreshGame(this.density);
      }
    },

    undo() {
      if (this.undosRemaining <= 0 || this.undoHistory.length === 0 || this.generating || this.resizePromptOpen || (this.isFinished && this.game.phase !== GAME_PHASE.LOST)) return;
      const wasPaused = this.paused;
      this.pauseTimer();
      const snapshot = this.undoHistory.pop();
      this.game = snapshot.game;
      this.elapsedMs = snapshot.elapsedMs;
      this.outcomeAnnouncement = "";
      this.undosRemaining -= 1;
      this.paused = wasPaused;
      if (!this.paused && this.game.phase === GAME_PHASE.PLAYING) this.startTimer();
      this.persistGame();
    },

    togglePause() {
      if (this.generating || this.resizePromptOpen || this.isFinished) return;
      this.paused = !this.paused;
      if (this.paused) this.pauseTimer();
      else this.startTimer();
      this.persistGame();
    },

    handleKeyboard(event) {
      const target = event.target;
      if (target?.matches?.("input, textarea, select, [contenteditable=true]")) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "escape") {
        this.shortcutsOpen = false;
        return;
      }
      if (key === "?" || (event.shiftKey && event.key === "/")) {
        event.preventDefault();
        this.shortcutsOpen = !this.shortcutsOpen;
      } else if (!event.shiftKey && key === "n") {
        event.preventDefault();
        this.startFreshGame(this.density);
      } else if (!event.shiftKey && key === "r") {
        event.preventDefault();
        this.restart();
      } else if (!event.shiftKey && key === "u") {
        event.preventDefault();
        this.undo();
      } else if (!event.shiftKey && key === "p") {
        event.preventDefault();
        this.togglePause();
      }
    },

    startTimer() {
      this.pauseTimer();
      if (this.paused || this.game.phase !== GAME_PHASE.PLAYING || this.generating) return;
      this.timerStartedAt = Date.now() - this.elapsedMs;
      this.timerHandle = window.setInterval(() => {
        this.elapsedMs = Math.max(0, Date.now() - this.timerStartedAt);
        const elapsedSecond = Math.floor(this.elapsedMs / 1000);
        if (elapsedSecond > 0 && elapsedSecond % 5 === 0 && elapsedSecond !== this.lastSavedSecond) {
          this.lastSavedSecond = elapsedSecond;
          this.persistGame();
        }
      }, 250);
    },

    pauseTimer() {
      if (this.timerHandle !== null) {
        this.elapsedMs = Math.max(0, Date.now() - this.timerStartedAt);
        window.clearInterval(this.timerHandle);
        this.timerHandle = null;
      }
    },

    playSound(name) {
      if (!this.soundAvailable || !this.soundOn || !this.audio.has(name)) return;
      const audio = this.audio.get(name);
      try {
        audio.currentTime = 0;
        const playback = audio.play();
        if (playback?.catch) playback.catch(() => {});
      } catch {
        // Browser media policies can reject playback without affecting play.
      }
    },

    toggleSound() {
      this.soundOn = !this.soundOn;
      try { window.localStorage.setItem(SOUND_STORAGE_KEY, this.soundOn ? "on" : "off"); } catch {}
    },

    applyAction(result) {
      if (!result.changed) return;
      const previousPhase = this.game.phase;
      this.undoHistory.push({ game: cloneGame(this.game), elapsedMs: this.elapsedMs });
      if (this.undoHistory.length > 3) this.undoHistory.shift();
      this.game = result.game;

      if (this.game.phase !== previousPhase && this.isFinished) {
        this.pauseTimer();
        this.discardSavedGame();
        if (this.game.phase === GAME_PHASE.WON) {
          this.outcomeAnnouncement = `Board cleared in ${formatElapsed(this.elapsedMs)}.`;
          this.playSound("won");
        } else {
          this.outcomeAnnouncement = `Bug found. ${this.timerLabel} of bugs were correctly marked.`;
          this.playSound("lost");
        }
        return;
      }

      if (result.flagDelta > 0) this.playSound("flag");
      else if (result.flagDelta < 0) this.playSound("unflag");
      else if (result.revealedCount > 0) this.playSound("reveal");
      this.persistGame();
    },

    handleReveal(index) {
      if (this.paused || this.generating || this.resizePromptOpen || this.isFinished) return;
      if (this.suppressClickIndex === index && Date.now() <= this.suppressClickUntil) {
        this.suppressClickIndex = null;
        this.suppressClickUntil = 0;
        return;
      }

      const cell = this.game.cells[index];
      if (!this.game.generated) {
        if (cell.state === CELL_STATE.HIDDEN) this.beginGeneration(index);
        return;
      }
      this.applyAction(revealCell(this.game, index));
    },

    handleMark(index) {
      if (this.paused || this.generating || this.resizePromptOpen || this.isFinished) return;
      if (this.game.cells[index].state === CELL_STATE.REVEALED) {
        this.applyAction(revealCell(this.game, index));
      } else {
        this.applyAction(toggleFlag(this.game, index));
      }
    },

    handleContextMenu(index) {
      if (
        this.recentLongPressIndex === index &&
        Date.now() <= this.recentLongPressUntil
      ) return;
      this.cancelLongPress();
      this.suppressClickIndex = index;
      this.suppressClickUntil = Date.now() + 900;
      this.handleMark(index);
    },

    validateBoard() {
      if (this.paused || this.generating || this.resizePromptOpen) return;
      this.applyAction(validateFlags(this.game));
    },

    pointerDown(event, index) {
      if (
        event.pointerType === "mouse" ||
        event.button !== 0 ||
        !event.isPrimary ||
        this.paused ||
        this.generating ||
        this.isFinished
      ) return;
      this.cancelLongPress();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is an enhancement, not a requirement.
      }
      const press = {
        pointerId: event.pointerId,
        index,
        startX: event.clientX,
        startY: event.clientY,
        triggered: false,
        timer: null,
      };
      press.timer = window.setTimeout(() => {
        if (
          !this.longPress ||
          this.longPress.pointerId !== press.pointerId ||
          this.longPress.index !== press.index
        ) return;
        this.longPress.triggered = true;
        this.suppressClickIndex = index;
        this.suppressClickUntil = Date.now() + 1_000;
        this.recentLongPressIndex = index;
        this.recentLongPressUntil = Date.now() + 1_000;
        this.handleMark(index);
      }, LONG_PRESS_MS);
      this.longPress = press;
    },

    pointerMove(event) {
      const press = this.longPress;
      if (!press || press.pointerId !== event.pointerId || press.triggered) return;
      if (
        Math.abs(event.clientX - press.startX) > MOVE_TOLERANCE ||
        Math.abs(event.clientY - press.startY) > MOVE_TOLERANCE
      ) {
        this.cancelLongPress();
      }
    },

    pointerEnd(event) {
      if (!this.longPress || this.longPress.pointerId !== event.pointerId) return;
      const triggered = this.longPress.triggered;
      window.clearTimeout(this.longPress.timer);
      this.longPress = null;
      if (triggered) {
        window.setTimeout(() => {
          if (Date.now() > this.suppressClickUntil) this.suppressClickIndex = null;
        }, 1_050);
      }
    },

    cancelLongPress() {
      if (this.longPress?.timer) window.clearTimeout(this.longPress.timer);
      this.longPress = null;
    },

    beginGeneration(firstIndex) {
      this.cancelGeneration();
      if (typeof Worker === "undefined") {
        this.showGenerationError("This browser cannot generate boards in the background.");
        return;
      }

      const requestId = ++this.requestId;
      this.generating = true;
      this.generationAttempts = 0;
      this.generationError = false;
      this.generationMessage = "Generating a solvable board…";
      this.overlayVisible = false;
      this.overlayTimer = window.setTimeout(() => {
        if (this.generating && requestId === this.requestId) this.overlayVisible = true;
      }, 300);

      try {
        const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
        this.worker = worker;
        worker.addEventListener("message", (event) => {
          const message = event.data;
          if (!message || message.requestId !== requestId || requestId !== this.requestId) return;
          if (message.type === "progress") {
            this.generationAttempts = message.attempts;
            this.generationMessage = `Testing board ${message.attempts}…`;
          } else if (message.type === "complete") {
            this.completeGeneration(message.board, firstIndex, requestId);
          } else if (message.type === "error") {
            this.failGeneration(message.error?.message, requestId);
          }
        });
        worker.addEventListener("error", (event) => {
          event.preventDefault();
          this.failGeneration(event.message || "The board worker stopped unexpectedly.", requestId);
        });
        worker.postMessage({
          type: "generate",
          requestId,
          settings: {
            logicDifficulty: this.logicDifficulty,
            columns: this.game.columns,
            rows: this.game.rows,
            mines: this.game.mineCount,
            difficulty: this.game.difficulty,
            logicDifficulty: this.logicDifficulty,
          },
          firstIndex,
        });
      } catch (error) {
        this.failGeneration(error instanceof Error ? error.message : null, requestId);
      }
    },

    completeGeneration(board, firstIndex, requestId) {
      if (requestId !== this.requestId) return;
      this.finishWorker();
      try {
        this.lastBoard = { ...board, cells: board.cells.map((cell) => ({ mine: cell.mine, adjacent: cell.adjacent })) };
        this.undoHistory = [];
        this.undosRemaining = 3;
        this.firstRevealIndex = firstIndex;
        this.game = installGeneratedBoard(this.game, board);
        this.elapsedMs = 0;
        const result = revealCell(this.game, firstIndex);
        this.game = result.game;
        this.generating = false;
        this.hideGenerationOverlay();

        if (this.game.phase === GAME_PHASE.WON) {
          this.outcomeAnnouncement = "Board cleared in 0:00.";
          this.playSound("won");
          this.discardSavedGame();
        } else {
          if (result.revealedCount > 0) this.playSound("reveal");
          if (this.resizePromptOpen) {
            // Generation is not timed, and a resize prompt must continue to
            // hold the clock even if the worker finishes behind it.
            this.resizeWasRunning = true;
          } else {
            this.startTimer();
          }
          this.persistGame();
        }
      } catch (error) {
        this.failGeneration(error instanceof Error ? error.message : null, requestId);
      }
    },

    failGeneration(message, requestId) {
      if (requestId !== this.requestId) return;
      this.finishWorker();
      this.generating = false;
      this.showGenerationError(message || "The board could not be generated. Please try again.");
    },

    showGenerationError(message) {
      if (this.overlayTimer !== null) window.clearTimeout(this.overlayTimer);
      if (this.errorTimer !== null) window.clearTimeout(this.errorTimer);
      this.generationError = true;
      this.generationMessage = message;
      this.overlayVisible = true;
      this.errorTimer = window.setTimeout(() => {
        this.overlayVisible = false;
        this.generationError = false;
      }, 2_800);
    },

    hideGenerationOverlay() {
      if (this.overlayTimer !== null) window.clearTimeout(this.overlayTimer);
      if (this.errorTimer !== null) window.clearTimeout(this.errorTimer);
      this.overlayTimer = null;
      this.errorTimer = null;
      this.overlayVisible = false;
      this.generationError = false;
    },

    finishWorker() {
      if (this.worker) this.worker.terminate();
      this.worker = null;
    },

    cancelGeneration() {
      this.requestId += 1;
      this.finishWorker();
      this.generating = false;
      this.hideGenerationOverlay();
    },

    handleResize() {
      const width = window.innerWidth;
      const height = window.innerHeight - FOOTER_HEIGHT;
      if (
        this.resizePromptOpen ||
        (Math.abs(width - this.baselineWidth) <= RESIZE_THRESHOLD &&
          Math.abs(height - this.baselineHeight) <= RESIZE_THRESHOLD)
      ) return;

      this.resizeWasRunning = this.timerHandle !== null;
      this.pauseTimer();
      this.resizePromptOpen = true;
      this.difficultyMenuOpen = false;
      this.$nextTick(() => this.$refs.resizeReload?.focus());
    },

    dismissResizePrompt() {
      this.resizePromptOpen = false;
      this.baselineWidth = window.innerWidth;
      this.baselineHeight = window.innerHeight - FOOTER_HEIGHT;
      if (this.resizeWasRunning && this.game.phase === GAME_PHASE.PLAYING) this.startTimer();
      this.resizeWasRunning = false;
    },

    acceptResizePrompt() {
      this.resizePromptOpen = false;
      this.resizeWasRunning = false;
      this.startFreshGame(this.difficulty);
    },

    focusCell(index, columnDelta, rowDelta) {
      const row = Math.floor(index / this.game.columns);
      const column = index % this.game.columns;
      const nextColumn = Math.max(0, Math.min(this.game.columns - 1, column + columnDelta));
      const nextRow = Math.max(0, Math.min(this.game.rows - 1, row + rowDelta));
      const nextIndex = nextRow * this.game.columns + nextColumn;
      this.$refs.board?.querySelector(`[data-cell-index="${nextIndex}"]`)?.focus();
    },

    boardStyle() {
      const availableWidth = Math.max(1, window.innerWidth - 24);
      const availableHeight = Math.max(1, window.innerHeight - FOOTER_HEIGHT - 24);
      const cellSize = Math.max(10, Math.min(this.cellSize, availableWidth / this.game.columns - 2, availableHeight / this.game.rows - 2));
      return `--columns:${this.game.columns};--cell-size:${cellSize}px`;
    },

    cellClasses(cell, index) {
      const finished = this.isFinished;
      const lost = this.game.phase === GAME_PHASE.LOST;
      return {
        "cell--hidden": cell.state === CELL_STATE.HIDDEN,
        "cell--flagged": cell.state === CELL_STATE.FLAGGED,
        "cell--revealed": cell.state === CELL_STATE.REVEALED && !cell.mine,
        "cell--done": finished,
        [`clue-${cell.adjacent}`]: cell.state === CELL_STATE.REVEALED && !cell.mine && cell.adjacent > 0,
        "cell--win-flag": this.game.phase === GAME_PHASE.WON && cell.mine,
        "cell--correct-flag": lost && cell.mine && cell.state === CELL_STATE.FLAGGED,
        "cell--wrong-flag": lost && !cell.mine && cell.state === CELL_STATE.FLAGGED,
        "cell--missed-bug": lost && cell.mine && cell.state !== CELL_STATE.FLAGGED,
        "cell--exploded": lost && index === this.game.explodedIndex,
      };
    },

    showFlag(cell) {
      return cell.state === CELL_STATE.FLAGGED;
    },

    showBug(cell) {
      return cell.mine && cell.state !== CELL_STATE.FLAGGED &&
        (this.game.phase === GAME_PHASE.LOST || this.game.phase === GAME_PHASE.WON);
    },

    bugEmoji() {
      return "💣";
    },

    showClue(cell) {
      return cell.state === CELL_STATE.REVEALED && !cell.mine && cell.adjacent > 0;
    },

    cellLabel(cell, index) {
      const row = Math.floor(index / this.game.columns) + 1;
      const column = (index % this.game.columns) + 1;
      const position = `Row ${row}, column ${column}`;
      if (this.game.phase === GAME_PHASE.LOST && cell.mine) {
        return `${position}, ${index === this.game.explodedIndex ? "exploded" : "missed"} bug`;
      }
      if (cell.state === CELL_STATE.FLAGGED) return `${position}, marked`;
      if (cell.state === CELL_STATE.HIDDEN) return `${position}, hidden`;
      return cell.adjacent === 0
        ? `${position}, clear`
        : `${position}, ${cell.adjacent} adjacent ${cell.adjacent === 1 ? "bug" : "bugs"}`;
    },
  }));
});
