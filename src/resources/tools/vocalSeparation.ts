/**
 * Vocal separation: splits a track into a vocals stem and an instrumental.
 *
 * Runs are serialised against a single sidecar, so a pending row reports
 * {@link VocalSeparation.queue_position} - how many live runs entered the queue
 * ahead of it, `0` meaning next up. Surface it: on a busy day the wait is the
 * queue, not the model. {@link vocalSeparationProgress} folds it into the
 * progress line for exactly that reason.
 *
 * There is a second door onto the same machinery, `POST /songs/:id/separate`,
 * which separates a track already in the music library and leaves the stems on
 * the song rather than as attachments. Both doors share one daily ceiling, and
 * both are behind the same expensive-tools throttle - the twin was added to
 * that throttle only after a load generator drove it on its own and pushed the
 * box into swap.
 *
 * Limits, all enforced by the backend:
 *
 * | | |
 * |---|---|
 * | file size | 100 MiB (`413`) |
 * | daily quota, anonymous | 12 minutes of audio |
 * | daily quota, signed in | 30 minutes of audio |
 * | `POST /vocal_separations` | 20 a minute, shared with every other expensive tool |
 *
 * The quota is metered in seconds of audio and charged on the file's duration
 * at create time, not on how long the run takes - which matters here more than
 * anywhere else, because this is the slowest tool in the family. Read
 * {@link VocalSeparationNamespace.quota} before uploading; it is cheap, it
 * works anonymously, and a track longer than the whole daily ceiling is a 400
 * that no amount of waiting fixes.
 */

import { OmsError } from "../../errors";
import { Resource } from "../../http";
import type { FileInput, Id, Progress, RequestOptions } from "../../types";
import { pollUntilTerminal } from "../jobs";
import {
  fetchToolArtifact,
  isToolTerminal,
  requireToolArtifact,
  toolCaptchaFields,
  toolProgress,
  type SecondsQuota,
  type ToolCaptcha,
  type ToolModel,
  type ToolRecord,
  type ToolRunOptions,
} from "./index";

/** Which stem to fetch. */
export type VocalStem = "vocals" | "instrumental";

/**
 * A vocal separation run.
 *
 * Both routes that answer with one - `POST /vocal_separations` and
 * `GET /vocal_separations/:id` - render the `:extended` view, so every key
 * below is present on every response. Only the values move.
 */
export interface VocalSeparation extends ToolRecord {
  /** Never `null`: `NOT NULL`, and an unknown model is a 400 before the row exists. */
  readonly model_id: string;
  /** Audio duration charged against the quota, rounded up at create time. */
  readonly duration_seconds: number;
  /**
   * Set when the run came from the music library rather than an upload.
   *
   * A **number**, not a string. `vocal_separations.song_id` is a `bigint`
   * pointing at `songs`, which is one of the few tables in this API that kept
   * an integer primary key - so this is the one id in the tools family that is
   * not an {@link Id}. Comparing it against a string never matches.
   */
  readonly song_id: number | null;
  /** Title of that song, or `null` for an uploaded run. */
  readonly song_title: string | null;
  /** Real booleans, never `null`: each is an `attached?` call on the record. */
  readonly has_original: boolean;
  readonly has_vocals: boolean;
  readonly has_instrumental: boolean;
  /**
   * Live runs queued ahead of this one; `0` means next up. `null` once the run
   * is processing or terminal.
   */
  readonly queue_position: number | null;
  /**
   * Signed stem URLs once complete, `null` otherwise - and permanently `null`
   * for a song-owned separation, whose stems are written onto the song as
   * filesystem nodes and never attached to this row.
   */
  readonly vocals_url: string | null;
  readonly instrumental_url: string | null;
}

/** Arguments for starting a separation. */
export interface CreateVocalSeparationInput extends ToolCaptcha {
  /** The audio. Sent as the `audio` form field. Backend cap: 100 MiB. */
  readonly audio: FileInput;
  /** Model to use. Omit for the one flagged `default` in {@link VocalSeparationNamespace.models}. */
  readonly modelId?: string;
}

