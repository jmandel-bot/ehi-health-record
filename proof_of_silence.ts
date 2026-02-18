// This is the fundamental problem. EpicRow = Record<string, unknown>.
// Every column access is an unchecked string lookup.

type EpicRow = Record<string, unknown>;

const row: EpicRow = {
  TOBACCO_USER_C_NAME: "Never",
  ALCOHOL_USE_C_NAME: "Yes",
  ALCOHOL_COMMENT: "about 3-4 drinks per week",
};

// This works:
console.log("correct:", row.TOBACCO_USER_C_NAME);  // "Never"

// This silently returns undefined — no error, no warning, nothing:
console.log("typo:", row.SMOKING_PACKS_PER_DAY);    // undefined
console.log("typo:", row.MARITAL_STATUS_C_NAME);     // undefined
console.log("typo:", row.ADD_LINE_1);                // undefined

// The entire spike has ~200 of these string lookups.
// Any one of them could be wrong and you'd never know
// unless you manually inspect the output.
