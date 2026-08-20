const APPS_SCRIPT_URL = 'PASTE_YOUR_WEB_APP_URL_HERE';

const video = document.getElementById('video');
const fullCanvas = document.getElementById('fullCanvas');
const fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true });

const startBtn = document.getElementById('startBtn');
const scanBtn = document.getElementById('scanBtn');
const autoBtn = document.getElementById('autoBtn');
const clearBtn = document.getElementById('clearBtn');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');
const tbody = document.querySelector('#dataTable tbody');

let stream = null;
let autoMode = false;
let autoTimer = null;
let isScanning = false;
let scannedRows = [];
let lastSignature = '';

startBtn.addEventListener('click', startCamera);
scanBtn.addEventListener('click', () => scanFrame(false));
autoBtn.addEventListener('click', toggleAutoMode);
clearBtn.addEventListener('click', clearRows);
saveBtn.addEventListener('click', saveRows);

function setStatus(msg) {
  statusEl.textContent = msg;
}

async function startCamera() {
  try {
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
      if (!isScanning) scanFrame(true);
    }, 1600);
    setStatus('Auto scan enabled');
  } else {
    clearInterval(autoTimer);
    autoTimer = null;
    setStatus('Auto scan disabled');
  }
}

async function scanFrame(isAuto) {
  if (!video.videoWidth || !video.videoHeight) {
    setStatus('Camera not ready');
    return;
  }

  if (isScanning) return;
  isScanning = true;

  try {
    setStatus('Capturing frame...');

    fullCanvas.width = video.videoWidth;
    fullCanvas.height = video.videoHeight;
    fullCtx.drawImage(video, 0, 0, fullCanvas.width, fullCanvas.height);

    const uidCanvas = cropUIDRegion(fullCanvas);
    const tableCanvas = cropTableRegion(fullCanvas);

    preprocess(uidCanvas, 170);
    preprocess(tableCanvas, 165);

    const signature = buildSignature(uidCanvas, tableCanvas);
    if (isAuto && signature === lastSignature) {
      isScanning = false;
      return;
    }
    lastSignature = signature;

    const uidImageBase64 = uidCanvas.toDataURL('image/jpeg', 0.92).split(',')[1];
    const tableImageBase64 = tableCanvas.toDataURL('image/jpeg', 0.92).split(',')[1];

    setStatus('Sending OCR request...');
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify({
        action: 'scan',
        uidImageBase64,
        tableImageBase64
      })
    });

    const text = await res.text();
    const data = JSON.parse(text);

    if (!data.success) throw new Error(data.message || 'Scan failed');

    const row = data.parsed || {};
    row.rawUIDText = data.rawUIDText || '';
    row.rawTableText = data.rawTableText || '';
    row.total = calcTotal(row);

    if (!row.uid && !hasAnyMarks(row)) {
      setStatus('No valid UID/marks detected');
      return;
    }

    if (row.uid && scannedRows.some(r => String(r.uid) === String(row.uid))) {
      setStatus(`Duplicate UID skipped: ${row.uid}`);
      return;
    }

    normalizeRow(row);
    scannedRows.push(row);
    renderTable();
    setStatus(`Scan added${row.uid ? ' - UID ' + row.uid : ''}`);
  } catch (err) {
    setStatus('Scan error: ' + err.message);
  } finally {
    isScanning = false;
  }
}

function cropUIDRegion(source) {
  const sw = source.width;
  const sh = source.height;

  const x = Math.floor(sw * 0.66);
  const y = Math.floor(sh * 0.05);
  const w = Math.floor(sw * 0.26);
  const h = Math.floor(sh * 0.13);

  return cropCanvas(source, x, y, w, h);
}

function cropTableRegion(source) {
  const sw = source.width;
  const sh = source.height;

  const x = Math.floor(sw * 0.07);
  const y = Math.floor(sh * 0.19);
  const w = Math.floor(sw * 0.86);
  const h = Math.floor(sh * 0.18);

  return cropCanvas(source, x, y, w, h);
}

