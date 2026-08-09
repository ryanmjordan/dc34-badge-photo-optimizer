(function () {
  const OUTPUT_SIZE = 128;
  const STORAGE_KEY = "dc34-badge-optimizer-settings";

  const el = {
    uploadSection: document.getElementById("upload-section"),
    editorSection: document.getElementById("editor-section"),
    dropZone: document.getElementById("drop-zone"),
    fileInput: document.getElementById("file-input"),
    errorMessage: document.getElementById("error-message"),
    cropStage: document.getElementById("crop-stage"),
    cropImage: document.getElementById("crop-image"),
    cropBox: document.getElementById("crop-box"),
    newImageBtn: document.getElementById("new-image-btn"),
    presetSelect: document.getElementById("preset-select"),
    algorithmSelect: document.getElementById("algorithm-select"),
    brightness: document.getElementById("brightness-input"),
    brightnessOut: document.getElementById("brightness-output"),
    contrast: document.getElementById("contrast-input"),
    contrastOut: document.getElementById("contrast-output"),
    gamma: document.getElementById("gamma-input"),
    gammaOut: document.getElementById("gamma-output"),
    blackPoint: document.getElementById("black-point-input"),
    blackPointOut: document.getElementById("black-point-output"),
    whitePoint: document.getElementById("white-point-input"),
    whitePointOut: document.getElementById("white-point-output"),
    invert: document.getElementById("invert-input"),
    resetBtn: document.getElementById("reset-adjustments-btn"),
    preview1x: document.getElementById("preview-1x"),
    preview4x: document.getElementById("preview-4x"),
    comparisonGrid: document.getElementById("comparison-grid"),
    downloadBtn: document.getElementById("download-btn"),
    sendSerialBtn: document.getElementById("send-serial-btn"),
    clearBadgeBtn: document.getElementById("clear-badge-btn"),
    serialProgress: document.getElementById("serial-progress"),
    serialStatus: document.getElementById("serial-status"),
    serialUnsupported: document.getElementById("serial-unsupported"),
  };

  const state = {
    img: null,
    objectUrl: null,
    cropRect: null,
    grayBase: null, // Float32Array OUTPUT_SIZE^2, post crop+resize, pre-adjust
    adjusted: null, // Float32Array OUTPUT_SIZE^2, post tonal adjustments
    dithered: null, // Uint8Array OUTPUT_SIZE^2, values 0/255
    algorithm: "floyd-steinberg",
    adjustments: { brightness: 0, contrast: 20, gamma: 1.0, blackPoint: 0, whitePoint: 255, invert: false },
  };

  const extractCanvas = document.createElement("canvas");
  const extractCtx = extractCanvas.getContext("2d", { willReadFrequently: true });

  // ---------- comparison grid setup ----------
  const comparisonCanvases = {};
  for (const key of Object.keys(DITHER_ALGORITHMS)) {
    const item = document.createElement("div");
    item.className = "comparison-item";
    item.dataset.algorithm = key;
    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    canvas.className = "pixelated";
    const label = document.createElement("span");
    label.textContent = DITHER_ALGORITHMS[key].label;
    item.appendChild(canvas);
    item.appendChild(label);
    item.addEventListener("click", () => {
      el.algorithmSelect.value = key;
      state.algorithm = key;
      recomputeDither();
      saveSettings();
    });
    el.comparisonGrid.appendChild(item);
    comparisonCanvases[key] = canvas;
  }

  // ---------- settings persistence ----------
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.algorithm && DITHER_ALGORITHMS[saved.algorithm]) state.algorithm = saved.algorithm;
      if (saved.adjustments) Object.assign(state.adjustments, saved.adjustments);
    } catch {
      // ignore malformed/unavailable storage
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ algorithm: state.algorithm, adjustments: state.adjustments })
      );
    } catch {
      // ignore quota/availability errors
    }
  }

  // ---------- UI <-> state sync ----------
  function syncControlsFromState() {
    el.algorithmSelect.value = state.algorithm;
    const a = state.adjustments;
    el.brightness.value = a.brightness;
    el.contrast.value = a.contrast;
    el.gamma.value = a.gamma;
    el.blackPoint.value = a.blackPoint;
    el.whitePoint.value = a.whitePoint;
    el.invert.checked = a.invert;
    updateOutputs();
    el.presetSelect.value = matchingPreset();
  }

  function updateOutputs() {
    el.brightnessOut.textContent = state.adjustments.brightness;
    el.contrastOut.textContent = state.adjustments.contrast;
    el.gammaOut.textContent = Number(state.adjustments.gamma).toFixed(2);
    el.blackPointOut.textContent = state.adjustments.blackPoint;
    el.whitePointOut.textContent = state.adjustments.whitePoint;
  }

  function matchingPreset() {
    for (const [key, preset] of Object.entries(PRESETS)) {
      if (key === "custom") continue;
      if (
        preset.brightness === state.adjustments.brightness &&
        preset.contrast === state.adjustments.contrast &&
        preset.gamma === state.adjustments.gamma &&
        preset.blackPoint === state.adjustments.blackPoint &&
        preset.whitePoint === state.adjustments.whitePoint
      ) {
        return key;
      }
    }
    return "custom";
  }

  // ---------- pipeline ----------
  function recomputeBase() {
    if (!state.img || !state.cropRect) return;
    const { x, y, size } = state.cropRect;
    extractCanvas.width = size;
    extractCanvas.height = size;
    extractCtx.imageSmoothingEnabled = false;
    extractCtx.clearRect(0, 0, size, size);
    extractCtx.drawImage(state.img, x, y, size, size, 0, 0, size, size);
    const imageData = extractCtx.getImageData(0, 0, size, size);
    const gray = toGrayscale(imageData);
    state.grayBase = resizeLanczosGray(gray, size, size, OUTPUT_SIZE, OUTPUT_SIZE);
    recomputeAdjusted();
  }

  function recomputeAdjusted() {
    if (!state.grayBase) return;
    state.adjusted = applyAdjustments(state.grayBase, state.adjustments);
    recomputeDither();
  }

  function recomputeDither() {
    if (!state.adjusted) return;
    state.dithered = DITHER_ALGORITHMS[state.algorithm].fn(state.adjusted, OUTPUT_SIZE, OUTPUT_SIZE);
    render();
  }

  function bufferToImageData(buf) {
    const imageData = new ImageData(OUTPUT_SIZE, OUTPUT_SIZE);
    const data = imageData.data;
    for (let i = 0, p = 0; i < buf.length; i++, p += 4) {
      const v = buf[i];
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
    return imageData;
  }

  function render() {
    if (!state.dithered) return;
    const imageData = bufferToImageData(state.dithered);
    el.preview1x.getContext("2d").putImageData(imageData, 0, 0);
    el.preview4x.getContext("2d").putImageData(imageData, 0, 0);
    renderComparisonGrid();
  }

  function renderComparisonGrid() {
    if (!state.adjusted) return;
    for (const [key, def] of Object.entries(DITHER_ALGORITHMS)) {
      const result = def.fn(state.adjusted, OUTPUT_SIZE, OUTPUT_SIZE);
      const imageData = bufferToImageData(result);
      comparisonCanvases[key].getContext("2d").putImageData(imageData, 0, 0);
      comparisonCanvases[key].parentElement.classList.toggle("active", key === state.algorithm);
    }
  }

  // ---------- crop ----------
  const cropper = new Cropper(el.cropStage, el.cropImage, el.cropBox, (rect) => {
    state.cropRect = rect;
    recomputeBase();
  });

  // ---------- file loading ----------
  function showError(message) {
    el.errorMessage.textContent = message;
    el.errorMessage.hidden = false;
  }

  function clearError() {
    el.errorMessage.hidden = true;
    el.errorMessage.textContent = "";
  }

  function loadFile(file) {
    if (!file || !file.type.startsWith("image/")) {
      showError("That doesn't look like an image file.");
      return;
    }
    clearError();
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = URL.createObjectURL(file);

    const img = new Image();
    img.onload = () => {
      state.img = img;
      el.cropImage.src = state.objectUrl;
      el.uploadSection.hidden = true;
      el.editorSection.hidden = false;
      // wait a frame so layout is settled before measuring the crop stage
      requestAnimationFrame(() => cropper.reset());
    };
    img.onerror = () => {
      showError("Couldn't decode that image. Try converting it to JPG or PNG first.");
    };
    img.src = state.objectUrl;
  }

  el.dropZone.addEventListener("click", () => el.fileInput.click());
  el.dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      el.fileInput.click();
    }
  });
  el.fileInput.addEventListener("change", () => {
    if (el.fileInput.files[0]) loadFile(el.fileInput.files[0]);
  });
  ["dragenter", "dragover"].forEach((evt) =>
    el.dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropZone.classList.add("drag-over");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    el.dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropZone.classList.remove("drag-over");
    })
  );
  el.dropZone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  });

  el.newImageBtn.addEventListener("click", () => {
    el.editorSection.hidden = true;
    el.uploadSection.hidden = false;
    el.fileInput.value = "";
    clearError();
  });

  // ---------- controls ----------
  el.presetSelect.addEventListener("change", () => {
    const preset = PRESETS[el.presetSelect.value];
    if (!preset) return;
    Object.assign(state.adjustments, {
      brightness: preset.brightness,
      contrast: preset.contrast,
      gamma: preset.gamma,
      blackPoint: preset.blackPoint,
      whitePoint: preset.whitePoint,
    });
    syncControlsFromState();
    recomputeAdjusted();
    saveSettings();
  });

  el.algorithmSelect.addEventListener("change", () => {
    state.algorithm = el.algorithmSelect.value;
    recomputeDither();
    saveSettings();
  });

  function bindSlider(input, key, parse) {
    input.addEventListener("input", () => {
      state.adjustments[key] = parse(input.value);
      if (key === "blackPoint" && state.adjustments.blackPoint >= state.adjustments.whitePoint) {
        state.adjustments.blackPoint = state.adjustments.whitePoint - 1;
        input.value = state.adjustments.blackPoint;
      }
      if (key === "whitePoint" && state.adjustments.whitePoint <= state.adjustments.blackPoint) {
        state.adjustments.whitePoint = state.adjustments.blackPoint + 1;
        input.value = state.adjustments.whitePoint;
      }
      updateOutputs();
      el.presetSelect.value = matchingPreset();
      recomputeAdjusted();
      saveSettings();
    });
  }

  bindSlider(el.brightness, "brightness", Number);
  bindSlider(el.contrast, "contrast", Number);
  bindSlider(el.gamma, "gamma", Number);
  bindSlider(el.blackPoint, "blackPoint", Number);
  bindSlider(el.whitePoint, "whitePoint", Number);

  el.invert.addEventListener("change", () => {
    state.adjustments.invert = el.invert.checked;
    recomputeAdjusted();
    saveSettings();
  });

  el.resetBtn.addEventListener("click", () => {
    Object.assign(state.adjustments, PRESETS.custom);
    state.adjustments.invert = false;
    syncControlsFromState();
    recomputeAdjusted();
    saveSettings();
  });

  // ---------- download ----------
  el.downloadBtn.addEventListener("click", () => {
    if (!state.dithered) return;
    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    canvas.getContext("2d").putImageData(bufferToImageData(state.dithered), 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "badge-128x128.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }, "image/png");
  });

  // ---------- send to badge (Web Serial) ----------
  function setSerialStatus(text, kind) {
    el.serialStatus.textContent = text;
    el.serialStatus.classList.remove("status-success", "status-warning", "status-error");
    if (kind) el.serialStatus.classList.add(`status-${kind}`);
  }

  function describeSerialError(err) {
    console.error("Serial error:", err);
    if (err instanceof WebSerialBadge.SerialUnsupportedError) return err.message;
    if (err instanceof WebSerialBadge.SerialSendError) {
      if (err.message === "No port selected.") return err.message;
      return `${err.message} Try a hard restart of the badge (unplug, press the reset panel on its lower-right edge, reconnect) and try again.`;
    }
    if (err && err.name === "NotFoundError") return "No port selected.";
    if (err && err.name === "NetworkError") {
      return (
        "Couldn't open the serial port. Try a hard restart of the badge — unplug the USB cable, " +
        "press the reset panel on its lower-right edge, wait a few seconds, then reconnect and try " +
        "again. If that doesn't help, make sure no other program (dc34-image, a terminal, another " +
        "browser tab) has the port open."
      );
    }
    return (err && err.message) || "Something went wrong talking to the badge — a hard restart of the badge (unplug, press the reset panel, reconnect) is worth trying.";
  }

  if (!WebSerialBadge.isSupported()) {
    el.sendSerialBtn.disabled = true;
    el.clearBadgeBtn.disabled = true;
    el.serialUnsupported.hidden = false;
  }

  el.sendSerialBtn.addEventListener("click", async () => {
    if (!state.dithered) return;
    el.sendSerialBtn.disabled = true;
    el.clearBadgeBtn.disabled = true;
    el.serialProgress.hidden = false;
    el.serialProgress.value = 0;
    setSerialStatus("Requesting serial port…");
    try {
      const result = await WebSerialBadge.sendImage(state.dithered, (sent, total) => {
        el.serialProgress.max = total;
        el.serialProgress.value = sent;
        setSerialStatus(`Sending chunk ${sent}/${total}…`);
      });
      if (result.success) {
        setSerialStatus("Sent — your badge should now show the new image.", "success");
      } else {
        setSerialStatus("All chunks sent, but the badge never confirmed. Check the display.", "warning");
      }
    } catch (err) {
      setSerialStatus(describeSerialError(err), "error");
    } finally {
      el.sendSerialBtn.disabled = false;
      el.clearBadgeBtn.disabled = false;
      el.serialProgress.hidden = true;
    }
  });

  el.clearBadgeBtn.addEventListener("click", async () => {
    el.sendSerialBtn.disabled = true;
    el.clearBadgeBtn.disabled = true;
    setSerialStatus("Requesting serial port…");
    try {
      await WebSerialBadge.clearImage();
      setSerialStatus("Badge reset to the DEF CON logo.", "success");
    } catch (err) {
      setSerialStatus(describeSerialError(err), "error");
    } finally {
      el.sendSerialBtn.disabled = false;
      el.clearBadgeBtn.disabled = false;
    }
  });

  // ---------- init ----------
  loadSettings();
  syncControlsFromState();
})();
