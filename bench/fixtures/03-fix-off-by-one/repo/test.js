const { lastN } = require('./src/array-utils.js');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

function eq(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

assert(eq(lastN([1, 2, 3, 4, 5], 3), [3, 4, 5]), 'lastN([1..5], 3) should be [3,4,5]');
assert(eq(lastN([1, 2, 3], 0), []), 'lastN([1,2,3], 0) should be []');
assert(eq(lastN([1, 2, 3], 10), [1, 2, 3]), 'lastN([1,2,3], 10) should be [1,2,3]');
assert(eq(lastN([], 3), []), 'lastN([], 3) should be []');
assert(eq(lastN([1, 2, 3, 4, 5], 1), [5]), 'lastN([1..5], 1) should be [5]');
assert(eq(lastN([1, 2, 3, 4, 5], 5), [1, 2, 3, 4, 5]), 'lastN([1..5], 5) should be [1..5]');

console.log('PASS');
