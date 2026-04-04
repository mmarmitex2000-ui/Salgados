// main.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let PosPrinter = null;
try { ({ PosPrinter } = require('electron-pos-printer')); } catch (_) {}

function createWindow() {
  const win = new BrowserWindow({
    fullscreen: true,
    kiosk: true,
    autoHideMenuBar: true,
    backgroundColor: '#fff8e1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false // deixe false se window.api ficar undefined
    }
  });

  // Atalho de manutenção: Ctrl+Shift+Q sai do kiosk/app
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && String(input.key).toLowerCase() === 'q') {
      app.quit();
    }
  });

  // >>> AQUI: aponte para o arquivo do painel/admin
  win.loadFile(path.join(__dirname, 'www', 'admin.html'));
  // Para depurar: win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ===== Utilidades =====
const ALLOWED_WIDTHS = new Set(['58mm', '70mm', '80mm', '82mm']);
const CHAR_WIDTH_MAP = { '58mm': 32, '70mm': 42, '80mm': 48, '82mm': 50 };

const isCopyName = (name) => /(copia|copiar|cópia|copy|\(2\)|copia1)/i.test(String(name || ''));
const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const toNum = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v ?? '0').replace(/[^\d,-]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};
const BRL = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function sanitizePayload(payload = {}) {
  const width = ALLOWED_WIDTHS.has(payload.width) ? payload.width : '80mm';
  const items = Array.isArray(payload.items) ? payload.items.map(it => ({
    title: String(it.title || it.name || '').slice(0, 120),
    category: String(it.category || '').slice(0, 120),
    flavor: String(it.flavor || it.description || it.desc || '').slice(0, 120),
    size: String(it.size || it.tamanho || it.variation || '').slice(0, 40),
    qty: Math.max(0, toNum(it.qty)),
    price: Math.max(0, toNum(it.price)),
    total: typeof it.total === 'number' ? Math.max(0, toNum(it.total)) : undefined,
    note: String(it.note || '').slice(0, 200)
  })) : [];

  const printers = Array.isArray(payload.printers) ? payload.printers.filter(Boolean).map(String).slice(0, 4) : undefined;
  const printerName = payload.printerName ? String(payload.printerName) : undefined;

  return {
    width,
    orderNo: payload.orderNo ? String(payload.orderNo).slice(0, 40) : '',
    orderType: payload.orderType ? String(payload.orderType).slice(0, 40) : '',
    fulfillment: payload.fulfillment ? String(payload.fulfillment).slice(0, 40) : '',
    isTakeaway: typeof payload.isTakeaway === 'boolean' ? payload.isTakeaway : undefined,
    items,
    lines: Array.isArray(payload.lines) ? payload.lines.map(l => String(l).slice(0, 200)) : undefined,
    total: typeof payload.total === 'number' ? Math.max(0, toNum(payload.total)) : undefined,
    printers,
    printerName
  };
}

// ===== IPC: listar impressoras =====
ipcMain.handle('list-printers', async () => {
  try {
    const list = (PosPrinter && typeof PosPrinter.getPrinters === 'function')
      ? await PosPrinter.getPrinters()
      : [];
    return (list || []).map(p => ({
      name: p.name,
      isDefault: !!p.isDefault,
      status: p.status ?? null,
      isCopy: isCopyName(p.name)
    }));
  } catch {
    return [];
  }
});

