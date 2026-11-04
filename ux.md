# Bugsweeper UX

## The experience

Bugsweeper is a full-screen, deliberately spare Minesweeper variant. The board is the product: there is no title screen, tutorial, score table, or ornamental frame competing with it. A narrow toolbar sits at the bottom, while the largest board that comfortably fits the current viewport is centered in the remaining space.

The theme is light rather than elaborate. Mines are bugs, but the familiar flags and numbered clues remain. The result should feel immediately legible to someone who knows Minesweeper without requiring much explanation.

The fork makes one important promise beyond classic Minesweeper: a game never requires a guess. The first reveal is safe, normally opens a zero-valued area, and becomes the starting point for a board that the built-in solver has verified can be completed through deduction. This removes arbitrary losses without turning the solver into a visible hint system; the reasoning is still left to the player.

## Starting and resuming a game

On first load, the game creates an empty, hidden grid sized from the viewport. **Hard** is the default difficulty. The timer reads `-:--` because the game has not started yet.

The actual bugs are placed only after the first reveal. This serves three purposes:

- the chosen cell is guaranteed safe;
- its neighbours are also kept safe when the board has enough room, producing a useful opening rather than a single isolated clue;
- the generator can reject boards that its solver cannot finish without guessing.

Generation happens in the background. Fast generation is invisible; after 300 ms, a translucent blocking overlay appears with a spinner and a live “Testing board N…” message. The delay avoids flashing a progress indicator for ordinary fast starts. Generation time is not charged to the player: the clock begins at zero only when the verified board is ready and the initiating cell has been revealed. If generation fails, a short error message is shown and the unopened board can be tried again.

A player may mark cells before the first reveal. Those marks survive board generation, even though they may prove incorrect.

An unfinished game is stored locally and restored on a later visit, including difficulty, board state, and elapsed time. The clock resumes for a game already in progress. Finished or failed games are not resumed; returning starts fresh.

## The play loop

A hidden cell has two actions:

- tap or left-click to reveal it;
- long-press or right-click to toggle a flag.

The browser context menu is suppressed over the board. On touch devices, marking relies on the browser's long-press/context-menu gesture rather than a persistent “flag mode.” This keeps every ordinary tap devoted to revealing and avoids a mode error where the player forgets what a tap will do. The tradeoff is discoverability: the footer's flag count and board accessibility label explain the gesture, but there is no visible tutorial or dedicated marking button.

Flags are limited to the number of bugs. A flagged cell cannot be revealed until it is unflagged. The remaining-flag counter updates after each mark.

Revealing an empty cell automatically clears the connected empty area and its numbered boundary. Revealing an already-open numbered cell performs the familiar chord action: when its adjacent flag count equals its number, all other adjacent cells are opened. Either mouse button has this same meaning on an open cell because there is nothing left to mark there. Incorrect flags can therefore make a chord expose a bug, preserving the risk and speed of classic Minesweeper.

The game is won as soon as every safe cell is open. The remaining bugs are then flagged automatically, so the player is not asked to perform bookkeeping after the puzzle has already been logically solved.

When the player has used every available flag, the flag counter is replaced by a smile button. It is an explicit “check my board” action: all unflagged hidden cells are revealed. If every flag is correct this wins the game; if a bug was left unflagged it loses. This offers a quick finish for a player confident in their marking, at the cost of making the smile icon's purpose somewhat implicit.

## Difficulty

Difficulty changes bug density, not the physical size of the grid:

| Mode | Bug density |
| --- | ---: |
| Easy | 14% |
| Medium | 17% |
| Hard | 20% |
| Insane | 25% |

The menu opens upward from the footer, shows the percentages, and highlights the current choice in green. It closes after a selection, an outside click, or Escape. Choosing a different difficulty immediately abandons the current game and creates another board of the same viewport-derived dimensions, without confirmation. Choosing the already active difficulty does nothing.

This is a compact way to offer meaningful variation: lower densities create broader openings and simpler deductions, while higher densities create tighter, more information-dense fronts. Because every generated board still carries the no-guess guarantee, “Insane” means harder deduction rather than worse luck.

## Time, sound, and feedback

The timer is intentionally simple: it displays minutes and seconds, starts after the first board has been generated, and stops when the game ends.

On desktop, sound starts enabled and can be toggled from the footer. Reveals, flags, unflags, wins, and losses have distinct short cues. The current implementation hides sound entirely on mobile, favouring a quiet, reliable mobile session over audio that may be blocked or intrusive. The sound preference is not persisted.

Visual feedback is restrained during play. Hidden cells are pale grey; revealed cells are white with a light dashed edge. Clue values use the conventional escalating Minesweeper palette. The condensed Economica typeface and Font Awesome symbols give the game its slightly playful, utilitarian character.

At the end, the board itself explains the result:

- on a win, correct flags turn green and pulse, and the footer gains a green top edge;
- on a loss, the exploded bug is red and pulsing, missed bugs are exposed, correct flags are outlined in green, and incorrect flags pulse red;
- clue colours are muted after either outcome so the bug/flag diagnosis dominates;
- a loss replaces elapsed time with the percentage of bugs that were correctly flagged, giving limited partial credit;
- board input, validation, and sound controls disappear, while a restart button takes their place.

There is no mid-game restart button. A normal restart is offered after the outcome; changing difficulty is the available escape hatch during play. This reduces accidental resets but makes abandoning a game less explicit.

## Layout and resizing

The application occupies the viewport and does not scroll. A 50 px footer is fixed to the bottom; the board is centered in the space above it. Grid dimensions are calculated when a new game begins, using roughly 45 px cells on desktop and 44 px cells when either viewport dimension is below 500 px. Mobile cells are therefore kept near the recommended touch-target size rather than shrinking the entire desktop board to fit.

The consequence of maximizing the grid is that rotation or a substantial resize cannot merely reflow the same board. A width or height change greater than 50 px pauses the timer and asks whether to reload the game. Confirming starts a new board sized for the new viewport; dismissing preserves the existing board. Small viewport fluctuations are ignored, which avoids needless interruptions from browser chrome appearing and disappearing.


## Keyboard controls

- **N** starts a fresh board at the current difficulty.
- **R** replays the current generated board with the same bug locations and a reset timer.
- **P** pauses or resumes an active board. Pause freezes elapsed time and blocks board actions.
- **?** opens the keyboard shortcut reference; **Escape** closes it.

Shortcuts are ignored while typing in form controls.