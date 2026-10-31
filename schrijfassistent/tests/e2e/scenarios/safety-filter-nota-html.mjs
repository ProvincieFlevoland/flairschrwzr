import assert from 'node:assert/strict';
import { scratchNota, notaHtml } from '../lib/api.mjs';
import { openNota, cellContent, cellHtml, cellText, putCalls, waitFor, sleep, localGet } from '../lib/app.mjs';

// Every vector below executes or loads something when it is put into the live DOM as it is; each sets a window probe.
const PAYLOAD = [
  '<p onclick="window.__pwn_onclick=1" class="keep">klik hier</p>',
  '<script>window.__pwn_script=1</script>',
  '<img src="x" onerror="window.__pwn_img=1">',
  '<a href="javascript:window.__pwn_a=1">een link</a>',
  '<iframe srcdoc="<p>x</p>"></iframe>',
  '<style>body{display:none}</style>',
  '<svg onload="window.__pwn_svg=1"><script>window.__pwn_svgscript=1</script></svg>',
  '<span class="reviewer-highlight" data-note-id="note-j34b" style="background-color: rgba(59, 130, 246, 0.19); border-bottom: 2px solid rgb(59, 130, 246);">gemarkeerd</span>',
  '<span style="background:url(javascript:window.__pwn_css=1)">stijl</span>',
  '<p>staart</p>',
  // classes and styles outside the allow-list (host utilities, app layout, a viewport-covering overlay)
  '<span class="fixed inset-0 z-50 reviewer-highlight" data-note-id="note-j34b-2" style="position:fixed;left:0;top:0;width:100vw;height:100vh;background-color:#ffffff;z-index:2147483647">overlay</span>',
  '<div class="editor-cell expanded">kaart</div>',
].join('');

// entity text at the top level of a cell is decoded by parseContentToBlocks (textContent) and must stay text
const ENTITY_H3 = '<p>ok</p>&lt;img src=x onerror=window.__pwn_entity=1&gt;<p>na</p>&lt;svg onload=window.__pwn_entity_svg=1&gt;';
const ENTITY_H4 = '&lt;img src=x onerror=window.__pwn_entity2=1&gt; &amp; &lt;b&gt;geen vet&lt;/b&gt;';

/** a stored nota that carries script, event handlers, javascript: links, an iframe,
 *  a style element, svg and a style with url(javascript:) is opened and saved -> nothing executes, the editor holds the text and the allowed markup
 *  (p, span.reviewer-highlight with its inline style) and the PUT carries the cleaned content. A cleaned nota is the filter's only visible effect;
 *  The stored-notas round trip proves the filter is a no-op on the notas that exist today. */
