const APPS_SCRIPT_URL = 'PASTE_YOUR_WEB_APP_URL_HERE';
const video = document.getElementById('video');
const overlayCanvas = document.getElementById('overlayCanvas');
const overlayCtx = overlayCanvas.getContext('2d');

const startBtn = document.getElementById('startBtn');
const captureBtn = document.getElementById('captureBtn');
const autoBtn = document.getElementById('autoBtn');
const clearBtn = document.getElementById('clearBtn');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');
const alignStatus = document.getElementById('alignStatus');
const tbody = document.querySelector('#dataTable tbody');

let stream = null;
let scannedRows = [];
let autoMode = false;
let autoTimer = null;
let processing = false;
let cvReady = false;
let lastDetectedRect = null;
let stableAlignedCount = 0;

startBtn.addEventListener('click', startCamera);
captureBtn.addEventListener('click', captureDetectedDocument);
autoBtn.addEventListener('click', toggleAutoMode);
clearBtn.addEventListener('click', clearRows);
saveBtn.addEventListener('click', saveRows);

waitForOpenCV();

function setStatus(msg) {
  statusEl.textContent = msg;
}

function setAlignment(ok) {
  alignStatus.textContent = ok ? 'Aligned' : 'Not aligned';
  alignStatus.classList.toggle('good', ok);
  alignStatus.classList.toggle('bad', !ok);
  captureBtn.disabled = !ok;
}

function waitForOpenCV() {
  const t = setInterval(() => {
    if (window.cv && cv.Mat) {
      clearInterval(t);
      cvReady = true;
      setStatus('Ready');
    }
  }, 300);
}

async function startCamera() {
  try {
    if (!cvReady) {
      setStatus('OpenCV loading...');
      return;
    }

    if (stream) stopCamera();

    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });

    video.srcObject = stream;
    await video.play();
    requestAnimationFrame(scanLoop);
    setStatus('Camera started');
  } catch (err) {
    setStatus('Camera error: ' + err.message);
  }
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
}

function toggleAutoMode() {
  autoMode = !autoMode;
  autoBtn.textContent = `Auto Scan: ${autoMode ? 'ON' : 'OFF'}`;

  if (autoMode) {
    autoTimer = setInterval(() => {
      if (stableAlignedCount >= 4 && !processing) {
        captureDetectedDocument();
      }
    }, 1800);
    setStatus('Auto scan enabled');
  } else {
    clearInterval(autoTimer);
    autoTimer = null;
    setStatus('Auto scan disabled');
  }
}

function scanLoop() {
  if (!stream || !video.videoWidth) {
    requestAnimationFrame(scanLoop);
    return;
  }

  detectAndDraw();
  requestAnimationFrame(scanLoop);
}

function detectAndDraw() {
  const rect = video.getBoundingClientRect();
  overlayCanvas.width = rect.width;
  overlayCanvas.height = rect.height;
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  const detected = detectLargestQuad();
  if (!detected) {
    lastDetectedRect = null;
    stableAlignedCount = 0;
    setAlignment(false);
    return;
  }

  const blurOk = checkSharpness();
  const areaOk = detected.area > 90000;

  if (blurOk && areaOk) {
    lastDetectedRect = detected;
    stableAlignedCount++;
    drawPolygon(detected.points, '#00ff66', 4);
    setAlignment(true);
  } else {
    lastDetectedRect = null;
    stableAlignedCount = 0;
    setAlignment(false);
  }
}

function detectLargestQuad() {
  try {
    const temp = document.createElement('canvas');
    temp.width = video.videoWidth;
    temp.height = video.videoHeight;
    const ctx = temp.getContext('2d');
    ctx.drawImage(video, 0, 0);

    const src = cv.imread(temp);
    const gray = new cv.Mat();
    const blur = new cv.Mat();
    const edges = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    cv.Canny(blur, edges, 75, 180);
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let best = null;
    let bestArea = 0;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

      if (approx.rows === 4) {
        const area = cv.contourArea(approx);
        if (area > bestArea) {
          bestArea = area;
          if (best) best.delete();
          best = approx.clone();
        }
      }

      approx.delete();
      cnt.delete();
    }

    src.delete();
    gray.delete();
    blur.delete();
    edges.delete();
    contours.delete();
    hierarchy.delete();

    if (!best) return null;

    const points = [];
    for (let i = 0; i < 4; i++) {
      points.push({
        x: best.intPtr(i, 0)[0],
        y: best.intPtr(i, 0)[1]
      });
    }
    best.delete();

    return {
      points: sortCorners(points),
      area: bestArea
    };
  } catch (e) {
    return null;
  }
}

function sortCorners(points) {
  const sum = points.map(p => p.x + p.y);
  const diff = points.map(p => p.x - p.y);

  return [
    points[sum.indexOf(Math.min(...sum))],
    points[diff.indexOf(Math.max(...diff))],
    points[sum.indexOf(Math.max(...sum))],
    points[diff.indexOf(Math.min(...diff))]
  ];
}

