import { copyText, toLogTime } from "./helpers";

type JsonObject = Record<string, unknown>;

type Codec = {
  name: string;
  encode: (message: JsonObject) => string | Uint8Array;
  decode: (payload: unknown) => JsonObject;
};

type BridgeClientLike = {
  connect: (url: string) => Promise<void>;
  close: () => void;
  subscribe: (
    topic: string,
    type: string,
    callback: (msg: JsonObject) => void,
    options?: { compression?: string }
  ) => Promise<void>;
  advertise: (topic: string, type: string) => Promise<void>;
  publish: (topic: string, msg: JsonObject) => Promise<void>;
  callService: (
    service: string,
    type: string,
    args: JsonObject,
    options?: { id?: string; timeoutMs?: number }
  ) => Promise<JsonObject>;
  sendActionGoal: (options: {
    action: string;
    actionType: string;
    goal: JsonObject;
    id?: string;
    sessionId?: string;
    timeoutMs?: number;
    onRequest?: (msg: JsonObject) => void;
    onFeedback?: (msg: JsonObject) => void;
    onResult?: (msg: JsonObject) => void;
  }) => Promise<{ id: string; completion: Promise<JsonObject> }>;
  cancelActionGoal: (options: {
    action: string;
    actionType: string;
    sessionId?: string;
    timeoutMs?: number;
  }) => Promise<JsonObject>;
};

type BridgeClientConstructor = new (options?: {
  strictWasm?: boolean;
  timeoutMs?: number;
  reconnect?: {
    enabled?: boolean;
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
  codec?: Codec | "json" | "cbor" | "auto";
}) => BridgeClientLike;

type BridgeDeps = {
  BridgeClient: BridgeClientConstructor;
  codecs: {
    json: Codec;
    cbor: Codec;
    auto: Codec;
  };
};

type AppState = {
  client: BridgeClientLike | null;
  connected: boolean;
  pubSubReady: boolean;
  received: string[];
  serviceResult: string;
  actionTimeline: string[];
  rawLogs: string[];
  smokeResult: string;
};

const PUBSUB_TOPIC = "/demo/out";

function appendLine(lines: string[], line: string, limit = 200): string[] {
  return [line, ...lines].slice(0, limit);
}

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = text;
  }
}

function valueOf(id: string): string {
  const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
  return el?.value ?? "";
}

function renderList(id: string, lines: string[]): void {
  setText(id, lines.join("\n"));
}

function asRecord(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonObject;
}

function toImageSource(data: unknown, format: string, createBlobUrl: (bytes: Uint8Array, mimeType: string) => string): string | undefined {
  const normalizedFormat = format.toLowerCase();
  const mimeType = normalizedFormat === "jpg" || normalizedFormat === "jpeg" ? "image/jpeg" : `image/${normalizedFormat}`;

  if (typeof data === "string" && data.length > 0) {
    if (data.startsWith("data:image/")) {
      return data;
    }
    return `data:${mimeType};base64,${data}`;
  }

  if (data instanceof Uint8Array) {
    return createBlobUrl(data, mimeType);
  }

  if (data instanceof ArrayBuffer) {
    return createBlobUrl(new Uint8Array(data), mimeType);
  }

  if (Array.isArray(data) && data.every((n) => typeof n === "number")) {
    return createBlobUrl(Uint8Array.from(data), mimeType);
  }

  return undefined;
}