export default {
  id: 'safety-filter-nota-html', title: 'safety filter: hostile nota HTML is neutralised on load, allowed markup stays',
  async run({ page, adapter, api, rec, record, cleanup }) {
    const nota = scratchNota('safety-filter-nota-html', { content: notaHtml({ h2: PAYLOAD, h3: ENTITY_H3, h4: ENTITY_H4 }) });
    await api.putNota(nota);
    cleanup(() => api.deleteNota(nota.id));
    await adapter.enter(page, { name: 'Test Auteur', role: 'auteur' });
    await openNota(page, nota.title);
    await sleep(800);                                    // let a late onerror / script fire if the filter let it through
    const probes = await page.evaluate(() => Object.keys(window).filter((k) => k.startsWith('__pwn')));
    record('probes_fired', probes);
    assert.deepEqual(probes, [], 'nothing from the nota executed');

    const html = await cellHtml(page, 'h2');
    record('cell_html_h2', html);
    for (const bad of ['<script', '<iframe', '<style', '<svg', '<img', '<a ', 'onclick', 'onerror', 'onload', 'javascript:']) {
      assert.ok(!html.includes(bad), `${bad} is gone from the editor: ${html}`);
    }
    assert.equal((html.match(/<p[ >]/g) || []).length, 2, 'both paragraphs survive');
    assert.ok(html.includes('<p>klik hier</p>'), `the event handler is dropped and so is the class outside the allow-list: ${html}`);
    assert.ok(html.includes('<p>staart</p>'));
    for (const t of ['een link', 'gemarkeerd', 'stijl']) assert.ok(html.includes(t), `the text "${t}" survives the unwrapping`);
    const span = cellContent(page, 'h2').locator('span.reviewer-highlight[data-note-id="note-j34b"]');
    assert.equal(await span.count(), 1, 'the reviewer span stays');
    assert.match((await span.getAttribute('style')) || '', /background-color/, 'with its inline style');
    const plainStyleSpan = await cellContent(page, 'h2').evaluate((el) => [...el.querySelectorAll('span')].filter((s) => s.textContent === 'stijl').map((s) => s.getAttribute('style')));
    assert.deepEqual(plainStyleSpan, [null], 'the style with url(javascript:) is dropped, the span stays');

    // the overlay span keeps only the allowed class and the allowed declaration
    const overlay = await cellContent(page, 'h2').evaluate((el) => {
      const sp = [...el.querySelectorAll('span')].find((x) => x.textContent === 'overlay');
      const card = [...el.querySelectorAll('div')].find((x) => x.textContent === 'kaart');
      const r = sp ? sp.getBoundingClientRect() : null;
      return { cls: sp?.getAttribute('class'), style: sp?.getAttribute('style'), fixed: sp ? getComputedStyle(sp).position : null, w: r ? Math.round(r.width) : null, cardClass: card ? card.getAttribute('class') : 'no-div', cardText: !!card };
    });
    record('overlay_span', overlay);
    assert.equal(overlay.cls, 'reviewer-highlight', 'host utility classes are dropped');
    assert.ok(!/position|z-index|width|height|left|top/.test(overlay.style || ''), `no layout properties survive: ${overlay.style}`);
    assert.notEqual(overlay.fixed, 'fixed', 'the span is not fixed');
    assert.ok(overlay.w < 600, 'the span is not stretched over the viewport');
    assert.equal(overlay.cardClass, null, 'app layout classes (editor-cell expanded) are dropped, the div stays');

    // entity text stays text, in the editor, in the PUT and in what the backend holds
    const h3 = await cellHtml(page, 'h3');
    record('cell_html_h3', h3);
    const h4 = await cellHtml(page, 'h4');
    record('cell_html_h4', h4);
    for (const [name, h] of [['h3', h3], ['h4', h4]]) {
      assert.ok(!/<img|<svg|<b>/.test(h), `${name}: entity text did not turn into elements: ${h}`);
      assert.ok(h.includes('&lt;'), `${name}: the text is still there as text: ${h}`);
    }
    assert.equal(await cellContent(page, 'h3').locator('img, svg').count(), 0);
    assert.equal(await cellContent(page, 'h4').locator('img, b').count(), 0);
    assert.ok((await cellText(page, 'h4')).includes('<img src=x onerror=window.__pwn_entity2=1> & <b>geen vet</b>'), 'the typed text is shown literally');

    // drag and drop: markup dragged in from outside is reduced like a paste; nothing is fetched
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.id = 'j34b-dragsrc'; d.draggable = true; d.textContent = 'sleep mij'; d.style.cssText = 'position:fixed;left:2px;bottom:2px;z-index:2147483647;background:#eee;padding:4px';
      d.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/html', '<p style="background:url(https://evil.invalid/css.gif)">gesleept <b>vet</b><img src="https://evil.invalid/p.gif" onerror="window.__pwn_drop=1"><a href="https://evil.invalid/x">link</a></p>');
        e.dataTransfer.setData('text/plain', 'gesleept vet link');
        e.dataTransfer.effectAllowed = 'copy';
      });
      document.body.appendChild(d);
    });
    await page.dragAndDrop('#j34b-dragsrc', `.editor-cell[data-block-id="block-h4"] .cell-content`, { targetPosition: { x: 40, y: 20 } });
    await sleep(600);
    const afterDrop = await cellHtml(page, 'h4');
    record('cell_html_h4_after_drop', afterDrop);
    assert.ok(/gesleept/.test(afterDrop), `the dropped text arrived: ${afterDrop}`);
    assert.ok(!/<img|<a |<table|evil\.invalid|url\(/.test(afterDrop), `no foreign markup from the drop: ${afterDrop}`);
    assert.deepEqual(rec.external.filter((u) => /evil\.invalid/.test(u)), [], 'nothing was fetched for the drop');
    assert.equal(await page.evaluate(() => window.__pwn_drop), undefined, 'the dropped handler did not run');

    // manual save: the PUT carries the filtered content (a stored nota is cleaned by its first save)
    const since = Date.now();
    await page.getByRole('button', { name: 'Opslaan' }).click();
    const puts = await waitFor(() => { const p = putCalls(rec, nota.id, since); return p.length && p[0].doneTs ? p : null; }, { what: 'PUT after load' });
    const sent = JSON.parse(puts[0].postData).content;
    record('put_content_tail', sent.slice(-400));
    for (const bad of ['<script', '<iframe', '<style', '<svg', '<img', 'javascript:', '<a ']) {
      assert.ok(!sent.includes(bad), `${bad} is not saved: ${sent}`);
    }
    assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(sent), `no event handler attribute is saved: ${sent}`);   // entity TEXT such as `&lt;img onerror=..&gt;` is allowed to say "onerror"
    assert.ok(sent.includes('<p>klik hier</p>') && sent.includes('<p>staart</p>'), 'paragraphs saved');
    assert.ok(!/<img|<svg|<b>/.test(sent), `entity text is saved as text, not as elements: ${sent}`);
    assert.ok(sent.includes('&lt;img src=x onerror=window.__pwn_entity=1&gt;'), 'the entity text is saved as entities');
    const cached = (await localGet(page, 'gs_nota_db')) || '';
    assert.ok(!/<img|<script|<svg|javascript:/.test(cached), 'the local cache holds no hostile markup either');
    const fresh = await api.getNota(nota.id);
    assert.equal(fresh.content, sent, 'the backend holds what was sent');
  },
};