function drawPolygon(points, color, lineWidth) {
  const sx = overlayCanvas.width / video.videoWidth;
  const sy = overlayCanvas.height / video.videoHeight;

  overlayCtx.strokeStyle = color;
  overlayCtx.lineWidth = lineWidth;
  overlayCtx.beginPath();
  overlayCtx.moveTo(points[0].x * sx, points[0].y * sy);
  for (let i = 1; i < points.length; i++) {
    overlayCtx.lineTo(points[i].x * sx, points[i].y * sy);
  }
  overlayCtx.closePath();
  overlayCtx.stroke();
}

function checkSharpness() {
  const temp = document.createElement('canvas');
  temp.width = 320;
  temp.height = 240;
  const ctx = temp.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, temp.width, temp.height);
  const img = ctx.getImageData(0, 0, temp.width, temp.height).data;

  let diffSum = 0;
  for (let i = 4; i < img.length; i += 16) {
    diffSum += Math.abs(img[i] - img[i - 4]);
  }
  return diffSum > 120000;
}

async function captureDetectedDocument() {
  if (!lastDetectedRect || processing) return;
  processing = true;

  try {
    setStatus('Capturing...');

    const full = document.createElement('canvas');
    full.width = video.videoWidth;
    full.height = video.videoHeight;
    const fctx = full.getContext('2d');
    fctx.drawImage(video, 0, 0);

    const xs = lastDetectedRect.points.map(p => p.x);
    const ys = lastDetectedRect.points.map(p => p.y);
    const minX = Math.max(0, Math.min(...xs));
    const minY = Math.max(0, Math.min(...ys));
    const maxX = Math.min(full.width, Math.max(...xs));
    const maxY = Math.min(full.height, Math.max(...ys));

    const doc = document.createElement('canvas');
    doc.width = maxX - minX;
    doc.height = maxY - minY;
    const dctx = doc.getContext('2d');
    dctx.drawImage(full, minX, minY, doc.width, doc.height, 0, 0, doc.width, doc.height);

    const qrCanvas = cropRelative(doc, 0.72, 0.04, 0.22, 0.20);
    const uidCanvas = cropRelative(doc, 0.73, 0.18, 0.22, 0.10);

    const row1Canvas = cropRelative(doc, 0.05, 0.34, 0.90, 0.16);
    const row2Canvas = cropRelative(doc, 0.05, 0.56, 0.90, 0.16);

    const qrText = readQR(qrCanvas);
    preprocess(uidCanvas, 155);

    const row1Cells = splitRow(row1Canvas, 7);
    const row2Cells = splitRow(row2Canvas, 7);

    const cellImages = [];
    for (let i = 0; i < 7; i++) {
      preprocess(row1Cells[i], 165);
      cellImages.push(toBase64(row1Cells[i]));
    }
    for (let i = 0; i < 6; i++) {
      preprocess(row2Cells[i], 165);
      cellImages.push(toBase64(row2Cells[i]));
    }

    const payload = {
      action: 'scan',
      qrText,
      uidImageBase64: toBase64(uidCanvas),
      cellImages
    };

    setStatus('Reading UID and marks...');
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    const data = JSON.parse(text);

    if (!data.success) throw new Error(data.message || 'Scan failed');

    const row = data.parsed || {};
    row.total = calcTotal(row);
    row.flag = validateRow(row);

    if (!row.uid && !hasAnyMarks(row)) {
      setStatus('No valid data found');
      return;
    }

    if (row.uid && scannedRows.some(r => String(r.uid) === String(row.uid))) {
      setStatus(`Duplicate UID skipped: ${row.uid}`);
      return;
    }

    scannedRows.push(row);
    renderTable();
    setStatus('Scan added');
  } catch (err) {
    setStatus('Scan error: ' + err.message);
  } finally {
    processing = false;
  }
}

function cropRelative(source, rx, ry, rw, rh) {
  const x = Math.floor(source.width * rx);
  const y = Math.floor(source.height * ry);
  const w = Math.floor(source.width * rw);
  const h = Math.floor(source.height * rh);

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  ctx.drawImage(source, x, y, w, h, 0, 0, w, h);
  return out;
}

function splitRow(canvas, parts) {
  const gap = Math.floor(canvas.width * 0.006);
  const partW = Math.floor((canvas.width - gap * (parts - 1)) / parts);
  const cells = [];

  for (let i = 0; i < parts; i++) {
    const x = i * (partW + gap);
    const out = document.createElement('canvas');
    out.width = partW;
    out.height = canvas.height;
    const ctx = out.getContext('2d');
    ctx.drawImage(canvas, x, 0, partW, canvas.height, 0, 0, partW, canvas.height);

    const inner = document.createElement('canvas');
    inner.width = Math.floor(partW * 0.75);
    inner.height = Math.floor(canvas.height * 0.60);
    const ictx = inner.getContext('2d');

    const ix = Math.floor(partW * 0.12);
    const iy = Math.floor(canvas.height * 0.25);
    const iw = Math.floor(partW * 0.75);
    const ih = Math.floor(canvas.height * 0.60);

    ictx.drawImage(out, ix, iy, iw, ih, 0, 0, inner.width, inner.height);
    cells.push(inner);
  }
  return cells;
}

