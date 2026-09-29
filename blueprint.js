/* =========================================================================
   BLUEPRINT GENERATOR — blueprint.js
   Upload an image → OpenRouter vision model analyses it → produces a
   structured text blueprint → save as .txt.

   v3: adds a "Measured Colour Palette" section (section 9) generated
   locally from actual image pixels, appended after the AI content.
   AI's own colour description (section 5) is preserved unchanged.

   The API key lives in localStorage on this device only.
   ========================================================================= */

(function () {
  "use strict";

  /* =======================================================================
     DOM
     ======================================================================= */
  const fileInput         = document.getElementById("fileInput");
  const btnChooseImage    = document.getElementById("btnChooseImage");
  const btnUploadTop      = document.getElementById("btnUploadTop");
  const emptyState        = document.getElementById("emptyState");
  const previewWrap       = document.getElementById("previewWrap");
  const previewImg        = document.getElementById("previewImg");
  const fileMeta          = document.getElementById("fileMeta");

  const openrouterKey     = document.getElementById("openrouterKey");
  const btnSaveKey        = document.getElementById("btnSaveKey");
  const btnClearKey       = document.getElementById("btnClearKey");
  const btnRefreshModels  = document.getElementById("btnRefreshModels");
  const pricingFilter     = document.getElementById("pricingFilter");
  const providerFilter    = document.getElementById("providerFilter");
  const modelList         = document.getElementById("modelList");
  const detailLevel       = document.getElementById("detailLevel");
  const modelCount        = document.getElementById("modelCount");

  const btnAnalyse        = document.getElementById("btnAnalyse");
  const analyseStatus     = document.getElementById("analyseStatus");

  const projectName       = document.getElementById("projectName");
  const manifestPreview   = document.getElementById("manifestPreview");
  const btnCopyManifest   = document.getElementById("btnCopyManifest");
  const btnExportTxt      = document.getElementById("btnExportTxt");

  const btnResetAll       = document.getElementById("btnResetAll");

  /* =======================================================================
     STATE
     ======================================================================= */
  let sourceImage = null;
  let sourceFile  = null;
  let currentModel = "";
  let blueprintText = "";

  let allVisionModels = [];
  let savedModelId = "";
  let measuredPalette = [];   // populated at upload time

  const KEY_STORAGE = "blueprint_openrouter_key";
  const MODEL_STORAGE = "blueprint_openrouter_model";

  /* =======================================================================
     STATUS LINE HELPERS
     ======================================================================= */
  function showStatus(msg, kind) {
    analyseStatus.classList.remove("hidden", "error", "success");
    if (kind === "error") analyseStatus.classList.add("error");
    if (kind === "success") analyseStatus.classList.add("success");
    analyseStatus.textContent = msg;
  }

  function hideStatus() {
    analyseStatus.classList.add("hidden");
    analyseStatus.textContent = "";
  }

  /* =======================================================================
     COLOUR PALETTE EXTRACTION — pure client-side, no AI
     Samples the image on an offscreen canvas, quantises pixels to group
     near-identical colours, counts frequency, returns top N.
     ======================================================================= */
  function extractPalette(img, maxColors) {
    const maxEdge = 200; // small enough to be fast, big enough for accuracy
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));

    const c = document.createElement("canvas");
    c.width = tw;
    c.height = th;
    const cx = c.getContext("2d", { willReadFrequently: true });
    cx.drawImage(img, 0, 0, tw, th);

    let data;
    try {
      data = cx.getImageData(0, 0, tw, th).data;
    } catch (e) {
      // Canvas tainted or blocked — return empty gracefully
      return [];
    }

    const counts = new Map();
    const quantize = 24; // channel bucket size — groups similar tones

    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 128) continue; // skip transparent pixels

      let r = data[i];
      let g = data[i + 1];
      let b = data[i + 2];

      // Quantise
      r = Math.min(255, Math.round(r / quantize) * quantize);
      g = Math.min(255, Math.round(g / quantize) * quantize);
      b = Math.min(255, Math.round(b / quantize) * quantize);

      const key = r + "," + g + "," + b;
      counts.set(key, (counts.get(key) || 0) + 1);
    }

    const totalSampled = tw * th;
    const entries = Array.from(counts.entries())
      .map(([key, count]) => {
        const parts = key.split(",");
        return {
          r: Number(parts[0]),
          g: Number(parts[1]),
          b: Number(parts[2]),
          count: count,
          percent: (count / totalSampled) * 100
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, maxColors);

    return entries;
  }

  function toHex(r, g, b) {
    const h = (v) => {
      const s = Math.max(0, Math.min(255, v)).toString(16);
      return s.length === 1 ? "0" + s : s;
    };
    return "#" + (h(r) + h(g) + h(b)).toUpperCase();
  }

  function padRight(str, n) {
    str = String(str);
    while (str.length < n) str += " ";
    return str;
  }

  function buildPaletteSection(palette) {
    const hr2 = "-".repeat(64);
    const lines = [];
    lines.push(hr2);
    lines.push("  9. MEASURED COLOUR PALETTE");
    lines.push(hr2);
    lines.push("  Extracted directly from image pixels — not AI-generated.");
    lines.push("  Top colours by coverage after grouping similar tones.");
    lines.push("");

    if (!palette || palette.length === 0) {
      lines.push("  No palette could be extracted.");
      lines.push("");
      return lines.join("\n");
    }

    lines.push("  " + padRight("Rank", 6) + padRight("Hex", 10) +
               padRight("RGB", 22) + "Coverage");
    lines.push("  " + padRight("----", 6) + padRight("-------", 10) +
               padRight("-------------------", 22) + "--------");

    palette.forEach((entry, i) => {
      const hex = toHex(entry.r, entry.g, entry.b);
      const rgbStr = `rgb(${entry.r}, ${entry.g}, ${entry.b})`;
      const pct = entry.percent.toFixed(2) + "%";
      lines.push("  " + padRight((i + 1), 6) + padRight(hex, 10) +
                 padRight(rgbStr, 22) + pct);
    });

    lines.push("");
    return lines.join("\n");
  }

  /* =======================================================================
     IMAGE UPLOAD
     ======================================================================= */
  function openPicker() { fileInput.click(); }
  btnChooseImage.addEventListener("click", openPicker);
  btnUploadTop.addEventListener("click", openPicker);

  fileInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    if (file.type && !file.type.startsWith("image/")) {
      showStatus("That file is not an image.", "error");
      return;
    }

    sourceFile = file;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        sourceImage = img;
        previewImg.src = ev.target.result;
        emptyState.classList.add("hidden");
        previewWrap.classList.remove("hidden");

        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const mb = (file.size / 1024 / 1024).toFixed(2);
        const mime = (file.type && file.type.split("/")[1])
          ? file.type.split("/")[1].toUpperCase()
          : "IMAGE";
        fileMeta.textContent = `${w} × ${h} px  ·  ${mime}  ·  ${mb} MB`;

        // Extract the palette now, ready for the next analysis
        try {
          measuredPalette = extractPalette(img, 10);
        } catch (err) {
          measuredPalette = [];
        }

        hideStatus();
      };
      img.onerror = () => showStatus("Could not load that image.", "error");
      img.src = ev.target.result;
    };
    reader.onerror = () => showStatus("Could not read that file.", "error");
    reader.readAsDataURL(file);
  });

  /* =======================================================================
     KEY STORAGE
     ======================================================================= */
  function loadKey() {
    try {
      const k = localStorage.getItem(KEY_STORAGE);
      if (k) openrouterKey.value = k;
    } catch (e) {}
  }

  btnSaveKey.addEventListener("click", () => {
    const k = openrouterKey.value.trim();
    if (!k) {
      showStatus("Paste your OpenRouter API key first.", "error");
      return;
    }
    if (!k.startsWith("sk-or-")) {
      showStatus("That doesn't look like an OpenRouter key (should start with sk-or-).", "error");
      return;
    }
    try {
      localStorage.setItem(KEY_STORAGE, k);
      showStatus("API key saved to this device.", "success");
      setTimeout(hideStatus, 2000);
    } catch (e) {
      showStatus("Could not save key.", "error");
    }
  });

  btnClearKey.addEventListener("click", () => {
    if (!confirm("Remove saved API key from this device?")) return;
    try { localStorage.removeItem(KEY_STORAGE); } catch (e) {}
    openrouterKey.value = "";
    allVisionModels = [];
    modelList.innerHTML = '<option value="">Tap Refresh Models</option>';
    providerFilter.innerHTML = '<option value="all" selected>All providers</option>';
    currentModel = "";
    updateModelCount(0);
    showStatus("Key cleared.", "success");
    setTimeout(hideStatus, 1500);
  });

  /* =======================================================================
     MODEL LIST
     ======================================================================= */
  function isFreeModel(m) {
    const p = m.pricing || {};
    const promptPrice = parseFloat(p.prompt || 0);
    const completionPrice = parseFloat(p.completion || 0);
    return promptPrice === 0 && completionPrice === 0;
  }

  function getProviderName(m) {
    if (m.id && m.id.includes("/")) {
      const prefix = m.id.split("/")[0];
      return prefix
        .replace(/[-_]/g, " ")
        .split(" ")
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
    }
    return "Other";
  }

  function updateModelCount(n) {
    if (modelCount) modelCount.textContent = String(n);
  }

  function rebuildModelDropdown() {
    const pricingMode = pricingFilter.value;
    const providerMode = providerFilter.value;

    let filtered = allVisionModels.slice();

    if (pricingMode === "free") {
      filtered = filtered.filter(m => isFreeModel(m));
    } else if (pricingMode === "paid") {
      filtered = filtered.filter(m => !isFreeModel(m));
    }

    if (providerMode !== "all") {
      filtered = filtered.filter(m => getProviderName(m) === providerMode);
    }

    filtered.sort((a, b) => {
      const fa = isFreeModel(a) ? 0 : 1;
      const fb = isFreeModel(b) ? 0 : 1;
      if (fa !== fb) return fa - fb;
      return (a.name || "").localeCompare(b.name || "");
    });

    updateModelCount(filtered.length);

    const frag = document.createDocumentFragment();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = filtered.length
      ? `Select a model (${filtered.length} shown)`
      : "No models match filters";
    frag.appendChild(placeholder);

    let restoreId = null;

    for (const m of filtered) {
      const opt = document.createElement("option");
      opt.value = m.id;

      let priceHint = "";
      const p = m.pricing || {};
      const promptPrice = parseFloat(p.prompt || 0);
      if (isFreeModel(m)) {
        priceHint = " — free";
      } else if (promptPrice > 0) {
        const perM = (promptPrice * 1000000).toFixed(2);
        priceHint = ` — $${perM}/M in`;
      }

      opt.textContent = (m.name || m.id) + priceHint;
      frag.appendChild(opt);

      if (m.id === savedModelId || m.id === currentModel) {
        restoreId = m.id;
      }
    }

    modelList.innerHTML = "";
    modelList.appendChild(frag);

    if (restoreId) {
      modelList.value = restoreId;
      currentModel = restoreId;
    } else {
      currentModel = "";
    }
  }

  function populateProviderFilter() {
    const set = new Set();
    for (const m of allVisionModels) {
      set.add(getProviderName(m));
    }

    const providers = Array.from(set).sort((a, b) => a.localeCompare(b));
    const current = providerFilter.value || "all";

    providerFilter.innerHTML = "";
    const allOpt = document.createElement("option");
    allOpt.value = "all";
    allOpt.textContent = "All providers";
    providerFilter.appendChild(allOpt);

    for (const prov of providers) {
      const opt = document.createElement("option");
      opt.value = prov;
      opt.textContent = prov;
      providerFilter.appendChild(opt);
    }

    if (current && providers.includes(current)) {
      providerFilter.value = current;
    } else {
      providerFilter.value = "all";
    }
  }

  btnRefreshModels.addEventListener("click", async () => {
    const btnLabel = btnRefreshModels.textContent;
    btnRefreshModels.textContent = "Loading…";
    btnRefreshModels.disabled = true;

    try {
      const url = "https://openrouter.ai/api/v1/models?input_modalities=image";
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      const models = json.data || [];

      const visionModels = models.filter(m => {
        const arch = m.architecture || {};
        const im = arch.input_modalities || [];
        return im.includes("image");
      });

      if (visionModels.length === 0) {
        allVisionModels = [];
        modelList.innerHTML = '<option value="">No vision models found</option>';
        updateModelCount(0);
        showStatus("No vision-capable models returned.", "error");
        return;
      }

      allVisionModels = visionModels;

      populateProviderFilter();
      rebuildModelDropdown();

      showStatus(`${visionModels.length} vision models loaded.`, "success");
      setTimeout(hideStatus, 2200);
    } catch (e) {
      console.warn("Model fetch failed:", e);
      allVisionModels = [];
      modelList.innerHTML = '<option value="">Failed to load — check connection</option>';
      updateModelCount(0);
      showStatus("Could not load model list. " + (e.message || "Check your connection."), "error");
    } finally {
      btnRefreshModels.textContent = btnLabel;
      btnRefreshModels.disabled = false;
    }
  });

  pricingFilter.addEventListener("change", () => {
    if (allVisionModels.length) rebuildModelDropdown();
  });

  providerFilter.addEventListener("change", () => {
    if (allVisionModels.length) rebuildModelDropdown();
  });

  modelList.addEventListener("change", () => {
    currentModel = modelList.value;
    savedModelId = currentModel;
    if (currentModel) {
      try { localStorage.setItem(MODEL_STORAGE, currentModel); } catch (e) {}
    }
  });

  /* =======================================================================
     BUILD THE PROMPT
     ======================================================================= */
  function buildPrompt() {
    const detail = detailLevel.value;

    const baseInstruction =
      "You are analysing an image to produce a comprehensive written blueprint " +
      "that a blind reader must be able to fully reconstruct the scene from. " +
      "The reader will NEVER see the image — only your text. " +
      "Be specific, factual, and exhaustively detailed. Avoid hedging. " +
      "Do not use markdown — write plain text suitable for a .txt file. " +
      "Use the exact numbered-section structure below, with the section headers " +
      "kept identical. Use plain hyphens or equals signs for separators.";

    const structureInstruction =
      "Produce your output in this structure:\n\n" +
      "BLUEPRINT MANIFEST\n" +
      "[equals line]\n" +
      "  Project      : (leave blank — filled automatically)\n" +
      "  Source image : (leave blank)\n" +
      "  [equals line]\n\n" +
      "1. IMAGE SPECIFICATIONS\n" +
      "[dash line]\n" +
      "  Resolution    : (w × h px, from the image)\n" +
      "  Aspect ratio  : (reduced ratio and decimal)\n" +
      "  Orientation   : (Landscape / Portrait / Square)\n" +
      "  Total pixels  : (number, and megapixels)\n\n" +
      "2. OVERALL COMPOSITION\n" +
      "[dash line]\n" +
      "  A paragraph describing what the image is, its vantage point, mood, " +
      "and general character. 4–8 sentences.\n\n" +
      "3. OBJECT INVENTORY\n" +
      "[dash line]\n" +
      "  List every distinct object or region. Number them [1], [2], [3]… " +
      "In order of visual prominence. For each:\n" +
      "      Position   : where in the frame (use nine-part grid: top-left, " +
      "top-center, top-right, middle-left, center, middle-right, bottom-left, " +
      "bottom-center, bottom-right; give approximate percentage if possible)\n" +
      "      Size       : approximate width and height as % of the image\n" +
      "      Appearance : full physical description — colour, material, shape, " +
      "texture, condition, orientation, state\n" +
      "      Relationships : how it overlaps or abuts other objects\n\n" +
      "4. TEXT VISIBLE IN THE IMAGE\n" +
      "[dash line]\n" +
      "  Quote every piece of text you can read, exactly, with its location. " +
      "If no text, say 'No text visible.'\n\n" +
      "5. COLOUR & LIGHTING\n" +
      "[dash line]\n" +
      "  Dominant colours, palette feel, direction and quality of light, " +
      "shadows, exposure, white balance.\n\n" +
      "6. SPATIAL RELATIONSHIPS\n" +
      "[dash line]\n" +
      "  How the objects arrange relative to each other; what is in front, " +
      "behind, overlapping, touching.\n\n" +
      "7. NOTABLE DETAILS\n" +
      "[dash line]\n" +
      "  Anything unusual, out of place, or worth flagging. Bullet-style " +
      "with hyphens.\n\n" +
      "8. RECONSTRUCTION SUMMARY\n" +
      "[dash line]\n" +
      "  A single comprehensive paragraph that lets a blind reader fully " +
      "imagine the scene. This is the most important section. Do not " +
      "reference 'the image' — describe the scene as if narrating reality.\n\n" +
      "Do NOT number any further sections. Stop after section 8.";

    let lengthInstruction = "";
    if (detail === "standard") {
      lengthInstruction = "Target length: thorough but concise. Cover everything, but do not pad.";
    } else if (detail === "high") {
      lengthInstruction = "Target length: long and detailed. Elaborate on every object, every colour, every relationship. Do not abbreviate.";
    } else if (detail === "exhaustive") {
      lengthInstruction = "Target length: as long as necessary to describe everything a sighted person would see. Leave nothing out. If there are twenty objects, describe all twenty. Do not summarise away detail.";
    }

    return baseInstruction + "\n\n" + structureInstruction + "\n\n" + lengthInstruction;
  }

  /* =======================================================================
     ANALYSE
     ======================================================================= */
  btnAnalyse.addEventListener("click", async () => {
    if (!sourceImage) {
      showStatus("Upload an image first.", "error");
      return;
    }
    const key = (localStorage.getItem(KEY_STORAGE) || "").trim();
    if (!key) {
      showStatus("Save your OpenRouter API key first.", "error");
      return;
    }
    if (!currentModel) {
      showStatus("Pick a vision model from the dropdown first.", "error");
      return;
    }

    btnAnalyse.disabled = true;
    const originalLabel = btnAnalyse.textContent;
    btnAnalyse.textContent = "Analysing…";
    showStatus("Preparing image…", "");
    manifestPreview.textContent = "Analysing image… this can take 10–60 seconds depending on the model.";

    try {
      const dataUrl = await downscaleImage(sourceImage, 1536, 0.85);

      showStatus("Sending to " + prettyModelName(currentModel) + "…", "");

      const prompt = buildPrompt();

      const payload = {
        model: currentModel,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } }
            ]
          }
        ]
      };

      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errText = await res.text();
        let msg = "HTTP " + res.status;
        try {
          const j = JSON.parse(errText);
          if (j.error && j.error.message) msg += " — " + j.error.message;
        } catch (e) {
          msg += " — " + errText.slice(0, 200);
        }
        throw new Error(msg);
      }

      const json = await res.json();
      const text =
        json.choices && json.choices[0] && json.choices[0].message &&
        json.choices[0].message.content || "";

      if (!text) throw new Error("Model returned an empty response.");

      blueprintText = text.trim();

      const finalText = buildFinalManifest(blueprintText);
      manifestPreview.textContent = finalText;

      showStatus("Blueprint generated successfully.", "success");
      setTimeout(hideStatus, 3000);

    } catch (e) {
      console.warn("Analyse failed:", e);
      const msg = e.message || String(e);
      manifestPreview.textContent = "Analysis failed:\n\n" + msg;
      showStatus("Analysis failed. See output panel for details.", "error");
      blueprintText = "";
    } finally {
      btnAnalyse.disabled = false;
      btnAnalyse.textContent = originalLabel;
    }
  });

  /* =======================================================================
     IMAGE DOWNSCALE
     ======================================================================= */
  function downscaleImage(img, maxEdge, quality) {
    return new Promise((resolve) => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const scale = Math.min(1, maxEdge / Math.max(w, h));
      const tw = Math.max(1, Math.round(w * scale));
      const th = Math.max(1, Math.round(h * scale));

      const c = document.createElement("canvas");
      c.width = tw;
      c.height = th;
      const cx = c.getContext("2d");
      cx.drawImage(img, 0, 0, tw, th);
      resolve(c.toDataURL("image/jpeg", quality));
    });
  }

  /* =======================================================================
     BUILD FINAL MANIFEST
     ======================================================================= */
  function buildFinalManifest(aiText) {
    const hr  = "=".repeat(64);
    const hr2 = "-".repeat(64);
    const name = (projectName.value.trim() || "blueprint");
    const now = new Date();
    const stamp = now.getFullYear() + "-" +
                  String(now.getMonth() + 1).padStart(2, "0") + "-" +
                  String(now.getDate()).padStart(2, "0") + " " +
                  String(now.getHours()).padStart(2, "0") + ":" +
                  String(now.getMinutes()).padStart(2, "0") + ":" +
                  String(now.getSeconds()).padStart(2, "0");

    const w = sourceImage ? sourceImage.naturalWidth : 0;
    const h = sourceImage ? sourceImage.naturalHeight : 0;
    const fname = sourceFile ? sourceFile.name : "unknown";
    const fsize = sourceFile ? (sourceFile.size / 1024 / 1024).toFixed(2) + " MB" : "unknown";
    const ftype = (sourceFile && sourceFile.type && sourceFile.type.split("/")[1])
      ? sourceFile.type.split("/")[1].toUpperCase()
      : "IMAGE";

    const pad = (label, value) => {
      while (label.length < 16) label += " ";
      return "  " + label + ": " + value;
    };

    const header = [
      hr,
      "  BLUEPRINT MANIFEST",
      hr,
      pad("Project", name),
      pad("Generated", stamp),
      pad("Source file", fname),
      pad("Source size", fsize),
      pad("Source format", ftype),
      pad("Source res", w + " x " + h + " px"),
      pad("Analysed by", prettyModelName(currentModel)),
      hr,
      ""
    ].join("\n");

    // Strip AI's leading header if it echoed one
    let body = aiText;
    const startIdx = body.indexOf("1. IMAGE SPECIFICATIONS");
    if (startIdx > 0) body = body.slice(startIdx);

    // Strip AI's own trailing "END OF MANIFEST" block if it added one
    const endIdx = body.lastIndexOf("END OF MANIFEST");
    if (endIdx > 0) {
      const before = body.slice(0, endIdx);
      // Remove any trailing separator line(s) and whitespace
      body = before.replace(/[\s\n]*[=\-]{5,}[\s\n]*$/, "").trimEnd();
    } else {
      body = body.trimEnd();
    }

    // Measured palette — generated locally from image pixels
    const paletteSection = buildPaletteSection(measuredPalette);

    const footer = [
      "",
      hr,
      "  END OF MANIFEST",
      hr,
      "",
      "This document was generated from an image by an AI vision model.",
      "Section 9 (Measured Colour Palette) was extracted directly from",
      "image pixels, not generated by AI. All other sections were produced",
      "by the model named above.",
      "",
      "All measurements are expressed in the source image's native pixel",
      "grid with origin at the top-left corner (x increases rightwards,",
      "y increases downwards). Percentages are relative to the full frame.",
      ""
    ].join("\n");

    return header + body + "\n\n" + paletteSection + "\n" + footer;
  }

  function prettyModelName(id) {
    if (!id) return "unknown";
    const parts = id.split("/");
    const name = parts[parts.length - 1] || id;
    return name
      .replace(/[-_]/g, " ")
      .replace(/:\w+$/, "")
      .split(" ")
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  /* =======================================================================
     COPY / EXPORT
     ======================================================================= */
  btnCopyManifest.addEventListener("click", async () => {
    const text = manifestPreview.textContent;
    if (!text || text.startsWith("No blueprint yet") || text.startsWith("Analysing")) {
      showStatus("Nothing to copy yet.", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      const orig = btnCopyManifest.textContent;
      btnCopyManifest.textContent = "Copied!";
      setTimeout(() => { btnCopyManifest.textContent = orig; }, 1200);
      showStatus("Copied to clipboard.", "success");
      setTimeout(hideStatus, 1500);
    } catch (e) {
      prompt("Copy the manifest below:", text);
    }
  });

  btnExportTxt.addEventListener("click", () => {
    const text = manifestPreview.textContent;
    if (!text || text.startsWith("No blueprint yet") || text.startsWith("Analysing")) {
      showStatus("Nothing to save yet.", "error");
      return;
    }
    const base = (projectName.value.trim() || "blueprint");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = base + "-blueprint.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showStatus("Saved as " + base + "-blueprint.txt", "success");
    setTimeout(hideStatus, 2500);
  });

  /* =======================================================================
     RESET
     ======================================================================= */
  btnResetAll.addEventListener("click", () => {
    if (!confirm("Reset everything? Clears the current image and blueprint. Your API key stays saved.")) return;
    sourceImage = null;
    sourceFile = null;
    blueprintText = "";
    measuredPalette = [];
    previewImg.removeAttribute("src");
    previewWrap.classList.add("hidden");
    emptyState.classList.remove("hidden");
    fileInput.value = "";
    fileMeta.textContent = "—";
    manifestPreview.textContent = "No blueprint yet. Upload an image, save a key, pick a model, then tap Analyse Image.";
    hideStatus();
  });

  /* =======================================================================
     INIT
     ======================================================================= */
  function init() {
    loadKey();
    try {
      const saved = localStorage.getItem(MODEL_STORAGE);
      if (saved) {
        savedModelId = saved;
        currentModel = saved;
      }
    } catch (e) {}
  }

  init();

})();