/**
 * Renders a separation as a {@link Progress}, queue position included.
 *
 * Identical to the shared `toolProgress` except while the run is queued, where
 * the position is folded into `status` - `"pending (2 ahead in the queue)"`.
 * That is a deliberate liberty with a field documented as the server's own
 * status string: `status` is the only part of a {@link Progress} a host
 * renders as text, and "pending" for forty minutes with no explanation is the
 * single worst thing this tool does to a person watching it.
 */
export function vocalSeparationProgress(record: VocalSeparation): Progress {
  const base = toolProgress(record);
  const ahead = record.queue_position;
  if (typeof ahead !== "number") return base;
  return {
    ...base,
    status: ahead === 0 ? `${record.status} (next up)` : `${record.status} (${ahead} ahead in the queue)`,
  };
}

/** The `vocalSeparation` tool, reachable as `oms.tools.vocalSeparation`. */
export class VocalSeparationNamespace extends Resource {
  /**
   * `GET /vocal_separations/models` - the selectable models.
   *
   * The controller answers `{ models: [...] }`; this unwraps it. Exactly one
   * entry carries `default: true`, and that is what the server picks when
   * {@link CreateVocalSeparationInput.modelId} is omitted.
   *
   * The models differ in cost as well as quality - the default is the heaviest
   * of them - but the API exposes no such ranking, so there is nothing here to
   * choose on but the id.
   */
  async models(options: RequestOptions = {}): Promise<ToolModel[]> {
    const answer = await this.http.get<{ models?: ToolModel[] }>("/vocal_separations/models", options);
    return answer?.models ?? [];
  }

  /**
   * `GET /vocal_separations/quota` - seconds spent and left today.
   *
   * Cheap and anonymous-safe. `limit_seconds` and `remaining_seconds` are
   * `null` exactly when `unlimited` is `true`. The window is a calendar day, so
   * "remaining" is not a rate: it does not tick back up until midnight.
   *
   * This ceiling is shared with `POST /songs/:id/separate`, so a separation
   * started from the music library spends the same budget.
   */
  async quota(options: RequestOptions = {}): Promise<SecondsQuota> {
    return this.http.get<SecondsQuota>("/vocal_separations/quota", options);
  }

  /**
   * `POST /vocal_separations` - uploads the audio and enqueues the run.
   *
   * Answers with the row in `"pending"`, already carrying its
   * {@link VocalSeparation.queue_position}. There is no `job_id` here: this
   * tool is polled by re-reading its own row with {@link get}.
   *
   * NOT retried by default: replaying this `POST` after a 502 re-uploads up to
   * 100 MiB, charges the quota twice, and puts a second run behind the first in
   * a queue that is already the slowest thing in the API. Pass `retry: {}` to
   * opt back in.
   *
   * @throws {OmsQuotaError} 429 for the daily ceiling or the expensive-tools
   *   throttle. Read `retryAfterMs`; the throttle sets it, the daily ceiling
   *   does not, so `undefined` means the wait is until midnight.
   * @throws {OmsApiError} 413 when the file is over 100 MiB. 400 when it is
   *   missing, undecodable, names an unknown model, or is longer on its own
   *   than the whole daily quota.
   * @throws {OmsAuthError} 401 when anonymous and the captcha is missing or bad.
   */
  async create(input: CreateVocalSeparationInput, options: RequestOptions = {}): Promise<VocalSeparation> {
    return this.http.postForm<VocalSeparation>(
      "/vocal_separations",
      {
        audio: input.audio,
        ...(input.modelId === undefined ? {} : { model_id: input.modelId }),
        ...toolCaptchaFields(input),
      },
      { ...options, retry: options.retry ?? false },
    );
  }

  /**
   * `GET /vocal_separations/:id` - one poll, carrying `queue_position` while
   * pending and `progress_percent` while processing.
   *
   * Never both: the position is `null` from the moment the sidecar picks the
   * run up, and the percentage is `null` before that and after it finishes.
   *
   * @throws {OmsApiError} 404 once the 24-hour retention sweep has taken it.
   * @throws {OmsAuthError} 401 when the run belongs to someone else, which
   *   includes an anonymous run being read from a different address.
   */
  async get(id: Id, options: RequestOptions = {}): Promise<VocalSeparation> {
    return this.http.get<VocalSeparation>(`/vocal_separations/${encodeURIComponent(id)}`, options);
  }

