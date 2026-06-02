// Buggy seed: off-by-one in lastN. Should return the last n elements
// but currently returns n-1.

function lastN(arr, n) {
  return arr.slice(arr.length - n + 1);
}

module.exports = { lastN };