function cropCanvas(source, x, y, w, h) {
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, x, y, w, h, 0, 0, w, h);
  return out;
}

function preprocess(canvas, threshold = 170) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;

  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = gray > threshold ? 255 : 0;
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
  }

  ctx.putImageData(img, 0, 0);
}

function buildSignature(uidCanvas, tableCanvas) {
  return miniHash(uidCanvas) + '_' + miniHash(tableCanvas);
}

function miniHash(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const w = Math.min(40, canvas.width);
  const h = Math.min(40, canvas.height);
  const data = ctx.getImageData(0, 0, w, h).data;

  let sum = 0;
  for (let i = 0; i < data.length; i += 24) {
    sum += data[i];
  }
  return String(sum);
}

function normalizeRow(row) {
  for (let i = 1; i <= 13; i++) {
    const key = 'q' + i;
    const v = String(row[key] ?? '').trim();
    row[key] = v === '' ? '' : onlyNumberOrBlank(v);
  }
  row.uid = String(row.uid ?? '').trim();
  row.total = calcTotal(row);
}

function onlyNumberOrBlank(v) {
  const cleaned = String(v).replace(/[^\d]/g, '');
  return cleaned === '' ? '' : Number(cleaned);
}

function hasAnyMarks(row) {
  for (let i = 1; i <= 13; i++) {
    const v = row['q' + i];
    if (v !== '' && v !== null && v !== undefined) return true;
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

function renderTable() {
  tbody.innerHTML = '';

  scannedRows.forEach((row, index) => {
    row.total = calcTotal(row);

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
      <td><button class="delete-btn" onclick="deleteRow(${index})">Delete</button></td>
    `;
    tbody.appendChild(tr);
  });

  bindEditable();
}

function bindEditable() {
  document.querySelectorAll('#dataTable td[contenteditable="true"]').forEach(td => {
    td.addEventListener('input', onCellInput);
    td.addEventListener('blur', onCellBlur);
  });
}

function onCellInput(e) {
  const cell = e.target;
  const index = Number(cell.dataset.index);
  const field = cell.dataset.field;
  scannedRows[index][field] = cell.textContent.trim();

  if (field !== 'uid') {
    scannedRows[index][field] = onlyNumberOrBlank(scannedRows[index][field]);
  }

  scannedRows[index].total = calcTotal(scannedRows[index]);

  const totalCell = cell.parentElement.querySelector('.total-cell');
  if (totalCell) totalCell.textContent = scannedRows[index].total;
}

function onCellBlur(e) {
  const cell = e.target;
  const index = Number(cell.dataset.index);
  const field = cell.dataset.field;

  if (field === 'uid') {
    scannedRows[index][field] = String(scannedRows[index][field] ?? '').replace(/[^\d]/g, '');
    cell.textContent = scannedRows[index][field];
  } else {
    const val = onlyNumberOrBlank(scannedRows[index][field]);
    scannedRows[index][field] = val;
    cell.textContent = val === '' ? '' : val;
  }

  scannedRows[index].total = calcTotal(scannedRows[index]);
  const totalCell = cell.parentElement.querySelector('.total-cell');
  if (totalCell) totalCell.textContent = scannedRows[index].total;
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

    const payloadRows = scannedRows.map(r => ({
      uid: r.uid || '',
      q1: r.q1 || '',
      q2: r.q2 || '',
      q3: r.q3 || '',
      q4: r.q4 || '',
      q5: r.q5 || '',
      q6: r.q6 || '',
      q7: r.q7 || '',
      q8: r.q8 || '',
      q9: r.q9 || '',
      q10: r.q10 || '',
      q11: r.q11 || '',
      q12: r.q12 || '',
      q13: r.q13 || '',
      total: calcTotal(r),
      rawUIDText: r.rawUIDText || '',
      rawTableText: r.rawTableText || ''
    }));

    setStatus('Saving to sheet...');
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify({
        action: 'save',
        rows: payloadRows
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
