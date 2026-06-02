const calc = require('./src/calculator.js');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

assert(typeof calc.divide === 'function', 'divide must be exported');
assert(calc.divide(10, 2) === 5, 'divide(10, 2) should equal 5');
assert(calc.divide(-6, 3) === -2, 'divide(-6, 3) should equal -2');

let threw = false;
try {
  calc.divide(1, 0);
} catch (err) {
  threw = err instanceof Error && /divide by zero/i.test(err.message);
}
assert(threw, 'divide(1, 0) should throw with message containing "divide by zero"');

// Don't regress add/subtract/multiply
assert(calc.add(2, 3) === 5, 'add(2, 3) should equal 5');
assert(calc.subtract(10, 4) === 6, 'subtract(10, 4) should equal 6');
assert(calc.multiply(3, 4) === 12, 'multiply(3, 4) should equal 12');

console.log('PASS');
