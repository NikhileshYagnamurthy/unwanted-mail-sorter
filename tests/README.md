# InboxAI classification tests

Run from the repo root (Node 18+, no dependencies):

```
node tests/run_tests.mjs --set all --verbose     # every case, with reasons for failures
node tests/run_tests.mjs --set stress            # adversarial set
node tests/run_tests.mjs --scorer tests/baseline/scorer_v2_original.mjs   # the OLD scorer
node tests/compare.mjs                           # before/after table (RESULTS.md)
node tests/explain.mjs --from '...' --subject '...' --snippet '...' [--list-unsub] [--bulk]
```

`explain.mjs` is the tool to use on **your real misclassified emails**: paste the
sender, subject and the first line of the body, and it prints every score that decided the result.

## What the numbers do and do not mean

- All emails are **synthetic**. Subjects tagged `[real]` come from `classified_emails.json`,
  but their senders/snippets are reconstructed (that file stored subjects only).
- Expected labels are one author's judgement. `accept` lists other defensible answers;
  we report **exact** and **acceptable** accuracy separately.
- **DEV** was used while designing the scorer: its numbers are optimistic.
- **HOLDOUT** was written before the baseline run, but the author also designed the
  rules while mentally walking through several of its cases, so it is **contaminated** and
  its 98% is not a generalisation estimate.
- **STRESS** was written afterwards, specifically to break the scorer (unknown brands,
  empty snippets, scary-but-legitimate mail, phishing without obvious tells).
  First pass, before any fix: **62.7% exact / 94.1% acceptable** (old scorer: 41.2% / 56.9%).
  Three targeted fixes were then made (stem bug in the lookalike-domain check, parcel-carrier
  brands + delivery-fee wording, Indian bank transaction-alert phrasing) giving 68.6% / 98.0%.
  After those fixes STRESS is no longer independent.
- The only trustworthy estimate is **your real inbox**. Export ~100 real emails
  (sender, subject, snippet, headers) with your own labels and add them as a new set.

## Metrics beyond accuracy (chosen because this extension auto-archives)

- **Harmful archives**: mail that should stay in the inbox but was auto-archived.
- **Phishing recall / false positives**: false positives are costly because phishing is archived.
- **Confident errors**: wrong answers with confidence >= 80%.
