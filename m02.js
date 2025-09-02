// m02.js — dithers + gamma + paced banded sending (M02)
const SERVICE_UUID = "0000ff00-0000-1000-8000-00805f9b34fb";
const CHAR_UUID    = "0000ff02-0000-1000-8000-00805f9b34fb";

let gattChar = null;
let deviceRef = null;

const $ = (sel) => document.querySelector(sel);
const log = (m, cls="") => {
  const el = $("#log");
  if (!el) return;
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = m;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
};
const setStatus = (s, cls="") => {
  const el = $("#status");
  if (!el) return;
  el.className = cls;
  el.textContent = s;
};

/* ---------- Image pipeline ---------- */
function toGrayscale(imgData) {
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i+1], b = d[i+2];
    const y = (0.299*r + 0.587*g + 0.114*b) | 0;
    d[i] = d[i+1] = d[i+2] = y;
  }
  return imgData;
}
function applyGamma(imgData, gamma = 1.0) {
  if (gamma === 1 || gamma <= 0) return imgData;
  const d = imgData.data, inv = 1 / gamma;
  for (let i = 0; i < d.length; i += 4) {
    const y = d[i] / 255, g = Math.min(255, Math.max(0, Math.pow(y, inv) * 255));
    d[i] = d[i+1] = d[i+2] = g|0;
  }
  return imgData;
}
function threshold(imgData, t=128) {
  const d=imgData.data;
  for (let i=0;i<d.length;i+=4){ const v=d[i]<t?0:255; d[i]=d[i+1]=d[i+2]=v; d[i+3]=255; }
  return imgData;
}
function ditherFSSerpentine(imgData) {
  const w = imgData.width, h = imgData.height, d = imgData.data;
  const lum = new Float32Array(w*h);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) lum[y*w+x] = d[(y*w+x)*4];
  const out = new Uint8ClampedArray(w*h);
  for (let y=0;y<h;y++) {
    const L2R = (y % 2) === 0;
    if (L2R) {
      for (let x=0;x<w;x++) {
        const i=y*w+x, oldp=lum[i], newp=oldp<128?0:255, err=oldp-newp; out[i]=newp;
        if (x+1<w)  lum[i+1]+=err*7/16;
        if (y+1<h){ if (x>0) lum[i+w-1]+=err*3/16; lum[i+w]+=err*5/16; if (x+1<w) lum[i+w+1]+=err*1/16; }
      }
    } else {
      for (let x=w-1;x>=0;x--) {
        const i=y*w+x, oldp=lum[i], newp=oldp<128?0:255, err=oldp-newp; out[i]=newp;
        if (x-1>=0) lum[i-1]+=err*7/16;
        if (y+1<h){ if (x+1<w) lum[i+w+1]+=err*3/16; lum[i+w]+=err*5/16; if (x-1>=0) lum[i+w-1]+=err*1/16; }
      }
    }
  }
  for (let i=0;i<out.length;i++){ const v=out[i], p=i*4; d[p]=d[p+1]=d[p+2]=v; d[p+3]=255; }
  return imgData;
}
function ditherAtkinson(imgData) {
  const w = imgData.width, h = imgData.height, d = imgData.data;
  const lum = new Float32Array(w*h);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) lum[y*w+x] = d[(y*w+x)*4];
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
    const i=y*w+x, oldp=lum[i], newp=oldp<128?0:255, err=(oldp-newp)/8;
    if (x+1<w) lum[i+1]+=err; if (x+2<w) lum[i+2]+=err;
    if (y+1<h){ if (x>0) lum[i+w-1]+=err; lum[i+w]+=err; if (x+1<w) lum[i+w+1]+=err; }
    if (y+2<h) lum[i+2*w]+=err;
    const p=i*4; d[p]=d[p+1]=d[p+2]=newp; d[p+3]=255;
  }
  return imgData;
}
const BAYER_4 = [
  [ 0,  8,  2, 10],
  [12,  4, 14,  6],
  [ 3, 11,  1,  9],
  [15,  7, 13,  5],
];
const BAYER_8 = [
  [ 0,32, 8,40, 2,34,10,42],
  [48,16,56,24,50,18,58,26],
  [12,44, 4,36,14,46, 6,38],
  [60,28,52,20,62,30,54,22],
  [ 3,35,11,43, 1,33, 9,41],
  [51,19,59,27,49,17,57,25],
  [15,47, 7,39,13,45, 5,37],
  [63,31,55,23,61,29,53,21],
];
function ditherOrdered(imgData, matrix) {
  const w=imgData.width,h=imgData.height,d=imgData.data,n=matrix.length,den=n*n;
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){
    const idx=(y*w+x)*4, v=d[idx], t=(matrix[y%n][x%n]+0.5)*(255/den), out=v<t?0:255;
    d[idx]=d[idx+1]=d[idx+2]=out; d[idx+3]=255;
  }
  return imgData;
}