function preprocess(canvas, threshold) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;

  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = gray > threshold ? 255 : 0;
    d[i] = v; d[i + 1] = v; d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}

function readQR(canvas) {
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(img.data, canvas.width, canvas.height);
    return code ? code.data : '';
  } catch {
    return '';
  }
}

function toBase64(canvas) {
  return canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
}

function hasAnyMarks(row) {
  for (let i = 1; i <= 13; i++) {
    if (row['q' + i] !== '' && row['q' + i] !== null && row['q' + i] !== undefined) return true;
  }
  return false;
}

function calcTotal(row) {
  let sum = 0;
  for (let i = 1; i <= 13; i++) {
    const n = Number(row['q' + i]);
    if (!isNaN(n)) sum += n;
  }
  return sum;
}

function validateRow(row) {
  if (!row.uid) return 'CHECK';
  for (let i = 1; i <= 13; i++) {
    const v = row['q' + i];
    if (v === '') continue;
    const n = Number(v);
    if (isNaN(n) || n > 99) return 'CHECK';
  }
  return 'OK';
}

function renderTable() {
  tbody.innerHTML = '';

  scannedRows.forEach((row, index) => {
    row.total = calcTotal(row);
    row.flag = validateRow(row);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td contenteditable="true" data-index="${index}" data-field="uid">${safe(row.uid)}</td>
      <td contenteditable="true" data-index="${index}" data-field="q1">${safe(row.q1)}</td>
      <td contenteditable="true" data-index="${index}" data-field="q2">${safe(row.q2)}</td>
      <td contenteditable="true" data-index="${index}" data-field="q3">${safe(row.q3)}</td>
      <td contenteditable="true" data-index="${index}" data-field="q4">${safe(row.q4)}</td>
      <td contenteditable="true" data-index="${index}" data-field="q5">${safe(row.q5)}</td>
      <td contenteditable="true" data-index="${index}" data-field="q6">${safe(row.q6)}</td>
      <td contenteditable="true" data-index="${index}" data-field="q7">${safe(row.q7)}</td>
      <td contenteditable="true" data-index="${index}" data-field="q8">${safe(row.q8)}</td>
      <td contenteditable="true" data-index="${index}" data-field="q9">${safe(row.q9)}</td>
      <td contenteditable="true" data-index="${index}" data-field="q10">${safe(row.q10)}</td>
      <td contenteditable="true" data-index="${index}" data-field="q11">${safe(row.q11)}</td>
      <td contenteditable="true" data-index="${index}" data-field="q12">${safe(row.q12)}</td>
      <td contenteditable="true" data-index="${index}" data-field="q13">${safe(row.q13)}</td>
      <td class="total-cell">${row.total}</td>
      <td class="${row.flag === 'OK' ? 'flag-ok' : 'flag-check'}">${row.flag}</td>
      <td><button class="delete-btn" onclick="deleteRow(${index})">Delete</button></td>
    `;
    tbody.appendChild(tr);
  });

  bindEditable();
}

function bindEditable() {
  document.querySelectorAll('#dataTable td[contenteditable="true"]').forEach(td => {
    td.addEventListener('input', onCellInput);
  });
}

function onCellInput(e) {
  const cell = e.target;
  const index = Number(cell.dataset.index);
  const field = cell.dataset.field;
  let value = cell.textContent.trim();

  if (field === 'uid') value = value.replace(/[^\d]/g, '');
  else value = value.replace(/[^\d]/g, '');

  scannedRows[index][field] = value === '' ? '' : (field === 'uid' ? value : Number(value));
  scannedRows[index].total = calcTotal(scannedRows[index]);
  scannedRows[index].flag = validateRow(scannedRows[index]);

  const rowEl = cell.parentElement;
  rowEl.querySelector('.total-cell').textContent = scannedRows[index].total;
  rowEl.children[15].textContent = scannedRows[index].flag;
  rowEl.children[15].className = scannedRows[index].flag === 'OK' ? 'flag-ok' : 'flag-check';
}

function deleteRow(index) {
  scannedRows.splice(index, 1);
  renderTable();
}
window.deleteRow = deleteRow;

function clearRows() {
  scannedRows = [];
  renderTable();
  setStatus('All rows cleared');
}

async function saveRows() {
  try {
    if (!scannedRows.length) {
      setStatus('No rows to save');
      return;
    }

    setStatus('Saving...');
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'save',
        rows: scannedRows
      })
    });

    const text = await res.text();
    const data = JSON.parse(text);
    if (!data.success) throw new Error(data.message || 'Save failed');

    setStatus(`Saved ${data.saved} rows successfully`);
    scannedRows = [];
    renderTable();
  } catch (err) {
    setStatus('Save error: ' + err.message);
  }
}

function safe(v) {
  return v === undefined || v === null ? '' : String(v);
}
