# Vibesweeper

A full-screen Minesweeper variant whose boards are verified to be solvable without guessing.

Fork of Ronilan's [Bugsweeper](https://ronilan.com/bugsweeper/).

## Structure

- `js/bugsweeper.js` — pure game model, immutable game operations, board generation, solver, and versioned serialization.
- `js/bugsweeper.test.js` — standalone Node tests for the model and solver.
- `js/worker.js` — module worker that generates and verifies boards away from the UI thread.
- `js/index.js` — Alpine component and browser-only concerns such as storage, timing, sound, input, resize handling, and worker lifecycle.
- `js/alpine.min.js` — the local Alpine.js distribution.
- `index.html` and `css/bugsweeper.css` — declarative application markup and presentation.

There are no runtime package dependencies and no build step. Serve the repository over HTTP to run the browser application.

## Tests

Run the complete model and solver suite with:

```sh
node js/bugsweeper.test.js
```

The same command is available as `npm test`.
