// Acceptance test. Passes (exit 0) only when both behaviours are correct.
const { handle } = require('./src/handler.js');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

// 1: empty input should throw
let threw = false;
try {
  handle('');
} catch (err) {
  threw = err instanceof Error && /empty/i.test(err.message);
}
assert(threw, "handle('') should throw an Error whose message contains 'empty'");

// 2: whitespace should be trimmed
const trimmed = handle('  hello  ');
assert(trimmed === 'hello', `handle('  hello  ') should return 'hello', got ${JSON.stringify(trimmed)}`);

console.log('PASS');
