// Shared helpers for all pages.
const fmt = {
  money: (bani) => `${(bani / 100).toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} lei`,
  time: (ms) => new Date(ms).toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' }),
  dateTime: (ms) => new Date(ms).toLocaleString('ro-RO'),
  status: { new: 'nouă', accepted: 'confirmată', served: 'servită', rejected: 'respinsă' },
};

const $ = (sel, root = document) => root.querySelector(sel);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Socket.IO emit with ack, as a promise that rejects on { error }.
function call(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(15000).emit(event, payload, (err, res) => {
      if (err) return reject(new Error('Fără conexiune la server.'));
      if (res && res.error) return reject(new Error(res.error));
      resolve(res);
    });
  });
}

function toast(msg) {
  let box = $('.toast');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toast';
    document.body.appendChild(box);
  }
  const d = document.createElement('div');
  d.textContent = msg;
  box.appendChild(d);
  setTimeout(() => d.remove(), 4000);
}

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    return null;
  }
  return null;
}

function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    o.frequency.value = 880;
    o.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.15);
  } catch {
    /* audio not allowed yet */
  }
}

// Parses "12,50" or "12.50" lei into bani.
function parseLei(s) {
  const n = Number(String(s).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

function dialog(html) {
  const d = document.createElement('div');
  d.className = 'dialog';
  d.innerHTML = `<div>${html}</div>`;
  d.addEventListener('click', (e) => { if (e.target === d) d.remove(); });
  document.body.appendChild(d);
  return d;
}
