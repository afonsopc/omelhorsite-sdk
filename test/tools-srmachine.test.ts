import { describe, expect, test } from "bun:test";

import { OmsAuthError } from "../src/errors";
import { ApiClient } from "../src/http";
import { CaptionsNamespace } from "../src/resources/tools/captions";
import { SRMachineNamespace } from "../src/resources/tools/srMachine";

const BASE_URL = "https://api.test";

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

function harness(answer: (call: Recorded) => Response) {
  const calls: Recorded[] = [];
  const http = new ApiClient({
    baseUrl: BASE_URL,
    tokens: { getToken: () => "t" },
    fetch: async (input, init) => {
      const url = new URL(input);
      const call = { method: init?.method ?? "GET", path: url.pathname, query: url.searchParams, body: init?.body };
      calls.push(call);
      return answer(call);
    },
  });
  return { srMachine: new SRMachineNamespace(http), captions: new CaptionsNamespace(http), calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const bytes = (type: string, filename: string) =>
  new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "content-type": type, "content-disposition": `attachment; filename="${filename}"` },
  });

describe("tools.srMachine", () => {
  test("metadata passes the url as a query parameter", async () => {
    const { srMachine, calls } = harness(() => json({ title: "Construção", artist: "Chico Buarque" }));

    const metadata = await srMachine.metadata("https://youtu.be/abc");

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.path).toBe("/s_r_machine/metadata");
    expect(calls[0]!.query.get("url")).toBe("https://youtu.be/abc");
    expect(metadata.artist).toBe("Chico Buarque");
  });

  test("artwork and audio come back as FileOutputs carrying the server's filename", async () => {
    const { srMachine, calls } = harness((call) =>
      call.path.endsWith("/audio") ? bytes("audio/opus", "audio.opus") : bytes("image/jpeg", "artwork.jpg"),
    );

    const artwork = await srMachine.artwork("https://youtu.be/abc");
    const audio = await srMachine.audio("https://youtu.be/abc");

    expect(calls.map((c) => c.path)).toEqual(["/s_r_machine/artwork", "/s_r_machine/audio"]);
    expect(artwork.filename).toBe("artwork.jpg");
    expect(artwork.contentType).toBe("image/jpeg");
    expect(audio.filename).toBe("audio.opus");
    expect(audio.size).toBe(3);
  });

  test("convert-opus uploads multipart under the field name the server reads", async () => {
    const { srMachine, calls } = harness(() => bytes("audio/opus", "audio.opus"));

    const source = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });
    const file = await srMachine.convertToOpus({ data: source, filename: "song.wav" });

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe("/s_r_machine/convert-opus");
    expect((calls[0]!.body as FormData).get("file")).toBeInstanceOf(Blob);
    expect(file.contentType).toBe("audio/opus");
  });

  test("a non-admin is refused by the gatekeeper", async () => {
    const { srMachine } = harness(() => json("You SHALL NOT use this resource", 403));

    const failure = await srMachine.metadata("https://youtu.be/abc").catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsAuthError);
    expect((failure as OmsAuthError).status).toBe(403);
  });
});

describe("tools.captions start variants", () => {
  const row = (status: string) => json({ id: "job", status, words: [{ text: "ola", start: 0, end: 1 }] });

  test("startTranscribe answers the busy row after exactly one request", async () => {
    const { captions, calls } = harness(() => row("transcribing"));

    const job = await captions.startTranscribe("job", { start: 0, end: 5 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/caption_jobs/job/transcribe");
    expect(job.status).toBe("transcribing");
  });

  test("startRender reads the words when none are given and does not poll", async () => {
    const { captions, calls } = harness((call) => row(call.method === "POST" ? "rendering" : "transcribed"));

    const job = await captions.startRender("job");

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /caption_jobs/job",
      "POST /caption_jobs/job/render",
    ]);
    expect(job.status).toBe("rendering");
  });
});
