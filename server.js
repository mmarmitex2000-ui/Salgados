const express = require('express');
const cors = require('cors');
const { PosPrinter } = require('electron-pos-printer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Mesmas funções que você já tem no main.js (sanitize, buildData etc.)
// 👉 Cola aqui suas funções: sanitizePayload, buildData, etc.
// Exemplo de handler:

app.post('/print', async (req, res) => {
  try {
    const payload = req.body; // já vem do site
    // usa a mesma lógica do seu ipcMain.handle('print-receipt')
    const width = payload.width || '80mm';
    const INNER = 48; // ajuste conforme sua tabela CHAR_WIDTH_MAP
    const data = buildData(payload, INNER); // sua função que monta o array pro PosPrinter

    const printers = await PosPrinter.getPrinters().catch(() => []);
    const names = (printers || []).map(p => p.name).filter(Boolean);
    const targets = names.length ? names : ['POSPrinter POS80', 'POSPrinter POS80 (Copiar 1)'];

    const results = [];
    for (const printerName of targets) {
      try {
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
    res.json({ ok: results.some(r => r.ok), results });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/printers', async (_req, res) => {
  try {
    const list = await PosPrinter.getPrinters().catch(() => []);
    res.json(list.map(p => ({ name: p.name, isDefault: !!p.isDefault, status: p.status ?? null })));
  } catch {
    res.json([]);
  }
});

const PORT = 3333;
app.listen(PORT, () => console.log('Print service on http://localhost:' + PORT));