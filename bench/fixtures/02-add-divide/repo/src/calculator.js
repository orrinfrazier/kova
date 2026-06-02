// Seed: has add/subtract/multiply but no divide. Fix should add divide(a, b)
// that throws on b === 0.

const add = (a, b) => a + b;
const subtract = (a, b) => a - b;
const multiply = (a, b) => a * b;

module.exports = { add, subtract, multiply };