export function renderAppSkeleton(root: HTMLElement): void {
  root.innerHTML = `
    <div class="layout">
      <header>
        <h1>tachybridge-wasm Simple Mockup</h1>
        <p class="caption">Auto-subscribes after connect. Click Publish to receive immediately on the same topic.</p>
      </header>

      <section class="panel" id="panel-connection">
        <h2>1) Connection</h2>
        <div class="grid3">
          <label>WS URL <input id="ws-url" value="ws://127.0.0.1:9090" /></label>
          <label>Timeout(ms) <input id="timeout-ms" value="5000" /></label>
          <label>Codec
            <select id="codec-select">
              <option value="json" selected>json</option>
              <option value="cbor">cbor</option>
              <option value="auto">auto</option>
            </select>
          </label>
          <label>Status <span id="connection-state" class="pill">disconnected</span></label>
        </div>
        <div class="row">
          <button id="connect-btn">Connect</button>
          <button id="disconnect-btn">Disconnect</button>
          <span id="connection-error" class="error"></span>
        </div>
      </section>

      <section class="panel" id="panel-topic">
        <h2>2) Pub/Sub</h2>
        <p class="hint">Messages are received when you click Publish.</p>
        <label>Subscribe compression
          <select id="compression-select">
            <option value="none" selected>none</option>
            <option value="cbor">cbor</option>
            <option value="cbor-raw">cbor-raw</option>
          </select>
        </label>
        <label>Publish text <input id="publish-text" value="hello" /></label>
        <div class="row">
          <button id="publish-btn">Publish</button>
        </div>
        <pre id="topic-recv" class="stream"></pre>
      </section>

      <section class="panel" id="panel-service">
        <h2>3) Service</h2>
        <div class="row">
          <button id="service-ok-btn">Call /demo/sum</button>
          <button id="service-fail-btn">Call /demo/fail</button>
        </div>
        <pre id="service-result" class="stream"></pre>
      </section>

      <section class="panel" id="panel-action">
        <h2>4) Native Action</h2>
        <div class="grid2">
          <label>goal.x <input id="goal-x" value="1" /></label>
          <label>goal.y <input id="goal-y" value="2" /></label>
        </div>
        <div class="row">
          <button id="action-send-btn">Send Goal</button>
          <button id="action-cancel-btn">Cancel Goal</button>
        </div>
        <div class="row">
          <img id="action-image-0" alt="action camera 0" style="width: 240px; height: 135px; object-fit: contain; border: 1px solid #ddd;" />
          <img id="action-image-1" alt="action camera 1" style="width: 240px; height: 135px; object-fit: contain; border: 1px solid #ddd;" />
        </div>
        <pre id="action-stream" class="stream"></pre>
      </section>

      <section class="panel" id="panel-smoke">
        <h2>5) Protocol Smoke</h2>
        <div class="row">
          <button id="smoke-json-btn">Smoke JSON</button>
          <button id="smoke-cbor-btn">Smoke CBOR + cbor-raw</button>
        </div>
        <pre id="smoke-result" class="stream"></pre>
      </section>

      <section class="panel" id="panel-logs">
        <h2>Raw Logs</h2>
        <div class="row">
          <button id="logs-clear-btn">Clear</button>
          <button id="logs-copy-btn">Copy</button>
        </div>
        <pre id="raw-logs" class="stream"></pre>
      </section>
    </div>
  `;
}

