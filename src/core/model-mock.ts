/**
 * ModelMock — the model-mock PORT (transport axis). A harness test tier runs the
 * real agent against a fake, scripted model server so it needs no API key and is
 * deterministic. This descriptor captures what the mock's WIRE FORMAT is: the API
 * dialect it speaks, the endpoint that consumes a scripted turn, and the optional
 * token-count endpoint a client probes. The research (research/harness-landscape.md)
 * found the two concrete formats differ sharply — Claude Code speaks Anthropic
 * **Messages** SSE at `/v1/messages`; Codex speaks OpenAI **Responses** SSE at
 * `/v1/responses` — which is exactly the second implementation that makes this
 * port designable.
 *
 * The HTTP server + per-event flush mechanics live in the harness's mock module
 * (`startMock` for Claude Code); a second harness implements the same contract
 * with its own renderer. The Claude Code descriptor is `claudeCodeModelMock` in
 * `src/adapters/claude-code/model-mock.ts`.
 *
 * @public
 */
export interface ModelMock {
  /** Stable identifier, e.g. "claude-code". */
  readonly name: string;
  /** The model API wire format, e.g. "anthropic-messages" or "openai-responses". */
  readonly wireApi: string;
  /** URL substring identifying a turn-consuming model request (e.g. "/v1/messages"). */
  readonly modelEndpoint: string;
  /** Token-count endpoint substring a client probes (e.g. "count_tokens"); omit if none. */
  readonly countTokensEndpoint?: string;
}
