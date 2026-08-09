// Web Serial transport for sending a 128x128 1-bit image directly to the
// DC34 badge, byte-for-byte compatible with the dc34-image reference CLI
// (dc34_image/send_image.py). See badge-web-serial-spec.md for the protocol.
//
// Exposes a single global: WebSerialBadge

const WebSerialBadge = (() => {
  const USB_VENDOR_ID = 0x1d50; // Baochip / bao1x
  const BAUD_RATE = 1_000_000;

  const IMAGE_SIZE = 128;
  const CHUNK_DATA_SIZE = 64;
  const TOTAL_BYTES = (IMAGE_SIZE * IMAGE_SIZE) / 8; // 2048
  const NUM_CHUNKS = TOTAL_BYTES / CHUNK_DATA_SIZE; // 32

  const MAX_RETRIES = 4; // 5 attempts total
  const RETRY_DELAY_MS = 500;
  const INTER_CHUNK_DELAY_MS = 200;
  const RESPONSE_TIMEOUT_MS = 3000;
  const DRAIN_TIMEOUT_MS = 200;
  const PORT_SETTLE_DELAY_MS = 400;

  class SerialUnsupportedError extends Error {}
  class SerialSendError extends Error {}

  function isSupported() {
    return "serial" in navigator;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------- CRC-32 (ISO-HDLC / zlib variant) ----------
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  // ---------- image -> badge bitmap bytes ----------
  // pixels: Uint8Array of IMAGE_SIZE*IMAGE_SIZE, each 0 (black) or 255 (white)
  function imageToBadgeBytes(pixels, width, height) {
    if (width !== IMAGE_SIZE || height !== IMAGE_SIZE) {
      throw new SerialSendError(`Expected a ${IMAGE_SIZE}x${IMAGE_SIZE} image.`);
    }

    // 1. flip horizontally
    const flipped = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        flipped[y * width + x] = pixels[y * width + (width - 1 - x)];
      }
    }

    // 2-4: pack MSB-first into 32-bit words, black=1
    const numWords = (width * height) / 32; // 512
    const words = new Uint32Array(numWords);
    for (let w = 0; w < numWords; w++) {
      let word = 0;
      for (let b = 0; b < 32; b++) {
        const isBlack = flipped[w * 32 + b] === 0 ? 1 : 0;
        word = (word << 1) | isBlack;
      }
      words[w] = word >>> 0;
    }

    // 5. reverse each group of 4 consecutive words
    const reordered = new Uint32Array(numWords);
    const numGroups = numWords / 4; // 128
    for (let i = 0; i < numGroups; i++) {
      reordered[i * 4 + 0] = words[i * 4 + 3];
      reordered[i * 4 + 1] = words[i * 4 + 2];
      reordered[i * 4 + 2] = words[i * 4 + 1];
      reordered[i * 4 + 3] = words[i * 4 + 0];
    }

    // 6. serialize big-endian
    const bytes = new Uint8Array(numWords * 4);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < numWords; i++) {
      view.setUint32(i * 4, reordered[i], false);
    }
    return bytes; // 2048 bytes
  }

  // ---------- chunk wire framing ----------
  // [0:2] u16 index BE | [2:66] 64 bytes data | [66:70] u32 CRC32 BE over [0:66]
  function frameChunk(idx, data) {
    const buf = new Uint8Array(70);
    const view = new DataView(buf.buffer);
    view.setUint16(0, idx, false);
    buf.set(data, 2);
    const crc = crc32(buf.subarray(0, 66));
    view.setUint32(66, crc, false);
    return buf;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  // ---------- line-based serial reader ----------
  // Owns a single reader on port.readable (via a TextDecoderStream) and pumps
  // it continuously, handing decoded lines out to whoever calls readLine().
  // Timeouts never touch the underlying reader, so at most one read() is ever
  // outstanding at a time.
  class SerialLineReader {
    constructor(port) {
      this.textDecoder = new TextDecoderStream();
      this.readableStreamClosed = port.readable.pipeTo(this.textDecoder.writable).catch(() => {});
      this.reader = this.textDecoder.readable.getReader();
      this.buffer = "";
      this.lineQueue = [];
      this.waiters = [];
      this._pump();
    }

    async _pump() {
      try {
        while (true) {
          const { value, done } = await this.reader.read();
          if (done) break;
          this.buffer += value;
          let nl;
          while ((nl = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, nl).replace(/\r$/, "");
            this.buffer = this.buffer.slice(nl + 1);
            this._deliver(line);
          }
        }
      } catch {
        // reader cancelled or the port dropped; fall through to EOF signal
      } finally {
        this._deliver(null);
      }
    }

    _deliver(line) {
      if (this.waiters.length) {
        this.waiters.shift()(line);
      } else {
        this.lineQueue.push(line);
      }
    }

    readLine(timeoutMs) {
      if (this.lineQueue.length) return Promise.resolve(this.lineQueue.shift());
      return new Promise((resolve) => {
        let settled = false;
        const waiter = (line) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(line);
        };
        const timer = timeoutMs
          ? setTimeout(() => {
              if (settled) return;
              settled = true;
              const idx = this.waiters.indexOf(waiter);
              if (idx !== -1) this.waiters.splice(idx, 1);
              resolve(null);
            }, timeoutMs)
          : null;
        this.waiters.push(waiter);
      });
    }

    async close() {
      try {
        await this.reader.cancel();
      } catch {
        // ignore
      }
      try {
        await this.readableStreamClosed;
      } catch {
        // ignore
      }
    }
  }

  async function drainBuffered(session) {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const line = await session.readLine(DRAIN_TIMEOUT_MS);
      if (line === null) return;
    }
  }

  async function waitForToken(session, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const line = await session.readLine(remaining);
      if (line === null) return null;
      const trimmed = line.trim();
      if (trimmed === "OK" || trimmed === "ERR" || trimmed === "SUCCESS") return trimmed;
    }
  }

  // Wraps a port's writer + line reader and knows how to rebuild them from
  // scratch. Some USB-CDC drivers (observed in practice on Windows with this
  // badge) leave the readable/writable streams permanently errored after a
  // single fatal write/read failure — retrying on the same writer just
  // reproduces the identical error forever. A full close/reopen cycle gets a
  // fresh OS-level handle and a real chance of the next attempt succeeding.
  class SerialSession {
    constructor(port) {
      this.port = port;
      this.encoder = new TextEncoder();
      this._attach();
    }

    _attach() {
      this.writer = this.port.writable.getWriter();
      this.lineReader = new SerialLineReader(this.port);
    }

    async _detach() {
      try {
        this.writer.releaseLock();
      } catch {
        // ignore
      }
      try {
        await this.lineReader.close();
      } catch {
        // ignore
      }
    }

    async write(text) {
      await this.writer.write(this.encoder.encode(text));
    }

    readLine(timeoutMs) {
      return this.lineReader.readLine(timeoutMs);
    }

    async reconnect() {
      await this._detach();
      try {
        await this.port.close();
      } catch {
        // ignore — it may already be in an errored/closed state
      }
      await delay(PORT_SETTLE_DELAY_MS);
      await this.port.open({ baudRate: BAUD_RATE });
      await delay(PORT_SETTLE_DELAY_MS);
      this._attach();
      // A fresh open often surfaces boot/log chatter on the wire; clear it
      // before the caller's next write so it doesn't get mistaken for a
      // protocol response.
      await drainBuffered(this);
    }

    async dispose() {
      await this._detach();
    }
  }

  // ---------- port acquisition ----------
  async function requestBadgePort() {
    if (!isSupported()) {
      throw new SerialUnsupportedError(
        "Web Serial isn't supported in this browser. Use Chrome, Edge, or Opera, or fall back to the dc34-image CLI."
      );
    }
    let port;
    try {
      port = await navigator.serial.requestPort({ filters: [{ usbVendorId: USB_VENDOR_ID }] });
    } catch (err) {
      if (err && err.name === "NotFoundError") {
        throw new SerialSendError("No port selected.");
      }
      throw err;
    }
    await port.open({ baudRate: BAUD_RATE });
    // Some USB-CDC virtual COM ports (notably on Windows) aren't fully
    // settled the instant open() resolves; writing immediately can fail
    // with a low-level driver error. A brief pause avoids that race.
    await delay(PORT_SETTLE_DELAY_MS);
    return port;
  }

  // Runs one attempt of `action` against `session`. On a transport-level
  // throw (as opposed to a protocol-level ERR/timeout, which `action` itself
  // handles), reconnects the session so the next attempt gets a fresh handle
  // instead of hammering a stream that's already errored out.
  async function attemptWithReconnect(session, action) {
    try {
      return { ok: true, value: await action() };
    } catch (err) {
      try {
        await session.reconnect();
      } catch (reconnectErr) {
        return { ok: false, error: reconnectErr };
      }
      return { ok: false, error: err };
    }
  }

  // ---------- main send flow ----------
  async function sendImageOverSerial(port, pixels, onProgress) {
    const bytes = imageToBadgeBytes(pixels, IMAGE_SIZE, IMAGE_SIZE);
    const session = new SerialSession(port);

    try {
      await drainBuffered(session);
      for (let i = 0; i < 3; i++) {
        const result = await attemptWithReconnect(session, async () => {
          await session.write("\r\n");
          await session.readLine(RESPONSE_TIMEOUT_MS);
        });
        if (!result.ok) {
          // Best-effort: a flaky flush write just means the badge's stale
          // buffer isn't cleared, not a fatal condition. The chunk loop
          // below has its own retry/CRC protection.
          console.warn("Serial flush write failed, continuing:", result.error);
        }
      }

      let successSeen = false;
      for (let idx = 0; idx < NUM_CHUNKS && !successSeen; idx++) {
        const chunkData = bytes.subarray(idx * CHUNK_DATA_SIZE, (idx + 1) * CHUNK_DATA_SIZE);
        const line = `image ${bytesToBase64(frameChunk(idx, chunkData))}\n`;

        let accepted = false;
        let lastTransportError = null;
        for (let attempt = 0; attempt <= MAX_RETRIES && !accepted; attempt++) {
          if (attempt > 0) await delay(RETRY_DELAY_MS);
          const result = await attemptWithReconnect(session, async () => {
            await session.write(line);
            return waitForToken(session, RESPONSE_TIMEOUT_MS);
          });
          if (result.ok) {
            if (result.value === "SUCCESS") {
              successSeen = true;
              accepted = true;
            } else if (result.value === "OK") {
              accepted = true;
            }
            // "ERR" or a timeout (null) falls through and retries
          } else {
            // A transient transport-level hiccup (seen in practice on some
            // Windows USB-CDC drivers) — reconnected above; retry the same
            // chunk rather than aborting the whole transfer.
            lastTransportError = result.error;
          }
        }

        if (!accepted) {
          const reason = lastTransportError ? `: ${lastTransportError.message || lastTransportError}` : "";
          throw new SerialSendError(`Chunk ${idx + 1}/${NUM_CHUNKS} failed after ${MAX_RETRIES + 1} attempts${reason}`);
        }

        if (onProgress) onProgress(idx + 1, NUM_CHUNKS);
        if (!successSeen && idx < NUM_CHUNKS - 1) await delay(INTER_CHUNK_DELAY_MS);
      }

      return { success: successSeen };
    } finally {
      await session.dispose();
    }
  }

  async function clearImageOverSerial(port) {
    const session = new SerialSession(port);

    try {
      let lastTransportError = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) await delay(RETRY_DELAY_MS);
        const result = await attemptWithReconnect(session, async () => {
          await session.write("image clear\n");

          const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
          while (true) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) return null;
            const line = await session.readLine(remaining);
            if (line === null) return null;
            if (line.startsWith("[console]")) continue; // local echo, discard
            return line.trim();
          }
        });
        if (result.ok) {
          if (result.value === "CLEAR") return true;
        } else {
          lastTransportError = result.error;
        }
      }
      const reason = lastTransportError ? `: ${lastTransportError.message || lastTransportError}` : "";
      throw new SerialSendError(`Badge didn't confirm the reset after retries${reason}`);
    } finally {
      await session.dispose();
    }
  }

  async function sendImage(pixels, onProgress) {
    const port = await requestBadgePort();
    try {
      return await sendImageOverSerial(port, pixels, onProgress);
    } finally {
      try {
        await port.close();
      } catch {
        // ignore
      }
    }
  }

  async function clearImage() {
    const port = await requestBadgePort();
    try {
      return await clearImageOverSerial(port);
    } finally {
      try {
        await port.close();
      } catch {
        // ignore
      }
    }
  }

  return {
    isSupported,
    sendImage,
    clearImage,
    SerialUnsupportedError,
    SerialSendError,
    // exposed for testing
    _internal: { crc32, imageToBadgeBytes, frameChunk, bytesToBase64, NUM_CHUNKS, TOTAL_BYTES, CHUNK_DATA_SIZE },
  };
})();