export function mountMockupWeb(root: HTMLElement, deps: BridgeDeps): void {
  renderAppSkeleton(root);

  const state: AppState = {
    client: null,
    connected: false,
    pubSubReady: false,
    received: [],
    serviceResult: "",
    actionTimeline: [],
    rawLogs: [],
    smokeResult: ""
  };

  let currentActionSessionId: string | null = null;
  let actionBlobUrls: string[] = [];

  function pushRaw(direction: "tx" | "rx", payload: unknown): void {
    state.rawLogs = appendLine(state.rawLogs, `${toLogTime()} [${direction}] ${JSON.stringify(payload)}`, 500);
    renderList("raw-logs", state.rawLogs);
  }

  function pushReceived(label: string, payload: unknown): void {
    state.received = appendLine(state.received, `${toLogTime()} ${label} ${JSON.stringify(payload)}`);
    renderList("topic-recv", state.received);
  }

  function pushAction(label: string, payload: unknown): void {
    state.actionTimeline = appendLine(state.actionTimeline, `${toLogTime()} ${label} ${JSON.stringify(payload)}`);
    renderList("action-stream", state.actionTimeline);
  }

  function clearActionBlobUrls(): void {
    for (const url of actionBlobUrls) {
      URL.revokeObjectURL(url);
    }
    actionBlobUrls = [];
  }

  function setActionImage(index: number, src?: string): void {
    const el = document.getElementById(`action-image-${index}`) as HTMLImageElement | null;
    if (!el) {
      return;
    }
    el.src = src ?? "";
  }

  function renderActionImages(feedback: JsonObject): void {
    const imagesRaw = feedback.images;
    if (!Array.isArray(imagesRaw)) {
      return;
    }

    clearActionBlobUrls();

    for (let i = 0; i < 2; i += 1) {
      const entry = asRecord(imagesRaw[i]);
      const format = typeof entry?.format === "string" ? entry.format : "jpeg";
      const src = toImageSource(entry?.data, format, (bytes, mimeType) => {
        const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
        actionBlobUrls.push(url);
        return url;
      });
      setActionImage(i, src);
    }
  }

  function setStatus(text: string, error = ""): void {
    setText("connection-state", text);
    setText("connection-error", error);
  }

  function createClient(): BridgeClientLike {
    const timeoutMs = Number(valueOf("timeout-ms") || "5000");
    const selectedCodec = valueOf("codec-select") || "json";
    const baseCodec = selectedCodec === "cbor" ? deps.codecs.cbor : selectedCodec === "auto" ? deps.codecs.auto : deps.codecs.json;
    const codec: Codec = {
      name: baseCodec.name,
      encode: (message) => {
        pushRaw("tx", message);
        return baseCodec.encode(message);
      },
      decode: (payload) => {
        const parsed = baseCodec.decode(payload) as JsonObject;
        pushRaw("rx", parsed);

        if (parsed.op === "action_result" || parsed.op === "cancel_action_result") {
          pushAction(String(parsed.op), parsed);
        }
        if (parsed.type === "request" || parsed.type === "feedback" || parsed.type === "result" || parsed.type === "error") {
          pushAction(String(parsed.type), parsed);
        }

        return parsed;
      }
    };

    return new deps.BridgeClient({ strictWasm: false, timeoutMs, codec });
  }

  async function ensureConnected(): Promise<BridgeClientLike> {
    if (!state.client || !state.connected) {
      throw new Error("Connect first.");
    }
    return state.client;
  }

  async function setupPubSub(client: BridgeClientLike): Promise<void> {
    if (state.pubSubReady) {
      return;
    }

    await client.subscribe(
      PUBSUB_TOPIC,
      "std_msgs/String",
      (msg) => {
        pushReceived(PUBSUB_TOPIC, msg);
      },
      {
        compression: valueOf("compression-select") !== "none" ? valueOf("compression-select") : undefined
      }
    );

    await client.advertise(PUBSUB_TOPIC, "std_msgs/String");
    state.pubSubReady = true;
  }

  document.getElementById("connect-btn")?.addEventListener("click", () => {
    void (async () => {
      try {
        setStatus("connecting");
        const client = createClient();
        await client.connect(valueOf("ws-url"));
        state.client = client;
        state.connected = true;
        await setupPubSub(client);
        setStatus("connected");
      } catch (error) {
        state.connected = false;
        setStatus("error", String(error));
      }
    })();
  });

  document.getElementById("disconnect-btn")?.addEventListener("click", () => {
    clearActionBlobUrls();
    setActionImage(0);
    setActionImage(1);
    state.client?.close();
    state.client = null;
    state.connected = false;
    state.pubSubReady = false;
    setStatus("disconnected");
  });

  document.getElementById("publish-btn")?.addEventListener("click", () => {
    void (async () => {
      try {
        const client = await ensureConnected();
        await setupPubSub(client);
        await client.publish(PUBSUB_TOPIC, { text: valueOf("publish-text") });
      } catch (error) {
        setStatus("error", String(error));
      }
    })();
  });

  document.getElementById("service-ok-btn")?.addEventListener("click", () => {
    void (async () => {
      try {
        const client = await ensureConnected();
        const result = await client.callService("/demo/sum", "example/AddTwoInts", { a: 1, b: 2 });
        state.serviceResult = JSON.stringify(result, null, 2);
        setText("service-result", state.serviceResult);
      } catch (error) {
        setText("service-result", String(error));
      }
    })();
  });

  document.getElementById("service-fail-btn")?.addEventListener("click", () => {
    void (async () => {
      try {
        const client = await ensureConnected();
        await client.callService("/demo/fail", "example/Fail", { force_fail: true });
        setText("service-result", "unexpected success");
      } catch (error) {
        setText("service-result", `expected failure: ${String(error)}`);
      }
    })();
  });

  document.getElementById("action-send-btn")?.addEventListener("click", () => {
    void (async () => {
      try {
        const client = await ensureConnected();
        const x = Number(valueOf("goal-x") || "0");
        const y = Number(valueOf("goal-y") || "0");
        const sessionId = `web-session-${Date.now()}`;
        currentActionSessionId = sessionId;

        const handle = await client.sendActionGoal({
          action: "/arm/move",
          actionType: "demo/MoveArm",
          goal: { x, y },
          sessionId,
          onFeedback: (fb) => {
            pushAction("feedback", fb);
            renderActionImages(fb);
          },
          onRequest: (req) => pushAction("request", req),
          onResult: (res) => pushAction("result", res)
        });

        void handle.completion.then(
          (result) => pushAction("completion", result),
          (error) => pushAction("completion_error", String(error))
        );
      } catch (error) {
        pushAction("error", String(error));
      }
    })();
  });

  document.getElementById("action-cancel-btn")?.addEventListener("click", () => {
    void (async () => {
      try {
        const client = await ensureConnected();
        if (!currentActionSessionId) {
          throw new Error("Send a goal first.");
        }
        const ack = await client.cancelActionGoal({
          action: "/arm/move",
          actionType: "demo/MoveArm",
          sessionId: currentActionSessionId
        });
        pushAction("cancel_ack", ack);
      } catch (error) {
        pushAction("cancel_error", String(error));
      }
    })();
  });

  document.getElementById("logs-clear-btn")?.addEventListener("click", () => {
    state.rawLogs = [];
    renderList("raw-logs", []);
  });

  document.getElementById("logs-copy-btn")?.addEventListener("click", () => {
    void copyText(state.rawLogs.join("\n")).catch((error) => {
      setStatus("error", `copy failed: ${String(error)}`);
    });
  });

  async function reconnectForSmoke(codec: "json" | "cbor" | "auto", compression: "none" | "cbor-raw"): Promise<void> {
    state.client?.close();
    state.client = null;
    state.connected = false;
    state.pubSubReady = false;
    (document.getElementById("codec-select") as HTMLSelectElement).value = codec;
    (document.getElementById("compression-select") as HTMLSelectElement).value = compression;

    const client = createClient();
    await client.connect(valueOf("ws-url"));
    state.client = client;
    state.connected = true;
    await setupPubSub(client);
  }

  async function waitForContains(text: string, timeoutMs = 3000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (state.received.some((line) => line.includes(text))) {
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timeout waiting for ${text}`);
  }

  document.getElementById("smoke-json-btn")?.addEventListener("click", () => {
    void (async () => {
      try {
        state.received = [];
        renderList("topic-recv", state.received);
        await reconnectForSmoke("json", "none");
        const client = await ensureConnected();
        await client.publish(PUBSUB_TOPIC, { text: "smoke-json" });
        await waitForContains("smoke-json");
        const service = await client.callService("/demo/sum", "example/AddTwoInts", { a: 3, b: 4 });
        state.smokeResult = `PASS json (${JSON.stringify(service)})`;
      } catch (error) {
        state.smokeResult = `FAIL json: ${String(error)}`;
      }
      setText("smoke-result", state.smokeResult);
    })();
  });

  document.getElementById("smoke-cbor-btn")?.addEventListener("click", () => {
    void (async () => {
      try {
        state.received = [];
        renderList("topic-recv", state.received);
        await reconnectForSmoke("cbor", "cbor-raw");
        const client = await ensureConnected();
        await client.publish(PUBSUB_TOPIC, { text: "smoke-cbor" });
        await waitForContains("\"bytes\"");
        const service = await client.callService("/demo/sum", "example/AddTwoInts", { a: 8, b: 9 });
        state.smokeResult = `PASS cbor+cbor-raw (${JSON.stringify(service)})`;
      } catch (error) {
        state.smokeResult = `FAIL cbor+cbor-raw: ${String(error)}`;
      }
      setText("smoke-result", state.smokeResult);
    })();
  });
}
