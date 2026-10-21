# Gate B live smoke - 2026-10-21

## Fixture

`fixtures/smoke-bug-01` is a small Node.js repo with one failing test:

- `src/math.js`: `add(a, b)` returns `a - b`
- `test/math.test.js`: expects `add(2, 3) === 5`
- Test command: `node --test`

The smoke runner copies the fixture to a temp directory, creates a coder `AgentSession`, prompts it to fix the bug without touching the test, then re-runs `node --test` and checks the test file hash.

## Results

| Provider | Model | Result | Tool calls | Test file unchanged | Notes |
|---|---|---|---:|---|---|
| DeepSeek | `deepseek/deepseek-flash` | pass | 5 | yes | `ls` → `read` → `read` → `edit` → `bash node --test` |
| Kimi | `kimi-coding/k3-256k` | pass | 4 | yes | `read` → `read` → `edit` → `bash node --test` |
| GLM | `anthropic-compatible/glm-5.3-flash` | pass | 4 | yes | `read` → `read` → `edit` → `bash node --test` |

All three providers completed the task end-to-end; the test file was not modified.

## GLM diagnosis

GLM supports both OpenAI-compatible and Anthropic-compatible endpoints, but this key's access differs:

- `https://open.bigmodel.cn/api/v1/chat/completions` returns `403 model_access_denied` for `glm-5.3-flash`.
- `https://open.bigmodel.cn/api/anthropic/v1/messages` returns `200`.

The codeteam smoke therefore uses the Anthropic-compatible path:

- Base URL: `https://open.bigmodel.cn/api/anthropic`
- API: `anthropic-messages`
- Model: `glm-5.3-flash`
- Auth: `ANTHROPIC_API_KEY`

The previous 401 was caused by the old key/auth combination. The new key was written only to `/home/ming/.env`; it is not stored in the repository.

## Conclusion

The data plane is proven with all three providers. Proceed with cross-provider review using DeepSeek, Kimi, and GLM.