  /**
   * Uploads, waits, and returns the finished row.
   *
   * The wait is {@link get} on a loop, driven by `pollUntilTerminal` from the
   * jobs module - the same loop every other tool uses. Progress reports carry
   * the queue position while the run is still waiting its turn; see
   * {@link vocalSeparationProgress}.
   *
   * Resolves with a `"failed"` row rather than throwing when the work failed.
   * Pass `waitTimeoutMs` (or a `signal`) to bound the wait; there is no default
   * deadline, and this is the tool where that matters most - a busy queue plus
   * a long track is comfortably an hour.
   *
   * @throws {OmsTimeoutError} `code: "timeout"` when `waitTimeoutMs` elapses,
   *   `code: "aborted"` when the signal fires. Neither cancels the run: pick it
   *   up later with {@link get}.
   */
  async run(input: CreateVocalSeparationInput, options: ToolRunOptions = {}): Promise<VocalSeparation> {
    const created = await this.create(input, options);
    options.onProgress?.(vocalSeparationProgress(created));

    return pollUntilTerminal<VocalSeparation>({
      ...options,
      label: "the vocal separation",
      poll: (request) => this.get(created.id, request),
      terminal: (record) => isToolTerminal(record.status),
      progress: vocalSeparationProgress,
    });
  }

  /**
   * Downloads one stem of a finished run.
   *
   * Two calls: one to read the row for the stem's URL, one to fetch the signed
   * URL itself with NO credential attached. Hand a row you already hold to
   * {@link stemUrl} plus `fetchToolArtifact` if you would rather not pay for
   * the first.
   *
   * @throws {OmsError} `not_found` for a song-owned separation, whose stems are
   *   not attachments at all; read them through the music library instead.
   *   `conflict` when the run has not finished, `invalid_request` when it
   *   failed, `not_found` again once the 24-hour sweep has taken the stems.
   */
  async download(id: Id, stem: VocalStem, options: RequestOptions = {}): Promise<Blob> {
    const record = await this.get(id, options);
    return fetchToolArtifact(this.http, this.stemUrl(record, stem), options);
  }

  /**
   * The signed URL of one stem, from a row you already hold.
   *
   * Good for handing to a player instead of moving the bytes. It is a
   * credential: anyone holding it can read the stem.
   *
   * A song-owned separation is answered separately and first, because
   * otherwise it looks exactly like a swept artefact - complete, no URL - and
   * the caller would be told to blame a retention sweep for a run whose stems
   * were never attachments in the first place.
   *
   * @throws {OmsError} explaining which of the four reasons there is no URL.
   */
  stemUrl(record: VocalSeparation, stem: VocalStem): string {
    if (isSongOwned(record)) {
      throw new OmsError(
        `This separation belongs to song ${record.song_id}, so its stems live on the song as filesystem nodes, ` +
          `not as downloadable attachments. Read them through the music library instead.`,
        "not_found",
      );
    }
    return requireToolArtifact(record, stem === "vocals" ? record.vocals_url : record.instrumental_url, stem);
  }
}

/**
 * Whether this run came from the music library rather than from an upload.
 *
 * Tests for a present, non-empty id and NOT for a particular JavaScript type,
 * which is the whole point of extracting it. `vocal_separations.song_id` is a
 * bigint, so the wire value is a NUMBER - and this check used to be
 * `typeof record.song_id === "string"`, which meant it never fired for a real
 * row. Every song-owned separation fell through to `requireToolArtifact`,
 * which saw a complete run with no URL and blamed the 24-hour retention sweep
 * for stems that were never attachments in the first place.
 *
 * The string branch is kept because this predicate is also handed rows a host
 * deserialised itself, and a JSON parser that widened a bigint to a string is
 * a wrong TYPE, not a run that suddenly has no song. Answering the wrong
 * question loudly is worse than accepting both spellings of the right one.
 */
function isSongOwned(record: VocalSeparation): boolean {
  const songId: unknown = record.song_id;
  if (typeof songId === "number") return Number.isFinite(songId);
  return typeof songId === "string" && songId.length > 0;
}
