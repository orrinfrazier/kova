// Buggy seed: returns input unchanged. The fix should trim whitespace
// and throw on empty input. See test.js for acceptance criteria.

function handle(input) {
  return input;
}

module.exports = { handle };