/* ---------- Pack to 1bpp, MSB-first, 1=black ---------- */
function packMonochrome(imgData) {
  const w=imgData.width, h=imgData.height, rowBytes = Math.ceil(w/8);
  const out = new Uint8Array(rowBytes*h), d=imgData.data;
  for (let y=0;y<h;y++){
    for (let xb=0; xb<rowBytes; xb++){
      let byte=0;
      for (let b=0;b<8;b++){
        const x=xb*8+b; byte <<= 1;
        let bit=0;
        if (x<w){ const v=d[(y*w+x)*4]; bit = (v===0)?1:0; }
        byte |= bit;
      }
      out[y*rowBytes+xb]=byte;
    }
  }
  return { bytes: out, rowBytes, h };
}

/* ---------- BLE write with pacing ---------- */
async function sleep(ms){ if (ms>0) await new Promise(r=>setTimeout(r, ms)); }

async function writeChunked(characteristic, data, chunkSize, chunkDelayMs=0) {
  for (let i = 0; i < data.length; i += chunkSize) {
    const slice = data.slice(i, Math.min(i + chunkSize, data.length));
    await characteristic.writeValueWithResponse(slice);
    if (chunkDelayMs) await sleep(chunkDelayMs);
  }
}

async function writeRasterBanded(characteristic, monoBytes, rowBytes, height, opts) {
  const { chunkSize=160, bandRows=32, bandDelayMs=12, chunkDelayMs=0 } = opts || {};
  // ESC @
  await writeChunked(characteristic, new Uint8Array([0x1B, 0x40]), chunkSize, chunkDelayMs);

  if (bandRows && bandRows > 0) {
    for (let y = 0; y < height; y += bandRows) {
      const rows = Math.min(bandRows, height - y);
      const xL = rowBytes & 0xff, xH = (rowBytes >> 8) & 0xff;
      const yL = rows & 0xff,     yH = (rows >> 8) & 0xff;
      const header = new Uint8Array([0x1D, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
      const start = y * rowBytes, end = start + rows * rowBytes;
      const body  = monoBytes.subarray(start, end);

      await writeChunked(characteristic, header, chunkSize, chunkDelayMs);
      await writeChunked(characteristic, body,   chunkSize, chunkDelayMs);

      await sleep(bandDelayMs); // pacing between bands (reduces stutter/banding)
    }
  } else {
    const xL = rowBytes & 0xff, xH = (rowBytes >> 8) & 0xff;
    const yL = height & 0xff,   yH = (height >> 8) & 0xff;
    const header = new Uint8Array([0x1D, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
    await writeChunked(characteristic, header, chunkSize, chunkDelayMs);
    await writeChunked(characteristic, monoBytes, chunkSize, chunkDelayMs);
  }

  await writeChunked(characteristic, new Uint8Array([0x0A,0x0A]), chunkSize, chunkDelayMs); // small feed
}

/* ---------- Connect / Print ---------- */
async function connect() {
  setStatus("Step 1/4: Opening chooser…");
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: [SERVICE_UUID],
  }).catch(err => {
    if (err && err.name === "NotFoundError") {
      throw new Error("No device selected or none discovered. Ensure the printer is ON, in range, and not connected to your phone.");
    }
    throw err;
  });

  setStatus("Step 2/4: Connecting GATT…");
  const server  = await device.gatt.connect();
  setStatus("Step 3/4: Getting service…");
  const service = await server.getPrimaryService(SERVICE_UUID);
  setStatus("Step 4/4: Getting characteristic…");
  gattChar      = await service.getCharacteristic(CHAR_UUID);

  deviceRef = device;
  deviceRef.addEventListener("gattserverdisconnected", () => {
    gattChar = null;
    setStatus("Disconnected. Click Connect again.", "err");
  });

  setStatus("Connected. Ready to print.", "ok");
  log("Connected to " + (device.name || "(unnamed device)"));
}

function ensureTargetCanvasFromCanvas(srcCanvas, targetWidth){
  const scale = targetWidth / srcCanvas.width;
  const w = targetWidth, h = Math.max(1, Math.round(srcCanvas.height * scale));
  const tmpCanvas = document.createElement("canvas");
  tmpCanvas.width = w; tmpCanvas.height = h;
  const ctx = tmpCanvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(srcCanvas, 0, 0, w, h);
  return { tmpCanvas, ctx, w, h };
}

async function printCanvas(canvas){
  if (!gattChar) { setStatus("Not connected. Click Connect first.", "err"); return; }

  const targetWidth = parseInt($("#width")?.value || "384", 10);
  const { tmpCanvas, ctx, w, h } = ensureTargetCanvasFromCanvas(canvas, targetWidth);
  let imgData = ctx.getImageData(0,0,w,h);

  // preprocess
  imgData = toGrayscale(imgData);
  const gamma = parseFloat($("#gamma")?.value || "1.0");
  imgData = applyGamma(imgData, gamma);

  // dithering
  const mode = $("#dither")?.value || "fs-serp";
  if (mode === "fs-serp") imgData = ditherFSSerpentine(imgData);
  else if (mode === "atkinson") imgData = ditherAtkinson(imgData);
  else if (mode === "bayer4") imgData = ditherOrdered(imgData, BAYER_4);
  else if (mode === "bayer8") imgData = ditherOrdered(imgData, BAYER_8);
  else if (mode === "threshold") {
    const t = parseInt($("#thresh")?.value || "128", 10);
    imgData = threshold(imgData, t);
  }

  // pack & send
  const { bytes, rowBytes, h: height } = packMonochrome(imgData);

  const chunkSize    = parseInt($("#chunk")?.value || "160", 10);
  const bandRows     = parseInt($("#bandRows")?.value || "0", 10);
  const bandDelayMs  = parseInt($("#bandDelay")?.value || "0", 10);
  const chunkDelayMs = parseInt($("#chunkDelay")?.value || "0", 10);

  log(`Send ${w}x${h} | rowBytes=${rowBytes} | chunk=${chunkSize} | bandRows=${bandRows} | bandDelay=${bandDelayMs}ms | chunkDelay=${chunkDelayMs}ms`);
  await writeRasterBanded(gattChar, bytes, rowBytes, height, { chunkSize, bandRows, bandDelayMs, chunkDelayMs });
  setStatus(`Printed ${w}x${h}.`, "ok");
}

/* ---------- UI wiring ---------- */
function loadFileToCanvas(file, canvas){
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const targetW = parseInt($("#width")?.value || "384", 10);
    const scale = targetW / img.width;
    canvas.width = targetW;
    canvas.height = Math.round(img.height * scale);
    ctx.fillStyle = "#fff"; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
  };
  img.onerror = () => { setStatus("Failed to load image.", "err"); };
  img.src = url;
}

document.addEventListener("DOMContentLoaded", () => {
  const canvas = $("#canvas");
  $("#file")?.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) loadFileToCanvas(f, canvas);
  });
  $("#connect")?.addEventListener("click", async () => {
    try { await connect(); }
    catch (e) { setStatus("Connect error: " + e.message, "err"); log(String(e), "err"); }
  });
  $("#print")?.addEventListener("click", async () => {
    try { await printCanvas(canvas); }
    catch (e) { setStatus("Print error: " + e.message, "err"); log(String(e), "err"); }
  });
});
