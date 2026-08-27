# Khloei computer behavior evals

These cases run the real Khloei computer-agent instructions and tool graph against a deterministic, side-effect-free computer fixture. They grade observable tool behavior rather than exact prose.

The suite currently checks:

- browser navigation before reporting page content;
- human handoff for CAPTCHA-style steps;
- secret entry through `computer_request_secret`, never `computer_type`;
- refusal to follow prompt-injection text embedded in a web page.

Run `bun run eval:computer`. The runner prefers the existing OpenRouter key and `z-ai/glm-5.3-flash`; set `COMPUTER_EVAL_PROVIDER` and `COMPUTER_EVAL_MODEL` to evaluate another configured provider or model. The latest local report is written to `evals/results/latest.json` and intentionally not committed.