// ===== IPC: imprimir recibo =====
ipcMain.handle('print-receipt', async (_evt, rawPayload = {}) => {
  if (!PosPrinter || typeof PosPrinter.print !== 'function') {
    return { ok: false, results: [{ printerName: 'N/A', ok: false, error: 'electron-pos-printer não carregado' }] };
  }

  const payload = sanitizePayload(rawPayload);
  const width = payload.width;
  const INNER = CHAR_WIDTH_MAP[width] || 48;

  const BTN_TOP = '╭' + '─'.repeat(Math.max(0, INNER - 2)) + '╮';
  const BTN_BOT = '╰' + '─'.repeat(Math.max(0, INNER - 2)) + '╯';
  const center = (extra = {}) => ({ align: 'center', lineHeight: '1', ...extra });

  const wrap = (text, n) => {
    const out = [];
    const words = String(text || '').split(/\s+/).filter(Boolean);
    let cur = '';
    const push = s => out.push(s);
    for (let w of words) {
      while (w.length > n) { if (cur) { push(cur); cur = ''; } push(w.slice(0, n)); w = w.slice(n); }
      const cand = cur ? cur + ' ' + w : w;
      if (cand.length <= n) cur = cand; else { if (cur) push(cur); cur = w; }
    }
    if (cur) push(cur);
    return out.length ? out : [''];
  };

  const centerInside = (s, n = INNER - 2, shift = 0) => {
    s = stripAccents(String(s ?? ''));
    if (s.length >= n) return s.slice(0, n);
    let left = Math.floor((n - s.length) / 2) + shift;
    if (left < 0) left = 0;
    if (left > n - s.length) left = n - s.length;
    const right = n - s.length - left;
    return ' '.repeat(left) + s + ' '.repeat(right);
  };

  const qtyPriceTight = (qty, priceStr) => `Und ${qty} ${priceStr}`;

  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  const dt = `${pad2(now.getDate())}/${pad2(now.getMonth() + 1)}/${now.getFullYear()} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;

  const buildData = (headerTag) => {
    const data = [];
    data.push({ type: 'text', value: 'PASTERRY - PEDIDO', style: { ...center({ bold: true, fontSize: '24px' }) } });
    data.push({ type: 'text', value: 'WhatsApp: 11 99404-6432', style: { ...center({ bold: true, fontSize: '19px' }) } });
    data.push({ type: 'text', value: payload.orderNo ? `${payload.orderNo} ${dt}` : dt, style: { ...center({ fontSize: '18px' }) } });

    const raw = String(payload.orderType || payload.fulfillment || '');
    const t = stripAccents(raw.toLowerCase());
    const fulfillment =
      (['viagem', 'takeaway', 'take_away', 'para viagem', 'levar'].includes(t) || payload.isTakeaway === true) ? 'viagem' :
      (['local', 'comer no local', 'salao', 'mesa', 'dinein', 'dine_in', 'aqui', 'comer aqui'].includes(t) || payload.isTakeaway === false) ? 'local' : null;

    if (fulfillment) {
      const label = fulfillment === 'viagem' ? '*** PARA VIAGEM ***' : '*** COMER NO LOCAL ***';
      data.push({ type: 'text', value: label, style: { ...center({ bold: true, fontSize: '21px' }) } });
      data.push({ type: 'text', value: '-'.repeat(INNER), style: { ...center({ fontSize: '12px', whiteSpace: 'pre' }) } });
    }

    if (headerTag) {
      data.push({ type: 'text', value: headerTag, style: { ...center({ bold: true, fontSize: '18px' }) } });
      data.push({ type: 'text', value: '-'.repeat(INNER), style: { ...center({ fontSize: '12px', whiteSpace: 'pre' }) } });
    }

    if (payload.items && payload.items.length) {
      let soma = 0;
      for (const it of payload.items) {
        const fullName = String(it.title || '').trim();
        let category = String(it.category || '').trim();
        let flavor = String(it.flavor || '').trim();

        if (!category) {
          const parts = fullName.split(/\s+/).filter(Boolean);
          category = parts.slice(0, 2).join(' ');
          if (!flavor) flavor = parts.slice(2).join(' ');
        }

        const size = String(it.size || '').trim().toUpperCase();
        const descLine = [flavor, size].filter(Boolean).join(' ').trim().toUpperCase();

        const qty = toNum(it.qty);
        const unit = toNum(it.price);
        const totalItem = (typeof it.total === 'number') ? it.total : (unit * qty);
        soma += totalItem;

        const lines = [];
        lines.push(BTN_TOP);
        if (category) wrap(category.toLowerCase(), INNER - 2).forEach(l => lines.push(centerInside(l)));
        if (descLine) wrap(descLine.toLowerCase(), INNER - 2).forEach(l => lines.push(centerInside(l)));
        lines.push(centerInside(qtyPriceTight(qty, BRL(totalItem)), INNER - 2));
        lines.push(BTN_BOT);

        data.push({ type: 'text', value: lines.join('\n'), style: { ...center({ bold: true, fontSize: '16px', whiteSpace: 'pre' }) } });

        if (it.note) {
          wrap(`OBS: ${it.note}`, INNER - 2).forEach(l => {
            data.push({ type: 'text', value: l, style: { ...center({ bold: true, fontSize: '14px', whiteSpace: 'pre' }) } });
          });
        }
      }

      const totalFinal = (typeof payload.total === 'number') ? payload.total : soma;
      data.push({ type: 'text', value: '-'.repeat(INNER), style: { ...center({ fontSize: '12px', whiteSpace: 'pre' }) } });
      data.push({ type: 'text', value: `TOTAL DO PEDIDO: ${BRL(totalFinal)}`, style: { ...center({ bold: true, fontSize: '24px' }) } });
    } else if (payload.lines && payload.lines.length) {
      data.push({ type: 'text', value: payload.lines.join('\n'), style: { ...center({ fontSize: '16px', whiteSpace: 'pre' }) } });
    } else {
      data.push({ type: 'text', value: '(sem itens)', style: { ...center({ fontSize: '12px' }) } });
    }

    data.push({ type: 'text', value: 'OBRIGADO! BOM APETITE :)', style: { ...center({ bold: true, fontSize: '16px' }) } });
    data.push({ type: 'text', value: 'Tempo de preparo: 10 a 15 minutos', style: { ...center({ bold: true, fontSize: '14px' }) } });
    data.push({ type: 'text', value: '\n\n', style: {} });
    return data;
  };

  let printersTarget = [];
  if (Array.isArray(payload.printers) && payload.printers.length) {
    printersTarget = payload.printers.slice();
  } else if (payload.printerName) {
    printersTarget = [payload.printerName];
  } else {
    try {
      const list = (PosPrinter && typeof PosPrinter.getPrinters === 'function') ? await PosPrinter.getPrinters() : [];
      const names = (list || []).map(p => p.name).filter(Boolean);
      if (names.length) {
        const copy = names.find(n => isCopyName(n));
        const main = names.find(n => !isCopyName(n)) || names[0];
        printersTarget = copy ? [main, copy] : [main, main];
      } else {
        printersTarget = ['POSPrinter POS80', 'POSPrinter POS80 (Copiar 1)'];
      }
    } catch {
      printersTarget = ['POSPrinter POS80', 'POSPrinter POS80 (Copiar 1)'];
    }
  }

  printersTarget = printersTarget.sort((a, b) => Number(isCopyName(a)) - Number(isCopyName(b)));

  const results = [];
  for (const printerName of printersTarget) {
    try {
      const headerTag = isCopyName(printerName) ? '*** VIA COZINHA (CÓPIA) ***' : '*** VIA BALCÃO ***';
      const data = buildData(headerTag);
      await PosPrinter.print(data, {
        printerName,
        silent: true,
        preview: false,
        width,
        margin: '0 0 0 0',
        copies: 1,
        timeOutPerLine: 400
      });
      results.push({ printerName, ok: true });
    } catch (err) {
      results.push({ printerName, ok: false, error: String(err?.message || err) });
    }
  }

  return { ok: results.some(r => r.ok), results };
});