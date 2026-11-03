import assert from 'node:assert/strict';
import { scratchNota } from '../lib/api.mjs';
import { openNota, cellContent, cellHtml, focusCell, localGetJson } from '../lib/app.mjs';

const PASTE_HTML = '<h1>x</h1><b>y</b><i>z</i><script>window.__pwned = 1</script>';

/** paste `<h1>x</h1><b>y</b><i>z</i><script>` into a cell -> cell HTML contains `<strong>y</strong><em>z</em>` and no h1 or script. */
export default {
  id: 'paste-keeps-basic-markup', title: 'paste keeps only text, br, strong, em',
  async run({ page, adapter, api, record, cleanup }) {
    const nota = scratchNota('paste-keeps-basic-markup');
    await api.putNota(nota);
    cleanup(() => api.deleteNota(nota.id));
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openNota(page, nota.title);
    await focusCell(page, 'h2');
    // A synthetic paste with a real DataTransfer; BlockEditor.handlePaste reads text/html then text/plain.
    await cellContent(page, 'h2').evaluate((el, html) => {
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', 'x y z');
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
    }, PASTE_HTML);
    await page.waitForTimeout(200);
    const html = await cellHtml(page, 'h2');
    record('cell_html_after_paste', html);
    assert.ok(html.includes('<strong>y</strong><em>z</em>'), `strong/em kept: ${html}`);
    assert.ok(!/<h1[\s>]/i.test(html), `no h1 element: ${html}`);
    assert.ok(!/<script/i.test(html), `no script: ${html}`);
    assert.ok(!/<b>|<i>/.test(html), 'b/i were converted, not kept');
    // the h1 text survives as text + <br> (block tags become line breaks, pasteSanitize.js visit())
    assert.ok(/x<br>/.test(html), `h1 content flattened to text + <br>: ${html}`);
    assert.equal(await page.evaluate(() => window.__pwned), undefined, 'script did not run');
    // the paste reached the nota (updateBlockContent) — localStorage copy carries it
    const stored = (await localGetJson(page, 'gs_nota_db')).notas.find((n) => n.id === nota.id).content;   // per-user key
    assert.ok(stored.includes('<strong>y</strong><em>z</em>') && !/<h1/.test(stored));
  },
};
